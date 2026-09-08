/** Public hardening wrapper around the existing local-summary producer. */
import { createAnalysisStatus } from '../status.js';
import {
  classifyCallTargetProof,
  createFunctionSummary,
  summaryIdentityMatches,
} from './contract.js';
import * as core from './local-core.js';

export const LOCAL_SUMMARY_ANALYZER_ID = core.LOCAL_SUMMARY_ANALYZER_ID;
export const LOCAL_SUMMARY_ANALYZER_VERSION = '1.1.1';

function summaryForTarget(options, target) {
  return options?.calleeSummaries?.get?.(String(target))
    ?? (options?.calleeSummaries && typeof options.calleeSummaries === 'object' ? options.calleeSummaries[String(target)] : null)
    ?? options?.summaries?.get?.(String(target))
    ?? options?.summaryProvider?.(String(target))
    ?? null;
}
function needsConservativeCall(callNode, options) {
  const proof = classifyCallTargetProof(callNode.call ?? {});
  if (!proof.exhaustive) return true;
  const target = proof.exactSingletonEntityId;
  if (target == null) return false;
  const candidate = summaryForTarget(options, target);
  if (candidate == null) return false;
  return !summaryIdentityMatches(candidate, {
    functionId:String(target),
    snapshotId:options?.snapshotId ?? candidate?.status?.snapshotId ?? null,
  });
}
function conservativeIr(ir, options) {
  let changed = false;
  const nodes = (ir?.nodes ?? []).map((node) => {
    if (node?.kind !== 'call' || !needsConservativeCall(node, options)) return node;
    changed = true;
    return { ...node, call:{ ...(node.call ?? {}), completeness:'partial' } };
  });
  return changed ? { ...ir, nodes } : ir;
}

export function buildLocalFunctionSummary(ir, cfg, ssa, memorySsa, options = {}) {
  const result = core.buildLocalFunctionSummary(conservativeIr(ir, options), cfg, ssa, memorySsa, options);
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
