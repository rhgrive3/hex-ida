#!/usr/bin/env node
import path from "node:path";
import { loadConfig } from "../../core/config.mjs";
import { estimateTokens } from "../../core/tokens.mjs";
import { createPipeline } from "../../core/pipeline.mjs";
import { elideItem } from "../../core/elision.mjs";
import { spawnPrewarm, createHookLogger, contentDigest } from "../hooks/handler.mjs";
import { createSessionStore, deriveMetaFromHook, hookToolOutput, readHookInput, writeHookOutput } from "../hooks/protocol.mjs";

/**
 * Agy adapter (Agy 1.2.7), wired to Agy's own `overwrite_result` contract.
 *
 * Where the extension point is
 * ---------------------------
 * Agy resolves Claude-compatible lifecycle hooks from a `hooks.json` file. The
 * events its 1.2.7 binary actually recognises are SessionStart, SessionEnd,
 * PreToolUse and PostToolUse (`UserPromptSubmit`, `PreCompact`, `BeforeModel`
 * and `AfterModel` do not exist in it). So there is no event that receives the
 * assembled message array, and no way to revise an older item on a later call.
 *
 * What makes Agy genuinely capable rather than observe-only is the *output*
 * schema of PostToolUse. The binary embeds the JSON schema of its hook result:
 *
 *   OverwriteResult *string `json:"overwrite_result,omitempty"`
 *     "Optional. Replaces the result of the tool call that just ran with this
 *      string. The model is told that the result was replaced. Omit to leave
 *      the result untouched."
 *
 * That is a supported rewrite of the content the model is about to see, applied
 * before the model sees it. So on Agy a drop is applied here, at write time.
 *
 * Modes
 * -----
 *   off     nothing is sent anywhere; the hook answers `{}`.
 *   shadow  nothing is applied and nothing blocks: the result is classified by
 *           a detached process, the shared decision cache is warmed, and
 *           `jev-prune stats` reports what active mode would have removed.
 *   active  the result is judged on the spot with a bounded timeout and, only
 *           if every invariant passes and OpenJEV is confident, replaced by a
 *           short marker. The verbatim original is stashed locally first, so
 *           the model can always recover it.
 *
 * Fail-open
 * ---------
 * Every path returns a valid JSON object or `{}`. A missing key, a timeout, a
 * 401/422/503, a malformed answer, a corrupt state file, or an unwritable stash
 * all resolve to "leave the result untouched". Agy always keeps working.
 */

const HOST = "agy";

function toolNameOf(payload) {
  return String(payload.tool_name || payload.toolName || payload.tool || "unknown");
}

function sessionIdOf(payload) {
  return String(payload.session_id || payload.sessionId || "default");
}

