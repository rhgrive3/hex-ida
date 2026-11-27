import fs from "node:fs";
import path from "node:path";

/**
 * Metrics — counts and token deltas only.
 *
 * The rule is absolute: no metrics field ever contains conversation content, a
 * tool result, or any part of the API key. `snapshot()` is safe to print, log,
 * persist and paste into an issue.
 */

const ZERO = () => ({
  contextTokensBefore: 0,
  contextTokensAfter: 0,
  tokensRemoved: 0,
  toolResultsEvaluated: 0,
  itemsKept: 0,
  itemsDropped: 0,
  itemsWouldDrop: 0,
  cacheHits: 0,
  cacheMisses: 0,
  openjevCalls: 0,
  openjevInputTokens: 0,
  openjevOutputTokens: 0,
  openjevLatencyTotalMs: 0,
  openjevLatencySamples: 0,
  timeoutCount: 0,
  apiFailureCount: 0,
  fallbackCount: 0,
  modelCallsAffected: 0,
  estimatedMainTokensAvoided: 0,
  shadowEvaluations: 0,
  redactionCount: 0,
  skippedUnsafeItems: 0,
});

export function createMetrics(options = {}) {
  const filePath = options.path;
  const COUNTER_KEYS = Object.keys(ZERO());
  let totals = { ...ZERO(), startedAt: new Date().toISOString() };
  let delta = ZERO();
  let loaded = false;
  let resetPending = false;

  function readFromDisk() {
    if (!filePath) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object") {
        const base = { ...ZERO(), startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : new Date().toISOString() };
        for (const key of COUNTER_KEYS) {
          if (typeof parsed[key] === "number" && Number.isFinite(parsed[key])) {
            base[key] = parsed[key];
          }
        }
        return base;
      }
    } catch {
      /* missing or corrupt metrics are simply replaced by a fresh set */
    }
    return null;
  }

  function ensureLoaded() {
    if (loaded || resetPending || !filePath) return;
    loaded = true;
    const disk = readFromDisk();
    if (disk) totals = disk;
  }

  function record(patch = {}) {
    ensureLoaded();
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        totals[key] = (totals[key] || 0) + value;
        if (key in delta) delta[key] = (delta[key] || 0) + value;
      }
    }
    return totals;
  }

  /** One finished pruning pass. */
  function recordPass(pass) {
    return record({
      contextTokensBefore: pass.tokensBefore,
      contextTokensAfter: pass.tokensAfter,
      tokensRemoved: Math.max(0, pass.tokensBefore - pass.tokensAfter),
      toolResultsEvaluated: pass.evaluated,
      itemsKept: pass.kept,
      itemsDropped: pass.dropped,
      itemsWouldDrop: pass.wouldDrop,
      cacheHits: pass.cacheHits,
      cacheMisses: pass.cacheMisses,
      openjevCalls: pass.openjevCalls,
      openjevInputTokens: pass.openjevInputTokens,
      openjevOutputTokens: pass.openjevOutputTokens,
      openjevLatencyTotalMs: pass.openjevLatencyTotalMs,
      openjevLatencySamples: pass.openjevLatencySamples,
      timeoutCount: pass.timeouts,
      apiFailureCount: pass.apiFailures,
      fallbackCount: pass.fallbacks,
      modelCallsAffected: pass.modelCallsAffected,
      // The headline number: main-model input tokens that were never sent
      // because this pass omitted them. Only ever set for an applied pass, so a
      // shadow pass cannot inflate it.
      estimatedMainTokensAvoided: pass.estimatedMainTokensAvoided || 0,
      redactionCount: pass.redactions,
      skippedUnsafeItems: pass.skippedUnsafe,
      shadowEvaluations: pass.shadow ? 1 : 0,
    });
  }

  function snapshot() {
    ensureLoaded();
    const averageLatencyMs =
      totals.openjevLatencySamples > 0 ? totals.openjevLatencyTotalMs / totals.openjevLatencySamples : 0;
    const removalRatio =
      totals.contextTokensBefore > 0 ? totals.tokensRemoved / totals.contextTokensBefore : 0;
    return {
      ...totals,
      averageOpenjevLatencyMs: Math.round(averageLatencyMs),
      removalRatio: Number(removalRatio.toFixed(4)),
      removalPercent: Number((removalRatio * 100).toFixed(2)),
      cacheHitRate:
        totals.cacheHits + totals.cacheMisses > 0
          ? Number((totals.cacheHits / (totals.cacheHits + totals.cacheMisses)).toFixed(4))
          : 0,
      estimatedMainTokensAvoided: totals.estimatedMainTokensAvoided,
    };
  }

  function save() {
    if (!filePath) return { saved: false };
    try {
      if (!resetPending) {
        const disk = readFromDisk();
        if (disk) {
          for (const key of COUNTER_KEYS) {
            disk[key] = (disk[key] || 0) + (delta[key] || 0);
          }
          totals = disk;
        }
      }
      loaded = true;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot(), null, 2), { mode: 0o600 });
      fs.renameSync(tmp, filePath);
      delta = ZERO();
      resetPending = false;
      return { saved: true };
    } catch {
      return { saved: false };
    }
  }

  function reset() {
    totals = { ...ZERO(), startedAt: new Date().toISOString() };
    delta = ZERO();
    loaded = true;
    resetPending = true;
    return totals;
  }

  function load() {
    loaded = true;
    resetPending = false;
    delta = ZERO();
    if (!filePath) return snapshot();
    const disk = readFromDisk();
    if (disk) totals = disk;
    return snapshot();
  }

  return { record, recordPass, snapshot, save, reset, load };
}
