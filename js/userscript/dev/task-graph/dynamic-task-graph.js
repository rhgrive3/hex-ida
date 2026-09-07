import { buildDevWorkerInstruction } from '../../../ai/dev/workers/contracts.js';
import { DEV_WORKER_POOL_MAX } from '../frame-mesh/iframe-worker-pool.js';

export const DEV_TASK_STATE = Object.freeze({
  PENDING: 'PENDING',
  READY: 'READY',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  BLOCKED: 'BLOCKED',
  CANCELLED: 'CANCELLED',
});
export const DEV_TASK_TERMINAL_STATES = Object.freeze([
  DEV_TASK_STATE.SUCCEEDED,
  DEV_TASK_STATE.FAILED,
  DEV_TASK_STATE.BLOCKED,
  DEV_TASK_STATE.CANCELLED,
]);
export const DEV_TASK_GRAPH_STATE = Object.freeze({
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

const TASK_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/;
const GRAPH_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/;
const MAX_TASKS = 128;
const MIN_TIMEOUT_MS = 10;
const MAX_ATTEMPTS = 5;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5000;
const DEFAULT_POLL_MS = 50;
const DEFAULT_SUPERVISOR_WATCHDOG_TIMEOUT_MS = MAX_TIMEOUT_MS;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;

export class DynamicTaskGraphHost {
  constructor({
    workerPool,
    cryptoRef = globalThis.crypto,
    now = () => new Date().toISOString(),
    sleep = delay,
    pollMs = DEFAULT_POLL_MS,
    cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
    supervisorWatchdogTimeoutMs = DEFAULT_SUPERVISOR_WATCHDOG_TIMEOUT_MS,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    onWorkerCompletion = null,
  } = {}) {
    if (!workerPool || typeof workerPool.claim !== 'function' || typeof workerPool.release !== 'function'
      || typeof workerPool.waitResult !== 'function') {
      throw new TypeError('Dynamic Task Graph requires an IframeWorkerPool-compatible workerPool.');
    }
    this.workerPool = workerPool;
    this.cryptoRef = cryptoRef;
    this.now = now;
    this.sleep = sleep;
    this.pollMs = boundedInt(pollMs, 1, 1000, DEFAULT_POLL_MS);
    this.cleanupTimeoutMs = boundedInt(cleanupTimeoutMs, 10, 60000, DEFAULT_CLEANUP_TIMEOUT_MS);
    this.supervisorWatchdogTimeoutMs = boundedInt(
      supervisorWatchdogTimeoutMs,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      DEFAULT_SUPERVISOR_WATCHDOG_TIMEOUT_MS,
    );
    this.retryBaseDelayMs = boundedInt(retryBaseDelayMs, 0, MAX_RETRY_DELAY_MS, DEFAULT_RETRY_BASE_DELAY_MS);
    this.onWorkerCompletion = typeof onWorkerCompletion === 'function' ? onWorkerCompletion : null;
    this.graphs = new Map();
  }

  async start({ graphId = null, tasks, maxConcurrency = DEV_WORKER_POOL_MAX, runId = null } = {}) {
    const id = graphId == null ? randomGraphId(this.cryptoRef) : normalizeGraphId(graphId);
    if (this.graphs.has(id)) throw graphError('graph-exists', `Task graph already exists: ${id}`);
    const graph = new DynamicTaskGraph({
      graphId: id,
      tasks,
      maxConcurrency,
      workerPool: this.workerPool,
      now: this.now,
      sleep: this.sleep,
      pollMs: this.pollMs,
      cleanupTimeoutMs: this.cleanupTimeoutMs,
      supervisorWatchdogTimeoutMs: this.supervisorWatchdogTimeoutMs,
      retryBaseDelayMs: this.retryBaseDelayMs,
      runId,
      onWorkerCompletion: this.onWorkerCompletion,
    });
    this.graphs.set(id, graph);
    await graph.start();
    return graph.status();
  }

  status({ graphId } = {}) {
    return this.requireGraph(graphId).status();
  }

  taskResult({ graphId, taskId } = {}) {
    return this.requireGraph(graphId).taskResult(taskId);
  }

  cancel({ graphId, reason = 'cancelled-by-supervisor' } = {}) {
    const graph = this.requireGraph(graphId);
    graph.cancel(reason);
    return graph.status();
  }

  close() {
    for (const graph of this.graphs.values()) graph.cancel('task-graph-host-closed');
  }

  requireGraph(graphId) {
    const id = normalizeGraphId(graphId);
    const graph = this.graphs.get(id);
    if (!graph) throw graphError('graph-missing', `Task graph is unavailable: ${id}`);
    return graph;
  }
}

export class DynamicTaskGraph {
  constructor({
    graphId,
    tasks,
    maxConcurrency,
    workerPool,
    now,
    sleep,
    pollMs,
    cleanupTimeoutMs,
    supervisorWatchdogTimeoutMs = DEFAULT_SUPERVISOR_WATCHDOG_TIMEOUT_MS,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    runId = null,
    onWorkerCompletion = null,
  } = {}) {
    this.graphId = normalizeGraphId(graphId);
    this.workerPool = workerPool;
    this.now = now;
    this.sleep = sleep;
    this.pollMs = pollMs;
    this.cleanupTimeoutMs = cleanupTimeoutMs;
    this.supervisorWatchdogTimeoutMs = supervisorWatchdogTimeoutMs;
    this.retryBaseDelayMs = retryBaseDelayMs;
    this.runId = normalizeOptionalRunId(runId);
    this.onWorkerCompletion = typeof onWorkerCompletion === 'function' ? onWorkerCompletion : null;
    this.maxConcurrency = boundedInt(maxConcurrency, 1, DEV_WORKER_POOL_MAX, DEV_WORKER_POOL_MAX);
    this.tasks = normalizeTasks(tasks, now);
    assertAcyclic(this.tasks);
    this.state = DEV_TASK_GRAPH_STATE.STARTING;
    this.error = null;
    this.startedAt = null;
    this.finishedAt = null;
    this.cancelReason = null;
    this.abortController = new AbortController();
    this.active = new Map();
    this.loopPromise = null;
  }

  async start() {
    this.startedAt = this.now();
    try {
      const wanted = Math.min(this.maxConcurrency, Math.max(1, this.tasks.size));
      const provisioned = await this.workerPool.provision({ size: wanted });
      if (this.abortController.signal.aborted) {
        this.state = DEV_TASK_GRAPH_STATE.CANCELLED;
        this.cancelReason ||= 'cancelled';
        this.cancelNonRunning();
        this.finishedAt = this.now();
        return;
      }
      const readyCount = Number(provisioned?.readyCount ?? this.workerPool.status?.().readyCount ?? 0);
      if (!Number.isFinite(readyCount) || readyCount < 1) {
        throw graphError('worker-pool-unavailable', 'Dynamic Task Graph could not provision a ready Worker iframe.');
      }
      this.maxConcurrency = Math.min(this.maxConcurrency, Math.floor(readyCount));
      this.state = DEV_TASK_GRAPH_STATE.RUNNING;
      this.loopPromise = this.runLoop().catch((error) => this.failGraph(error));
    } catch (error) {
      this.failGraph(error);
    }
  }

  cancel(reason = 'cancelled') {
    if (isGraphTerminal(this.state)) return;
    this.cancelReason = String(reason || 'cancelled').slice(0, 256);
    this.abortController.abort(this.cancelReason);
    this.cancelNonRunning();
    if (this.active.size === 0) this.finalize();
  }

  status() {
    const tasks = [...this.tasks.values()].map((task) => publicTask(task, false));
    return Object.freeze({
      graphId: this.graphId,
      state: this.state,
      maxConcurrency: this.maxConcurrency,
      activeCount: this.active.size,
      counts: countStates(tasks),
      error: this.error,
      cancelReason: this.cancelReason,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      tasks,
    });
  }

  taskResult(taskId) {
    const id = normalizeTaskId(taskId);
    const task = this.tasks.get(id);
    if (!task) throw graphError('task-missing', `Task is unavailable in graph ${this.graphId}: ${id}`);
    return publicTask(task, true);
  }

  async runLoop() {
    while (this.state === DEV_TASK_GRAPH_STATE.RUNNING) {
      this.propagateDependencyFailures();
      this.markReady();
      this.launchReadyTasks();
      if (allTerminal(this.tasks)) {
        this.finalize();
        return;
      }
      const retryWaitMs = this.nextRetryWaitMs();
      if (this.active.size === 0) {
        if (retryWaitMs != null) {
          await this.sleep(retryWaitMs);
          continue;
        }
        this.failGraph(graphError('graph-stalled', 'Task graph has no runnable or active task.'));
        return;
      }
      const activeWait = Promise.race(this.active.values());
      if (retryWaitMs == null) await activeWait;
      else await Promise.race([activeWait, this.sleep(retryWaitMs)]);
    }
  }

  propagateDependencyFailures() {
    for (const task of this.tasks.values()) {
      if (![DEV_TASK_STATE.PENDING, DEV_TASK_STATE.READY].includes(task.state)) continue;
      const failed = task.dependencies.filter((id) => {
        const state = this.tasks.get(id).state;
        return [DEV_TASK_STATE.FAILED, DEV_TASK_STATE.BLOCKED, DEV_TASK_STATE.CANCELLED].includes(state);
      });
      if (!failed.length) continue;
      task.state = DEV_TASK_STATE.BLOCKED;
      task.error = Object.freeze({ code: 'dependency-failed', message: `Dependency failed: ${failed.join(', ')}`, dependencies: Object.freeze([...failed]) });
      task.finishedAt = this.now();
    }
  }

  markReady() {
    for (const task of this.tasks.values()) {
      if (task.state !== DEV_TASK_STATE.PENDING) continue;
      if (task.dependencies.every((id) => this.tasks.get(id).state === DEV_TASK_STATE.SUCCEEDED)) {
        task.state = DEV_TASK_STATE.READY;
        task.readyAt = this.now();
      }
    }
  }

  launchReadyTasks() {
    const currentMs = Date.now();
    for (const task of this.tasks.values()) {
      if (this.active.size >= this.maxConcurrency) break;
      if (task.state !== DEV_TASK_STATE.READY) continue;
      if (task.retryNotBeforeMs > currentMs) continue;
      task.retryNotBeforeMs = 0;
      task.state = DEV_TASK_STATE.RUNNING;
      if (!task.startedAt) task.startedAt = this.now();
      const running = this.executeTask(task)
        .catch((error) => this.finishTaskFailure(task, error))
        .finally(() => this.active.delete(task.id));
      this.active.set(task.id, running);
    }
  }

  nextRetryWaitMs() {
    const currentMs = Date.now();
    let next = null;
    for (const task of this.tasks.values()) {
      if (task.state !== DEV_TASK_STATE.READY || task.retryNotBeforeMs <= currentMs) continue;
      const waitMs = task.retryNotBeforeMs - currentMs;
      next = next == null ? waitMs : Math.min(next, waitMs);
    }
    return next;
  }

  retryDelayMs(task) {
    if (!this.runId || this.retryBaseDelayMs <= 0) return 0;
    const exponent = Math.max(0, task.attempts - 1);
    return Math.min(MAX_RETRY_DELAY_MS, this.retryBaseDelayMs * (2 ** exponent));
  }

  async executeTask(task) {
    if (task.executionActive) throw graphError('duplicate-execution', `Task is already executing: ${task.id}`);
    task.executionActive = true;
    try {
      while (task.attempts < task.maxAttempts) {
        if (this.abortController.signal.aborted) {
          this.finishTaskCancelled(task, this.cancelReason || 'cancelled');
          return;
        }
        task.attempts += 1;
        const trace = this.beginAttemptTrace(task);
        const supervisorDeadline = this.runId ? Date.now() + this.supervisorWatchdogTimeoutMs : null;
        let lease = null;
        let outcome = null;
        let attemptError = null;
        try {
          lease = await this.claimWorker(task, supervisorDeadline);
          trace.leaseClaimedAt = this.now();
          trace.leaseId = lease.leaseId;
          trace.slot = lease.slot ?? null;
          trace.workerId = lease.workerId || null;
          task.owner = Object.freeze({ leaseId: lease.leaseId, slot: lease.slot, workerId: lease.workerId || null });
          await this.awaitSupervisorPhase(
            () => this.workerPool.createChat({ leaseId: lease.leaseId }),
            task,
            supervisorDeadline,
            'creating the Worker chat',
          );
          await this.awaitSupervisorPhase(
            () => this.workerPool.start({ leaseId: lease.leaseId, instruction: buildDevWorkerInstruction(task.instruction) }),
            task,
            supervisorDeadline,
            'submitting the Worker task',
          );
          trace.promptSubmitAt = this.now();
          outcome = await this.waitForWorkerResult(task, lease.leaseId, supervisorDeadline);
          trace.completionDetectedAt = this.now();
          const succeeded = workerSucceeded(outcome);
          trace.resultParsedAt = this.now();
          if (!succeeded) throw workerResultError(outcome);
        } catch (error) {
          attemptError = normalizeError(error, 'task-failed');
        }

        const cleanupError = lease ? await this.cleanupLease(task, lease.leaseId) : null;
        if (lease && !cleanupError) trace.leaseReleasedAt = this.now();
        task.owner = null;

        /* Once the Worker result proves success, never replay the workload merely
           because post-result lease cleanup failed. Repository/API side effects
           may already be committed. Preserve success and surface cleanup only as
           infrastructure diagnostics; later work still has the run watchdog if
           the pool lost capacity. */
        if (outcome && !attemptError) {
          const warning = cleanupError ? normalizeError(cleanupError, 'lease-cleanup-failed') : null;
          trace.cleanupWarning = warning;
          closeAttemptTrace(trace, 'succeeded', null);
          task.result = safeClone(outcome);
          task.error = null;
          task.cleanupWarning = warning;
          task.state = DEV_TASK_STATE.SUCCEEDED;
          task.finishedAt = this.now();
          this.publishWorkerCompletion(task, lease);
          return;
        }
        if (cleanupError) {
          closeAttemptTrace(trace, 'failed', cleanupError);
          this.finishTaskFailure(task, cleanupError);
          if (outcome) this.publishWorkerCompletion(task, lease);
          return;
        }
        if (this.abortController.signal.aborted || attemptError?.code === 'cancelled') {
          closeAttemptTrace(trace, 'cancelled', attemptError);
          this.finishTaskCancelled(task, this.cancelReason || attemptError?.message || 'cancelled');
          if (outcome) this.publishWorkerCompletion(task, lease);
          return;
        }
        closeAttemptTrace(trace, 'failed', attemptError);
        task.error = attemptError;
        if (task.attempts < task.maxAttempts) {
          task.state = DEV_TASK_STATE.READY;
          task.readyAt = this.now();
          const retryDelayMs = this.retryDelayMs(task);
          task.retryNotBeforeMs = retryDelayMs > 0 ? Date.now() + retryDelayMs : 0;
          if (outcome) this.publishWorkerCompletion(task, lease);
          return;
        }
        this.finishTaskFailure(task, attemptError || graphError('task-failed', `Task failed: ${task.id}`));
        if (outcome) this.publishWorkerCompletion(task, lease);
        return;
      }
    } finally {
      task.executionActive = false;
    }
  }

  /* One await for the whole model turn. The Pool owns the turn and wakes us
     when it settles, so nothing re-reads it on a timer while the Worker
     generates. An explicit task deadline remains caller-owned. Supervisor-owned
     unattended graphs additionally carry one bounded per-attempt safety watchdog
     across claim/create/start/result so infrastructure loss cannot strand the run
     forever. Cleanup remains the existing stop -> release -> discard transaction. */
  beginAttemptTrace(task) {
    const trace = {
      graphId: this.graphId,
      taskId: task.id,
      attempt: task.attempts,
      leaseId: null,
      workerId: null,
      slot: null,
      readyAt: task.readyAt || this.now(),
      leaseClaimedAt: null,
      promptSubmitAt: null,
      completionDetectedAt: null,
      resultParsedAt: null,
      leaseReleasedAt: null,
      outcome: null,
      error: null,
      cleanupWarning: null,
    };
    task.trace.push(trace);
    return trace;
  }

  publishWorkerCompletion(task, lease) {
    if (!this.runId || !this.onWorkerCompletion) return null;
    const completion = Object.freeze({
      runId: this.runId,
      graphId: this.graphId,
      taskId: task.id,
      attempt: task.attempts,
      leaseId: lease?.leaseId || null,
      workerId: lease?.workerId || null,
      slot: lease?.slot ?? null,
    });
    try {
      const delivery = this.onWorkerCompletion(completion);
      if (delivery && typeof delivery.then === 'function') Promise.resolve(delivery).catch(() => {});
    } catch {
      /* Task execution state is authoritative and must never be rewritten by an
         observer/wakeup delivery failure. The canonical completion bridge retains
         graph completions before enqueue, so its wait path can still replay them. */
    }
    return null;
  }

  async claimWorker(task, supervisorDeadline) {
    const controller = new AbortController();
    let watchdogExpired = false;
    const onGraphCancel = () => controller.abort(this.cancelReason || 'cancelled');
    this.abortController.signal.addEventListener('abort', onGraphCancel, { once: true });
    let watchdog = null;
    if (supervisorDeadline != null) {
      const remaining = Math.max(0, supervisorDeadline - Date.now());
      watchdog = setTimeout(() => {
        watchdogExpired = true;
        controller.abort('supervisor-watchdog-timeout');
      }, remaining);
    }
    try {
      return await this.workerPool.claim({ taskId: task.id, wait: true, signal: controller.signal });
    } catch (error) {
      if (watchdogExpired) throw supervisorWatchdogError(task, this.supervisorWatchdogTimeoutMs, 'claiming a Worker lease');
      if (this.abortController.signal.aborted) throw graphError('cancelled', this.cancelReason || 'cancelled');
      throw error;
    } finally {
      if (watchdog) clearTimeout(watchdog);
      this.abortController.signal.removeEventListener('abort', onGraphCancel);
    }
  }

  async awaitSupervisorPhase(operation, task, supervisorDeadline, phase) {
    if (supervisorDeadline == null) return operation();
    const remaining = Math.max(0, supervisorDeadline - Date.now());
    const settled = await settleWithin(operation, remaining);
    if (!settled.settled) throw supervisorWatchdogError(task, this.supervisorWatchdogTimeoutMs, phase);
    if (settled.error) throw settled.error;
    return settled.value;
  }

  async waitForWorkerResult(task, leaseId, supervisorDeadline = null) {
    if (this.abortController.signal.aborted) throw graphError('cancelled', this.cancelReason || 'cancelled');
    const controller = new AbortController();
    const onGraphCancel = () => controller.abort(this.cancelReason || 'cancelled');
    this.abortController.signal.addEventListener('abort', onGraphCancel, { once: true });
    let timeoutCode = null;
    const timers = [];
    if (task.timeoutMs != null) {
      timers.push(setTimeout(() => {
        if (timeoutCode) return;
        timeoutCode = 'task-timeout';
        controller.abort(timeoutCode);
      }, task.timeoutMs));
    }
    if (supervisorDeadline != null) {
      const remaining = Math.max(0, supervisorDeadline - Date.now());
      timers.push(setTimeout(() => {
        if (timeoutCode) return;
        timeoutCode = 'supervisor-watchdog-timeout';
        controller.abort(timeoutCode);
      }, remaining));
    }
    try {
      return await this.workerPool.waitResult({ leaseId }, { signal: controller.signal });
    } catch (error) {
      if (timeoutCode === 'task-timeout') throw graphError('task-timeout', `Task ${task.id} exceeded ${task.timeoutMs}ms.`);
      if (timeoutCode === 'supervisor-watchdog-timeout') {
        throw supervisorWatchdogError(task, this.supervisorWatchdogTimeoutMs, 'waiting for a terminal Worker result');
      }
      if (this.abortController.signal.aborted) throw graphError('cancelled', this.cancelReason || 'cancelled');
      throw error;
    } finally {
      for (const timer of timers) clearTimeout(timer);
      this.abortController.signal.removeEventListener('abort', onGraphCancel);
    }
  }

  async cleanupLease(task, leaseId) {
    try {
      const deadline = Date.now() + this.cleanupTimeoutMs;
      const remaining = () => Math.max(0, deadline - Date.now());
      let current = null;
      const initial = await settleWithin(() => this.workerPool.result({ leaseId }), remaining());
      if (!initial.settled) return this.discardAfterCleanupTimeout(task, leaseId, 'result-timeout');
      if (initial.error) {
        if (String(initial.error?.code || '') === 'lease-missing') return null;
      } else {
        current = initial.value;
      }
      if (String(current?.status || '').toLowerCase() === 'working') {
        const stopped = await settleWithin(() => this.workerPool.stop({ leaseId }), remaining());
        if (!stopped.settled) return this.discardAfterCleanupTimeout(task, leaseId, 'stop-timeout');
      }
      while (Date.now() < deadline) {
        const observed = await settleWithin(() => this.workerPool.result({ leaseId }), remaining());
        if (!observed.settled) return this.discardAfterCleanupTimeout(task, leaseId, 'result-timeout');
        if (observed.error) {
          if (String(observed.error?.code || '') === 'lease-missing') return null;
          break;
        }
        current = observed.value;
        if (String(current?.status || '').toLowerCase() !== 'working') break;
        const waitMs = Math.min(this.pollMs, remaining());
        if (waitMs <= 0) break;
        await this.sleep(waitMs);
      }
      const released = await settleWithin(() => this.workerPool.release({ leaseId }), remaining());
      if (released.settled && !released.error) return null;
      if (released.error && String(released.error?.code || '') === 'lease-missing') return null;
      return this.discardAfterCleanupTimeout(task, leaseId, released.settled ? 'release-failed' : 'release-timeout', released.error);
    } catch (error) {
      return graphError('lease-cleanup-failed', `Task ${task.id} Worker lease cleanup failed: ${String(error?.message || error).slice(0, 256)}`);
    }
  }

  async discardAfterCleanupTimeout(task, leaseId, reason, releaseError = null) {
    if (typeof this.workerPool.discard === 'function') {
      try {
        await this.workerPool.discard({
          leaseId,
          reason: `task-graph-cleanup:${this.graphId}:${task.id}:${reason}`,
          timeoutMs: 0,
        });
        return null;
      } catch (error) {
        if (String(error?.code || '') === 'lease-missing') return null;
        releaseError ||= error;
      }
    }
    return graphError('lease-cleanup-failed', `Task ${task.id} could not release Worker lease: ${String(releaseError?.message || releaseError || reason).slice(0, 256)}`);
  }

  finishTaskFailure(task, error) {
    if (isTaskTerminal(task.state)) return;
    task.state = DEV_TASK_STATE.FAILED;
    task.error = normalizeError(error, 'task-failed');
    task.finishedAt = this.now();
  }

  finishTaskCancelled(task, reason) {
    if (isTaskTerminal(task.state)) return;
    task.state = DEV_TASK_STATE.CANCELLED;
    task.error = Object.freeze({ code: 'cancelled', message: String(reason || 'cancelled').slice(0, 256) });
    task.finishedAt = this.now();
  }

  cancelNonRunning() {
    for (const task of this.tasks.values()) {
      if ([DEV_TASK_STATE.PENDING, DEV_TASK_STATE.READY].includes(task.state)) this.finishTaskCancelled(task, this.cancelReason || 'cancelled');
    }
  }

  finalize() {
    if (this.finishedAt) return;
    if (this.abortController.signal.aborted) this.state = DEV_TASK_GRAPH_STATE.CANCELLED;
    else if ([...this.tasks.values()].every((task) => task.state === DEV_TASK_STATE.SUCCEEDED)) this.state = DEV_TASK_GRAPH_STATE.SUCCEEDED;
    else this.state = DEV_TASK_GRAPH_STATE.FAILED;
    this.finishedAt = this.now();
  }

  failGraph(error) {
    if (this.finishedAt) return;
    this.error = normalizeError(error, 'graph-failed');
    for (const task of this.tasks.values()) {
      if ([DEV_TASK_STATE.PENDING, DEV_TASK_STATE.READY].includes(task.state)) {
        task.state = DEV_TASK_STATE.BLOCKED;
        task.error = Object.freeze({ code: 'graph-failed', message: this.error.message });
        task.finishedAt = this.now();
      }
    }
    if (this.active.size === 0) {
      this.state = DEV_TASK_GRAPH_STATE.FAILED;
      this.finishedAt = this.now();
    }
  }
}

function normalizeTasks(input, now) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_TASKS) {
    throw new TypeError(`Dynamic Task Graph requires 1-${MAX_TASKS} tasks.`);
  }
  const tasks = new Map();
  for (const source of input) {
    if (!plainRecord(source)) throw new TypeError('Task must be a plain object.');
    const id = normalizeTaskId(source.id);
    if (tasks.has(id)) throw graphError('duplicate-task-id', `Duplicate task id: ${id}`);
    const dependencies = source.dependencies == null ? [] : source.dependencies;
    if (!Array.isArray(dependencies)) throw new TypeError(`Task ${id} dependencies must be an array.`);
    const normalizedDependencies = [...new Set(dependencies.map(normalizeTaskId))];
    if (normalizedDependencies.includes(id)) throw graphError('task-self-dependency', `Task ${id} may not depend on itself.`);
    const instruction = String(source.instruction || '').trim();
    if (!instruction || instruction.length > 32768) throw new TypeError(`Task ${id} requires an instruction up to 32768 characters.`);
    tasks.set(id, {
      id,
      dependencies: Object.freeze(normalizedDependencies),
      instruction,
      maxAttempts: boundedInt(source.maxAttempts, 1, MAX_ATTEMPTS, 1),
      timeoutMs: normalizeDeadline(source.timeoutMs),
      state: DEV_TASK_STATE.PENDING,
      owner: null,
      attempts: 0,
      result: null,
      error: null,
      cleanupWarning: null,
      retryNotBeforeMs: 0,
      readyAt: null,
      startedAt: null,
      finishedAt: null,
      executionActive: false,
      trace: [],
      createdAt: now(),
    });
  }
  for (const task of tasks.values()) {
    for (const dependency of task.dependencies) {
      if (!tasks.has(dependency)) throw graphError('dependency-missing', `Task ${task.id} depends on missing task ${dependency}.`);
    }
  }
  return tasks;
}

