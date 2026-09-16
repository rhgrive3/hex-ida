import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { DynamicTaskGraphHost } from '../js/userscript/dev/task-graph/dynamic-task-graph.js';

const unhandled = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason); });

async function testCancelInterruptsHangingCreateChat() {
  const pool = new HangingWorkerPool({ hangPhase: 'createChat' });
  const host = graphHost(pool, { supervisorWatchdogTimeoutMs: 4000, retryBaseDelayMs: 0 });
  await host.start({
    graphId: 'cancel-create-chat',
    runId: 'run-cancel-create-chat',
    maxConcurrency: 1,
    tasks: [{ id: 'stuck', dependencies: [], instruction: 'stuck', maxAttempts: 3 }, { id: 'after', dependencies: ['stuck'], instruction: 'after' }],
  });
  await enteredPhase(pool, 'createChat');
  const cancelledAt = Date.now();
  host.cancel({ graphId: 'cancel-create-chat', reason: 'user-cancel' });
  const status = await waitTerminal(host, 'cancel-create-chat');
  assert.equal(status.state, 'CANCELLED');
  assert.ok(Date.now() - cancelledAt < 2000, 'explicit cancel must not wait for the supervisor watchdog');
  assert.equal(status.activeCount, 0, 'a cancelled create/start await must release the active slot');
  const task = host.taskResult({ graphId: 'cancel-create-chat', taskId: 'stuck' });
  assert.equal(task.state, 'CANCELLED');
  assert.equal(task.error.code, 'cancelled');
  assert.equal(task.error.message, 'user-cancel');
  assert.equal(task.attempts, 1, 'graph cancellation must never replay the workload');
  assert.equal(task.trace[0].outcome, 'cancelled');
  assert.equal(task.trace[0].leaseReleasedAt !== null, true, 'cancellation must still complete lease cleanup');
  assert.equal(host.taskResult({ graphId: 'cancel-create-chat', taskId: 'after' }).state, 'CANCELLED');
  assert.equal(pool.releaseCalls, 1, 'the hung createChat lease must be released once');
  assert.equal(pool.leases.size, 0, 'no Worker lease may outlive the cancelled graph');
  host.close();
}

async function testCancelInterruptsHangingStartPhase() {
  const pool = new HangingWorkerPool({ hangPhase: 'start' });
  const host = graphHost(pool, { supervisorWatchdogTimeoutMs: 4000, retryBaseDelayMs: 0 });
  await host.start({
    graphId: 'cancel-start',
    runId: 'run-cancel-start',
    tasks: [{ id: 'stuck', dependencies: [], instruction: 'stuck' }],
  });
  await enteredPhase(pool, 'start');
  host.cancel({ graphId: 'cancel-start', reason: 'supervisor-stop' });
  const status = await waitTerminal(host, 'cancel-start');
  assert.equal(status.state, 'CANCELLED');
  const task = host.taskResult({ graphId: 'cancel-start', taskId: 'stuck' });
  assert.equal(task.state, 'CANCELLED');
  assert.equal(task.error.code, 'cancelled');
  assert.equal(pool.releaseCalls, 1);
  host.close();
}

async function testCancelInterruptsHangingPhaseWithoutRunId() {
  const pool = new HangingWorkerPool({ hangPhase: 'createChat' });
  const host = graphHost(pool);
  await host.start({
    graphId: 'cancel-no-run',
    tasks: [{ id: 'stuck', dependencies: [], instruction: 'stuck' }],
  });
  await enteredPhase(pool, 'createChat');
  host.cancel({ graphId: 'cancel-no-run', reason: 'caller-cancel' });
  const status = await waitTerminal(host, 'cancel-no-run');
  assert.equal(status.state, 'CANCELLED');
  assert.equal(host.taskResult({ graphId: 'cancel-no-run', taskId: 'stuck' }).error.code, 'cancelled');
  assert.equal(pool.leases.size, 0);
  host.close();
}

async function testHostCloseInterruptsHangingPhase() {
  const pool = new HangingWorkerPool({ hangPhase: 'createChat' });
  const host = graphHost(pool, { supervisorWatchdogTimeoutMs: 4000 });
  await host.start({
    graphId: 'host-close',
    runId: 'run-host-close',
    tasks: [{ id: 'stuck', dependencies: [], instruction: 'stuck' }],
  });
  await enteredPhase(pool, 'createChat');
  host.close();
  const status = await waitTerminal(host, 'host-close');
  assert.equal(status.state, 'CANCELLED');
  assert.equal(status.cancelReason, 'task-graph-host-closed');
  assert.equal(pool.leases.size, 0, 'teardown must not strand an active lease');
}

