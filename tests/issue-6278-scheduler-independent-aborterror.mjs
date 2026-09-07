import assert from 'node:assert/strict';
import { AnalysisScheduler } from '../js/core/scheduler/analysis-scheduler.js';
import { SchedulerDependencyError } from '../js/core/scheduler/index.js';
import { descriptor, scheduler, TestStore, waitState, delay } from './phase4/scheduler/helpers.mjs';

// 1. non-aborted task + producer throws new DOMException(..., 'AbortError') -> failed / producerFailures++ / job.failed
{
  const events = [];
  const { store, scheduler: s } = scheduler({
    maxConcurrency: 1,
    onEvent: (e) => events.push(e),
  });
  const target = descriptor('producer-aborterror');
  const independentAbortError = new DOMException('producer internal abort', 'AbortError');

  const error = await s.request({
    descriptor: target,
    produce: async () => {
      throw independentAbortError;
    },
  }).catch((e) => e);

  assert.equal(error, independentAbortError);
  assert.equal(s.state(target.artifactId), 'failed');
  assert.equal(s.stats().producerFailures, 1);
  assert.equal(s.stats().cancelledJobs, 0);
  assert.equal(s.stats().failedJobs, 1);

  const jobFailedEvt = events.find((e) => e.type === 'job.failed');
  assert.ok(jobFailedEvt, 'should emit job.failed');
  assert.equal(jobFailedEvt.details.name, 'AbortError');
  const jobCancelledEvt = events.find((e) => e.type === 'job.cancelled');
  assert.equal(jobCancelledEvt, undefined, 'should NOT emit job.cancelled');
}

// 2. non-aborted task + storage-side independent AbortError -> storageFailures++ / storage.failed (not cancelled)
{
  const events = [];
  class FailingStorage extends TestStore {
    async publish() {
      const err = new Error('IndexedDB transaction aborted');
      err.name = 'AbortError';
      err.code = 'artifact-storage-transaction-aborted';
      throw err;
    }
  }
  const store = new FailingStorage();
  const { scheduler: s } = scheduler({
    store,
    maxConcurrency: 1,
    onEvent: (e) => events.push(e),
  });
  const target = descriptor('storage-aborterror');

  const error = await s.request({
    descriptor: target,
    produce: async () => ({ data: 1 }),
  }).catch((e) => e);

  assert.equal(error.name, 'AbortError');
  assert.equal(s.state(target.artifactId), 'failed');
  assert.equal(s.stats().storageFailures, 1);
  assert.equal(s.stats().cancelledJobs, 0);
  assert.equal(s.stats().failedJobs, 1);

  const storageFailedEvt = events.find((e) => e.type === 'storage.failed');
  assert.ok(storageFailedEvt, 'should emit storage.failed');
  const jobCancelledEvt = events.find((e) => e.type === 'job.cancelled');
  assert.equal(jobCancelledEvt, undefined, 'should NOT emit job.cancelled');
}

// 3. running task controller abort + AbortError -> cancelled / cancelledJobs++ / job.cancelled
{
  const events = [];
  const { store, scheduler: s } = scheduler({
    maxConcurrency: 1,
    onEvent: (e) => events.push(e),
  });
  const ac = new AbortController();
  const target = descriptor('legitimate-running-cancel');

  const p = s.request({
    descriptor: target,
    signal: ac.signal,
    produce: async ({ signal }) => {
      ac.abort(new DOMException('User cancelled operation', 'AbortError'));
      if (signal.aborted) throw signal.reason;
      return { val: 123 };
    },
  });

  await assert.rejects(async () => p, (err) => err.name === 'AbortError');
  await delay(10);
  assert.equal(s.state(target.artifactId), 'cancelled');
  assert.equal(s.stats().cancelledJobs, 1);
  assert.equal(s.stats().producerFailures, 0);

  const cancelEvt = events.find((e) => e.type === 'job.cancelled');
  assert.ok(cancelEvt, 'should emit job.cancelled');
  assert.equal(cancelEvt.details.phase, 'running');
}

// 4. queued consumer abort -> cancelled / cancelledJobs++
{
  const events = [];
  const { store, scheduler: s } = scheduler({
    maxConcurrency: 1,
    onEvent: (e) => events.push(e),
  });
  let unblockBlocker;
  const blocker = descriptor('blocker-4');
  const blockerPromise = s.request({
    descriptor: blocker,
    produce: async () => {
      await new Promise((r) => { unblockBlocker = r; });
      return { ok: true };
    },
  });

  const ac = new AbortController();
  const queuedTarget = descriptor('queued-cancel-4');
  const queuedPromise = s.request({
    descriptor: queuedTarget,
    signal: ac.signal,
    produce: async () => ({ ok: true }),
  });

  await delay(10);
  ac.abort();
  await assert.rejects(async () => queuedPromise, (err) => err.name === 'AbortError');
  unblockBlocker();
  await blockerPromise;

  assert.equal(s.state(queuedTarget.artifactId), 'cancelled');
  assert.equal(s.stats().cancelledJobs, 1);
}

// 5. pre-aborted signal -> cancelledConsumers++
{
  const { store, scheduler: s } = scheduler();
  const ac = new AbortController();
  ac.abort(new DOMException('Pre-aborted', 'AbortError'));
  const target = descriptor('pre-aborted-target');

  await assert.rejects(
    s.request({ descriptor: target, signal: ac.signal, produce: async () => ({}) }),
    (err) => err.name === 'AbortError',
  );
  assert.equal(s.stats().cancelledConsumers, 1);
}

// 6. dependency cancellation -> parent is SchedulerDependencyError, not cancelled
{
  const { store, scheduler: s } = scheduler({ maxConcurrency: 2 });
  const dep = descriptor('dep-cancellation');
  const root = descriptor('root-cancellation', [dep]);

  const p = s.request({
    descriptor: root,
    dependencies: [{
      descriptor: dep,
      produce: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    }],
    produce: async () => ({}),
  });

  await waitState(s, dep.artifactId, 'running');
  assert.equal(s.cancel(dep.artifactId), true);
  await assert.rejects(p, (err) => err instanceof SchedulerDependencyError && err.cause?.name === 'AbortError');
  assert.equal(s.state(root.artifactId), 'failed');
}

console.log('issue-6278 regression test: PASS');
