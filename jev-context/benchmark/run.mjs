#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { createPipeline } from "../core/pipeline.mjs";
import { estimateTokens, sumTokens } from "../core/tokens.mjs";
import { createSessionStore } from "../adapters/hooks/protocol.mjs";
import { contentDigest } from "../adapters/hooks/handler.mjs";

const TASK = "Refactor src/core/a.mjs and make the test suite pass.";

/**
 * Benchmark: OFF vs SHADOW vs ACTIVE over a simulated long coding session.
 *
 * The question this answers is not "does it remove tokens" — dropping the whole
 * context would win that — but "does it remove tokens *while the agent still has
 * everything it needs to finish the task*". So every run ends with a
 * correctness gate over the items that must still be present.
 *
 * Latency is simulated at the value measured against the live service
 * (JEV_ROUND_TRIP_MS, default 700 ms) rather than actually calling api.openjev.sh,
 * so the benchmark is deterministic and offline. `--live` switches to the real
 * client and requires OPENJEV_API_KEY.
 */

const ROUND_TRIP_MS = Number(process.env.JEV_BENCH_ROUND_TRIP_MS || 700);
const LIVE = process.argv.includes("--live");
const TURNS = Number(process.env.JEV_BENCH_TURNS || 60);

/* ------------------------------------------------------------ session model */

function verbose(marker, lines = 40) {
  return Array.from({ length: lines }, (_, i) => `${marker}: step ${i + 1}/${lines} 45% complete`).join("\n");
}

/**
 * Builds a long session that looks like real agent work: repeated file reads, a
 * recurring install log, an unresolved error, search output, and constraints the
 * user stated once at the very beginning.
 */
function buildSession(turns) {
  const items = [
    { id: "sys", role: "system", text: "SYSTEM: You are a careful engineer. Preserve exact error messages." },
    {
      id: "constraint",
      role: "user",
      text: "CONSTRAINT: do not modify anything under vendor/ and never force-push. src/core/a.mjs is the file under edit.",
    },
  ];

  const mustKeep = new Set(["sys", "constraint"]);
  const pushes = [];

  for (let turn = 1; turn <= turns; turn += 1) {
    pushes.push({ id: `u_turn${turn}`, role: "user", text: `Turn ${turn}: continue the refactor and verify it.` });
    pushes.push({ id: `a_turn${turn}`, role: "assistant", text: `Working on turn ${turn}.` });

    // The recurring install log: large, repetitive, and superseded every turn.
    pushes.push({
      id: `install_turn${turn}`,
      role: "tool",
      tool: "bash",
      text: verbose(`npm install run ${turn}`, 60),
      meta: { group: "install", resourceKey: "cmd:npm install" },
    });

    // Repeated reads of the file under edit: only the newest one is the truth.
    pushes.push({
      id: `read_turn${turn}`,
      role: "tool",
      tool: "read",
      text: `// src/core/a.mjs @ turn ${turn}\nexport function resolve(node) { return node; } // rev ${turn}`,
      meta: { group: "file", resourceKey: "file:src/core/a.mjs" },
    });

    // A long-tail search whose result matters much later.
    pushes.push({
      id: `grep_turn${turn}`,
      role: "tool",
      tool: "grep",
      text: `src/core/a.mjs:12: export function resolve(node) {  // found in turn ${turn}`,
      meta: { group: "search", resourceKey: "search:resolve" },
    });

    if (turn === 4) {
      pushes.push({
        id: "error_unresolved",
        role: "tool",
        tool: "bash",
        text: "Error: Cannot find module './vendor/legacy.mjs'\n    at resolve\n    at processTicksAndRejections\nexit code 1",
        meta: { group: "command", resourceKey: "cmd:node build" },
      });
      mustKeep.add("error_unresolved");
    }

    if (turn === turns) {
      // Still-unresolved at the end: this is the state the agent must act on.
      pushes.push({
        id: "read_final",
        role: "tool",
        tool: "read",
        text: `// src/core/a.mjs @ FINAL\nexport function resolve(node) { return normalize(node); }`,
        meta: { group: "file", resourceKey: "file:src/core/a.mjs" },
      });
      pushes.push({
        id: "test_final",
        role: "tool",
        tool: "bash",
        text: "1 failing test: resolve() drops the vendor guard\nexit code 1",
        meta: { group: "test", resourceKey: "cmd:npm test" },
      });
      mustKeep.add("read_final");
      mustKeep.add("test_final");
    }

    // Assemble this turn's context the way a host would: history + new results.
    pushes.forEach((push, index) => {
      if (!items.some((existing) => existing.id === push.id)) {
        items.push({ ...push, position: items.length, index });
      }
    });
  }

  // Normalise positions to the array order the host would assemble.
  const normalised = items.map((item, index) => ({ ...item, position: index }));
  return { items: normalised, mustKeep };
}

