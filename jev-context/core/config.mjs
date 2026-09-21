import os from "node:os";
import path from "node:path";

/** Bumped whenever the pruning question/policy semantics change: invalidates cached decisions. */
export const POLICY_VERSION = "jev-pruning-policy-1";

export const MODES = ["off", "shadow", "active"];

function toBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const v = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function toPositiveNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Loads configuration from the environment only.
 *
 * The OpenJEV key is read from `OPENJEV_API_KEY` and is never written to disk,
 * logged, or embedded in metrics/cache output. If the key is absent the engine
 * is inert: every call short-circuits to "keep everything" (fail-open).
 */
export function loadConfig(env = process.env) {
  const home = env.JEV_PRUNING_HOME || path.join(os.homedir(), ".jev-prune");

  const mode = String(env.JEV_PRUNING_MODE || "shadow").trim().toLowerCase();

  const config = {
    policyVersion: POLICY_VERSION,

    apiKey: typeof env.OPENJEV_API_KEY === "string" ? env.OPENJEV_API_KEY.trim() : "",
    baseUrl: String(env.OPENJEV_BASE_URL || "https://api.openjev.sh").replace(/\/+$/, ""),
    model: env.OPENJEV_MODEL || "openjev",
    endpointPath: "/v1/systemone",

    enabled: toBool(env.JEV_PRUNING_ENABLED, true),
    mode: MODES.includes(mode) ? mode : "shadow",

    // Only engage once the volatile context is genuinely large.
    thresholdTokens: toPositiveNumber(env.JEV_PRUNING_THRESHOLD_TOKENS, 12000),
    // "near context limit" multiplier over thresholdTokens.
    contextLimitFactor: toPositiveNumber(env.JEV_PRUNING_CONTEXT_LIMIT_FACTOR, 3),

    timeoutMs: toPositiveNumber(env.JEV_PRUNING_TIMEOUT_MS, 4000),
    maxStateTokens: toPositiveNumber(env.JEV_PRUNING_MAX_STATE_TOKENS, 24000),
    minConfidence: toPositiveNumber(env.JEV_PRUNING_MIN_CONFIDENCE, 0.72),
    dropProbability: toPositiveNumber(env.JEV_PRUNING_DROP_PROBABILITY, 0.9),
    maxQuestionsPerCall: toPositiveNumber(env.JEV_PRUNING_MAX_QUESTIONS_PER_CALL, 24),
    keepRecentItems: toPositiveNumber(env.JEV_PRUNING_KEEP_RECENT_ITEMS, 6),

    background: toBool(env.JEV_PRUNING_BACKGROUND, true),
    redactFailClosed: toBool(env.JEV_PRUNING_REDACT_FAIL_CLOSED, true),
    // The current task statement is what makes a relevance judgement possible
    // at all, so it is sent by default — redacted, and only as much of it as the
    // state budget allows. Set JEV_PRUNING_SEND_TASK=false to withhold it
    // entirely, at the cost of less accurate decisions.
    sendTask: toBool(env.JEV_PRUNING_SEND_TASK, true),

    // A dropped tool result is never destroyed. Hosts whose extension point can
    // rewrite a live tool result (Agy `overwrite_result`, and the proxy) stash
    // the verbatim original under the state directory and leave a bounded marker
    // in its place, so the decision stays reversible by the agent itself.
    elisionStash: toBool(env.JEV_PRUNING_ELISION_STASH, true),
    elisionExcerptChars: toPositiveNumber(env.JEV_PRUNING_ELISION_EXCERPT_CHARS, 160),

    // Write-time hosts (Agy's `overwrite_result`) must decide during the tool
    // call, so a careless configuration would pay one blocking round trip per
    // tool result. Below this size there is nothing worth a round trip: the
    // item is still classified by rules — so free duplicate drops still happen —
    // but `ask` verdicts resolve to keep without a network call.
    writeTimeMinTokens: toPositiveNumber(env.JEV_PRUNING_WRITE_TIME_MIN_TOKENS, 200),

    cachePath: env.JEV_PRUNING_CACHE_PATH || path.join(home, "decision-cache.json"),
    elisionPath: env.JEV_PRUNING_ELISION_PATH || path.join(home, "elided"),
    statePath: env.JEV_PRUNING_STATE_PATH || path.join(home, "state.json"),
    metricsPath: env.JEV_PRUNING_METRICS_PATH || path.join(home, "metrics.json"),
    logPath: env.JEV_PRUNING_LOG_PATH || path.join(home, "jev-prune.log"),
    home,
  };

  // `usable` is the single gate every entry point checks before doing anything.
  config.usable = config.enabled && config.mode !== "off" && config.apiKey.length > 0;
  config.partialPruning = config.apiKey.length > 0;

  return config;
}

/** Safe, key-free view of the configuration for logs, CLI status and diagnostics. */
export function describeConfig(config) {
  return {
    enabled: config.enabled,
    mode: config.mode,
    provider: "OpenJEV",
    endpoint: `${config.baseUrl}${config.endpointPath}`,
    model: config.model,
    policyVersion: config.policyVersion,
    thresholdTokens: config.thresholdTokens,
    timeoutMs: config.timeoutMs,
    maxStateTokens: config.maxStateTokens,
    minConfidence: config.minConfidence,
    dropProbability: config.dropProbability,
    maxQuestionsPerCall: config.maxQuestionsPerCall,
    keepRecentItems: config.keepRecentItems,
    background: config.background,
    redactFailClosed: config.redactFailClosed,
    sendTask: config.sendTask,
    elisionStash: config.elisionStash,
    elisionExcerptChars: config.elisionExcerptChars,
    writeTimeMinTokens: config.writeTimeMinTokens,
    apiKeyPresent: config.apiKey.length > 0,
  };
}
