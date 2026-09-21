#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { loadConfig, describeConfig } from "../core/config.mjs";
import { createPipeline, makeItem } from "../core/pipeline.mjs";
import { redact, mustNotTransmit } from "../core/redact.mjs";
import { interpretAnswer } from "../core/openjev.mjs";
import { estimateTokens } from "../core/tokens.mjs";
import { createDecisionCache } from "../core/decision-cache.mjs";
import { createOpenJevClient } from "../core/openjev.mjs";
import { classifyAll } from "../core/classifier.mjs";
import { adapterTests } from "./adapters.mjs";

/**
 * Fixture suite for the pruning engine.
 *
 * Each fixture is one of the A–O scenarios from the design brief. Every test
 * drives the real pipeline — real Stage 1 rules, real batching, real redaction,
 * real cache, real policy vetoes — and stubs only the OpenJEV HTTP boundary, so
 * what is under test is the engine's behaviour rather than a mock's.
 */

const FAILURE_MODES = {
  timeout: { ok: false, reason: "timeout", latencyMs: 5 },
  unauthorized: { ok: false, reason: "http-401", status: 401, latencyMs: 4 },
  unavailable: { ok: false, reason: "http-503", status: 503, latencyMs: 4 },
  malformed: { ok: false, reason: "malformed-response", latencyMs: 3 },
};

function stubClient({ decider, failure, capture } = {}) {
  return {
    calls: 0,
    async classify({ state, questions }) {
      this.calls += 1;
      if (capture) capture.push({ state, questions });
      if (failure) return { ...FAILURE_MODES[failure] };
      const answers = {};
      for (const id of Object.keys(questions || {})) {
        answers[id] = decider
          ? decider({ state, id, questions })
          : { type: "choice", choice: "drop", probabilities: { keep: 0.01, drop: 0.99 }, confidence: 0.99 };
      }
      return { ok: true, answers, usage: { input_tokens: 200, output_tokens: 20 }, latencyMs: 7 };
    },
    async probe() {
      return { ok: true, answers: { item_0001_keep: { choice: "drop", confidence: 0.99 } }, latencyMs: 5 };
    },
  };
}

function testEnv(overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jev-test-"));
  return {
    OPENJEV_API_KEY: "oj_test.this-is-not-a-real-key-000000000000",
    JEV_PRUNING_HOME: home,
    JEV_PRUNING_THRESHOLD_TOKENS: "1",
    JEV_PRUNING_MODE: "active",
    JEV_PRUNING_BACKGROUND: "false",
    JEV_PRUNING_MIN_CONFIDENCE: "0.72",
    JEV_PRUNING_DROP_PROBABILITY: "0.9",
    JEV_PRUNING_KEEP_RECENT_ITEMS: "1",
    ...overrides,
  };
}

function makePipeline(env, client, extra = {}) {
  return createPipeline({ env, client, logger: () => {}, ...extra });
}

let toolSeq = 0;
function toolItem(id, text, options = {}) {
  toolSeq += 1;
  return {
    id,
    role: "tool",
    tool: options.tool || "shell",
    text,
    meta: options.meta || { group: "command", resourceKey: `cmd:${id}` },
    flags: options.flags || {},
  };
}

function userItem(id, text) {
  return { id, role: "user", tool: null, text };
}

function assistantItem(id, text) {
  return { id, role: "assistant", tool: null, text };
}

function verboseLog(marker, lines = 40) {
  return Array.from({ length: lines }, (_, index) => `${marker} progress ${index}/40 ${(index * 2.5).toFixed(1)}% complete`).join("\n");
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    process.stdout.write(`  ok    ${name}\n`);
  } catch (error) {
    results.push({ name, ok: false, error });
    process.stdout.write(`  FAIL  ${name}\n        ${String(error && error.message).split("\n").join("\n        ")}\n`);
  }
}

/* ------------------------------------------------------------------ unit tests */

await test("tokens: deterministic, CJK-aware, monotone", () => {
  assert.equal(estimateTokens(""), 0);
  assert.ok(estimateTokens("あ".repeat(100)) > estimateTokens("ab".repeat(100)));
  assert.equal(estimateTokens("hello world"), estimateTokens("hello world"));
  assert.ok(estimateTokens("a".repeat(400)) >= 100);
});