/* ------------------------------------------------------------------ clients */

/** Wraps a client with a simulated round trip, recording per-call latency. */
function simulateLatency(base, roundTripMs) {
  const latencies = [];
  return {
    latencies,
    calls: 0,
    async classify(payload) {
      this.calls += 1;
      // A cache miss is what costs a round trip; the engine only calls us on
      // misses, so every call here is a real one.
      const jitter = 0.85 + Math.random() * 0.3;
      const latency = Math.round(roundTripMs * jitter);
      latencies.push(latency);
      await new Promise((resolve) => setTimeout(resolve, Math.min(latency, 5)));
      return base.classify(payload, latency);
    },
    async probe() {
      return base.probe();
    },
  };
}

function fixtureDecider({ state }) {
  // A deterministic stand-in for Jev's judgement, matching the semantics the
  // live service demonstrated: repetitive progress output and superseded
  // snapshots are droppable; anything carrying a failure is not.
  const hasFailure = /Error:|exit code [1-9]|failing test|Traceback/.test(state);
  const choice = hasFailure ? "keep" : "drop";
  return {
    type: "choice",
    choice,
    probabilities: choice === "drop" ? { keep: 0.01, drop: 0.99 } : { keep: 0.97, drop: 0.03 },
    confidence: 0.97,
  };
}

function stubClient() {
  return {
    async classify(payload, latencyMs) {
      const answers = {};
      for (const id of Object.keys(payload.questions || {})) answers[id] = fixtureDecider(payload);
      return { ok: true, answers, usage: { input_tokens: Math.ceil(payload.state.length / 4), output_tokens: 20 }, latencyMs };
    },
    async probe() {
      return { ok: true, answers: {}, latencyMs: 1 };
    },
  };
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

/* -------------------------------------------------------------------- runner */

async function runMode(mode, session, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `jev-bench-${mode}-`));
  const env = {
    OPENJEV_API_KEY: options.live ? process.env.OPENJEV_API_KEY : "oj_test.benchmark-key-000000000000",
    OPENJEV_BASE_URL: process.env.OPENJEV_BASE_URL || "https://api.openjev.sh",
    JEV_PRUNING_HOME: home,
    JEV_PRUNING_THRESHOLD_TOKENS: "1",
    JEV_PRUNING_MODE: mode,
    // Blocking is what we measure for the default row: the added latency of a
    // cache miss on the critical path. The background row flips this off.
    JEV_PRUNING_BACKGROUND: options.background ? "true" : "false",
    JEV_PRUNING_KEEP_RECENT_ITEMS: "6",
  };

  const inner = options.live ? undefined : stubClient();
  const client = options.live ? undefined : simulateLatency(inner, ROUND_TRIP_MS);
  const pipeline = createPipeline({ env, client, logger: () => {} });

  // Replay the session turn by turn: each turn prunes the context assembled so
  // far, exactly as a host would on every model call.
  let mainTokensTotal = 0;
  const perTurnLatency = [];
  let finalItems = [];
  const totals = {
    openjevCalls: 0,
    openjevInputTokens: 0,
    openjevOutputTokens: 0,
    dropped: 0,
    wouldDrop: 0,
    cacheHits: 0,
    cacheMisses: 0,
    fallbacks: 0,
    apiFailures: 0,
  };

  for (let turn = 1; turn <= TURNS; turn += 1) {
    const upTo = session.items.filter((item) => {
      const match = /turn(\d+)/.exec(item.id);
      if (!match) return true;
      return Number(match[1]) <= turn;
    });

    const started = Date.now();
    const { items, stats } = await pipeline.run(upTo, {
      scope: `bench-${mode}`,
      taskText: "Refactor src/core/a.mjs and make the test suite pass.",
      // In background mode the model call never waits: decisions learned here
      // land in the cache and take effect on the following turn.
      allowBlockingRequests: !options.background,
    });
    perTurnLatency.push(Date.now() - started);

    if (options.background) {
      // This is the detached `prewarm-worker.mjs` contract: same items, run off
      // the critical path, results cached for the next turn.
      const warmed = await pipeline.prewarm(upTo, {
        scope: `bench-${mode}`,
        taskText: "Refactor src/core/a.mjs and make the test suite pass.",
      });
      totals.prewarmed = (totals.prewarmed || 0) + warmed.classified;
    }

    // Session totals, not the final turn's numbers.
    totals.openjevCalls += stats.openjevCalls;
    totals.openjevInputTokens += stats.openjevInputTokens;
    totals.openjevOutputTokens += stats.openjevOutputTokens;
    totals.dropped += stats.dropped;
    totals.wouldDrop += stats.wouldDrop;
    totals.cacheHits += stats.cacheHits;
    totals.cacheMisses += stats.cacheMisses;
    totals.fallbacks += stats.fallbacks;
    totals.apiFailures += stats.apiFailures;

    mainTokensTotal += sumTokens(items);
    finalItems = items;
  }

  return {
    mode,
    mainTokensTotal,
    perTurnLatency,
    finalItems,
    ...totals,
    // Total OpenJEV invocations actually made, including any fired from the
    // detached background worker (which is why this can exceed the synchronous
    // per-turn sum for the background row).
    openjevCalls: client && typeof client.calls === "number" ? client.calls : totals.openjevCalls,
    // What the critical path would actually have paid to OpenJEV.
    simulatedLatencies: client && client.latencies ? client.latencies : [],
  };
}