async function testWatchdogCauseStaysDistinctFromCancellation() {
  const pool = new HangingWorkerPool({ hangPhase: 'createChat' });
  const host = graphHost(pool, { supervisorWatchdogTimeoutMs: 25, retryBaseDelayMs: 0 });
  await host.start({
    graphId: 'watchdog-create-chat',
    runId: 'run-watchdog-create-chat',
    tasks: [{ id: 'stuck', dependencies: [], instruction: 'stuck', maxAttempts: 1 }],
  });
  const status = await waitTerminal(host, 'watchdog-create-chat');
  assert.equal(status.state, 'FAILED');
  const task = host.taskResult({ graphId: 'watchdog-create-chat', taskId: 'stuck' });
  assert.equal(task.error.code, 'supervisor-watchdog-timeout');
  assert.equal(task.trace[0].outcome, 'failed');
  assert.equal(pool.releaseCalls, 1, 'watchdog expiry must still complete lease cleanup');
  host.close();
}

async function testSuccessfulCreateAndStartStillCompletes() {
  const pool = new HangingWorkerPool({ hangPhase: null });
  const host = graphHost(pool, { supervisorWatchdogTimeoutMs: 4000 });
  await host.start({
    graphId: 'healthy',
    runId: 'run-healthy',
    tasks: [{ id: 'ok', dependencies: [], instruction: 'ok' }],
  });
  const status = await waitTerminal(host, 'healthy');
  assert.equal(status.state, 'SUCCEEDED');
  assert.equal(host.taskResult({ graphId: 'healthy', taskId: 'ok' }).state, 'SUCCEEDED');
  host.close();
}

function graphHost(workerPool, options = {}) {
  return new DynamicTaskGraphHost({
    workerPool,
    cryptoRef: webcrypto,
    pollMs: 1,
    cleanupTimeoutMs: 50,
    supervisorWatchdogTimeoutMs: options.supervisorWatchdogTimeoutMs ?? 4000,
    retryBaseDelayMs: options.retryBaseDelayMs ?? 0,
  });
}

async function enteredPhase(pool, phase) {
  const settled = await Promise.race([pool.entered.get(phase).then(() => true), delay(1500).then(() => false)]);
  assert.equal(settled, true, `task never reached the ${phase} phase`);
}

async function waitTerminal(host, graphId, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = host.status({ graphId });
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status.state)) return status;
    await delay(2);
  }
  throw new Error(`graph ${graphId} did not settle: ${host.status({ graphId }).state}`);
}

class HangingWorkerPool {
  constructor({ hangPhase = null } = {}) {
    this.hangPhase = hangPhase;
    this.entered = new Map();
    this.resolvers = new Map();
    for (const phase of ['claim', 'createChat', 'start', 'waitResult']) {
      this.entered.set(phase, new Promise((resolve) => this.resolvers.set(phase, resolve)));
    }
    this.leases = new Map();
    this.releaseCalls = 0;
    this.discardCalls = 0;
    this.sequence = 0;
  }

  mark(phase) {
    const resolve = this.resolvers.get(phase);
    if (resolve) resolve(phase);
  }

  async provision() { return { readyCount: 1 }; }
  status() { return { readyCount: 1, claimedCount: this.leases.size }; }

  async claim({ taskId } = {}) {
    this.mark('claim');
    this.sequence += 1;
    const leaseId = `lease-${this.sequence}`;
    this.leases.set(leaseId, { taskId, state: 'claimed' });
    return { leaseId, slot: this.sequence, workerId: `worker-${this.sequence}` };
  }

  async createChat({ leaseId } = {}) {
    this.mark('createChat');
    this.require(leaseId).state = 'chat-pending';
    if (this.hangPhase === 'createChat') return new Promise(() => {});
    this.require(leaseId).state = 'claimed';
    return { prepared: true };
  }

  async start({ leaseId } = {}) {
    this.mark('start');
    if (this.hangPhase === 'start') return new Promise(() => {});
    const lease = this.require(leaseId);
    lease.state = 'working';
    lease.retained = { status: 'completed', responseText: `done:${lease.taskId}` };
    return { started: true };
  }

  async waitResult({ leaseId } = {}) {
    this.mark('waitResult');
    if (this.hangPhase === 'waitResult') return new Promise(() => {});
    return this.require(leaseId).retained || { status: 'available' };
  }

  async result({ leaseId }) {
    const lease = this.require(leaseId);
    if (lease.state === 'working') return { status: 'working' };
    return lease.retained || { status: 'available' };
  }

  async stop({ leaseId }) {
    const lease = this.require(leaseId);
    lease.state = 'cancelled';
    lease.retained = { status: 'cancelled', error: { code: 'cancelled', message: 'stopped' } };
    return { outcome: 'stopped' };
  }

  async release({ leaseId }) {
    this.releaseCalls += 1;
    this.leases.delete(String(leaseId));
    return { released: true };
  }

  async discard({ leaseId }) {
    this.discardCalls += 1;
    this.leases.delete(String(leaseId));
    return { discarded: true };
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
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

await testCancelInterruptsHangingCreateChat();
await testCancelInterruptsHangingStartPhase();
await testCancelInterruptsHangingPhaseWithoutRunId();
await testHostCloseInterruptsHangingPhase();
await testWatchdogCauseStaysDistinctFromCancellation();
await testSuccessfulCreateAndStartStillCompletes();
assert.deepEqual(unhandled, [], 'cancellation races must not leak unhandled rejections');
console.log('issue #5073 graph cancel reaches create/start supervisor phases: ok');
