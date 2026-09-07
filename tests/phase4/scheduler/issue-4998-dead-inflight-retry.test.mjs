import assert from 'node:assert/strict';
import { createArtifactDescriptor } from '../../../js/core/artifacts/contracts.js';
import { AnalysisScheduler } from '../../../js/core/scheduler/analysis-scheduler.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function descriptor(name) {
  return createArtifactDescriptor({
    binaryId:'bin_issue_4998',
    artifactKind:'phase4-scheduler-dead-inflight',
    producerId:'issue-4998-regression',
    producerVersion:'1',
    versions:{ loader:'1' },
    relevance:{ architectureSemantic:false, abiSemantic:false, semanticSchema:false },
    config:{ name },
  });
}

class NoCacheStore {
  async get(desc, { signal } = {}) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    return { status:'miss', source:'memory', artifactId:desc.artifactId };
  }

  async publish(desc, payload, { signal, completeness = 'complete' } = {}) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    return {
      status:'published',
      artifactId:desc.artifactId,
      payload,
      record:{ completeness },
    };
  }
}

async function waitFor(predicate, message, turns = 1000) {
  for (let i = 0; i < turns; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
}

// Minimal race: after the last consumer aborts, the cancelled producer stays
// unresolved. A fresh request for the same artifact must not attach to that
// dead task or inherit its AbortError.
{
  const store = new NoCacheStore();
  const scheduler = new AnalysisScheduler({ store, maxConcurrency:2 });
  const d = descriptor('last-consumer-retry');
  const oldEntered = deferred();
  const releaseOld = deferred();
  const freshEntered = deferred();
  const releaseFresh = deferred();
  const firstConsumer = new AbortController();
  let oldSignal = null;
  let oldCalls = 0;
  let freshCalls = 0;

  const first = scheduler.request({
    descriptor:d,
    signal:firstConsumer.signal,
    produce:async ({ signal }) => {
      oldCalls++;
      oldSignal = signal;
      oldEntered.resolve();
      await releaseOld.promise;
      if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      return { generation:'old' };
    },
  });

  await oldEntered.promise;
  firstConsumer.abort(new DOMException('first consumer left', 'AbortError'));
  await assert.rejects(first, (error) => error?.name === 'AbortError');
  assert.equal(oldSignal?.aborted, true, 'last consumer must cancel the orphaned producer');
  assert.equal(scheduler.stats().orphanCancellations, 1);

  const fresh = scheduler.request({
    descriptor:d,
    produce:async ({ signal }) => {
      freshCalls++;
      assert.equal(signal.aborted, false, 'fresh generation must not inherit the old controller');
      freshEntered.resolve();
      await releaseFresh.promise;
      return { generation:'fresh' };
    },
  });

  const freshOutcome = fresh.then(
    (value) => ({ status:'resolved', value }),
    (error) => ({ status:'rejected', error }),
  );
  const startOutcome = await Promise.race([
    freshEntered.promise.then(() => ({ status:'started' })),
    freshOutcome,
  ]);
  assert.equal(startOutcome.status, 'started', 'fresh request must not inherit the dead generation AbortError');
  assert.equal(oldCalls, 1);
  assert.equal(freshCalls, 1, 'fresh producer must start while the dead generation is still unsettled');
  assert.equal(scheduler.stats().coalescedRequests, 0, 'dead generation is not a valid coalescing target');

  // Settle the old generation while its replacement is still running. Its
  // identity-guarded finally must not erase the fresh inflight entry, and its
  // stale cancellation must not overwrite the replacement's public state.
  releaseOld.resolve();
  await waitFor(() => scheduler.stats().cancelledJobs === 1, 'old generation must settle as cancelled');
  assert.equal(scheduler.stats().inflight, 1, 'old finally must not delete the replacement inflight entry');
  assert.equal(scheduler.state(d.artifactId), 'running', 'stale cancellation must not overwrite fresh running state');

  releaseFresh.resolve();
  const result = (await freshOutcome).value;
  assert.equal(result.payload.generation, 'fresh');
  assert.equal(result.reused, false);
  await waitFor(() => scheduler.stats().inflight === 0, 'all generations must eventually leave inflight');
  assert.equal(scheduler.state(d.artifactId), 'completed');
}

// A superseded cache lookup is not durable authority. Even if a custom store
// ignores AbortSignal and resolves a stale hit late, it must not publish a
// completed state over the replacement generation.
{
  const oldLookup = deferred();
  const freshGate = deferred();
  const firstController = new AbortController();
  let getCalls = 0;
  let freshCalls = 0;
  const store = {
    async get(desc) {
      getCalls++;
      if (getCalls === 1) return oldLookup.promise;
      return { status:'miss', source:'memory', artifactId:desc.artifactId };
    },
    async publish(desc, payload, { completeness = 'complete' } = {}) {
      return { status:'published', artifactId:desc.artifactId, payload, record:{ completeness } };
    },
  };
  const scheduler = new AnalysisScheduler({ store, maxConcurrency:2 });
  const d = descriptor('stale-cache-hit');

  const first = scheduler.request({
    descriptor:d,
    signal:firstController.signal,
    produce:async () => ({ generation:'old-producer-should-not-run' }),
  });
  await waitFor(() => getCalls === 1, 'old cache lookup must start');
  firstController.abort(new DOMException('old cache consumer left', 'AbortError'));
  await assert.rejects(first, (error) => error?.name === 'AbortError');

  const fresh = scheduler.request({
    descriptor:d,
    produce:async () => {
      freshCalls++;
      await freshGate.promise;
      return { generation:'fresh-after-cache' };
    },
  });
  await waitFor(() => freshCalls === 1, 'fresh generation must start independently of stale cache lookup');
  assert.equal(scheduler.state(d.artifactId), 'running');

  oldLookup.resolve({
    status:'hit',
    source:'memory',
    artifactId:d.artifactId,
    payload:{ generation:'stale-cache' },
    record:{ completeness:'complete' },
  });
  await waitFor(() => scheduler.stats().cancelledJobs === 1, 'stale cache generation must settle as cancelled');
  assert.equal(scheduler.state(d.artifactId), 'running', 'late stale cache hit must not overwrite replacement state');
  assert.equal(scheduler.stats().cacheHits, 0, 'aborted cache hit must not count as reusable evidence');

  freshGate.resolve();
  const result = await fresh;
  assert.equal(result.payload.generation, 'fresh-after-cache');
  assert.equal(scheduler.state(d.artifactId), 'completed');
}

// Publication is special: cancellation after durable publication starts must
// not launch a colliding generation before the store outcome is known (#4595).
// The retry waits, then re-enters through the normal cache path.
{
  const publishEntered = deferred();
  const publishRelease = deferred();
  const controller = new AbortController();
  let entry = null;
  let producerCalls = 0;
  const store = {
    async get(desc, { signal } = {}) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      if (!entry) return { status:'miss', source:'memory', artifactId:desc.artifactId };
      return { status:'hit', source:'memory', artifactId:desc.artifactId, ...entry };
    },
    async publish(desc, payload, { completeness = 'complete' } = {}) {
      publishEntered.resolve();
      await publishRelease.promise;
      entry = { payload, record:{ completeness } };
      return { status:'published', artifactId:desc.artifactId, ...entry };
    },
  };
  const scheduler = new AnalysisScheduler({ store, maxConcurrency:2 });
  const d = descriptor('publish-outcome-authority');

  const first = scheduler.request({
    descriptor:d,
    signal:controller.signal,
    produce:async () => {
      producerCalls++;
      return { generation:'durable' };
    },
  });
  await publishEntered.promise;
  controller.abort(new DOMException('consumer left during publish', 'AbortError'));

  const second = scheduler.request({
    descriptor:d,
    produce:async () => {
      producerCalls++;
      return { generation:'duplicate' };
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(producerCalls, 1, 'replacement must wait for in-flight publication authority');

  publishRelease.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.payload.generation, 'durable');
  assert.equal(secondResult.payload.generation, 'durable');
  assert.equal(secondResult.reused, true);
  assert.equal(producerCalls, 1, 'committed publication must satisfy the retry from cache');
  assert.equal(scheduler.stats().coalescedRequests, 0, 'waiting for durable outcome is not consumer coalescing');
}

// Cancelling one of two consumers must preserve the live shared producer for
// the remaining consumer; the fix must not turn ordinary consumer isolation
// into eager producer cancellation.
{
  const store = new NoCacheStore();
  const scheduler = new AnalysisScheduler({ store, maxConcurrency:1 });
  const d = descriptor('one-of-two-cancel');
  const gate = deferred();
  const firstController = new AbortController();
  let producerSignal = null;
  let producerCalls = 0;

  const first = scheduler.request({
    descriptor:d,
    signal:firstController.signal,
    produce:async ({ signal }) => {
      producerCalls++;
      producerSignal = signal;
      await gate.promise;
      return { ok:true };
    },
  });
  await waitFor(() => producerSignal != null, 'shared producer must start');

  const second = scheduler.request({
    descriptor:d,
    produce:async () => {
      producerCalls++;
      return { unexpected:true };
    },
  });

  firstController.abort(new DOMException('only first consumer left', 'AbortError'));
  await assert.rejects(first, (error) => error?.name === 'AbortError');
  assert.equal(producerSignal.aborted, false, 'remaining consumer keeps the shared producer alive');
  assert.equal(scheduler.stats().orphanCancellations, 0);

  gate.resolve();
  const result = await second;
  assert.equal(result.payload.ok, true);
  assert.equal(producerCalls, 1);
  assert.equal(scheduler.stats().coalescedRequests, 1);
}

// Ordinary live same-artifact requests still coalesce; only dead/aborting
// generations lose eligibility.
{
  const store = new NoCacheStore();
  const scheduler = new AnalysisScheduler({ store, maxConcurrency:1 });
  const d = descriptor('ordinary-coalescing');
  const gate = deferred();
  let calls = 0;

  const first = scheduler.request({
    descriptor:d,
    produce:async () => {
      calls++;
      await gate.promise;
      return { value:1 };
    },
  });
  await waitFor(() => scheduler.state(d.artifactId) === 'running', 'first producer must run');
  const second = scheduler.request({
    descriptor:d,
    produce:async () => {
      calls++;
      return { value:2 };
    },
  });
  gate.resolve();

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.payload.value, 1);
  assert.equal(b.payload.value, 1);
  assert.equal(calls, 1);
  assert.equal(scheduler.stats().coalescedRequests, 1);
}

console.log('issue #4998 scheduler dead inflight retry: PASS');
