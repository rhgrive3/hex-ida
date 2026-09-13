import assert from 'node:assert/strict';
import { DynamicTaskGraphHost } from '../js/userscript/dev/task-graph/dynamic-task-graph.js';

/* A caller deadline is an absolute wall-clock budget for the whole attempt. It must
   cover lease claim, chat creation, and task submission, not only the result wait. */
async function testCallerDeadlineAbortsAnUnsettledClaim() {
  const pool = new PhasePool({ claim: 'never' });
  const host = graphHost(pool);
  await host.start({
    graphId: 'claim-deadline',
    tasks: [{ id: 'stuck', dependencies: [], instruction: 'stuck', maxAttempts: 1, timeoutMs: 120 }],
  });
  const status = await waitTerminal(host, 'claim-deadline');
  assert.equal(status.state, 'FAILED');
  const task = host.taskResult({ graphId: 'claim-deadline', taskId: 'stuck' });
  assert.equal(task.error.code, 'task-timeout', 'a claim that outlives the caller deadline must fail as a caller timeout');
  assert.equal(pool.claimAborted, true, 'the caller deadline must be forwarded through the claim AbortSignal');
  assert.equal(pool.releaseCalls, 0, 'a deadline during claim releases nothing the attempt never held');
  assert.equal(pool.leases.size, 0);
  host.close();
}

/* Without a runId there is no supervisor watchdog at all, so the caller deadline is
   the only bound on a pending pre-result phase. */
async function testCallerDeadlineCoversPendingChatCreation() {
  const pool = new PhasePool({ createChat: 'never' });
  const host = graphHost(pool);
  await host.start({
    graphId: 'chat-hang',
    runId: null,
    tasks: [{ id: 'stuck', dependencies: [], instruction: 'stuck', maxAttempts: 1, timeoutMs: 120 }],
  });
  const startedAt = Date.now();
  const status = await waitTerminal(host, 'chat-hang');
  const elapsedMs = Date.now() - startedAt;
  assert.equal(status.state, 'FAILED');
  const task = host.taskResult({ graphId: 'chat-hang', taskId: 'stuck' });
  assert.equal(task.error.code, 'task-timeout');
  assert.ok(elapsedMs < 900, `an unbounded pre-result hang must not outlive the deadline by orders of magnitude (${elapsedMs}ms)`);
  assert.equal(pool.releaseCalls, 1, 'the claimed lease must be cleaned up after the deadline');
  assert.equal(pool.leases.size, 0);
  host.close();
}

/* Time spent before the result wait is consumed by the deadline, not added to it. */
async function testPreResultTimeIsChargedToTheDeadline() {
  const pool = new PhasePool({ createChat: { delay: 500 }, waitResult: 'never' });
  const host = graphHost(pool);
  await host.start({
    graphId: 'charged',
    runId: null,
    tasks: [{ id: 'slowsetup', dependencies: [], instruction: 'slowsetup', maxAttempts: 1, timeoutMs: 120 }],
  });
  const startedAt = Date.now();
  const status = await waitTerminal(host, 'charged');
  const elapsedMs = Date.now() - startedAt;
  assert.equal(status.state, 'FAILED');
  assert.equal(host.taskResult({ graphId: 'charged', taskId: 'slowsetup' }).error.code, 'task-timeout');
  assert.ok(
    elapsedMs < 400,
    `a 120ms deadline must not be re-armed after a 500ms setup phase (${elapsedMs}ms)`,
  );
  host.close();
}

/* The two deadlines stay distinguishable: the earlier one wins, and its own code is reported. */
async function testCallerAndSupervisorDeadlinesStayDistinguishable() {
  const callerWins = new PhasePool({ createChat: 'never' });
  const callerHost = graphHost(callerWins, { supervisorWatchdogTimeoutMs: 5000 });
  await callerHost.start({
    graphId: 'caller-wins',
    runId: 'run-caller-wins',
    tasks: [{ id: 'stuck', dependencies: [], instruction: 'stuck', maxAttempts: 1, timeoutMs: 120 }],
  });
  await waitTerminal(callerHost, 'caller-wins');
  assert.equal(
    callerHost.taskResult({ graphId: 'caller-wins', taskId: 'stuck' }).error.code,
    'task-timeout',
    'the shorter caller deadline must not be reported as a watchdog expiry',
  );
  callerHost.close();

  const watchdogWins = new PhasePool({ createChat: 'never' });
  const watchdogHost = graphHost(watchdogWins, { supervisorWatchdogTimeoutMs: 120 });
  await watchdogHost.start({
    graphId: 'watchdog-wins',
    runId: 'run-watchdog-wins',
    tasks: [{ id: 'stuck', dependencies: [], instruction: 'stuck', maxAttempts: 1, timeoutMs: 5000 }],
  });
  await waitTerminal(watchdogHost, 'watchdog-wins');
  assert.equal(
    watchdogHost.taskResult({ graphId: 'watchdog-wins', taskId: 'stuck' }).error.code,
    'supervisor-watchdog-timeout',
    'the shorter unattended watchdog must keep its own error code',
  );
  watchdogHost.close();
}

/* One deadline per attempt: a retry gets a fresh budget, and a normal attempt inside its
   budget still succeeds. */
