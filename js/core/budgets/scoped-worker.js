/** Resource accounting across an existing isolated worker; no new scheduler. */
import { AnalysisWorkStopped, assertScopedAnalysisWork, normalizeQueryLimits } from './scoped-work.js';
import { snapshotContractData, recordFields, exactInteger, exactString, exactEnum, contractFail } from '../identity/structured.js';

export function remainingScopedWorkerLimits(work) {
  assertScopedAnalysisWork(work); work.checkpoint();
  const cost = work.cost(), limits = {};
  for (const key of Object.keys(work.limits)) {
    if (key === 'deadlineMs') limits[key] = Math.max(0, Math.floor(work.limits.deadlineMs - cost.elapsedMs));
    else if (key === 'yieldEvery') limits[key] = work.limits[key];
    else limits[key] = Math.min(work.limits[key], work.remaining(key));
  }
  return normalizeQueryLimits(limits);
}

/** Charge newly executed work before publication, not replayed store cost. */
export function chargeScopedWorkerCost(work, value) {
  assertScopedAnalysisWork(work);
  const cost = snapshotContractData(value, { maxBytes: 16384, maxNodes: 256 });
  recordFields(cost, ['schema', 'limits', 'used', 'elapsedMs'], 'scoped-worker-cost-fields');
  if (cost.schema !== 'scoped-work/v1') contractFail('scoped-worker-cost-schema');
  if (typeof cost.elapsedMs !== 'number' || !Number.isFinite(cost.elapsedMs) || cost.elapsedMs < 0) contractFail('scoped-worker-elapsed-cost');
  const limits = normalizeQueryLimits(cost.limits);
  const resources = Object.keys(limits).filter((key) => !['deadlineMs', 'yieldEvery'].includes(key));
  recordFields(cost.used, resources, 'scoped-worker-resource-fields');
  // Validate every debit before changing any counters. Parent budgets remain
  // the canonical owner and reject counters exceeding the remaining balance.
  for (const used of Object.values(cost.used)) exactInteger(used, 'scoped-worker-resource-used');
  for (const [key, used] of Object.entries(cost.used)) work.charge(key, used);
  work.checkpoint();
}

/** Preserve typed stops across a structured-clone boundary without parsing
 * error strings. This payload contains NO analysis artifact and cannot pass
 * normal publication validation. Ordinary exceptions retain the error route.
 */
export function serializeScopedWorkerStop(error, binding) {
  if (!(error instanceof AnalysisWorkStopped)) return null;
  const input = snapshotContractData(binding, { maxBytes: 8192, maxNodes: 32 });
  recordFields(input, ['kind', 'worldId', 'snapshotId', 'binaryId'], 'scoped-worker-stop-binding-fields');
  for (const key of ['kind', 'worldId', 'snapshotId', 'binaryId']) exactString(input[key], 'scoped-worker-stop-binding');
  const status = exactEnum(error.status, ['budget-exhausted', 'timeout', 'cancelled'], 'scoped-worker-stop-status');
  if (!error.cost) contractFail('scoped-worker-stop-cost-required');
  return { schema: 'scoped-worker-stop/v1', ...input, status, cost: snapshotContractData(error.cost), exact: false };
}

/** Parent cost is charged once, before throwing and before any store publish. */
export function throwIfScopedWorkerStopped(work, value, binding) {
  if (value == null) return;
  assertScopedAnalysisWork(work); work.checkpoint();
  const stop = snapshotContractData(value, { maxBytes: 32768, maxNodes: 512 });
  recordFields(stop, ['schema', 'kind', 'worldId', 'snapshotId', 'binaryId', 'status', 'cost', 'exact'], 'scoped-worker-stop-fields');
  if (stop.schema !== 'scoped-worker-stop/v1' || stop.exact !== false) contractFail('scoped-worker-stop-schema');
  for (const key of ['kind', 'worldId', 'snapshotId', 'binaryId']) {
    exactString(stop[key], 'scoped-worker-stop-binding');
    if (stop[key] !== binding[key]) contractFail('scoped-worker-stop-source-mismatch');
  }
  const status = exactEnum(stop.status, ['budget-exhausted', 'timeout', 'cancelled'], 'scoped-worker-stop-status');
  chargeScopedWorkerCost(work, stop.cost);
  throw new AnalysisWorkStopped(status, `scoped-worker-${status}`, work.cost());
}
