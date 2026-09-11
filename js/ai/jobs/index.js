const CHECKPOINT_VERSION = 1;
const MAX_JOB_SLICES = 32;
const MAX_JOB_ELAPSED_MS = 4 * 60 * 60 * 1000;
let fallbackRandomSequence = 0n;
const activeExecutionLeases = new Map();
// A final-status write can fail after the provider turn has completed, and a
// fallback marker write can fail for the same transient reason. Keep a
// process-local hand-off keyed by the lease that ran the turn so a fresh
// manager in this process can recover the completed outcome without replaying
// provider/tool side effects. A true process crash has no entry here and still
// follows the interrupted-slice recovery path.
const completedExecutionOutcomes = new Map();
// Persistence adapters are often thin wrappers created per manager. Object
// identity therefore cannot identify a durable execution scope: two wrappers
// over one store could otherwise acquire independent leases. Use the job ID as
// the conservative process-local fallback so a job is single-flight even when
// its adapters differ. A lease is removed on every normal exit, so unrelated
// job IDs still run concurrently and the map does not retain completed jobs.
const activeLeaseScopes = new Map();

export class AgentJobManager {
  constructor({ runtime, persistence = null, maxSlices = 8, maxElapsedMs = 30 * 60 * 1000 } = {}) {
    if (!runtime || typeof runtime.turn !== 'function') throw new TypeError('AgentJobManager requires an AIRuntime');
    this.runtime = runtime; this.persistence = persistence; this.maxSlices = bounded(maxSlices, 1, MAX_JOB_SLICES); this.maxElapsedMs = bounded(maxElapsedMs, 1000, MAX_JOB_ELAPSED_MS);
    this.pendingCheckpoints = new Map();
    this.jobs = new Map(); this.creatingIds = new Set(); this.runningJobIds = new Set(); this.loadingPromises = new Map();
  }

  async create(input = {}) {
    const now = new Date().toISOString();
    const goal = String(input.goal || '');
    if (!goal) throw new TypeError('Agent job goal is required');
    const explicitId = input.jobId == null || input.jobId === '' ? null : requireIdentityString(input.jobId, 'Agent job id');
    let id = explicitId || autoJobId();
    while (true) {
      if (this.creatingIds.has(id)) {
        if (explicitId) throw new Error(`Agent job id already exists: ${id}`);
        id = autoJobId();
        continue;
      }
      this.creatingIds.add(id);
      let existing;
      try {
        existing = await this.get(id);
      } catch (error) {
        this.creatingIds.delete(id);
        throw error;
      }
      if (!existing) break;
      this.creatingIds.delete(id);
      if (explicitId) throw new Error(`Agent job id already exists: ${id}`);
      id = autoJobId();
    }
    try {
      const job = {
        version: CHECKPOINT_VERSION, id,
        // Persist a stable scope so managers that wrap the same durable store
        // share one process-local lease while independent stores remain
        // isolated. Legacy checkpoints without this field conservatively use
        // the job ID as their fallback scope.
        executionScopeId: `agent_job_scope_${randomId()}`,
        status: 'ready', goal, effectiveScope: input.scope || 'auto',
        conversationId: input.conversationId == null ? null : String(input.conversationId), sessionId: input.sessionId || null,
        provider: input.provider || null, model: input.model || null, reasoning: input.reasoning || null,
        evidenceIds: [], hypothesisIds: [], completedTools: [], continuationRefs: [], unresolvedWork: [],
        budgetUsage: { slices: 0, modelCalls: 0, toolCalls: 0, elapsedMs: 0, contextBytes: 0 },
        limits: { maxSlices: bounded(input.maxSlices ?? this.maxSlices, 1, MAX_JOB_SLICES), maxElapsedMs: bounded(input.maxElapsedMs ?? this.maxElapsedMs, 1000, MAX_JOB_ELAPSED_MS) },
        request: safeRequest(input), lastResult: null, createdAt: now, updatedAt: now,
      };
      // Keep the ID reserved, but do not publish a runnable job until its
      // initial checkpoint is durable. Failed saves leave no in-memory ghost.
      await this.save(job);
      this.jobs.set(job.id, job);
      return checkpoint(job);
    } finally {
      this.creatingIds.delete(id);
    }
  }

