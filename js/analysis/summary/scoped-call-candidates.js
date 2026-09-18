/** Additive, ephemeral candidate links for the EXISTING summary SCC owner.
 * A source-bound literal/selected-entry join is not an exhaustive dispatch
 * proof. Never remove unknown-call fallback, substitute arguments/returns,
 * publish a canonical summary, or specialize context in this adapter.
 */
import { deepFreeze } from '../../core/identity/index.js';
import { assertWorldScope, assertAssumptionSet } from '../../core/identity/world.js';
import { contractFail, exactString, exactInteger } from '../../core/identity/structured.js';
import { assertScopedAnalysisWork } from '../../core/budgets/scoped-work.js';
import { assertCanonicalQueryProjection } from '../query/semantic/projection.js';
import { scopedCallTargetRows } from '../query/semantic/call-targets.js';
import { createFunctionSummary, createIndirectCallSet, summaryIdentityMatches } from './contract.js';

export const SCOPED_SUMMARY_CANDIDATE_VERSION = '1.1.0';
export const SCOPED_SUMMARY_CANDIDATE_LIMITS = Object.freeze({ callSites: 512, candidatesPerCall: 64, bindings: 512 });
export async function bindScopedSummaryCallCandidates(summary, projection, index, { world, assumptions, snapshotId, work, maximumBindings = 512, nativeDemand = null } = {}) {
  exactInteger(maximumBindings, 'scoped-summary-link-budget', { max: SCOPED_SUMMARY_CANDIDATE_LIMITS.bindings });
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
  assertCanonicalQueryProjection(projection, { world, assumptions }); exactString(snapshotId, 'scoped-summary-link-snapshot');
  if (projection.inputIdentity.snapshotId !== snapshotId || !summaryIdentityMatches(summary, { functionId: projection.functionId, snapshotId })) {
    contractFail('scoped-summary-link-owner');
  }
  if (!(index?.functions instanceof Map) || index.functions.size > 32 || index.functions.get(projection.functionId) !== projection) {
    contractFail('scoped-summary-link-index');
  }
  for (const member of index.functions.values()) {
    work.charge('workUnits'); assertCanonicalQueryProjection(member, { world, assumptions });
    if (member.inputIdentity.snapshotId !== snapshotId) contractFail('scoped-summary-link-member-snapshot');
  }
  const sets = summary.indirectCallSets, bindings = [], skipped = [], next = [];
  const gap = entry => { if (skipped.length < SCOPED_SUMMARY_CANDIDATE_LIMITS.bindings) skipped.push(entry); };
  if (sets.length > SCOPED_SUMMARY_CANDIDATE_LIMITS.callSites) return deepFreeze({ summary, bindings, skipped: [{ reason: 'call-site-limit' }], exact: false });
  const unknownSites = new Set(summary.unknownCallEffects.map(row => row.callSiteId)), sites = new Set();
  for (const call of sets) {
    work.charge('workUnits');
    if (sites.has(call.callSiteId)) contractFail('scoped-summary-link-duplicate-site');
    sites.add(call.callSiteId);
    const reference = projection.entityReference('semantic-ir', call.callSiteId), node = reference && projection.source(reference);
    if (!node?.call || call.exhaustive || !unknownSites.has(call.callSiteId)) {
      next.push(call); gap({ callSiteId: call.callSiteId, reason: !node?.call ? 'canonical-call-site-unbound' : call.exhaustive ? 'exhaustive-call-not-modified' : 'unknown-call-fallback-unavailable' });
      await work.yieldIfNeeded(); continue;
    }
    if (call.candidateEntityIds.length > SCOPED_SUMMARY_CANDIDATE_LIMITS.candidatesPerCall) {
      next.push(call); gap({ callSiteId: call.callSiteId, reason: 'canonical-candidate-fanout-limit' });
      await work.yieldIfNeeded(); continue;
    }
    const candidates = new Set(call.candidateEntityIds);
    if (nativeDemand) work.charge('workUnits', Math.min(64, node.call?.targetValueIds?.length ?? 0) * 512);
    for (const row of scopedCallTargetRows(projection, node, index, nativeDemand)) {
      work.charge('workUnits'); await work.yieldIfNeeded();
      if (!row.inSelectedScope || row.reason || !row.targetFunctionId) {
        gap({ callSiteId: call.callSiteId, reason: row.reason ?? 'target-unbound' });
        continue;
      }
      if (candidates.has(row.targetFunctionId)) continue;
      if (candidates.size >= SCOPED_SUMMARY_CANDIDATE_LIMITS.candidatesPerCall || bindings.length >= maximumBindings) {
        gap({ callSiteId: call.callSiteId, reason: 'candidate-link-limit' });
        break;
      }
      work.charge('edges'); work.charge('residentBytes', 4096);
      candidates.add(row.targetFunctionId);
      bindings.push({ callerFunctionId: projection.functionId, callSiteId: call.callSiteId,
        targetFunctionId: row.targetFunctionId, source: row.source, sourceBinding: row.sourceBinding,
        exhaustive: false, exact: false });
      await work.yieldIfNeeded();
    }
    next.push(createIndirectCallSet({ ...call, candidateEntityIds: [...candidates], exhaustive: false }));
    await work.yieldIfNeeded();
  }
  work.checkpoint();
  // The canonical constructor preserves all effects/status and revalidates the
  // nonexhaustive-call/broad-memory invariant. This value stays session-local.
  const linked = bindings.length ? createFunctionSummary({ ...summary, indirectCallSets: next }) : summary;
  return deepFreeze({ summary: linked, bindings, skipped, exact: false,
    context: 'context-insensitive', publication: 'none', targetClosure: 'unknown' });
}
