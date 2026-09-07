/** Stable, read-only taint projection for query/evidence consumers. */

import { stableDigest } from '../../core/identity/index.js';
import { taintDigest } from '../taint/lattice.js';

function valuesOf(analysis) {
  if (analysis?.taints instanceof Map) return [...analysis.taints.entries()];
  if (analysis?.taints && typeof analysis.taints === 'object') return Object.entries(analysis.taints);
  if (analysis?.store?.values instanceof Map) return [...analysis.store.values.entries()];
  return [];
}

export function projectTaint(analysis, options = {}) {
  const records = valuesOf(analysis).map(([valueId, taint]) => Object.freeze({
    valueId: String(valueId),
    taint,
    taintDigest: taintDigest(taint),
  })).sort((left, right) => left.valueId.localeCompare(right.valueId));
  const sinks = Array.isArray(analysis?.sinks) ? analysis.sinks : [];
  const status = analysis?.status ?? 'unknown';
  const complete = analysis?.complete === true && status === 'complete'
    && analysis?.memoryUnknown !== true && analysis?.unknownAlias !== true && analysis?.incompleteAlias !== true;
  const reason = complete ? null
    : analysis?.memoryUnknown === true || analysis?.unknownAlias === true || analysis?.incompleteAlias === true
      ? 'taint-memory-alias-incomplete'
      : status === 'complete' ? 'taint-analysis-incomplete' : `taint-${status}`;
  return Object.freeze({
    version: 'symbolic-taint-proof-v1',
    status,
    complete,
    exact: complete,
    reason,
    records: Object.freeze(records),
    sinks: Object.freeze(sinks.slice()),
    digest: stableDigest({ version: 'symbolic-taint-proof-v1', status, complete, reason, records: records.map((record) => ({ valueId: record.valueId, taintDigest: record.taintDigest })), sinks }),
    provenance: options.includeProvenance === false ? null : (analysis?.flowEdges ?? null),
  });
}

export const projectTaintRecords = projectTaint;
