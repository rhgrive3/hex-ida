/** Query surface for canonical taint analysis records. */

import { stableDigest } from '../../core/identity/index.js';
import { hasUnknownTaint, TAINT_STATUS, TAINT_VERSION, taintDigest, unknownTaint } from '../taint/lattice.js';

function keyOf(value) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object') return value.id != null ? String(value.id) : value.symbolId != null ? String(value.symbolId) : null;
  return null;
}

function lookup(analysis, key) {
  const id = keyOf(key);
  if (id == null) return null;
  if (analysis?.store && typeof analysis.store.getValue === 'function') {
    const value = analysis.store.getValue(key) || analysis.store.getValue(id) || analysis.store.values?.get(`id:${id}`) || null;
    if (value) return value;
  }
  if (analysis?.taints instanceof Map) return analysis.taints.get(id) ?? null;
  if (analysis?.taints && typeof analysis.taints === 'object') return analysis.taints[id] ?? analysis.taints[`id:${id}`] ?? null;
  return null;
}

export function queryTaint(analysis, value, options = {}) {
  if (!analysis || typeof analysis !== 'object' || analysis.version !== TAINT_VERSION) {
    const unknown = unknownTaint('taint-analysis-missing', { valueId: keyOf(value) });
    return Object.freeze({ status: 'unknown', exact: false, value: unknown, reason: 'taint-analysis-missing' });
  }
  if (analysis.status !== TAINT_STATUS.COMPLETE || analysis.complete !== true
      || analysis.memoryUnknown === true || analysis.unknownAlias === true || analysis.incompleteAlias === true
      || analysis.stats?.status && analysis.stats.status !== TAINT_STATUS.COMPLETE) {
    const reason = analysis.memoryUnknown === true || analysis.unknownAlias === true || analysis.incompleteAlias === true
      ? 'taint-memory-alias-incomplete'
      : analysis.status === TAINT_STATUS.COMPLETE ? 'taint-analysis-incomplete' : `taint-${analysis.status || 'unknown'}`;
    const unknown = unknownTaint(reason, { valueId: keyOf(value) });
    return Object.freeze({ status: analysis.status || 'unknown', exact: false, value: unknown, reason });
  }
  const taint = lookup(analysis, value);
  if (!taint) {
    const unknown = unknownTaint('taint-value-not-recorded', { valueId: keyOf(value) });
    return Object.freeze({ status: 'unknown', exact: false, value: unknown, reason: 'taint-value-not-recorded' });
  }
  return Object.freeze({ status: hasUnknownTaint(taint) ? 'unknown' : 'exact', exact: !hasUnknownTaint(taint), value: taint, reason: hasUnknownTaint(taint) ? taint.reasons?.[0] || 'taint-unknown' : null, provenance: options.includeProvenance === false ? null : taint.provenance });
}

export const queryTaintAt = queryTaint;

export function explainTaint(analysis, value) {
  const queried = queryTaint(analysis, value);
  return Object.freeze({
    ...queried,
    valueId: keyOf(value),
    digest: taintDigest(queried.value),
    analysisDigest: analysis ? stableDigest({ status: analysis.status, stats: analysis.stats ?? null }) : null,
  });
}