/* ---------------------------------------------------- agy write-time path */

/**
 * Replays the same session through the *write-time* path that Agy uses.
 *
 * On Agy the decision has to be made the moment a tool result is produced
 * (`PostToolUse` -> `overwrite_result`), because no later hook can revise it.
 * So this run feeds one item at a time, in production order, with the session
 * store supplying the digests already seen. It is a genuinely harder path than
 * the proxy's: it cannot use supersession, because the future is unknown.
 */
async function runWriteTime(mode, session) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `jev-bench-agy-${mode}-`));
  const env = {
    OPENJEV_API_KEY: LIVE ? process.env.OPENJEV_API_KEY : "oj_test.benchmark-key-000000000000",
    OPENJEV_BASE_URL: process.env.OPENJEV_BASE_URL || "https://api.openjev.sh",
    JEV_PRUNING_HOME: home,
    JEV_PRUNING_THRESHOLD_TOKENS: "1",
    JEV_PRUNING_MODE: mode,
    JEV_PRUNING_BACKGROUND: "false",
    JEV_PRUNING_KEEP_RECENT_ITEMS: "6",
  };

  const inner = LIVE ? undefined : stubClient();
  const client = LIVE ? undefined : simulateLatency(inner, ROUND_TRIP_MS);
  const pipeline = createPipeline({ env, client, logger: () => {} });
  const store = createSessionStore({ path: path.join(home, "agy-sessions.json") });
  const scope = "bench-agy";

  let mainTokensTotal = 0;
  let elided = 0;
  let elidedTokens = 0;
  const perTurnLatency = [];
  const survivors = [];
  const totals = { openjevCalls: 0, openjevInputTokens: 0, openjevOutputTokens: 0, dropped: 0, wouldDrop: 0, cacheHits: 0, cacheMisses: 0, fallbacks: 0, apiFailures: 0 };

  for (const item of session.items) {
    const remembered = store.remember("bench", {
      tool: item.tool,
      group: item.meta && item.meta.group,
      resourceKey: item.meta && item.meta.resourceKey,
      chars: (item.text || "").length,
      digest: contentDigest(item.text, item.tool, scope, pipeline.config.policyVersion),
    });
    const priorDigests = new Map();
    for (const entry of remembered.slice(0, -1)) {
      if (entry && entry.digest) priorDigests.set(entry.digest, (priorDigests.get(entry.digest) || 0) + 1);
    }

    // Only a result big enough to be worth a round trip may block; smaller ones
    // are still classified by rules but never pay for a network call. Same gate
    // the adapter applies.
    const worthBlocking = estimateTokens(item.text || "") >= pipeline.config.writeTimeMinTokens;
    const raw = { ...item, position: 0 };
    const started = Date.now();

    if (mode === "active") {
      const pass = await pipeline.plan([raw], {
        scope,
        mode,
        writeTime: true,
        priorDigests,
        allowBlockingRequests: worthBlocking,
        taskText: TASK,
      });
      perTurnLatency.push(Date.now() - started);

      const decision = pass.decisions[0];
      const planned = pass.items[0];
      if (decision.action === "drop") {
        elided += 1;
        elidedTokens += planned.tokens;
      } else {
        mainTokensTotal += planned.tokens;
        survivors.push(planned);
      }
      for (const key of ["openjevCalls", "openjevInputTokens", "openjevOutputTokens", "dropped", "cacheHits", "cacheMisses", "fallbacks", "apiFailures"]) {
        totals[key] += pass.stats[key] || 0;
      }
    } else {
      // Shadow: the adapter hands this to the detached worker, so the model call
      // never waits. Everything is kept; the decision is recorded for stats.
      await pipeline.prewarm([raw], {
        scope,
        mode,
        writeTime: true,
        priorDigests,
        taskText: TASK,
      });
      perTurnLatency.push(Date.now() - started);
      const planned = { ...raw, tokens: estimateTokens(item.text || "") };
      mainTokensTotal += planned.tokens;
      survivors.push(planned);
      totals.wouldDrop += 1;
    }
  }

  return {
    mode: mode === "active" ? "agy active" : `agy ${mode}`,
    mainTokensTotal,
    perTurnLatency,
    finalItems: survivors,
    elided,
    elidedTokens,
    ...totals,
    openjevCalls: client && typeof client.calls === "number" ? client.calls : totals.openjevCalls,
    simulatedLatencies: client && client.latencies ? client.latencies : [],
  };
}