/* A task has a caller deadline only when its caller asked for one. Supervisor-
   owned unattended graphs use a separate internal watchdog, so timeoutMs remains
   an honest representation of the caller contract rather than a fabricated
   default. */
function normalizeDeadline(value) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError('Task timeoutMs must be a finite number of milliseconds, or null for no deadline.');
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(number)));
}

function assertAcyclic(tasks) {
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw graphError('dependency-cycle', `Task graph contains a dependency cycle at ${id}.`);
    visiting.add(id);
    for (const dependency of tasks.get(id).dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of tasks.keys()) visit(id);
}

function publicTask(task, includeResult) {
  return Object.freeze({
    id: task.id,
    dependencies: task.dependencies,
    state: task.state,
    owner: task.owner,
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    timeoutMs: task.timeoutMs,
    error: task.error,
    cleanupWarning: task.cleanupWarning,
    result: includeResult ? safeClone(task.result) : undefined,
    trace: includeResult ? Object.freeze(task.trace.map((entry) => Object.freeze({ ...entry }))) : undefined,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
  });
}
function countStates(tasks) {
  const counts = {};
  for (const state of Object.values(DEV_TASK_STATE)) counts[state] = 0;
  for (const task of tasks) counts[task.state] = (counts[task.state] || 0) + 1;
  return Object.freeze(counts);
}
function allTerminal(tasks) { return [...tasks.values()].every((task) => isTaskTerminal(task.state)); }
function isTaskTerminal(state) { return DEV_TASK_TERMINAL_STATES.includes(state); }
function isGraphTerminal(state) { return [DEV_TASK_GRAPH_STATE.SUCCEEDED, DEV_TASK_GRAPH_STATE.FAILED, DEV_TASK_GRAPH_STATE.CANCELLED].includes(state); }
function workerSucceeded(result) {
  const state = String(result?.status || result?.state || '').toLowerCase();
  return ['completed', 'succeeded', 'success'].includes(state);
}
function workerResultError(result) {
  const state = String(result?.status || result?.state || 'failed').toLowerCase();
  const code = String(result?.error?.code || `worker-${state}`).slice(0, 64);
  const message = String(result?.error?.message || `Worker task ended with status ${state}.`).slice(0, 512);
  return graphError(code, message);
}
function closeAttemptTrace(trace, outcome, error) {
  if (!trace || trace.outcome) return;
  trace.outcome = outcome;
  trace.error = error ? Object.freeze({ code: String(error.code || outcome).slice(0, 64), message: String(error.message || outcome).slice(0, 256) }) : null;
}