  async runSlice(jobOrId, options = {}) {
    const job = await this.require(jobOrId);
    const id = job.id;
    if (this.runningJobIds.has(id)) throw new Error('Agent job already has an active slice');
    this.runningJobIds.add(id);
    let executionLeaseId = null;
    try {
      // A completed execution marker is a durable hand-off from a failed
      // final-status write. Persist the recovered final status once, then
      // return it without replaying provider/tool side effects. A later
      // explicit resume may continue a checkpointed job normally.
      if (job.executionRecoveryPending === true) {
        delete job.executionRecoveryPending;
        try {
          await this.save(job);
        } catch (error) {
          job.executionRecoveryPending = true;
          throw error;
        }
        forgetCompletedExecutionOutcome(id);
        return checkpoint(job);
      }
      // A successful slice is never replayed to recover a failed checkpoint
      // write (#6273). The first resume retries the exact saved result only,
      // including when the execution status is checkpointed rather than done.
      if (this.pendingCheckpoints.has(id)) {
        await this.persistPendingCheckpoint(job);
        return checkpoint(job);
      }
      if (options.checkpointOnly === true) return checkpoint(job);
      if (job.status === 'complete' || job.status === 'hard-limit') return checkpoint(job);
      if (job.status === 'running') throw new Error('Agent job already has an active slice');
      if (hardLimit(job)) {
        const prevStatus = job.status;
        job.status = 'hard-limit';
        job.updatedAt = new Date().toISOString();
        try {
          await this.save(job);
        } catch (saveError) {
          job.status = prevStatus;
          throw saveError;
        }
        return checkpoint(job);
      }
      executionLeaseId = beginExecutionLease(this.runtime, this.persistence, id, job.executionScopeId);
      if (!executionLeaseId) {
        // A different manager sharing this execution scope still owns this job.
        // Drop any stale local copy so a later retry reloads durable state.
        this.jobs.delete(id);
        throw new Error('Agent job already has an active slice');
      }
      const prevStatus = job.status;
      job.status = 'running';
      job.executionLeaseId = executionLeaseId;
      try {
        await this.save(job);
      } catch (saveError) {
        job.status = prevStatus;
        delete job.executionLeaseId;
        throw saveError;
      }
      // Every started slice attempt consumes the job hard-limit budget
      // (#5205): a slice that throws after doing model/tool work must still
      // count its attempt and its wall-clock elapsed time — otherwise a
      // failure-heavy workload could retry past maxSlices/maxElapsedMs
      // forever, because only successful slices were accounted. Successful
      // slices keep the provider-reported usage aggregation below (no
      // double counting); the attempt counter replaces the success-only
      // increment that used to live inside mergeResult().
      const attemptStartedMs = monotonicNow();
      job.budgetUsage.slices += 1;
      let result;
      try {
        result = await this.runtime.turn({
          ...job.request, goal: job.goal, mode: 'agent', scope: job.effectiveScope,
          sessionId: job.sessionId, conversationId: job.conversationId,
          provider: job.provider, model: job.model, reasoning: job.reasoning,
        }, options);
      } catch (error) {
        const attemptElapsedMs = monotonicNow() - attemptStartedMs;
        if (Number.isFinite(attemptElapsedMs) && attemptElapsedMs >= 0) job.budgetUsage.elapsedMs += attemptElapsedMs;
        job.status = hardLimit(job) ? 'hard-limit' : options.signal?.aborted ? 'checkpointed' : 'failed';
        delete job.executionLeaseId;
        job.unresolvedWork = unique([...job.unresolvedWork, String(error?.message || error)]).slice(-32);
        job.updatedAt = new Date().toISOString();
        try {
          await this.save(job);
        } catch {}
        throw error;
      }
      mergeResult(job, result);
      const failureReason = nonBudgetFailureReason(result);
      if (failureReason) job.status = hardLimit(job) ? 'hard-limit' : 'checkpointed';
      else if (!result?.limits?.exhausted) job.status = 'complete';
      else if (hardLimit(job)) job.status = 'hard-limit';
      else job.status = 'checkpointed';
      const completedStatus = job.status;
      const completedLeaseId = executionLeaseId;
      delete job.executionLeaseId;
      job.updatedAt = new Date().toISOString();
      const completedCheckpoint = checkpoint(job);
      this.pendingCheckpoints.set(id, completedCheckpoint);
      rememberCompletedExecutionOutcome(job, completedLeaseId, completedCheckpoint);
      try {
        await this.persistPendingCheckpoint(job);
      } catch (error) {
        // The turn already completed. Preserve its result in a durable
        // running envelope when the final status write fails, so a fresh
        // manager can recover the completed checkpoint without replaying the
        // provider/tool side effects (#6273). If this fallback write also
        // fails, the ordinary interrupted-running recovery remains available
        // for a true process crash (#4389).
        await this.persistCompletedExecutionMarker(job, completedStatus);
        throw error;
      }
      return checkpoint(job);
    } finally {
      if (executionLeaseId) endExecutionLease(this.runtime, this.persistence, id, executionLeaseId, job.executionScopeId);
      this.runningJobIds.delete(id);
    }
  }