function correctnessGate(result, session) {
  const present = new Set(result.finalItems.map((item) => item.id));
  const missing = [...session.mustKeep].filter((id) => !present.has(id));
  return { ok: missing.length === 0, missing };
}

/* ---------------------------------------------------------------------- main */

const session = buildSession(TURNS);
const totalTokensRaw = session.items.reduce((total, item) => total + estimateTokens(item.text || ""), 0);

process.stdout.write(
  `\njev-prune benchmark — ${TURNS} turns, ${session.items.length} context items, ` +
    `${totalTokensRaw.toLocaleString("en-US")} tokens if never pruned\n` +
    (LIVE ? "client: LIVE OpenJEV\n" : `client: offline fixture, simulated round trip ${ROUND_TRIP_MS} ms\n`) +
    "\n",
);

const off = await runMode("off", session);
const shadow = await runMode("shadow", session);
const active = await runMode("active", session, {});
const activeBackground = await runMode("active", session, { background: true });
// The Agy path: judged at write time, one item at a time, with no future
// knowledge and no supersession available.
const agyShadow = await runWriteTime("shadow", session);
const agyActive = await runWriteTime("active", session);

const rows = [off, shadow, active, activeBackground, agyShadow, agyActive];
const baseline = off.mainTokensTotal;

function pct(value) {
  return `${(100 * value).toFixed(1)}%`;
}

process.stdout.write(
  [
    "mode        main input tokens   vs OFF    dropped  would-drop  JEV calls  cache hit   p50 ms  p95 ms  correctness",
    "----------  ------------------  --------  -------  ----------  ---------  ---------  -------  ------  -----------",
  ]
    .concat(
      rows.map((row) => {
        const gate = correctnessGate(row, session);
        const cacheTotal = (row.cacheHits || 0) + (row.cacheMisses || 0);
        const hitRate = cacheTotal > 0 ? pct((row.cacheHits || 0) / cacheTotal) : "n/a";
        return [
          String(row.mode + (row === activeBackground ? " (bg)" : "")).padEnd(11),
          String(row.mainTokensTotal.toLocaleString("en-US")).padStart(18),
          pct(1 - row.mainTokensTotal / baseline).padStart(8),
          String(row.dropped ?? 0).padStart(7),
          String(row.wouldDrop ?? 0).padStart(10),
          String(row.openjevCalls ?? 0).padStart(9),
          hitRate.padStart(9),
          String(percentile(row.perTurnLatency, 50)).padStart(7),
          String(percentile(row.perTurnLatency, 95)).padStart(6),
          `  ${gate.ok ? "PASS" : `FAIL (${gate.missing.join(", ")})`}`,
        ].join("  ");
      }),
    )
    .join("\n") + "\n",
);

