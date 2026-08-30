import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { DynamicTaskGraphHost } from '../../js/userscript/dev/task-graph/dynamic-task-graph.js';
import { SingleConversationWorkerCoordinator } from '../../js/userscript/dev/single-tab/single-conversation-worker-coordinator.js';

await testSupervisorWatchdogBoundsUnattendedWait();
await testRunScopedRetryUsesBackoff();
await testCompletionDeliveryCannotRewriteSuccess();
await testSuccessfulWorkIsNotRetriedForCleanupFailure();
await testSupervisorRestoreFailurePreservesWorkerCompletion();
console.log('agent loop resilience: ok');

async function testSupervisorWatchdogBoundsUnattendedWait() {
  const pool = new FakePool([{ hang: true }]);
  const host = graphHost(pool, { supervisorWatchdogTimeoutMs: 25, retryBaseDelayMs: 0 });
  await host.start({
    graphId: 'watchdog',
    runId: 'run-watchdog',
    tasks: [{ id: 'stuck', dependencies: [], instruction: 'stuck', maxAttempts: 1 }],
  });
  const status = await waitTerminal(host, 'watchdog');
  assert.equal(status.state, 'FAILED');
  const task = host.taskResult({ graphId: 'watchdog', taskId: 'stuck' });
  assert.equal(task.error.code, 'supervisor-watchdog-timeout');
  assert.equal(task.timeoutMs, null, 'internal unattended watchdog must not fabricate a caller deadline');
  assert.equal(pool.releaseCalls, 1, 'watchdog expiry must still complete Worker lease cleanup');
  host.close();
}

async function testRunScopedRetryUsesBackoff() {
  const pool = new FakePool([
    { result: { status: 'failed', error: { code: 'transient', message: 'retry me' } } },
    { result: { status: 'completed', responseText: 'done' } },
  ]);
  const host = graphHost(pool, { supervisorWatchdogTimeoutMs: 500, retryBaseDelayMs: 35 });
  await host.start({
    graphId: 'backoff',
    runId: 'run-backoff',
    tasks: [{ id: 'retry', dependencies: [], instruction: 'retry', maxAttempts: 2 }],
  });
  const status = await waitTerminal(host, 'backoff');
  assert.equal(status.state, 'SUCCEEDED');
  const task = host.taskResult({ graphId: 'backoff', taskId: 'retry' });
  assert.equal(task.attempts, 2);
  assert.equal(pool.claimTimes.length, 2);
  assert.ok(pool.claimTimes[1] - pool.claimTimes[0] >= 25, 'transient failure must not consume the next attempt immediately');
  host.close();
}

async function testCompletionDeliveryCannotRewriteSuccess() {
  const syncPool = new FakePool([{ result: { status: 'completed', responseText: 'sync' } }]);
  const syncHost = graphHost(syncPool, {
    onWorkerCompletion() { throw new Error('sync delivery failure'); },
  });
  await syncHost.start({
    graphId: 'sync-delivery',
    runId: 'run-sync-delivery',
    tasks: [{ id: 'sync', dependencies: [], instruction: 'sync', maxAttempts: 1 }],
  });
  assert.equal((await waitTerminal(syncHost, 'sync-delivery')).state, 'SUCCEEDED');
  assert.equal(syncHost.taskResult({ graphId: 'sync-delivery', taskId: 'sync' }).state, 'SUCCEEDED');
  syncHost.close();

  let unhandled = null;
  const onUnhandled = (reason) => { unhandled = reason; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const asyncPool = new FakePool([{ result: { status: 'completed', responseText: 'async' } }]);
    const asyncHost = graphHost(asyncPool, {
      onWorkerCompletion: async () => { throw new Error('async delivery failure'); },
    });
    await asyncHost.start({
      graphId: 'async-delivery',
      runId: 'run-async-delivery',
      tasks: [{ id: 'async', dependencies: [], instruction: 'async', maxAttempts: 1 }],
    });
    assert.equal((await waitTerminal(asyncHost, 'async-delivery')).state, 'SUCCEEDED');
    await delay(0);
    assert.equal(unhandled, null, 'async completion observer rejection must be contained');
    asyncHost.close();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}

async function testSuccessfulWorkIsNotRetriedForCleanupFailure() {
  const pool = new FakePool(
    [{ result: { status: 'completed', responseText: 'external side effect already committed' } }],
    { releaseError: true, discardError: true },
  );
  const host = graphHost(pool, { retryBaseDelayMs: 1 });
  await host.start({
    graphId: 'cleanup-after-success',
    runId: 'run-cleanup-after-success',
    tasks: [{ id: 'side-effect', dependencies: [], instruction: 'side-effect', maxAttempts: 3 }],
  });
  const status = await waitTerminal(host, 'cleanup-after-success');
  assert.equal(status.state, 'SUCCEEDED');
  const task = host.taskResult({ graphId: 'cleanup-after-success', taskId: 'side-effect' });
  assert.equal(task.state, 'SUCCEEDED');
  assert.equal(task.attempts, 1, 'post-success cleanup failure must never replay the workload');
  assert.equal(task.cleanupWarning.code, 'lease-cleanup-failed');
  assert.equal(task.trace[0].cleanupWarning.code, 'lease-cleanup-failed');
  assert.equal(task.trace[0].leaseReleasedAt, null, 'trace must not claim a release that failed');
  host.close();
}

async function testSupervisorRestoreFailurePreservesWorkerCompletion() {
  const supervisor = { id: 'supervisor', url: 'https://chatgpt.com/c/supervisor' };
  const worker = { id: 'worker', url: 'https://chatgpt.com/c/worker' };
  let page = supervisor;
  const controller = {
    on() { return () => {}; },
    currentConversation() { return page; },
    currentUserAnchors() { return [{ id: `${page.id}-turn`, text: page.id }]; },
    observe() { return { state: 'QUIET' }; },
    isActive() { return false; },
    workerConversation() { return worker; },
    result() { return { status: 'completed', responseText: 'done', chatgptConversationId: worker.id }; },
    async navigateToConversation() {
      const error = new Error('restore route failed');
      error.code = 'conversation-mismatch';
      throw error;
    },
  };
  const coordinator = new SingleConversationWorkerCoordinator({ controller, tabNodeId: 'single-tab' });
  await coordinator.claim({ runId: 'restore-run', workerId: 'restore-worker' });
  page = worker;
  await coordinator.finishTerminal({ kind: 'completed', data: { responseText: 'done' } });

  const result = await coordinator.result({ runId: 'restore-run', workerId: 'restore-worker' });
  assert.equal(String(result.status).toLowerCase(), 'completed', 'restore fault must not rewrite successful Worker status');
  assert.equal(result.supervisorRestoreError.code, 'conversation-mismatch');
  const event = await coordinator.waitEvent({ events: ['worker.completed'], runId: 'restore-run' });
  assert.equal(event.type, 'worker.completed', 'restore fault must preserve the terminal completion event');
  assert.equal(event.data.supervisorRestoreError.code, 'conversation-mismatch');
  coordinator.close();
}

function graphHost(workerPool, options = {}) {
  return new DynamicTaskGraphHost({
    workerPool,
    cryptoRef: webcrypto,
    pollMs: 1,
    cleanupTimeoutMs: 50,
    supervisorWatchdogTimeoutMs: options.supervisorWatchdogTimeoutMs ?? 500,
    retryBaseDelayMs: options.retryBaseDelayMs ?? 0,
    onWorkerCompletion: options.onWorkerCompletion ?? null,
  });
}

async function waitTerminal(host, graphId, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = host.status({ graphId });
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status.state)) return status;
    await delay(2);
  }
  throw new Error(`graph ${graphId} did not settle`);
}

