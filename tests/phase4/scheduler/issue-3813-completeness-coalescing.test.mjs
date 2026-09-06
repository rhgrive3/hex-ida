import assert from 'node:assert/strict';
import { createArtifactDescriptor } from '../../../js/core/artifacts/contracts.js';
import { AnalysisScheduler } from '../../../js/core/scheduler/analysis-scheduler.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function waitState(scheduler, artifactId, state, turns = 1000) {
  for (let i = 0; i < turns; i++) {
    if (scheduler.state(artifactId) === state) return;
    await Promise.resolve();
  }
  assert.fail(`state ${state} not reached for ${artifactId}; got ${scheduler.state(artifactId)}`);
}

function descriptor(name) {
  return createArtifactDescriptor({
    binaryId:'bin_3813_fixture', artifactKind:`fixture-${name}`, producerId:`fixture-${name}`, producerVersion:'1',
    versions:{ loader:'fixture-1' }, relevance:{ architectureSemantic:false, abiSemantic:false, semanticSchema:false },
    config:{ name }, upstreamArtifactIds:[],
  });
}

class NoCacheStore {
  async get(descriptor, { signal } = {}) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    return { status: 'miss', source: 'memory', artifactId: descriptor.artifactId };
  }

  async publish(descriptor, payload, { signal, completeness = 'complete' } = {}) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    return {
      status: 'published',
      artifactId: descriptor.artifactId,
      payload,
      record: { completeness },
    };
  }
}

class CompletenessStore {
  constructor() { this.entries = new Map(); }

  async get(descriptor, { signal } = {}) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    const entry = this.entries.get(descriptor.artifactId);
    if (!entry || entry.completeness !== 'complete') {
      return { status: 'miss', source: 'memory', artifactId: descriptor.artifactId };
    }
    return {
      status: 'hit',
      source: 'memory',
      artifactId: descriptor.artifactId,
      payload: entry.payload,
      record: { completeness: entry.completeness },
    };
  }

  async publish(descriptor, payload, { signal, completeness = 'complete' } = {}) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    const entry = { payload, completeness };
    this.entries.set(descriptor.artifactId, entry);
    return {
      status: 'published',
      artifactId: descriptor.artifactId,
      payload,
      record: { completeness },
    };
  }
}

// #3813 minimal regression: a complete consumer arriving behind an in-flight
// partial producer must not inherit the partial producer's authority.
{
  const store = new CompletenessStore();
  const events = [];
  const scheduler = new AnalysisScheduler({ store, maxConcurrency: 1, onEvent: (event) => events.push(event) });
  const d = descriptor('3813-partial-complete');
  const gate = deferred();
  let partialCalls = 0;
  let completeCalls = 0;

  const partial = scheduler.request({
    descriptor: d,
    completeness: 'partial',
    produce: async () => {
      partialCalls++;
      await gate.promise;
      return { rows: [1] };
    },
  });
  await waitState(scheduler, d.artifactId, 'running');

  const complete = scheduler.request({
    descriptor: d,
    completeness: 'complete',
    produce: async () => {
      completeCalls++;
      return { rows: [1, 2, 3] };
    },
  });

  await Promise.resolve();
  assert.equal(completeCalls, 0, 'incompatible producer must wait for the incumbent artifact slot');
  gate.resolve();

  const [partialResult, completeResult] = await Promise.all([partial, complete]);
  assert.equal(partialResult.record.completeness, 'partial');
  assert.equal(completeResult.record.completeness, 'complete');
  assert.equal(partialCalls, 1);
  assert.equal(completeCalls, 1, 'complete request must run its own producer after partial settles');
  assert.equal(scheduler.stats().coalescedRequests, 0);
  assert.equal(scheduler.stats().requests, 2, 'internal retry must not double-count the logical request');
  assert.equal(
    events.filter((event) => event.type === 'request.received').length,
    2,
    'internal retry must not duplicate externally visible request lifecycle events',
  );

  let cacheProducerCalls = 0;
  const cached = await scheduler.request({
    descriptor: d,
    completeness: 'complete',
    produce: async () => {
      cacheProducerCalls++;
      return { rows: [9] };
    },
  });
  assert.equal(cached.record.completeness, 'complete');
  assert.equal(cached.reused, true);
  assert.equal(cacheProducerCalls, 0, 'complete cache hit must preserve the same requirement');
}