  async resume(id, options = {}) { return this.runSlice(id, options); }
  async retryCheckpoint(id) { return this.runSlice(id, { checkpointOnly: true }); }
  async persistPendingCheckpoint(job) {
    const pending = this.pendingCheckpoints.get(job.id);
    if (!pending) return;
    try {
      // save() clones again, so a mutating/rejecting persistence adapter cannot
      // change the checkpoint retained for the next retry.
      await this.save(pending);
    } catch (error) {
      job.checkpointSavePending = true;
      job.checkpointSaveError = String(error?.message || error);
      throw error;
    }
    this.pendingCheckpoints.delete(job.id);
    forgetCompletedExecutionOutcome(job.id);
    delete job.checkpointSavePending;
    delete job.checkpointSaveError;
  }
  async persistCompletedExecutionMarker(job, status) {
    const marker = checkpoint(job);
    marker.status = 'running';
    delete marker.executionLeaseId;
    marker.executionOutcomeStatus = status;
    marker.executionRecoveryPending = true;
    try {
      await this.save(marker);
      forgetCompletedExecutionOutcome(job.id);
    } catch {
      // The original persistence error is the actionable failure. A later
      // manager can still classify an unmarked running checkpoint as an
      // interrupted slice and recover it (#4389).
    }
  }
  async get(id) {
    if (typeof id !== 'string') return null;
    return this.jobs.get(id) || await this.load(id);
  }
  list() { return [...this.jobs.values()].map(checkpoint); }

  async require(value) {
    let id;
    if (value && typeof value === 'object') {
      id = value.id;
    } else {
      id = value;
    }
    if (typeof id !== 'string' || !id) throw new Error(`Unknown agent job: ${value}`);
    const job = await this.get(id);
    // An unregistered checkpoint object is never canonical state (#4459):
    // only a registered (or persistence-loadable) job can run. Persisted
    // running checkpoints recover through the load path (#4389).
    if (!job) throw new Error(`Unknown agent job: ${id}`);
    return job;
  }
  async load(id) {
    if (typeof id !== 'string' || !id) return null;
    if (this.loadingPromises.has(id)) return this.loadingPromises.get(id);
    const promise = (async () => {
      let value;
      try {
        value = await this.persistence?.load?.(id);
      } catch {
        return null;
      }
      if (validateCheckpoint(value, id)) {
        const live = isLiveRunningCheckpoint(value);
        const recovered = recoverPersistedRunningCheckpoint(value);
        // Do not cache another live manager's running snapshot. Its durable
        // state may advance before this manager retries.
        if (!live) this.jobs.set(id, recovered);
        return recovered;
      }
      return null;
    })();
    this.loadingPromises.set(id, promise);
    try {
      return await promise;
    } finally {
      this.loadingPromises.delete(id);
    }
  }
  async save(job) { await this.persistence?.save?.(checkpoint(job)); }
}