export function devAttemptTraceDurations(trace) {
  return Object.freeze({
    readyToLeaseMs: spanMs(trace?.readyAt, trace?.leaseClaimedAt),
    leaseToSubmitMs: spanMs(trace?.leaseClaimedAt, trace?.promptSubmitAt),
    submitToCompletionDetectedMs: spanMs(trace?.promptSubmitAt, trace?.completionDetectedAt),
    completionToParseMs: spanMs(trace?.completionDetectedAt, trace?.resultParsedAt),
    parseToReleaseMs: spanMs(trace?.resultParsedAt, trace?.leaseReleasedAt),
  });
}
function spanMs(from, to) {
  if (from == null || to == null) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return end - start;
}

function supervisorWatchdogError(task, timeoutMs, phase) {
  return graphError(
    'supervisor-watchdog-timeout',
    `Supervisor-owned task ${task.id} exceeded the ${timeoutMs}ms unattended safety watchdog while ${phase}.`,
  );
}
function normalizeError(error, fallbackCode) {
  if (error && typeof error === 'object' && error.code && error.message) {
    return Object.freeze({ code: String(error.code).slice(0, 64), message: String(error.message).slice(0, 512) });
  }
  return Object.freeze({ code: fallbackCode, message: String(error?.message || error || fallbackCode).slice(0, 512) });
}
function safeClone(value) {
  if (value == null) return null;
  try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}
