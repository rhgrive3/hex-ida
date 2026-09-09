const CHECKPOINT_VERSION = 1;
const MAX_JOB_SLICES = 32;
const MAX_JOB_ELAPSED_MS = 4 * 60 * 60 * 1000;
let fallbackRandomSequence = 0n;
const activeExecutionLeases = new Map();
const activeLeaseScopes = new WeakMap();

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
      executionLeaseId = beginExecutionLease(this.runtime, this.persistence, id);
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
      if (!result?.limits?.exhausted) job.status = 'complete';
      else if (hardLimit(job)) job.status = 'hard-limit';
      else job.status = 'checkpointed';
      delete job.executionLeaseId;
      job.updatedAt = new Date().toISOString();
      this.pendingCheckpoints.set(id, checkpoint(job));
      await this.persistPendingCheckpoint(job);
      return checkpoint(job);
    } finally {
      if (executionLeaseId) endExecutionLease(this.runtime, this.persistence, id, executionLeaseId);
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
    delete job.checkpointSavePending;
    delete job.checkpointSaveError;
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
  job.unresolvedWork = unique([...(result?.followups || []), ...(result?.limits?.exhausted ? [`resume-after:${result.limits.reason || 'slice-budget'}`] : [])]).slice(-32);
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
function executionLeaseScope(runtime, persistence) {
  if (persistence && (typeof persistence === 'object' || typeof persistence === 'function')) return persistence;
  return runtime;
}
function beginExecutionLease(runtime, persistence, jobId) {
  const scope = executionLeaseScope(runtime, persistence);
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
function endExecutionLease(runtime, persistence, jobId, leaseId) {
  const scope = executionLeaseScope(runtime, persistence);
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
  if (value.status !== 'running' || isLiveRunningCheckpoint(value)) return value;
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
function isValidNumber(n, min = 0) { return typeof n === 'number' && Number.isFinite(n) && n >= min; }
function validateCheckpoint(value, expectedId = null) {
  if (!value || typeof value !== 'object') return false;
  if (value.version !== CHECKPOINT_VERSION) return false;
  if (typeof value.id !== 'string' || !value.id) return false;
  if (expectedId !== null && value.id !== expectedId) return false;
  if (!VALID_STATUSES.has(value.status)) return false;
  if (value.executionLeaseId !== undefined && (typeof value.executionLeaseId !== 'string' || !value.executionLeaseId)) return false;
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