// Compatible requests retain the existing one-producer coalescing behavior.
{
  const store = new NoCacheStore();
  const scheduler = new AnalysisScheduler({ store, maxConcurrency: 1 });
  const d = descriptor('3813-complete-complete');
  const gate = deferred();
  let producerCalls = 0;

  const first = scheduler.request({
    descriptor: d,
    completeness: 'complete',
    produce: async () => {
      producerCalls++;
      await gate.promise;
      return { rows: [1] };
    },
  });
  await waitState(scheduler, d.artifactId, 'running');

  const second = scheduler.request({
    descriptor: d,
    completeness: 'complete',
    produce: async () => {
      producerCalls++;
      return { rows: [2] };
    },
  });
  gate.resolve();

  await Promise.all([first, second]);
  assert.equal(producerCalls, 1);
  assert.equal(scheduler.stats().coalescedRequests, 1);
}

// Non-total incomplete states are compatible only with an identical state.
{
  const states = ['partial', 'bounded', 'truncated', 'unsupported'];
  for (const producerCompleteness of states) {
    for (const consumerCompleteness of states) {
      const store = new NoCacheStore();
      const scheduler = new AnalysisScheduler({ store, maxConcurrency: 1 });
      const d = descriptor(`3813-${producerCompleteness}-${consumerCompleteness}`);
      const gate = deferred();
      let producerCalls = 0;

      const first = scheduler.request({
        descriptor: d,
        completeness: producerCompleteness,
        produce: async () => {
          producerCalls++;
          await gate.promise;
          return { source: producerCompleteness };
        },
      });
      await waitState(scheduler, d.artifactId, 'running');

      const second = scheduler.request({
        descriptor: d,
        completeness: consumerCompleteness,
        produce: async () => {
          producerCalls++;
          return { source: consumerCompleteness };
        },
      });

      gate.resolve();
      const [, result] = await Promise.all([first, second]);
      const compatible = producerCompleteness === consumerCompleteness;
      assert.equal(
        producerCalls,
        compatible ? 1 : 2,
        `${producerCompleteness} -> ${consumerCompleteness} compatibility changed`,
      );
      assert.equal(result.record.completeness, consumerCompleteness);
      assert.equal(scheduler.stats().coalescedRequests, compatible ? 1 : 0);
    }
  }
}

// An incompatible waiter owns only its own cancellation. Aborting it must not
// keep alive or cancel the incumbent producer.
{
  const store = new NoCacheStore();
  const scheduler = new AnalysisScheduler({ store, maxConcurrency: 1 });
  const d = descriptor('3813-waiter-cancel');
  const gate = deferred();
  let firstSignal = null;
  let completeCalls = 0;

  const partial = scheduler.request({
    descriptor: d,
    completeness: 'partial',
    produce: async ({ signal }) => {
      firstSignal = signal;
      await gate.promise;
      return { rows: [1] };
    },
  });
  await waitState(scheduler, d.artifactId, 'running');

  const controller = new AbortController();
  const complete = scheduler.request({
    descriptor: d,
    completeness: 'complete',
    signal: controller.signal,
    produce: async () => {
      completeCalls++;
      return { rows: [1, 2] };
    },
  });
  controller.abort(new DOMException('consumer stopped', 'AbortError'));

  await assert.rejects(complete, (error) => error?.name === 'AbortError');
  assert.equal(firstSignal?.aborted, false, 'waiter cancellation must not cancel the incumbent producer');
  assert.equal(completeCalls, 0);

  gate.resolve();
  await partial;
  assert.equal(scheduler.stats().orphanCancellations, 0);
}

console.log('issue #3813 scheduler completeness coalescing: PASS');
