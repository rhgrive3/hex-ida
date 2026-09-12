/**
 * First-party adapter over EXISTING job/session stores. No load(), storesFor(),
 * persistence write, model turn, tool execution or new canonical agent DB.
 * Only an already loaded, idle job and its captured namespace may be borrowed.
 */
import { EvidenceStore } from '../evidence.js';
import { HypothesisStore } from '../hypothesis.js';
import { deepFreeze, stableDigest, lossyTypeWitness } from '../../core/identity/index.js';
import { snapshotContractData, exactString, stringSet, contractFail } from '../../core/identity/structured.js';
import { assertWorldScope, assertAssumptionSet } from '../../core/identity/world.js';

export const SCOPED_JOB_CONTEXT_VERSION = '1.0.0';
const digest = (value) => stableDigest({ value, typed: lossyTypeWitness(value) });

function jobInspection(job) {
  if (!job || typeof job !== 'object') return null;
  // Check lengths BEFORE snapshotting: never traverse lastResult, messages,
  // arbitrary provider state or a whole persisted investigation transcript.
  if (typeof job.goal !== 'string' || job.goal.length > 8192
    || !Array.isArray(job.hypothesisIds) || job.hypothesisIds.length > 128
    || !Array.isArray(job.evidenceIds) || job.evidenceIds.length > 1024
    || !Array.isArray(job.unresolvedWork) || job.unresolvedWork.length > 32
    || !Array.isArray(job.completedTools) || job.completedTools.length > 256) contractFail('investigation-job-inspection-budget');
  return snapshotContractData({ id: exactString(job.id, 'investigation-job-id'),
    executionScopeId: exactString(job.executionScopeId, 'investigation-job-execution-scope'),
    sessionId: exactString(job.sessionId, 'investigation-job-session'), goal: job.goal,
    status: exactString(job.status, 'investigation-job-status'), effectiveScope: job.effectiveScope,
    hypothesisIds: stringSet(job.hypothesisIds, 'investigation-job-hypotheses', 128),
    evidenceIds: stringSet(job.evidenceIds, 'investigation-job-evidence', 1024),
    unresolvedWork: job.unresolvedWork, completedTools: stringSet(job.completedTools, 'investigation-job-tools', 256),
    budgetUsage: job.budgetUsage, limits: job.limits, updatedAt: job.updatedAt },
  { maxBytes: 262144, maxNodes: 8192, maxStringLength: 8192 });
}

/**
 * Configure as getInvestigationContext on configureScopedAnalysisHost.
 * getObligations is OPTIONAL, and must itself return a current bound owner
 * record { data, isCurrent }. Its absence never means the goal is complete.
 */
export function createScopedJobContextProvider(runtime, { binaryId, getObligations = null } = {}) {
  exactString(binaryId, 'investigation-provider-binary');
  if (!runtime?.jobs?.jobs || !(runtime.storeNamespaces instanceof Map)
    || !(runtime.storeNamespaceOwners instanceof Map)
    || getObligations !== null && typeof getObligations !== 'function') contractFail('investigation-runtime-owner-required');
  return async (jobId, { world, assumptions, snapshotId, signal, work } = {}) => {
    assertWorldScope(world); assertAssumptionSet(assumptions, world);
    exactString(jobId, 'investigation-request-job'); exactString(snapshotId, 'investigation-request-snapshot');
    if (!world.binarySet.some((member) => member.binaryId === binaryId)) contractFail('investigation-provider-foreign-binary');
    const manager = runtime.jobs, job = manager.jobs.get(jobId);
    if (!job || !job.sessionId) return null;
    const idle = () => manager.jobs.get(jobId) === job && job.status !== 'running'
      && !manager.runningJobIds.has(jobId) && !manager.loadingPromises.has(jobId)
      && !manager.pendingCheckpoints.has(jobId) && job.executionRecoveryPending !== true;
    if (!idle()) contractFail('investigation-job-not-idle');
    const view = jobInspection(job), capturedDigest = digest(view);
    const key = `${binaryId}::${view.sessionId}`;
    const stores = runtime.storeNamespaces.get(key);
    if (!stores || runtime.storeNamespaceOwners.get(key) !== view.sessionId) return null;
    if (!(stores.evidenceStore instanceof EvidenceStore) || !(stores.hypothesisStore instanceof HypothesisStore)
      || stores.hypothesisStore.evidenceStore !== stores.evidenceStore) contractFail('investigation-native-stores-required');
    let owner = null;
    const current = () => {
      if (!idle() || runtime.storeNamespaces.get(key) !== stores || runtime.storeNamespaceOwners.get(key) !== view.sessionId) return false;
      try { return capturedDigest === digest(jobInspection(job)) && (!owner || owner.isCurrent() === true); }
      catch { return false; }
    };
    if (getObligations) {
      owner = await work.await((providerSignal) => getObligations(view, {
        binaryId, world, assumptions, snapshotId, signal: providerSignal, work,
      }));
      if (owner && typeof owner.isCurrent !== 'function') contractFail('investigation-obligation-current-owner-required');
    }
    if (signal?.aborted) throw signal.reason;
    if (!current()) contractFail('investigation-job-changed-during-capture');
    return Object.freeze({
      binding: deepFreeze({ schema: 'scoped-job-inspection-binding/v1', worldId: world.id,
        assumptionsId: assumptions.id, snapshotId, binaryId, jobId, sessionId: view.sessionId,
        executionScopeId: view.executionScopeId, jobDigest: capturedDigest, version: SCOPED_JOB_CONTEXT_VERSION }),
      job: view, evidenceStore: stores.evidenceStore, hypothesisStore: stores.hypothesisStore,
      obligationOwner: owner, isCurrent: current,
    });
  };
}