class FakePool {
  constructor(attempts, { releaseError = false, discardError = false } = {}) {
    this.attemptPlans = attempts;
    this.releaseError = releaseError;
    this.discardError = discardError;
    this.claimTimes = [];
    this.releaseCalls = 0;
    this.sequence = 0;
    this.leases = new Map();
  }

  async provision() { return { readyCount: 1 }; }
  status() { return { readyCount: 1 }; }

  async claim({ signal } = {}) {
    if (signal?.aborted) throw abortError(signal.reason);
    this.claimTimes.push(Date.now());
    const index = this.sequence++;
    const leaseId = `lease-${index + 1}`;
    const plan = this.attemptPlans[Math.min(index, this.attemptPlans.length - 1)] || {};
    this.leases.set(leaseId, { plan, state: 'claimed', retained: null });
    return { leaseId, slot: 1, workerId: `worker-${index + 1}` };
  }

  async createChat() { return { prepared: true }; }
  async start() { return { started: true }; }

  waitResult({ leaseId }, { signal } = {}) {
    const lease = this.require(leaseId);
    if (lease.plan.hang) {
      lease.state = 'working';
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(abortError(signal.reason));
        const onAbort = () => reject(abortError(signal?.reason));
        signal?.addEventListener?.('abort', onAbort, { once: true });
      });
    }
    lease.retained = lease.plan.result || { status: 'completed', responseText: 'done' };
    lease.state = String(lease.retained.status || '').toLowerCase();
    return Promise.resolve(lease.retained);
  }

  async result({ leaseId }) {
    const lease = this.require(leaseId);
    if (lease.state === 'working') return { status: 'working' };
    return lease.retained || { status: lease.state === 'claimed' ? 'available' : lease.state };
  }

  async stop({ leaseId }) {
    const lease = this.require(leaseId);
    lease.state = 'cancelled';
    lease.retained = { status: 'cancelled', error: { code: 'cancelled', message: 'stopped' } };
    return { outcome: 'stopped' };
  }

  async release({ leaseId }) {
    this.releaseCalls += 1;
    if (this.releaseError) {
      const error = new Error('release failed');
      error.code = 'transport-failure';
      throw error;
    }
    this.leases.delete(leaseId);
    return { released: true };
  }

  async discard({ leaseId }) {
    if (this.discardError) {
      const error = new Error('discard failed');
      error.code = 'worker-reprovision-failed';
      throw error;
    }
    this.leases.delete(leaseId);
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

function abortError(reason) {
  const error = new Error(String(reason || 'aborted'));
  error.name = 'AbortError';
  error.code = 'cancelled';
  return error;
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