async function testDeadlineIsPerAttemptAndDoesNotBreakSuccess() {
  const pool = new PhasePool({ createChat: ['never', 'ok'], result: { status: 'completed', responseText: 'done' } });
  const host = graphHost(pool);
  await host.start({
    graphId: 'attempts',
    runId: null,
    tasks: [{ id: 'retried', dependencies: [], instruction: 'retried', maxAttempts: 2, timeoutMs: 120 }],
  });
  const status = await waitTerminal(host, 'attempts');
  assert.equal(status.state, 'SUCCEEDED', 'a first attempt that consumes its budget must not poison the retry');
  const task = host.taskResult({ graphId: 'attempts', taskId: 'retried' });
  assert.equal(task.attempts, 2);
  assert.equal(task.state, 'SUCCEEDED');
  assert.equal(task.result.responseText, 'done');
  assert.equal(pool.leases.size, 0);
  host.close();

  const clean = new PhasePool({});
  const cleanHost = graphHost(clean);
  await cleanHost.start({
    graphId: 'clean',
    runId: null,
    tasks: [{ id: 'fast', dependencies: [], instruction: 'fast', maxAttempts: 1, timeoutMs: 2000 }],
  });
  assert.equal((await waitTerminal(cleanHost, 'clean')).state, 'SUCCEEDED');
  cleanHost.close();
}

function graphHost(workerPool, options = {}) {
  return new DynamicTaskGraphHost({
    workerPool,
    pollMs: 1,
    cleanupTimeoutMs: 50,
    supervisorWatchdogTimeoutMs: options.supervisorWatchdogTimeoutMs ?? 5000,
    retryBaseDelayMs: 0,
  });
}

async function waitTerminal(host, graphId, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = host.status({ graphId });
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status.state)) return status;
    await delay(2);
  }
  throw new Error(`graph ${graphId} did not settle within ${timeoutMs}ms`);
}

class PhasePool {
  constructor(spec = {}) {
    this.spec = spec;
    this.leases = new Map();
    this.sequence = 0;
    this.releaseCalls = 0;
    this.claimAborted = false;
    this.calls = new Map();
  }

  async provision() { return { readyCount: 1 }; }
  status() { return { readyCount: 1, claimedCount: this.leases.size }; }

  async claim({ taskId = null, signal = null } = {}) {
    if (signal?.aborted) throw abortError(signal.reason);
    const plan = this.step('claim');
    if (plan.mode === 'never') {
      return new Promise((resolve, reject) => {
        const onAbort = () => { this.claimAborted = true; reject(abortError(signal?.reason)); };
        signal?.addEventListener?.('abort', onAbort, { once: true });
      });
    }
    if (plan.mode === 'delay') await delay(plan.ms);
    const leaseId = `lease-${this.sequence += 1}`;
    this.leases.set(leaseId, { taskId });
    return { leaseId, slot: 1, workerId: `worker-${this.sequence}` };
  }

  async createChat() {
    const plan = this.step('createChat');
    if (plan.mode === 'never') return new Promise(() => {});
    if (plan.mode === 'delay') await delay(plan.ms);
    return { prepared: true };
  }

  async start() {
    const plan = this.step('start');
    if (plan.mode === 'never') return new Promise(() => {});
    if (plan.mode === 'delay') await delay(plan.ms);
    return { started: true };
  }

  async waitResult({ leaseId } = {}, { signal = null } = {}) {
    const plan = this.step('waitResult');
    this.require(leaseId);
    if (signal?.aborted) throw abortError(signal.reason);
    if (plan.mode === 'never') {
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(abortError(signal?.reason));
        signal?.addEventListener?.('abort', onAbort, { once: true });
      });
    }
    return this.spec.result || { status: 'completed', responseText: 'done' };
  }

  async result({ leaseId } = {}) {
    this.require(leaseId);
    return { status: 'available' };
  }

  async stop() { return { outcome: 'stopped' }; }

  async release({ leaseId } = {}) {
    this.releaseCalls += 1;
    this.leases.delete(String(leaseId));
    return { released: true };
  }

  require(leaseId) {
    const lease = this.leases.get(String(leaseId));
    if (!lease) {
      const error = new Error('lease missing');
      error.code = 'lease-missing';
      throw error;
    }
    return lease;
  }

  step(phase) {
    const index = this.calls.get(phase) || 0;
    this.calls.set(phase, index + 1);
    const configured = Array.isArray(this.spec[phase]) ? this.spec[phase] : [this.spec[phase]];
    const raw = index < configured.length ? configured[index] : configured[configured.length - 1];
    if (raw == null) return { mode: 'ok', ms: 0 };
    if (typeof raw === 'string') return { mode: raw === 'never' ? 'never' : 'ok', ms: 0 };
    return { mode: raw.delay != null ? 'delay' : 'ok', ms: Number(raw.delay) || 0 };
  }
}

function abortError(reason) {
  const error = new Error(String(reason || 'aborted'));
  error.name = 'AbortError';
  error.code = 'cancelled';
  return error;
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

await testCallerDeadlineAbortsAnUnsettledClaim();
await testCallerDeadlineCoversPendingChatCreation();
await testPreResultTimeIsChargedToTheDeadline();
await testCallerAndSupervisorDeadlinesStayDistinguishable();
await testDeadlineIsPerAttemptAndDoesNotBreakSuccess();
console.log('issue #5078 caller task deadline covers every attempt phase PASS');
