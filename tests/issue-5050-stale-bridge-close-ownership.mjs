// Regression for #5050: a stale IframeWorkerCompletionBridge.close() must
// restore only the wrapper it currently owns. It must never overwrite the
// start/followup wrappers installed by a newer bridge on the same pool, and
// a correctly closed pool must keep completion tracking for the next bridge.
import assert from 'node:assert/strict';
import { IframeWorkerCompletionBridge } from '../js/userscript/dev/frame-mesh/iframe-worker-completion-bridge.js';

function createPool() {
  const slot = {
    index: 0,
    href: 'https://example.test/',
    client: null,
    runtime: null,
    runtimeDocument: null,
    ready: true,
    claimed: true,
    reserving: false,
    leaseId: 'lease-1',
    workerId: 'worker-1',
    runId: 'pool-run-1',
    taskId: null,
    pending: null,
    lastResult: null,
  };
  return {
    slots: new Map([[0, slot]]),
    async claim({ runId } = {}) { return { leaseId: slot.leaseId, runId, workerId: slot.workerId }; },
    async release() { return { released: true }; },
    async start({ leaseId, instruction } = {}) {
      const held = this.requireLease(leaseId);
      if (held.pending) {
        const error = new Error('Worker slot already has an active task.');
        error.code = 'worker-busy';
        throw error;
      }
      const text = String(instruction || '').trim();
      const pending = Promise.resolve().then(() => ({ status: 'available', output: text }));
      held.pending = pending;
      held.lastResult = null;
      pending.then(
        (result) => { held.lastResult = result; held.pending = null; },
        (failure) => {
          held.lastResult = { status: 'failed', error: { code: String(failure?.code || 'provider-error'), message: String(failure?.message || failure).slice(0, 512) } };
          held.pending = null;
        },
      );
      return { started: true, leaseId: held.leaseId, runId: held.runId, workerId: held.workerId };
    },
    async followup({ leaseId, text } = {}) {
      this.requireLease(leaseId);
      return Promise.resolve().then(() => ({ status: 'available', output: String(text || '').trim() }));
    },
    requireLease(value) {
      const held = this.slots.get(0);
      if (!held || held.leaseId !== String(value ?? '')) {
        const error = new Error('No active lease.');
        error.code = 'worker-lease-unknown';
        throw error;
      }
      return held;
    },
  };
}

function createCoordinator() {
  return {
    queue: [],
    enqueue(event) { this.queue.push(event); },
    async waitEvent() { return new Promise(() => {}); },
  };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

// 1. The minimal counterexample from the issue: bridge A then bridge B on the
//    same pool; closing stale A must leave B's wrappers installed.
{
  const pool = createPool();
  const coordinator = createCoordinator();
  const a = new IframeWorkerCompletionBridge({ workerPool: pool, coordinator });
  const b = new IframeWorkerCompletionBridge({ workerPool: pool, coordinator });
  const bStart = pool.start;
  const bFollowup = pool.followup;
  assert.notEqual(bStart, a.originalStart);
  a.close();
  assert.equal(pool.start, bStart, 'stale A.close() must not replace the newer bridge wrapper for start');
  assert.equal(pool.followup, bFollowup, 'stale A.close() must not replace the newer bridge wrapper for followup');
  b.close();
  assert.notEqual(pool.start, bStart, 'B.close() still releases its own wrapper');
  assert.notEqual(pool.followup, bFollowup, 'B.close() still releases its own wrapper');
}

// 2. After a correct single-bridge close, the next bridge installed on the
//    same pool keeps full occurrence/completion tracking.
{
  const pool = createPool();
  const coordinator = createCoordinator();
  const a = new IframeWorkerCompletionBridge({ workerPool: pool, coordinator });
  const aStart = pool.start;
  a.close();
  assert.notEqual(pool.start, aStart, 'closing the owning bridge releases its wrapper');
  a.close();
  const b = new IframeWorkerCompletionBridge({ workerPool: pool, coordinator });
  await b.claim({ runId: 'run-b' });
  await pool.start({ leaseId: 'lease-1', runId: 'run-b', instruction: 'go' });
  await settle();
  await pool.followup({ leaseId: 'lease-1', runId: 'run-b', text: 'again' });
  await settle();
  b.close();
  const completions = coordinator.queue.filter((event) => event.type === 'worker.completed');
  assert.equal(completions.length, 2, 'start and followup through the live bridge publish worker.completed exactly once each');
  assert.equal(completions[0].data.source, 'iframe-worker-pool');
  assert.equal(completions[0].data.runId, 'run-b');
  assert.equal(completions[1].data.runId, 'run-b');
  assert.notEqual(completions[0].data.completionId, completions[1].data.completionId);
}

console.log('issue #5050 stale bridge close wrapper identity regressions PASS');
