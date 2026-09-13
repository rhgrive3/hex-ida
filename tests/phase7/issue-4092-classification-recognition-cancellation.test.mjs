import assert from 'node:assert/strict';
import test from 'node:test';

import { ensureRecognitionState } from '../../js/app.js';
import { createAnalysisSnapshot } from '../../js/analysis/query/snapshot.js';
import { createProductSurfaceQueries } from '../../js/analysis/query/product-surface.js';

const SNAPSHOT = createAnalysisSnapshot({ binaryId: 'bin-4092' });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate, message, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function withDeadline(promise, label, timeoutMs = 500) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => setTimeout(() => {
      const error = new Error(`${label} did not settle within ${timeoutMs}ms`);
      error.name = 'ProducerDeadlineError';
      reject(error);
    }, timeoutMs).unref()),
  ]);
}

function surfaceApp(extra = {}) {
  return {
    analysisQueries: { snapshot: async () => SNAPSHOT },
    backend: { gen: 1 },
    store: { get: (key) => (key === 'sliceIndex' ? 0 : null) },
    recognition: null,
    analyzeFunctionAt: async () => ({ model: null }),
    ...extra,
  };
}

function recognitionProducerApp() {
  const knowledge = { revision: 0 };
  let calls = 0;
  const started = deferred();
  const release = deferred();
  knowledge.propagate = async () => {
    calls += 1;
    if (calls === 1) {
      started.resolve();
      await release.promise;
    }
    return { propagated: false };
  };
  const app = {
    backend: { gen: 3, contentHash: 'fixture-4092' },
    symbols: {
      gen: 7,
      functionCount: 2,
      funcs: [0x1000n, 0x2000n],
      functionStartsComplete: true,
      nameAt: (address) => `sub_${address.toString(16)}`,
      functionWindowBound: (address) => address + 4n,
    },
    fields: null,
    knowledge,
    recognition: null,
    recognitionBusy: null,
    recognitionBusyKnowledgeRev: null,
    recognitionKnowledgeRev: null,
    ensureSwift: async () => null,
  };
  return { app, started, release, calls: () => calls };
}

test('#4092 classification forwards its AbortSignal into the ensureRecognition producer contract', async () => {
  let observedSignal = undefined;
  const gate = deferred();
  const app = surfaceApp({
    ensureRecognition: async (options = {}) => {
      observedSignal = options.signal;
      const signal = options.signal;
      if (signal && typeof signal.addEventListener === 'function') {
        await Promise.race([
          gate.promise,
          new Promise((resolve, reject) => signal.addEventListener('abort', () => {
            const error = new Error('producer detached');
            error.name = 'AbortError';
            reject(error);
          }, { once: true })),
        ]);
      } else {
        await gate.promise;
      }
      return null;
    },
  });
  const query = createProductSurfaceQueries(app);
  const controller = new AbortController();
  const pending = query.classification(SNAPSHOT, '0x1000', { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observedSignal, controller.signal,
    'classification must pass the query AbortSignal to the signal-aware ensureRecognition contract');
  controller.abort('consumer-left');
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  gate.resolve();
});

test('#4092 last-consumer detach on the product classification route stops the underlying recognition work', async () => {
  const producer = recognitionProducerApp();
  const app = Object.assign(producer.app, surfaceApp());
  app.ensureRecognition = (options = {}) => ensureRecognitionState(app, options);
  const query = createProductSurfaceQueries(app);
  const controller = new AbortController();
  const pending = query.classification(SNAPSHOT, '0x1000', { signal: controller.signal });
  await producer.started.promise;
  controller.abort('panel-closed');
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  producer.release.resolve();
  await waitFor(() => app.recognitionBusy === null, 'aborted recognition producer never retired');
  assert.equal(producer.calls(), 1,
    'the cancelled classification consumer must leave no further recognition knowledge work running');
  assert.equal(app.recognition, null,
    'an aborted producer must not commit recognition state');
});

test('#4092 one consumer aborting does not cancel a producer still owned by another consumer', async () => {
  const producer = recognitionProducerApp();
  const { app } = producer;
  const first = new AbortController();
  const second = new AbortController();
  const a = ensureRecognitionState(app, { signal: first.signal, maxFunctions: 1000, knowledgeLimit: 2 });
  await producer.started.promise;
  const b = ensureRecognitionState(app, { signal: second.signal, maxFunctions: 1000, knowledgeLimit: 2 });
  let failure;
  try {
    first.abort('consumer-a-left');
    await assert.rejects(withDeadline(a, 'consumer detach'), (error) => error?.name === 'AbortError');
    producer.release.resolve();
    const state = await b;
    assert.ok(state, 'the remaining consumer must still receive the shared recognition state');
    assert.ok(state.records.length > 0);
    assert.equal(app.recognition, state);
  } catch (error) {
    failure = error;
  } finally {
    producer.release.resolve();
  }
  if (failure) throw failure;
});

test('#4092 the last recognition consumer detaching aborts the shared producer exactly once', async () => {
  const producer = recognitionProducerApp();
  const { app } = producer;
  const first = new AbortController();
  const second = new AbortController();
  const a = ensureRecognitionState(app, { signal: first.signal, maxFunctions: 1000, knowledgeLimit: 2 });
  await producer.started.promise;
  const b = ensureRecognitionState(app, { signal: second.signal, maxFunctions: 1000, knowledgeLimit: 2 });
  let failure;
  try {
    first.abort('consumer-a-left');
    await assert.rejects(withDeadline(a, 'consumer detach'), (error) => error?.name === 'AbortError');
    second.abort('consumer-b-left');
    await assert.rejects(withDeadline(b, 'last consumer detach'), (error) => error?.name === 'AbortError');
    producer.release.resolve();
    await waitFor(() => app.recognitionBusy === null, 'the shared producer never retired after its last consumer detached');
    assert.equal(producer.calls(), 1,
      'no recognition work may continue once the last consumer has detached');
    assert.equal(app.recognition, null,
      'an aborted producer must not commit recognition state');
  } catch (error) {
    failure = error;
  } finally {
    producer.release.resolve();
  }
  if (failure) throw failure;
});