await test("redact: known credential shapes are replaced", () => {
  const cases = [
    ["OPENAI_API_KEY=sk-proj-ABCdef1234567890abcdef", "sk-proj-ABCdef1234567890abcdef"],
    ["token oj_live.user_abc.0123456789abcdef", "oj_live.user_abc.0123456789abcdef"],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklm.signature", "Bearer eyJhbGciOiJIUzI1NiJ9"],
    ["aws AKIAIOSFODNN7EXAMPLE ok", "AKIAIOSFODNN7EXAMPLE"],
    ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
  ];
  for (const [input, secret] of cases) {
    const result = redact(input);
    assert.ok(!result.text.includes(secret), `secret survived redaction in: ${input}`);
    assert.ok(result.count > 0, `no redaction recorded for: ${input}`);
  }
});

await test("redact: private key blocks and cookies are removed", () => {
  const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----`;
  const result = redact(`here it is\n${pem}\n`);
  assert.ok(!result.text.includes("MIIEowIBAAKCAQEA"), "private key body survived");
  const cookie = redact("Cookie: session=abcdef1234567890abcdef; other=1");
  assert.ok(!cookie.text.includes("abcdef1234567890abcdef"), "cookie value survived");
});

await test("redact: unrecognised opaque credential is flagged, not silently passed", () => {
  const suspicious = `notes: the customer secret is ${Buffer.from("x".repeat(80)).toString("base64")}`;
  const result = redact(suspicious);
  assert.equal(mustNotTransmit(result, { failClosed: true }), true, "long opaque credential should be fail-closed");
  const benign = redact("the build produced 42 warnings and 0 errors");
  assert.equal(mustNotTransmit(benign, { failClosed: true }), false);
});

await test("interpretAnswer: conservative thresholds", () => {
  const config = { dropProbability: 0.9, minConfidence: 0.72 };
  assert.equal(interpretAnswer({ choice: "drop", probabilities: { keep: 0.01, drop: 0.99 }, confidence: 0.99 }, config).action, "drop");
  assert.equal(interpretAnswer({ choice: "drop", probabilities: { keep: 0.4, drop: 0.6 }, confidence: 0.99 }, config).action, "keep");
  assert.equal(interpretAnswer({ choice: "drop", probabilities: { keep: 0.01, drop: 0.99 }, confidence: 0.4 }, config).action, "keep");
  assert.equal(interpretAnswer({ choice: "keep", probabilities: { keep: 0.9, drop: 0.1 }, confidence: 0.99 }, config).action, "keep");
  assert.equal(interpretAnswer(null, config).action, "keep");
  assert.equal(interpretAnswer({ choice: "drop" }, config).action, "keep");
});

await test("openjev client: failures never echo the key", async () => {
  const config = loadConfig(testEnv());
  const leakingFetch = async () => {
    throw new Error(`connect failed for Bearer ${config.apiKey} at ${config.baseUrl}`);
  };
  const client = createOpenJevClient(config, { fetchImpl: leakingFetch });
  const result = await client.classify({ state: "s", questions: { q: { type: "choice" } } });
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes(config.apiKey), "the API key leaked into an error result");
  assert.ok(result.detail.includes("[REDACTED"), "expected the credential to be redacted from the detail");
});

await test("config: describeConfig never exposes the key", () => {
  const config = loadConfig(testEnv());
  const described = JSON.stringify(describeConfig(config));
  assert.ok(!described.includes(config.apiKey));
  assert.ok(described.includes('"apiKeyPresent":true'));
});

/* -------------------------------------------------------------------- fixtures */

await test("fixture A: bulk old build/install logs are mostly droppable", async () => {
  const env = testEnv();
  const items = [userItem("u1", "Build the project and fix the failing tests.")];
  for (let i = 0; i < 30; i += 1) items.push(toolItem(`log${i}`, verboseLog(`installing package ${i}`), { tool: "bash" }));

  const pipeline = makePipeline(env, stubClient());
  const { plan, stats } = await pipeline.run(items, { scope: "A", taskText: "Build the project." });

  assert.ok(stats.engaged, "pipeline should engage for a large context");
  assert.ok(stats.dropped >= 20, `expected >=20 drops, got ${stats.dropped}`);
  assert.ok(stats.tokensAfter < stats.tokensBefore * 0.5, "expected a large token reduction");
  assert.equal(plan.decisions.filter((decision) => decision.action === "drop").length, stats.dropped);
});

await test("fixture B: an older-but-unresolved error is kept and never asked about", async () => {
  const env = testEnv();
  const error = "Error: Cannot find module './missing.mjs'\n  at Module._resolveFilename\n  exit code 1";
  const items = [
    userItem("u1", "Fix the build."),
    toolItem("err1", error, { tool: "bash", meta: { group: "command", resourceKey: "cmd:build" } }),
    toolItem("noise1", verboseLog("compiling"), { tool: "bash" }),
  ];

  const capture = [];
  const pipeline = makePipeline(env, stubClient({ capture }));
  const { items: survivors, plan } = await pipeline.run(items, { scope: "B" });

  assert.ok(
    survivors.some((item) => item.id === "err1"),
    "the unresolved failure must survive",
  );
  // The failure text must never have been part of a transmitted state at all:
  // Stage 1 resolves it, so OpenJEV is never asked about it.
  assert.ok(
    !capture.some((entry) => entry.state.includes("Cannot find module './missing.mjs'")),
    "the failure text must never be transmitted to OpenJEV",
  );
  const decision = plan.decisions.find((entry) => entry.id === "err1");
  assert.equal(decision.action, "keep");
  assert.match(decision.reason, /unresolved failure|newest snapshot/);
});

await test("fixture C: a user constraint in an old message is never lost", async () => {
  const env = testEnv();
  const items = [
    userItem("u1", "Constraint: you MUST NOT write to production. Also never delete tests."),
    assistantItem("a1", "Understood."),
  ];
  for (let i = 0; i < 12; i += 1) items.push(toolItem(`t${i}`, verboseLog(`step ${i}`), { tool: "bash" }));

  const pipeline = makePipeline(env, stubClient());
  const { items: survivors } = await pipeline.run(items, { scope: "C" });
  const constraint = survivors.find((item) => item.id === "u1");
  assert.ok(constraint, "the user constraint message must survive");
  assert.ok(constraint.text.includes("MUST NOT"), "its text must be byte-identical");
  assert.ok(survivors.some((item) => item.id === "a1"), "assistant text is never pruned");
});

await test("fixture D: three reads of one file keep the newest, drop the superseded ones", async () => {
  const env = testEnv();
  const resource = "file:/src/a.mjs";
  const items = [
    userItem("u1", "Inspect src/a.mjs."),
    toolItem("read_A", "// OLD SNAPSHOT A\nconst a = 1;", { tool: "read", meta: { group: "file", resourceKey: resource } }),
    toolItem("read_B", "// OLD SNAPSHOT B\nconst a = 2;", { tool: "read", meta: { group: "file", resourceKey: resource } }),
    toolItem("noise", verboseLog("x"), { tool: "bash" }),
    toolItem("read_C", "// LATEST SNAPSHOT C\nconst a = 3;", { tool: "read", meta: { group: "file", resourceKey: resource } }),
  ];

  const pipeline = makePipeline(env, stubClient());
  const { items: survivors, plan } = await pipeline.run(items, { scope: "D" });

  assert.ok(survivors.some((item) => item.id === "read_C"), "the newest snapshot must survive");
  assert.ok(!survivors.some((item) => item.id === "read_A"), "superseded snapshot A should be dropped");
  assert.ok(!survivors.some((item) => item.id === "read_B"), "superseded snapshot B should be dropped");
  const newest = plan.decisions.find((decision) => decision.id === "read_C");
  assert.equal(newest.action, "keep", "the newest snapshot must never be dropped");
});

await test("fixture E: old search output is never dropped unconditionally", async () => {
  const env = testEnv();
  const grep = "src/handler.mjs:88:  export function resolveSymbolIdentity(node) {";
  const items = [userItem("u1", "Find the resolver.")];
  for (let i = 0; i < 10; i += 1) items.push(toolItem(`t${i}`, verboseLog(`scan ${i}`), { tool: "bash" }));
  items.push(toolItem("grep1", grep, { tool: "grep", meta: { group: "search", resourceKey: "search:resolveSymbolIdentity" } }));
  // A trailing item so the search result sits outside the recent window.
  items.push(toolItem("tail3", verboseLog("wrap up"), { tool: "bash" }));

  // With OpenJEV unreachable the only thing protecting this item is the rule set.
  const pipeline = makePipeline(env, stubClient({ failure: "unavailable" }));
  const { items: survivors } = await pipeline.run(items, { scope: "E" });
  assert.ok(survivors.some((item) => item.id === "grep1"), "search results must survive a fail-open pass");

  // And it is routed to OpenJEV rather than dropped by rule.
  const { verdicts } = classifyAll(
    items.map((raw, index) => makeItem(raw, { scope: "E", policyVersion: "jev-pruning-policy-1", index })),
    { keepRecentItems: 1 },
  );
  const verdict = verdicts.find((entry) => entry.id === "grep1");
  assert.equal(verdict.action, "ask", "search output must be classified as ambiguous, not droppable");
});

await test("fixture F: credentials are stripped before anything is transmitted", async () => {
  const env = testEnv();
  const secret = "sk-proj-THISisASECRETvalue0000000000000000";
  const aws = "AKIAIOSFODNN7EXAMPLE";
  const items = [userItem("u1", "Why did the deploy fail?")];
  for (let i = 0; i < 8; i += 1) items.push(toolItem(`t${i}`, verboseLog(`deploy ${i}`), { tool: "bash" }));
  items.push(
    toolItem(`env1`, `OPENAI_API_KEY=${secret}\nAWS_ACCESS_KEY_ID=${aws}\nexit code 0`, {
      tool: "bash",
      meta: { group: "command", resourceKey: "cmd:deploy" },
    }),
  );
  // A trailing item so the credential item is not inside the recent window.
  items.push(toolItem("tail", verboseLog("final step"), { tool: "bash" }));

  const capture = [];
  const pipeline = makePipeline(env, stubClient({ capture }));
  await pipeline.run(items, { scope: "F" });

  assert.ok(capture.length > 0, "expected at least one OpenJEV request");
  const transmitted = JSON.stringify(capture);
  assert.ok(!transmitted.includes(secret), "the API key reached the OpenJEV request");
  assert.ok(!transmitted.includes(aws), "the AWS key reached the OpenJEV request");
  assert.ok(transmitted.includes("[REDACTED"), "expected redaction markers in the transmitted state");
});

await test("fixture F2: an unidentifiable credential is withheld entirely", async () => {
  const env = testEnv();
  const opaque = Buffer.from("0123456789abcdef".repeat(6)).toString("base64");
  const items = [
    userItem("u1", "Check the credentials."),
    toolItem("longjob", verboseLog("long job part one"), { tool: "bash" }),
    toolItem("t2", verboseLog("long job part two"), { tool: "bash" }),
    toolItem("secret1", `password: the value is ${opaque}`, { tool: "bash", meta: { group: "command", resourceKey: "cmd:creds" } }),
    // A trailing item so the withheld item is not inside the recent window.
    toolItem("tail2", verboseLog("final step two"), { tool: "bash" }),
  ];

  const capture = [];
  const pipeline = makePipeline(env, stubClient({ capture }));
  const { items: survivors, plan } = await pipeline.run(items, { scope: "F2" });

  assert.ok(!JSON.stringify(capture).includes(opaque), "an unidentifiable credential was transmitted");
  assert.ok(survivors.some((item) => item.id === "secret1"), "the withheld item must be kept");
  const decision = plan.decisions.find((entry) => entry.id === "secret1");
  assert.equal(decision.action, "keep");
  assert.equal(plan.stats.skippedUnsafe >= 1, true);
});

await test("fixture G: an OpenJEV timeout leaves the agent working", async () => {
  const env = testEnv();
  const items = [userItem("u1", "Continue.")];
  for (let i = 0; i < 8; i += 1) items.push(toolItem(`t${i}`, verboseLog(`t${i}`), { tool: "bash" }));

  const pipeline = makePipeline(env, stubClient({ failure: "timeout" }));
  const { items: survivors, stats } = await pipeline.run(items, { scope: "G" });
  assert.equal(survivors.length, items.length, "every item must be forwarded on timeout");
  assert.ok(stats.timeouts >= 1);
  assert.ok(stats.fallbacks >= 1);
  assert.equal(stats.dropped, 0);
});

await test("fixture H: an OpenJEV 401 leaves the agent working", async () => {
  const env = testEnv();
  const items = [userItem("u1", "Continue.")];
  for (let i = 0; i < 8; i += 1) items.push(toolItem(`t${i}`, verboseLog(`t${i}`), { tool: "bash" }));
  const pipeline = makePipeline(env, stubClient({ failure: "unauthorized" }));
  const { items: survivors, stats } = await pipeline.run(items, { scope: "H" });
  assert.equal(survivors.length, items.length);
  assert.ok(stats.failures.includes("http-401"));
  assert.equal(stats.dropped, 0);
});

await test("fixture I: an OpenJEV 503 leaves the agent working", async () => {
  const env = testEnv();
  const items = [userItem("u1", "Continue.")];
  for (let i = 0; i < 8; i += 1) items.push(toolItem(`t${i}`, verboseLog(`t${i}`), { tool: "bash" }));
  const pipeline = makePipeline(env, stubClient({ failure: "unavailable" }));
  const { items: survivors, stats } = await pipeline.run(items, { scope: "I" });
  assert.equal(survivors.length, items.length);
  assert.ok(stats.failures.includes("http-503"));
});

await test("fixture J: a malformed OpenJEV response leaves the agent working", async () => {
  const env = testEnv();
  const items = [userItem("u1", "Continue.")];
  for (let i = 0; i < 8; i += 1) items.push(toolItem(`t${i}`, verboseLog(`t${i}`), { tool: "bash" }));
  const pipeline = makePipeline(env, stubClient({ failure: "malformed" }));
  const { items: survivors, stats } = await pipeline.run(items, { scope: "J" });
  assert.equal(survivors.length, items.length);
  assert.ok(stats.failures.includes("malformed-response"));
});

await test("fixture J2: a real client treats a body-less 200 as a failure", async () => {
  const env = testEnv();
  const config = loadConfig(env);
  const client = createOpenJevClient(config, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ model: "openjev" }) }),
  });
  const result = await client.classify({ state: "s", questions: { q: { type: "choice" } } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "malformed-response");
});

await test("fixture J3: a missing API key disables pruning instead of failing", async () => {
  const env = testEnv({ OPENJEV_API_KEY: "" });
  const items = [userItem("u1", "Continue.")];
  for (let i = 0; i < 8; i += 1) items.push(toolItem(`t${i}`, verboseLog(`t${i}`), { tool: "bash" }));
  const pipeline = makePipeline(env, stubClient());
  const { items: survivors, stats } = await pipeline.run(items, { scope: "J3" });
  assert.equal(survivors.length, items.length);
  assert.equal(stats.dropped, 0);
});

await test("fixture K: a low-confidence drop judgement becomes a keep", async () => {
  const env = testEnv();
  const items = [userItem("u1", "Continue.")];
  for (let i = 0; i < 10; i += 1) items.push(toolItem(`t${i}`, verboseLog(`t${i}`), { tool: "bash" }));

  const pipeline = makePipeline(
    env,
    stubClient({
      decider: () => ({ type: "choice", choice: "drop", probabilities: { keep: 0.45, drop: 0.55 }, confidence: 0.4 }),
    }),
  );
  const { items: survivors, plan } = await pipeline.run(items, { scope: "K" });
  assert.equal(survivors.length, items.length, "nothing may be dropped below the confidence threshold");
  const asked = plan.decisions.filter((decision) => decision.source === "openjev");
  assert.ok(asked.length > 0, "the items should still have been judged");
  assert.ok(asked.every((decision) => decision.action === "keep"));
});

await test("fixture L: native compaction owners are untouched", async () => {
  const env = testEnv();
  const items = [
    userItem("u1", "Do the thing."),
    assistantItem("a1", "Working on it."),
    toolItem("t1", verboseLog("x"), { tool: "bash" }),
    toolItem("t2", verboseLog("y"), { tool: "bash" }),
    assistantItem("a2", "Still working."),
    toolItem("t3", verboseLog("z"), { tool: "bash" }),
    toolItem("t4", verboseLog("w"), { tool: "bash" }),
  ];

  const pipeline = makePipeline(env, stubClient());
  const { items: survivors } = await pipeline.run(items, { scope: "L" });

  const nonTool = items.filter((item) => item.role !== "tool").map((item) => item.id);
  for (const id of nonTool) {
    assert.ok(survivors.some((item) => item.id === id), `${id} should never be dropped`);
  }
  // Relative order of the survivors is preserved, so the host's own compaction
  // and summarisation logic sees a consistent, monotone view.
  const order = survivors.map((item) => item.id);
  const expected = items.map((item) => item.id).filter((id) => order.includes(id));
  assert.deepEqual(order, expected, "survivor order must match the original order");
});

await test("fixture M: the stable prefix is byte-identical before and after pruning", async () => {
  const env = testEnv();
  const system = "SYSTEM: you are a careful engineer.";
  const developer = "DEVELOPER: repository rules apply.";
  const constraint = "USER: never touch production.";
  const items = [
    { id: "s1", role: "system", tool: null, text: system, meta: {}, flags: {} },
    { id: "d1", role: "developer", tool: null, text: developer, meta: {}, flags: {} },
    userItem("u1", constraint),
  ];
  for (let i = 0; i < 12; i += 1) items.push(toolItem(`t${i}`, verboseLog(`t${i}`), { tool: "bash" }));

  const pipeline = makePipeline(env, stubClient());
  const { items: survivors, plan } = await pipeline.run(items, { scope: "M" });

  // Compare the enriched items the engine actually forwards, before vs after.
  const prefixBefore = JSON.stringify(plan.items.slice(0, 3));
  const prefixAfter = JSON.stringify(survivors.slice(0, 3));
  assert.equal(prefixAfter, prefixBefore, "the stable prefix must not change by a single byte");
  assert.deepEqual(
    survivors.slice(0, 3).map((item) => item.id),
    ["s1", "d1", "u1"],
    "the prefix must stay at the front in the same order",
  );
  // Nothing inside the prefix may even be considered for a drop.
  assert.ok(
    plan.decisions.slice(0, 3).every((decision) => decision.action === "keep"),
    "prefix items must be exempt from pruning",
  );
});

await test("fixture N: a corrupt decision cache cannot break the agent", async () => {
  const env = testEnv();
  const cachePath = path.join(env.JEV_PRUNING_HOME, "decision-cache.json");
  fs.writeFileSync(cachePath, "{ this is not json ");
  const items = [userItem("u1", "Continue.")];
  for (let i = 0; i < 8; i += 1) items.push(toolItem(`t${i}`, verboseLog(`t${i}`), { tool: "bash" }));

  const pipeline = makePipeline(env, stubClient());
  const { items: survivors, plan } = await pipeline.run(items, { scope: "N" });
  assert.equal(pipeline.cache.summary().corrupt, true, "corruption should be detected and recorded");
  assert.ok(survivors.length > 0, "the run must still complete");
  assert.ok(plan.stats.dropped >= 1, "pruning still works with a fresh cache");
});

await test("fixture N2: a missing cache file is not an error", async () => {
  const env = testEnv();
  const pipeline = makePipeline(env, stubClient());
  const summary = pipeline.cache.load();
  assert.equal(summary.corrupt, false);
  assert.equal(summary.size, 0);
});

await test("fixture N3: a policy-version change invalidates previous decisions", async () => {
  const env = testEnv();
  const cachePath = path.join(env.JEV_PRUNING_HOME, "decision-cache.json");
  const oldCache = createDecisionCache({ path: cachePath, policyVersion: "jev-pruning-policy-0" });
  oldCache.set("deadbeef", { action: "drop", confidence: 0.99, dropProbability: 0.99, reason: "old" });
  oldCache.save();

  const newCache = createDecisionCache({ path: cachePath, policyVersion: "jev-pruning-policy-1" });
  const summary = newCache.load();
  assert.equal(summary.size, 0, "stale-policy entries must not be reused");
  assert.equal(newCache.get("deadbeef"), null);
});

await test("fixture O: concurrent sessions do not cross-contaminate decisions", async () => {
  const env = testEnv();
  const pipelines = Array.from({ length: 8 }, () => makePipeline(env, stubClient()));

  const runs = pipelines.map((pipeline, index) => {
    const items = [userItem(`u${index}`, `Task ${index}`)];
    for (let i = 0; i < 10; i += 1) items.push(toolItem(`s${index}_t${i}`, verboseLog(`worker ${index} item ${i}`), { tool: "bash" }));
    return pipeline.run(items, { scope: `O-${index}` }).then((result) => ({ index, result }));
  });

  const settled = await Promise.all(runs);
  for (const { index, result } of settled) {
    const ids = result.items.map((item) => item.id);
    assert.ok(ids.includes(`u${index}`), `session ${index} lost its user message`);
    for (const id of ids) {
      assert.ok(id.startsWith(`s${index}_`) || id === `u${index}`, `session ${index} received a foreign item: ${id}`);
    }
  }

  // The shared cache file must still be valid after concurrent writers.
  const parsed = JSON.parse(fs.readFileSync(path.join(env.JEV_PRUNING_HOME, "decision-cache.json"), "utf8"));
  assert.ok(parsed && typeof parsed === "object");
});

await test("shadow mode records would-drops but returns the original context", async () => {
  const env = testEnv({ JEV_PRUNING_MODE: "shadow" });
  const items = [userItem("u1", "Continue.")];
  for (let i = 0; i < 12; i += 1) items.push(toolItem(`t${i}`, verboseLog(`t${i}`), { tool: "bash" }));

  const pipeline = makePipeline(env, stubClient());
  const { items: survivors, stats } = await pipeline.run(items, { scope: "shadow" });
  assert.equal(survivors.length, items.length, "shadow mode must never remove anything");
  assert.ok(stats.wouldDrop >= 1, "shadow mode must record the saving");
  assert.equal(stats.dropped, 0);
  assert.equal(stats.estimatedMainTokensAvoided, 0, "shadow savings are not real savings");
});

await test("off mode is inert", async () => {
  const env = testEnv({ JEV_PRUNING_MODE: "off" });
  const items = [userItem("u1", "Continue.")];
  for (let i = 0; i < 12; i += 1) items.push(toolItem(`t${i}`, verboseLog(`t${i}`), { tool: "bash" }));
  const client = stubClient();
  const pipeline = makePipeline(env, client);
  const { items: survivors, stats } = await pipeline.run(items, { scope: "off" });
  assert.equal(survivors.length, items.length);
  assert.equal(client.calls, 0, "off mode must not contact OpenJEV");
  assert.equal(stats.reason, "disabled");
});

await test("a small context costs nothing", async () => {
  const env = testEnv({ JEV_PRUNING_THRESHOLD_TOKENS: "100000" });
  const items = [userItem("u1", "hi"), toolItem("t1", "small output", { tool: "bash" })];
  const client = stubClient();
  const pipeline = makePipeline(env, client);
  const { stats } = await pipeline.run(items, { scope: "small" });
  assert.equal(stats.engaged, false);
  assert.equal(client.calls, 0, "below the threshold OpenJEV must not be called");
});

await test("background prewarm populates the cache without blocking", async () => {
  const env = testEnv({ JEV_PRUNING_BACKGROUND: "true" });
  const items = [userItem("u1", "Continue.")];
  for (let i = 0; i < 12; i += 1) items.push(toolItem(`t${i}`, verboseLog(`t${i}`), { tool: "bash" }));

  const client = stubClient();
  const pipeline = makePipeline(env, client);

  // First pass: background mode means cache-only, so nothing is dropped yet and
  // the host never waits on OpenJEV.
  const first = await pipeline.run(items, { scope: "bg", allowBlockingRequests: false });
  assert.equal(first.stats.dropped, 0, "the critical path must not wait for OpenJEV");
  assert.equal(client.calls, 0, "no synchronous OpenJEV call may be made in background mode");

  // The detached worker's job, run inline here so the test is deterministic.
  const warmed = await pipeline.prewarm(items, { scope: "bg" });
  assert.ok(warmed.classified >= 1, "prewarm should have classified at least one item");

  // Second pass: the prewarmed cache now allows instant drops with zero calls.
  const callsBefore = client.calls;
  const second = await pipeline.run(items, { scope: "bg" });
  assert.ok(second.stats.dropped >= 1, "prewarmed decisions should apply on the next call");
  assert.equal(client.calls, callsBefore, "a warm cache must not require another OpenJEV call");
});

await test("metrics never contain conversation content", async () => {
  const env = testEnv();
  const items = [userItem("u1", "TOP-SECRET-INSTRUCTION")];
  for (let i = 0; i < 10; i += 1) items.push(toolItem(`t${i}`, `TOOL-SECRET-${i}\n${verboseLog(`t${i}`)}`, { tool: "bash" }));
  const pipeline = makePipeline(env, stubClient());
  await pipeline.run(items, { scope: "metrics" });
  const snapshot = JSON.stringify(pipeline.metrics.snapshot());
  assert.ok(!snapshot.includes("TOP-SECRET-INSTRUCTION"));
  assert.ok(!snapshot.includes("TOOL-SECRET"));
  assert.ok(snapshot.includes("toolResultsEvaluated"));
});

await test("batching honours the question and state budgets", async () => {
  const env = testEnv({ JEV_PRUNING_MAX_QUESTIONS_PER_CALL: "4", JEV_PRUNING_MAX_STATE_TOKENS: "300" });
  const items = [userItem("u1", "Continue.")];
  for (let i = 0; i < 24; i += 1) items.push(toolItem(`t${i}`, verboseLog(`batch ${i}`, 20), { tool: "bash" }));

  const capture = [];
  const pipeline = makePipeline(env, stubClient({ capture }));
  await pipeline.run(items, { scope: "batch" });

  assert.ok(capture.length >= 2, "a large candidate set must be split into several calls");
  for (const entry of capture) {
    assert.ok(Object.keys(entry.questions).length <= 4, "questions per call exceeded the budget");
    assert.ok(estimateTokens(entry.state) <= 900, "state exceeded the configured budget by a wide margin");
  }
});

/* ---------------------------------------------------------------- adapters */

process.stdout.write("\nadapters\n");
/* ---------------------------------------------------- write-time accounting */

await test("write-time: a pass records the tokens it avoided, and shadow never inflates it", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jev-wt-"));
  const env = {
    OPENJEV_API_KEY: "oj_test.unit-key-0000000000000000",
    JEV_PRUNING_HOME: home,
    JEV_PRUNING_MODE: "active",
    JEV_PRUNING_BACKGROUND: "false",
  };
  // The default stub answers every question with a confident drop.
  const client = stubClient();
  const pipeline = createPipeline({ env, client, logger: () => {} });
  const bigLog = Array.from({ length: 120 }, (_, i) => `step ${i}/120 ${i}%`).join("\n");
  const item = {
    id: "i1",
    role: "tool",
    tool: "Bash",
    text: bigLog,
    position: 0,
    meta: { group: "command", resourceKey: "cmd:make" },
    flags: {},
  };

  const pass = await pipeline.plan([item], {
    scope: "s",
    mode: "active",
    writeTime: true,
    priorDigests: new Map(),
    taskText: "",
  });
  assert.equal(pass.decisions[0].action, "drop");
  assert.ok(pass.stats.estimatedMainTokensAvoided > 0, "an applied pass must report avoided tokens");

  pipeline.metrics.recordPass(pass.stats);
  const after = pipeline.metrics.snapshot();
  assert.equal(after.estimatedMainTokensAvoided, pass.stats.estimatedMainTokensAvoided);
  assert.equal(after.itemsDropped, 1);

  // A shadow pass must report would-drops and contribute nothing to the
  // headline avoided-token figure.
  const shadowPass = await pipeline.plan([{ ...item, id: "i2", text: `${bigLog}\n// other` }], {
    scope: "s",
    mode: "shadow",
    writeTime: true,
    priorDigests: new Map(),
    taskText: "",
  });
  pipeline.metrics.recordPass(shadowPass.stats);
  const afterShadow = pipeline.metrics.snapshot();
  assert.equal(afterShadow.itemsWouldDrop, 1);
  assert.equal(afterShadow.estimatedMainTokensAvoided, after.estimatedMainTokensAvoided);
  assert.equal(afterShadow.shadowEvaluations, 1);
});