function normalizeTaskId(value) { const id = String(value || '').trim(); if (!TASK_ID.test(id)) throw new TypeError(`Invalid task id: ${value}`); return id; }
function normalizeGraphId(value) { const id = String(value || '').trim(); if (!GRAPH_ID.test(id)) throw new TypeError(`Invalid graph id: ${value}`); return id; }
function normalizeOptionalRunId(value) { if (value == null) return null; const id = String(value).trim(); if (!id) throw new TypeError('Invalid Supervisor runId.'); return id; }
function plainRecord(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) return false; const proto = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null; }
function boundedInt(value, min, max, fallback) { if (value == null) return fallback; const number = Number(value); if (!Number.isFinite(number)) throw new TypeError('Expected finite numeric bound.'); return Math.min(max, Math.max(min, Math.floor(number))); }
function settleWithin(operation, timeoutMs) {
  const limit = Math.max(0, Number(timeoutMs) || 0);
  if (limit === 0) {
    void Promise.resolve().then(operation).catch(() => {});
    return Promise.resolve({ settled: false, value: undefined, error: null });
  }
  return new Promise((resolve) => {
    let finished = false;
    let timer = null;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => finish({ settled: false, value: undefined, error: null }), limit);
    Promise.resolve().then(operation).then(
      (value) => finish({ settled: true, value, error: null }),
      (error) => finish({ settled: true, value: undefined, error }),
    );
  });
}
function graphError(code, message) { const error = new Error(message); error.code = code; return error; }
function randomGraphId(cryptoRef) { if (!cryptoRef?.getRandomValues) throw new TypeError('WebCrypto is required for task graph identity.'); const bytes = cryptoRef.getRandomValues(new Uint8Array(12)); return `graph-${[...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')}`; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