function mergeResult(job, result) {
  job.sessionId = result?.sessionId || job.sessionId;
  job.effectiveScope = result?.scope?.effective || job.effectiveScope;
  job.evidenceIds = unique([...job.evidenceIds, ...(result?.evidence || []).map((item) => identityString(item?.id)).filter(Boolean)]);
  job.hypothesisIds = unique([...job.hypothesisIds, ...(result?.hypotheses || []).map((item) => identityString(item?.id)).filter(Boolean)]);
  job.completedTools = unique([...job.completedTools, ...(result?.activity || []).filter((item) => item.type === 'tool-result').map((item) => identityString(item?.tool) || identityString(item?.label)).filter(Boolean)]);
  job.continuationRefs = unique([...job.continuationRefs, ...collectRefs(result)]);
  const failureReason = nonBudgetFailureReason(result);
  const resumeReason = result?.limits?.exhausted
    ? `resume-after:${result.limits.reason || 'slice-budget'}`
    : failureReason == null ? null : `resume-after:${failureReason}`;
  job.unresolvedWork = unique([...(result?.followups || []), ...(resumeReason == null ? [] : [resumeReason])]).slice(-32);
  const usage = result?.usage || {};
  // Usage counters feed the job hard-limit authority (`maxElapsedMs` etc.).
  // `Number()` coercion admitted NaN (silently disabling the elapsed ceiling
  // forever after) and negative values (rewinding monotonic accounting);
  // adopt only primitive finite non-negative numbers (#5689).
  const usageDelta = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
  // The slice-attempt count is incremented when the attempt starts (see
  // runSlice, #5205), so successful and failed attempts share one hard-limit
  // denominator; mergeResult only aggregates the provider-reported usage.
  job.budgetUsage.modelCalls += usageDelta(usage.modelCalls); job.budgetUsage.toolCalls += usageDelta(usage.toolCalls);
  job.budgetUsage.elapsedMs += usageDelta(usage.elapsedMs); job.budgetUsage.contextBytes += usageDelta(usage.contextBytes);
  job.lastResult = compactResult(result);
}
function nonBudgetFailureReason(result) {
  const reason = result?.limits?.reason;
  return result?.limits?.exhausted !== true && typeof reason === 'string' && reason.trim() ? reason.trim() : null;
}
function monotonicNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}
function collectRefs(result) {
  const refs = [];
  for (const item of result?.evidence || []) {
    for (const key of ['detailRef', 'continuationRef', 'cursor']) {
      const ref = identityString(item?.[key]);
      if (ref) refs.push(ref);
    }
  }
  return refs;
}
function identityString(value) { return typeof value === 'string' && value ? value : null; }
function requireIdentityString(value, label) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}
function hardLimit(job) { return job.budgetUsage.slices >= job.limits.maxSlices || job.budgetUsage.elapsedMs >= job.limits.maxElapsedMs; }
function compactResult(result) { return { answer: result?.answer || '', confidence: result?.confidence ?? null, limits: result?.limits || { exhausted: false }, usage: result?.usage || {}, sessionId: result?.sessionId || null }; }
function checkpoint(job) { return JSON.parse(JSON.stringify(job)); }
function unique(values) { return [...new Set(values)]; }
function rememberCompletedExecutionOutcome(job, leaseId, completedCheckpoint) {
  if (typeof leaseId !== 'string' || !leaseId) return;
  completedExecutionOutcomes.set(job.id, {
    scopeId: typeof job.executionScopeId === 'string' && job.executionScopeId ? job.executionScopeId : null,
    leaseId,
    checkpoint: completedCheckpoint,
  });
  // A failed persistence adapter must not allow this process-local guard to
  // grow without bound when many jobs finish at once.
  while (completedExecutionOutcomes.size > 256) {
    const oldest = completedExecutionOutcomes.keys().next().value;
    completedExecutionOutcomes.delete(oldest);
  }
}
function forgetCompletedExecutionOutcome(jobId) { completedExecutionOutcomes.delete(jobId); }
function executionLeaseScope(runtime, persistence, jobId, executionScopeId) {
  void runtime;
  void persistence;
  return typeof executionScopeId === 'string' && executionScopeId ? `scope:${executionScopeId}` : `legacy-job:${jobId}`;
}
function beginExecutionLease(runtime, persistence, jobId, executionScopeId) {
  const scope = executionLeaseScope(runtime, persistence, jobId, executionScopeId);
  let jobs = activeLeaseScopes.get(scope);
  if (!jobs) {
    jobs = new Map();
    activeLeaseScopes.set(scope, jobs);
  }
  if (jobs.has(jobId)) return null;
  const leaseId = `agent_job_lease_${randomId()}`;
  jobs.set(jobId, leaseId);
  activeExecutionLeases.set(leaseId, jobId);
  return leaseId;
}
function endExecutionLease(runtime, persistence, jobId, leaseId, executionScopeId) {
  const scope = executionLeaseScope(runtime, persistence, jobId, executionScopeId);
  const jobs = activeLeaseScopes.get(scope);
  if (jobs?.get(jobId) === leaseId) {
    jobs.delete(jobId);
    if (jobs.size === 0) activeLeaseScopes.delete(scope);
  }
  if (activeExecutionLeases.get(leaseId) === jobId) activeExecutionLeases.delete(leaseId);
}
function isLiveRunningCheckpoint(value) {
  if (value?.status !== 'running') return false;
  const leaseId = identityString(value.executionLeaseId);
  return leaseId !== null && activeExecutionLeases.get(leaseId) === value.id;
}
function recoverPersistedRunningCheckpoint(value) {
  if (value.status !== 'running') return value;
  if (value.executionOutcomeStatus && value.executionRecoveryPending === true) {
    const recovered = { ...value, status: value.executionOutcomeStatus };
    delete recovered.executionOutcomeStatus;
    delete recovered.executionLeaseId;
    delete recovered.checkpointSavePending;
    delete recovered.checkpointSaveError;
    return recovered;
  }
  if (isLiveRunningCheckpoint(value)) return value;
  const completed = completedExecutionOutcomes.get(value.id);
  if (completed
    && completed.leaseId === value.executionLeaseId
    && (completed.scopeId === null || completed.scopeId === value.executionScopeId)) {
    return { ...completed.checkpoint, executionRecoveryPending: true };
  }
  // Only a running checkpoint whose process-local execution lease is no
  // longer active is treated as interrupted. A second manager in the same
  // process cannot turn a live owner's checkpoint into resumable work.
  return {
    ...value,
    status: 'checkpointed',
    unresolvedWork: unique([...value.unresolvedWork, 'resume-after:interrupted-slice']).slice(-32),
    updatedAt: new Date().toISOString(),
  };
}
function bounded(value, min, max) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : min; }
const VALID_STATUSES = new Set(['ready', 'running', 'checkpointed', 'complete', 'failed', 'hard-limit']);
const RECOVERABLE_OUTCOME_STATUSES = new Set(['checkpointed', 'complete', 'hard-limit']);
function isValidNumber(n, min = 0) { return typeof n === 'number' && Number.isFinite(n) && n >= min; }
function validateCheckpoint(value, expectedId = null) {
  if (!value || typeof value !== 'object') return false;
  if (value.version !== CHECKPOINT_VERSION) return false;
  if (typeof value.id !== 'string' || !value.id) return false;
  if (expectedId !== null && value.id !== expectedId) return false;
  if (!VALID_STATUSES.has(value.status)) return false;
  if (value.executionLeaseId !== undefined && (typeof value.executionLeaseId !== 'string' || !value.executionLeaseId)) return false;
  if (value.executionScopeId !== undefined && (typeof value.executionScopeId !== 'string' || !value.executionScopeId)) return false;
  if (value.executionRecoveryPending !== undefined && typeof value.executionRecoveryPending !== 'boolean') return false;
  if (value.executionRecoveryPending === true
    && (value.status !== 'running' || !RECOVERABLE_OUTCOME_STATUSES.has(value.executionOutcomeStatus))) return false;
  if (value.executionOutcomeStatus !== undefined
    && (value.status !== 'running' || !RECOVERABLE_OUTCOME_STATUSES.has(value.executionOutcomeStatus) || value.executionRecoveryPending !== true)) return false;
  if (typeof value.goal !== 'string' || !value.goal) return false;
  const bu = value.budgetUsage;
  if (!bu || typeof bu !== 'object') return false;
  if (!isValidNumber(bu.slices) || !isValidNumber(bu.modelCalls) || !isValidNumber(bu.toolCalls) || !isValidNumber(bu.elapsedMs) || !isValidNumber(bu.contextBytes)) return false;
  const lim = value.limits;
  if (!lim || typeof lim !== 'object') return false;
  if (!isValidNumber(lim.maxSlices, 1) || lim.maxSlices > MAX_JOB_SLICES) return false;
  if (!isValidNumber(lim.maxElapsedMs, 1000) || lim.maxElapsedMs > MAX_JOB_ELAPSED_MS) return false;
  if (!Array.isArray(value.evidenceIds) || !Array.isArray(value.hypothesisIds) || !Array.isArray(value.completedTools) || !Array.isArray(value.continuationRefs) || !Array.isArray(value.unresolvedWork)) return false;
  return true;
}
function autoJobId() { return `agent_job_${Date.now().toString(36)}_${randomId()}`; }
function randomId() {
  const bytes = new Uint8Array(6);
  if (typeof globalThis.crypto?.getRandomValues === 'function') globalThis.crypto.getRandomValues(bytes);
  else {
    const sequence = fallbackRandomSequence++ & 0xffffffffffffn;
    for (let i = 0; i < bytes.length; i++) bytes[bytes.length - 1 - i] = Number((sequence >> BigInt(i * 8)) & 0xffn);
  }
  return Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('');
}
function safeRequest(input) {
  const out = {};
  // `planner:false` is an explicit disable flag: it must survive the
  // checkpoint or runSlice silently re-enables the planner (#5440).
  for (const key of ['style', 'task', 'intent', 'budget', 'maxSearchResults', 'plannerTimeoutMs', 'planner']) if (input[key] != null) out[key] = input[key];
  return checkpoint(out);
}

export function createAgentJobManager(options) { return new AgentJobManager(options); }