await test("write-time: a fresh file read, a diff, and a todo list are never droppable", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jev-wt2-"));
  const bulky = Array.from({ length: 150 }, (_, i) => `line ${i} ${i}%`).join("\n");
  const cases = [
    { group: "file", resourceKey: "file:/a.ts", tool: "Read" },
    { group: "diff", resourceKey: "edit:/a.ts", tool: "Edit" },
    { group: "status", resourceKey: "todos", tool: "TodoWrite" },
  ];

  for (const [index, entry] of cases.entries()) {
    const client = stubClient();
    const pipeline = createPipeline({
      env: {
        OPENJEV_API_KEY: "oj_test.unit-key-0000000000000000",
        JEV_PRUNING_HOME: home,
        JEV_PRUNING_MODE: "active",
        JEV_PRUNING_BACKGROUND: "false",
      },
      client,
      logger: () => {},
    });
    const pass = await pipeline.plan(
      [{ id: `c${index}`, role: "tool", tool: entry.tool, text: bulky, position: 0, meta: entry, flags: {} }],
      { scope: "s", mode: "active", writeTime: true, priorDigests: new Map(), taskText: "" },
    );
    assert.equal(pass.decisions[0].action, "keep", `${entry.group} output must survive a confident drop judgement`);
    assert.equal(client.calls, 0, `${entry.group} output must not even be offered to OpenJEV`);
  }
});

await adapterTests(test);

/* ------------------------------------------------------------------------ main */

const failed = results.filter((result) => !result.ok);
process.stdout.write(
  `\n${results.length - failed.length}/${results.length} checks passed` +
    (failed.length ? `, ${failed.length} failed\n` : "\n"),
);

if (failed.length > 0) process.exit(1);
