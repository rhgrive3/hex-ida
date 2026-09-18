import assert from 'node:assert/strict';
import test from 'node:test';

import { installDemandDrivenAnalysis } from '../../js/analysis/demand-driven-runtime.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeApp({ symbolsReady = Promise.resolve(), applyError = null, advanceEpoch = false } = {}) {
  const recognition = Object.freeze({ kind: 'issue-4755-recognition' });
  const applyResult = Object.freeze({ kind: 'slice-result' });
  let recognitionCalls = 0;
  const app = {
    backend: { gen: 7, binaryId: 'issue-4755-binary' },
    symbols: { gen: 0 },
    store: { get: () => null },
    recognition: null,
    ensureRecognition: async () => {
      recognitionCalls++;
      app.recognition = recognition;
      return recognition;
    },
    applySlice() {
      app.symbolsReady = symbolsReady;
      if (advanceEpoch) app.backend.gen++;
      if (applyError) throw applyError;
      return applyResult;
    },
  };
  installDemandDrivenAnalysis(app);
  return { app, recognition, applyResult, recognitionCalls: () => recognitionCalls };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('#4755 synchronous applySlice failure releases bootstrap suppression in the same epoch', async () => {
  const error = new Error('invalid slice');
  const { app, recognition, recognitionCalls } = makeApp({
    symbolsReady: new Promise(() => {}),
    applyError: error,
  });

  assert.throws(() => app.applySlice(0), (thrown) => thrown === error,
    'the wrapper must preserve the original synchronous failure identity');
  assert.equal(await app.ensureRecognition(), recognition,
    'a failed apply is no longer an in-progress bootstrap and must not suppress recognition');
  assert.equal(recognitionCalls(), 1);
});

test('#4755 successful apply remains suppressed until symbolsReady fulfills', async () => {
  const gate = deferred();
  const { app, recognition, applyResult, recognitionCalls } = makeApp({ symbolsReady: gate.promise });

  assert.equal(app.applySlice(0), applyResult);
  assert.equal(await app.ensureRecognition(), null);
  assert.equal(recognitionCalls(), 0);

  gate.resolve();
  await gate.promise;
  await nextTurn();
  assert.equal(await app.ensureRecognition(), recognition);
  assert.equal(recognitionCalls(), 1);
});

test('#4755 symbolsReady rejection still releases bootstrap suppression', async () => {
  const gate = deferred();
  void gate.promise.catch(() => {});
  const { app, recognition, recognitionCalls } = makeApp({ symbolsReady: gate.promise });

  app.applySlice(0);
  assert.equal(await app.ensureRecognition(), null);
  gate.reject(new Error('symbol bootstrap failed'));
  await nextTurn();
  await nextTurn();

  assert.equal(await app.ensureRecognition(), recognition);
  assert.equal(recognitionCalls(), 1);
});

test('#4755 a successful apply that advances epoch does not suppress the new epoch', async () => {
  const gate = deferred();
  const { app, recognition, recognitionCalls } = makeApp({
    symbolsReady: gate.promise,
    advanceEpoch: true,
  });

  app.applySlice(0);
  assert.equal(app.backend.gen, 8);
  assert.equal(await app.ensureRecognition(), recognition,
    'bootstrap ownership is bound to the epoch captured before applySlice');
  assert.equal(recognitionCalls(), 1);
  gate.resolve();
});

test('#4755 force recognition continues to bypass active bootstrap suppression', async () => {
  const gate = deferred();
  const { app, recognition, recognitionCalls } = makeApp({ symbolsReady: gate.promise });

  app.applySlice(0);
  assert.equal(await app.ensureRecognition({ force: true }), recognition);
  assert.equal(recognitionCalls(), 1);
  gate.resolve();
});

test('#4755 failed overlapping apply does not clear an earlier bootstrap in the same epoch', async () => {
  const gate = deferred();
  const error = new Error('second apply failed');
  const recognition = Object.freeze({ kind: 'overlap-recognition' });
  let calls = 0;
  let applyCalls = 0;
  const app = {
    backend: { gen: 7, binaryId: 'issue-4755-overlap' },
    symbols: { gen: 0 },
    store: { get: () => null },
    recognition: null,
    ensureRecognition: async () => {
      calls++;
      app.recognition = recognition;
      return recognition;
    },
    applySlice() {
      applyCalls++;
      if (applyCalls === 1) {
        app.symbolsReady = gate.promise;
        return 'first';
      }
      throw error;
    },
  };
  installDemandDrivenAnalysis(app);

  assert.equal(app.applySlice(0), 'first');
  assert.throws(() => app.applySlice(1), (thrown) => thrown === error);
  assert.equal(await app.ensureRecognition(), null,
    'cleanup for a failed invocation must not release another active bootstrap owner');
  assert.equal(calls, 0);

  gate.resolve();
  await gate.promise;
  await nextTurn();
  assert.equal(await app.ensureRecognition(), recognition);
  assert.equal(calls, 1);
});