async function handlePostToolUse(payload, context) {
  const output = hookToolOutput(payload);
  if (!output) return { response: {} };

  const { config, store, log } = context;
  const sessionId = sessionIdOf(payload);
  const scope = `${HOST}:${sessionId}`;
  const toolName = toolNameOf(payload);
  const meta = deriveMetaFromHook(toolName, payload.tool_input || payload.toolInput);

  // Record before deciding: this record is what makes a repeat recognisable, and
  // it must survive a decision that throws. The digest is the engine's own, so a
  // remembered entry and the item the pipeline hashes are the same value.
  const remembered = store.remember(sessionId, {
    tool: toolName,
    group: meta.group,
    resourceKey: meta.resourceKey,
    chars: output.length,
    digest: contentDigest(output, toolName, scope, config.policyVersion),
  });
  const priorDigests = new Map();
  for (const entry of remembered.slice(0, -1)) {
    if (entry && entry.digest) priorDigests.set(entry.digest, (priorDigests.get(entry.digest) || 0) + 1);
  }

  if (!config.enabled || config.mode === "off") return { response: {} };

  const item = {
    id: `${HOST}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    role: "tool",
    tool: toolName,
    text: output,
    position: 0,
    meta,
    flags: {},
  };

  if (!config.usable) return { response: {}, note: "inert: no OpenJEV key" };

  // Shadow mode must add no latency at all, so it never calls OpenJEV inline:
  // the detached worker classifies the same item with the same rules and warms
  // the cache for the moment active mode is switched on.
  if (config.mode !== "active") {
    spawnPrewarm({
      scope,
      writeTime: true,
      mode: config.mode,
      priorDigests: [...priorDigests.entries()],
      taskText: context.taskText,
      items: [item],
    });
    return { response: {}, note: "shadow-deferred" };
  }

  // Only a result big enough to be worth a round trip may block. Smaller ones
  // are still classified by rules (so a free duplicate drop still happens), but
  // their ambiguous verdicts resolve to keep without any network call.
  const worthBlocking = estimateTokens(output) >= config.writeTimeMinTokens;

  const pass = await context.pipeline.plan([item], {
    scope,
    mode: "active",
    // The single blocking call on the critical path. `timeoutMs` bounds it, and
    // Agy bounds the hook itself, so the worst case is a late no-op.
    writeTime: true,
    priorDigests,
    allowBlockingRequests: worthBlocking,
    taskText: context.taskText,
  });

  const decision = pass.decisions[0];
  if (!decision || decision.action !== "drop") {
    const why = [decision ? decision.reason : "no-decision"];
    if (pass.stats.failures.length > 0) why.push(`failures=${pass.stats.failures.join("+")}`);
    if (pass.stats.engaged === false) why.push(`staging=${pass.stats.reason}`);
    if (!worthBlocking) why.push(`below write-time budget (${config.writeTimeMinTokens} tokens)`);
    return { response: {}, note: `keep:${why.join(" | ")}` };
  }

  // Use the pipeline's own item: it carries the computed token count and the
  // decision digest, so the marker and the metrics report real numbers.
  const planned = pass.items[0] || item;

  // Never lose content: if the original cannot be stashed, refuse the elision.
  const elision = elideItem(planned, { config, scope });
  if (!elision.ok) {
    log("elision-refused", { reason: elision.reason });
    // The item stays in context, so nothing was removed. Only the decision cost
    // is real, and it is still worth counting.
    context.metrics.record({ toolResultsEvaluated: pass.stats.evaluated });
    context.metrics.save();
    return { response: {}, note: `keep:${elision.reason}` };
  }

  // The pipeline's own pass statistics, which already carry the OpenJEV call
  // count, the tokens it cost us, the tokens we avoided, and the failure
  // counters. Recording them here is what makes `jev-prune status` tell the
  // truth about the write-time path.
  context.metrics.recordPass(pass.stats);
  context.metrics.save();
  log("dropped", { tool: toolName, group: meta.group, tokens: planned.tokens, reason: decision.reason });

  // The documented Agy contract: replace the result the model is about to see.
  return { response: { overwrite_result: elision.marker }, note: `drop:${decision.reason}` };
}

async function handle(payload, context) {
  const event = String(payload.hook_event_name || payload.event || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");

  if (event === "posttooluse" || event === "aftertool") return handlePostToolUse(payload, context);
  // PreToolUse can deny or rewrite a tool call. Neither helps: no Agy hook sees
  // the assembled request, and blocking a tool costs more correctness than the
  // tokens it would save.
  return { response: {} };
}

async function main() {
  let payload = {};
  try {
    payload = await readHookInput();
  } catch {
    payload = {};
  }

  let response = {};
  try {
    const config = loadConfig(process.env);
    const pipeline = createPipeline({ config });
    const context = {
      config,
      pipeline,
      metrics: pipeline.metrics,
      store: createSessionStore({ path: path.join(config.home, "agy-sessions.json") }),
      log: createHookLogger(config),
      taskText: String(config.sendTask ? payload.prompt || payload.user_prompt || "" : ""),
    };
    const outcome = await handle(payload, context);
    response = outcome.response || {};
    // Operator diagnostics. Reasons only — never tool content, never a key —
    // and only when explicitly asked for, because a hook's stderr is noise to
    // the host.
    if (process.env.JEV_PRUNING_DEBUG === "1" && outcome.note) {
      process.stderr.write(`[jev-prune] ${outcome.note}\n`);
    }
  } catch (error) {
    // Fail-open, unconditionally: a broken adapter must never break Agy.
    response = {};
  }

  writeHookOutput(response);
  process.exit(0);
}

main();
