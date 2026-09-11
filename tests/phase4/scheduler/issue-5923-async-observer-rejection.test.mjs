import assert from 'node:assert/strict';
import {
  AnalysisScheduler,
} from '../../../js/core/scheduler/index.js';
import {
  ArtifactStore,
  ArtifactHotCache,
  MemoryArtifactBackend,
  createArtifactDescriptor,
} from '../../../js/core/artifacts/index.js';

function makeStore() {
  return new ArtifactStore({
    backend: new MemoryArtifactBackend(),
    hotCache: new ArtifactHotCache({ maxBytes: 65536, maxEntries: 32 }),
  });
}

function makeDesc(num) {
  return createArtifactDescriptor({
    binaryId: 'bin_issue_5923',
    passId: 'issue-5923',
    artifactKind: 'semantic-ir-v2',
    producerId: 'issue-5923-test',
    loaderVersion: '1.0.0',
    architectureSemanticVersion: '1.0.0',
    abiSemanticVersion: '1.0.0',
    semanticSchemaVersion: '1.0.0',
    config: { num },
    upstreamArtifactIds: [],
  });
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

async function captureUnhandled(run) {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    await run(unhandled);
    await turn();
  } finally {
    process.removeListener('unhandledRejection', listener);
  }
  return unhandled;
}

// A rejected observer Promise is fire-and-forget telemetry: it must be consumed,
// counted, and must not change scheduler task completion.
{
  let observerCalls = 0;
  const scheduler = new AnalysisScheduler({
    store: makeStore(),
    maxConcurrency: 1,
    onEvent() {
      observerCalls++;
      if (observerCalls === 1) return Promise.reject(new Error('async-observer-failure'));
      return undefined;
    },
  });

  const unhandled = await captureUnhandled(async () => {
    const result = await scheduler.request({
      descriptor: makeDesc(1),
      produce: async () => ({ ok: true }),
    });
    assert.equal(result.state, 'completed');
  });

  assert.deepEqual(unhandled, []);
  assert.equal(scheduler.stats().observerFailures, 1);
  assert.equal(observerCalls, 4, 'observer rejection must not recursively emit lifecycle events');
}

// An async observer that throws has the same isolation contract as an explicit
// Promise.reject() return.
{
  let observerCalls = 0;
  const scheduler = new AnalysisScheduler({
    store: makeStore(),
    maxConcurrency: 1,
    async onEvent() {
      observerCalls++;
      if (observerCalls === 1) throw new Error('async-function-observer-failure');
    },
  });

  const unhandled = await captureUnhandled(async () => {
    const result = await scheduler.request({
      descriptor: makeDesc(4),
      produce: async () => ({ ok: true }),
    });
    assert.equal(result.state, 'completed');
  });

  assert.deepEqual(unhandled, []);
  assert.equal(scheduler.stats().observerFailures, 1);
  assert.equal(observerCalls, 4);
}

// A pending observer Promise must never be awaited by the scheduler. Its later
// rejection is still isolated and counted once when it eventually settles.
{
  let rejectObserver;
  let observerCalls = 0;
  const pending = new Promise((_resolve, reject) => { rejectObserver = reject; });
  const scheduler = new AnalysisScheduler({
    store: makeStore(),
    maxConcurrency: 1,
    onEvent() {
      observerCalls++;
      return observerCalls === 1 ? pending : undefined;
    },
  });

  const unhandled = await captureUnhandled(async () => {
    const result = await scheduler.request({
      descriptor: makeDesc(2),
      produce: async () => ({ ok: true }),
    });
    assert.equal(result.state, 'completed', 'request must finish while observer Promise is pending');
    assert.equal(scheduler.stats().observerFailures, 0);
    rejectObserver(new Error('delayed-observer-failure'));
    await turn();
    assert.equal(scheduler.stats().observerFailures, 1);
  });

  assert.deepEqual(unhandled, []);
  assert.equal(observerCalls, 4);
}

// Fulfilled observer Promises keep the existing sequence/gauge semantics and do
// not increment the failure counter.
{
  const events = [];
  const scheduler = new AnalysisScheduler({
    store: makeStore(),
    maxConcurrency: 1,
    onEvent(event) {
      events.push(event);
      return Promise.resolve();
    },
  });

  const result = await scheduler.request({
    descriptor: makeDesc(3),
    produce: async () => ({ ok: true }),
  });
  await turn();

  assert.equal(result.state, 'completed');
  assert.equal(scheduler.stats().observerFailures, 0);
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4]);
  assert.deepEqual(events.map((event) => event.type), [
    'request.received',
    'queue.enqueued',
    'job.started',
    'job.completed',
  ]);
}

console.log('issue-5923 async scheduler observer rejection regression: PASS');
