import assert from 'node:assert/strict';
import { AnalysisScheduler } from '../../../js/core/scheduler/index.js';
import {
  ArtifactHotCache,
  ArtifactStore,
  MemoryArtifactBackend,
  ArtifactStorageError,
  createArtifactDescriptor,
} from '../../../js/core/artifacts/index.js';
import { BudgetExceededError } from '../../../js/core/budgets/index.js';

function makeStore() {
  return new ArtifactStore({
    backend: new MemoryArtifactBackend(),
    hotCache: new ArtifactHotCache({ maxBytes: 65536, maxEntries: 32 }),
  });
}

function descriptor(num, upstreamArtifactIds = []) {
  return createArtifactDescriptor({
    binaryId: 'bin_issue_5087',
    passId: 'issue-5087',
    artifactKind: 'semantic-ir-v2',
    producerId: 'issue-5087-producer',
    loaderVersion: '1.0.0',
    architectureSemanticVersion: '1.0.0',
    abiSemanticVersion: '1.0.0',
    semanticSchemaVersion: '1.0.0',
    config: { num },
    upstreamArtifactIds,
  });
}

function terminalEvent(events, artifactId, type) {
  const matches = events.filter((event) => event.artifactId === artifactId && event.type === type);
  assert.equal(matches.length, 1, `${type} must be emitted exactly once`);
  return matches[0];
}

function assertCurrentState(scheduler, event, expected) {
  assert.equal(scheduler.state(event.artifactId), expected, 'scheduler state must already be terminal');
  assert.equal(event.state, expected, `${event.type} must report current scheduler state`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message, turns = 1000) {
  for (let i = 0; i < turns; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
}

// Published completion and warm cache completion must both report completed.
{
  const events = [];
  const store = makeStore();
  const scheduler = new AnalysisScheduler({ store, onEvent: (event) => events.push(event) });
  const desc = descriptor(1);
  await scheduler.request({ descriptor: desc, produce: async () => ({ ok: true }) });
  assertCurrentState(scheduler, terminalEvent(events, desc.artifactId, 'job.completed'), 'completed');

  events.length = 0;
  await scheduler.request({ descriptor: desc, produce: async () => { throw new Error('warm-cache producer must not run'); } });
  assertCurrentState(scheduler, terminalEvent(events, desc.artifactId, 'cache.hit'), 'completed');
}

// Producer failure.
{
  const events = [];
  const scheduler = new AnalysisScheduler({ store: makeStore(), onEvent: (event) => events.push(event) });
  const desc = descriptor(2);
  await assert.rejects(
    scheduler.request({ descriptor: desc, produce: async () => { throw new Error('producer-failed'); } }),
    /producer-failed/,
  );
  assertCurrentState(scheduler, terminalEvent(events, desc.artifactId, 'job.failed'), 'failed');
}

// Storage failure.
{
  const events = [];
  const store = {
    async get() { return { status: 'miss' }; },
    async publish() { throw new ArtifactStorageError('artifact-storage-write-failed'); },
  };
  const scheduler = new AnalysisScheduler({ store, onEvent: (event) => events.push(event) });
  const desc = descriptor(3);
  await assert.rejects(
    scheduler.request({ descriptor: desc, produce: async () => ({ ok: true }) }),
    (error) => error?.name === 'ArtifactStorageError',
  );
  assertCurrentState(scheduler, terminalEvent(events, desc.artifactId, 'storage.failed'), 'failed');
}

// Budget exhaustion.
{
  const events = [];
  const scheduler = new AnalysisScheduler({ store: makeStore(), onEvent: (event) => events.push(event) });
  const desc = descriptor(4);
  await assert.rejects(
    scheduler.request({
      descriptor: desc,
      produce: async ({ budget }) => {
        budget.consume('steps', 10);
        throw new BudgetExceededError('steps', 1, 10);
      },
    }),
    BudgetExceededError,
  );
  assertCurrentState(scheduler, terminalEvent(events, desc.artifactId, 'budget.exhausted'), 'budget-exhausted');
}

// Running cancellation.
{
  const events = [];
  const scheduler = new AnalysisScheduler({ store: makeStore(), onEvent: (event) => events.push(event) });
  const controller = new AbortController();
  const desc = descriptor(5);
  await assert.rejects(
    scheduler.request({
      descriptor: desc,
      signal: controller.signal,
      produce: async ({ signal }) => {
        controller.abort(new DOMException('cancelled', 'AbortError'));
        if (signal.aborted) throw signal.reason;
        return { ok: true };
      },
    }),
    (error) => error?.name === 'AbortError',
  );
  await new Promise((resolve) => setImmediate(resolve));
  assertCurrentState(scheduler, terminalEvent(events, desc.artifactId, 'job.cancelled'), 'cancelled');
}

// Parent dependency failure.
{
  const events = [];
  const scheduler = new AnalysisScheduler({ store: makeStore(), maxConcurrency: 2, onEvent: (event) => events.push(event) });
  const child = descriptor(60);
  const parent = descriptor(61, [child.artifactId]);
  await assert.rejects(
    scheduler.request({
      descriptor: parent,
      dependencies: [{ descriptor: child, produce: async () => { throw new Error('child-failed'); } }],
      produce: async () => ({ ok: true }),
    }),
    (error) => error?.name === 'SchedulerDependencyError',
  );
  assertCurrentState(scheduler, terminalEvent(events, parent.artifactId, 'dependency.failed'), 'failed');
}

// A superseded generation reports its own terminal cancellation state without
// overwriting the replacement generation's public state for the same artifact.
{
  const events = [];
  const oldEntered = deferred();
  const releaseOld = deferred();
  const freshEntered = deferred();
  const releaseFresh = deferred();
  const store = {
    async get(desc, { signal } = {}) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      return { status: 'miss', artifactId: desc.artifactId };
    },
    async publish(desc, payload, { signal, completeness = 'complete' } = {}) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      return { status: 'published', artifactId: desc.artifactId, payload, record: { completeness } };
    },
  };
  const scheduler = new AnalysisScheduler({ store, maxConcurrency: 2, onEvent: (event) => events.push(event) });
  const controller = new AbortController();
  const desc = descriptor(7);

  const oldRequest = scheduler.request({
    descriptor: desc,
    signal: controller.signal,
    produce: async ({ signal }) => {
      oldEntered.resolve();
      await releaseOld.promise;
      if (signal.aborted) throw signal.reason;
      return { generation: 'old' };
    },
  });
  await oldEntered.promise;
  controller.abort(new DOMException('old consumer left', 'AbortError'));
  await assert.rejects(oldRequest, (error) => error?.name === 'AbortError');

  const freshRequest = scheduler.request({
    descriptor: desc,
    produce: async () => {
      freshEntered.resolve();
      await releaseFresh.promise;
      return { generation: 'fresh' };
    },
  });
  await freshEntered.promise;
  assert.equal(scheduler.state(desc.artifactId), 'running');

  releaseOld.resolve();
  await waitFor(() => events.some((event) => event.type === 'job.cancelled' && event.details.superseded === true), 'superseded cancellation event must arrive');
  const cancelled = events.find((event) => event.type === 'job.cancelled' && event.details.superseded === true);
  assert.equal(cancelled.state, 'cancelled', 'superseded event must describe the cancelled generation');
  assert.equal(scheduler.state(desc.artifactId), 'running', 'stale generation must not overwrite replacement state');

  releaseFresh.resolve();
  await freshRequest;
  assert.equal(scheduler.state(desc.artifactId), 'completed');
}

console.log('issue #5087 lifecycle events report current scheduler state: PASS');