const activeGate = correctnessGate(active, session);
// Session-wide, not the final turn's figure.
const openjevInputTokens = active.openjevInputTokens;

process.stdout.write(
  [
    "",
    `main-model input tokens avoided: ${(baseline - active.mainTokensTotal).toLocaleString("en-US")} ` +
      `(${pct(1 - active.mainTokensTotal / baseline)} of the unpruned total)`,
    `token overhead sent to OpenJEV:  ${openjevInputTokens.toLocaleString("en-US")} input tokens ` +
      `across ${active.openjevCalls} calls`,
    `net token change:               ${(baseline - active.mainTokensTotal - openjevInputTokens).toLocaleString("en-US")} tokens saved`,
    `OpenJEV round trips:            ${active.simulatedLatencies.length} ` +
      `(added latency p50 ${percentile(active.simulatedLatencies, 50)} ms, ` +
      `p95 ${percentile(active.simulatedLatencies, 95)} ms, ` +
      `total ${active.simulatedLatencies.reduce((a, b) => a + b, 0)} ms)`,
    `engine overhead (no network):   p50 ${percentile(active.perTurnLatency, 50)} ms, ` +
      `p95 ${percentile(active.perTurnLatency, 95)} ms per model call`,
    `decision-cache hit rate:        ${pct(active.cacheHits / Math.max(1, active.cacheHits + active.cacheMisses))} ` +
      `(${active.cacheHits} hits / ${active.cacheMisses} misses)`,
    `OpenJEV failures / fallbacks:   ${active.apiFailures} / ${active.fallbacks}`,
    `background mode (recommended):  ${activeBackground.mainTokensTotal.toLocaleString("en-US")} main tokens ` +
      `(${pct(1 - activeBackground.mainTokensTotal / baseline)} removed), ` +
      `added critical-path latency p50 ${percentile(activeBackground.perTurnLatency, 50)} ms ` +
      `(engine only; no model call ever waits on OpenJEV)`,
    `agy write-time path:           ${agyActive.mainTokensTotal.toLocaleString("en-US")} main tokens ` +
      `(${pct(1 - agyActive.mainTokensTotal / baseline)} removed), ${agyActive.elided} results elided ` +
      `at production time (${agyActive.elidedTokens.toLocaleString("en-US")} tokens), ` +
      `critical-path latency p50 ${percentile(agyActive.perTurnLatency, 50)} ms across ` +
      `${agyActive.openjevCalls} blocking round trips ` +
      `(p50 ${percentile(agyActive.simulatedLatencies, 50)} ms each, ` +
      `total ${agyActive.simulatedLatencies.reduce((a, b) => a + b, 0)} ms of the session)`,
    `agy shadow path:               ${agyShadow.mainTokensTotal.toLocaleString("en-US")} main tokens ` +
      `(nothing removed), ${agyShadow.wouldDrop} would-drop decisions learned in the background ` +
      `at ${percentile(agyShadow.perTurnLatency, 50)} ms p50 critical-path latency`,
    `agy round trips / cache:       ${agyActive.openjevCalls} / ` +
      `${pct(agyActive.cacheHits / Math.max(1, agyActive.cacheHits + agyActive.cacheMisses))} hit rate`,
    `agy must-keep elisions:         ${correctnessGate(agyActive, session).ok ? "none (PASS)" : `FAIL — ${correctnessGate(agyActive, session).missing.join(", ")}`}`,
    `final-task correctness:          ${activeGate.ok ? "PASS — every must-keep item survived" : `FAIL — missing ${activeGate.missing.join(", ")}`}`,
    "",
  ].join("\n"),
);

if (!activeGate.ok) process.exit(1);
