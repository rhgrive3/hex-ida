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
  let totals = { ...ZERO(), startedAt: new Date().toISOString() };

  function record(patch = {}) {
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        totals[key] = (totals[key] || 0) + value;
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
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot(), null, 2), { mode: 0o600 });
      fs.renameSync(tmp, filePath);
      return { saved: true };
    } catch {
      return { saved: false };
    }
  }

  function reset() {
    totals = { ...ZERO(), startedAt: new Date().toISOString() };
    return totals;
  }

  function load() {
    if (!filePath) return snapshot();
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object") totals = { ...ZERO(), ...parsed };
    } catch {
      /* missing or corrupt metrics are simply replaced by a fresh set */
    }
    return snapshot();
  }

  return { record, recordPass, snapshot, save, reset, load };
}
