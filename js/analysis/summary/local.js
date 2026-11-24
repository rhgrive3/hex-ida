/** Public hardening wrapper around the existing local-summary producer. */
import { createAnalysisStatus } from '../status.js';
import {
  createSemanticCallTargetClassifier,
  RETURN_SUMMARY_CANDIDATE_LIMIT,
  createFunctionSummary,
  summaryIdentityMatches,
} from './contract.js';
import * as core from './local-core.js';

export const LOCAL_SUMMARY_ANALYZER_ID = core.LOCAL_SUMMARY_ANALYZER_ID;
export const LOCAL_SUMMARY_ANALYZER_VERSION = core.LOCAL_SUMMARY_ANALYZER_VERSION;

function summaryForTarget(options, target) {
  return options?.calleeSummaries?.get?.(String(target))
    ?? (options?.calleeSummaries && typeof options.calleeSummaries === 'object' ? options.calleeSummaries[String(target)] : null)
    ?? options?.summaries?.get?.(String(target))
    ?? options?.summaryProvider?.(String(target))
    ?? null;
}
function needsConservativeCall(callNode, options, classifyTarget) {
  const proof = classifyTarget(callNode);
  if (!proof.exhaustive || proof.candidateEntityIds.length > RETURN_SUMMARY_CANDIDATE_LIMIT) return true;
  return proof.candidateEntityIds.some(target => {
    const candidate = summaryForTarget(options, target);
    if (candidate == null) return false;
    return !summaryIdentityMatches(candidate, {
      functionId:target,
      snapshotId:options?.snapshotId ?? candidate?.status?.snapshotId ?? null,
    });
  });
}
function conservativeCallSiteIds(ir, memorySsa, options) {
  const classifyTarget = createSemanticCallTargetClassifier(ir, memorySsa, {
    ...options, summaryForTarget:target => summaryForTarget(options, target),
  });
  const degraded = new Set();
  for (const node of ir?.nodes ?? []) {
    if (node?.kind !== 'call' || node.call?.completeness !== 'complete'
      || !needsConservativeCall(node, options, classifyTarget)) continue;
    degraded.add(node.id);
  }
  return degraded.size ? degraded : null;
}

export function buildLocalFunctionSummary(ir, cfg, ssa, memorySsa, options = {}) {
  const degraded = conservativeCallSiteIds(ir, memorySsa, options);
  const coreOptions = degraded ? { ...options, conservativeCallSiteIds: degraded } : options;
  const result = core.buildLocalFunctionSummary(ir, cfg, ssa, memorySsa, coreOptions);
  if (!result?.summary) return result;
  const oldStatus = result.status ?? result.summary.status;
  const status = createAnalysisStatus({
    ...oldStatus,
    analyzerId:LOCAL_SUMMARY_ANALYZER_ID,
    analyzerVersion:LOCAL_SUMMARY_ANALYZER_VERSION,
  });
  const summary = createFunctionSummary({ ...result.summary, status });
  return { ...result, summary, status };
}
