import assert from 'node:assert/strict';
import test from 'node:test';

import { installDemandDrivenAnalysis } from '../../js/analysis/demand-driven-runtime.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeApp(symbolsReady, { applyError = null } = {}) {
  const sentinel = { slice: 'result' };
  const recognition = { kind: 'recognition' };
  let recognitionCalls = 0;
  const app = {
    backend: { gen: 7 },
    symbols: { gen: 0 },
    store: { get: () => null },
    ensureRecognition: async () => {
      recognitionCalls++;
      app.recognition = recognition;
      return recognition;
    },
    applySlice() {
      app.symbolsReady = symbolsReady;
      if (applyError) throw applyError;
      return sentinel;
    },
  };
  installDemandDrivenAnalysis(app);
  return { app, sentinel, recognition, recognitionCalls: () => recognitionCalls };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('#3868 rejected symbolsReady clears bootstrap without a child unhandled rejection', async () => {
  const gate = deferred();
  // The original promise is independently observed; #3868 is specifically about
  // the rejected child formerly created by the fire-and-forget .finally().
  void gate.promise.catch(() => {});
  const { app, sentinel, recognition, recognitionCalls } = makeApp(gate.promise);
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.equal(app.applySlice(), sentinel, 'wrapper preserves original return value');
    assert.equal(await app.ensureRecognition(), null, 'recognition remains suppressed while symbols bootstrap is pending');
    assert.equal(recognitionCalls(), 0);

    gate.reject(new Error('symbol discovery failed'));
    await nextTurn();
    await nextTurn();

    assert.deepEqual(unhandled, [], 'cleanup observer must not create an unhandled rejecting child');
    assert.equal(await app.ensureRecognition(), recognition, 'rejection settlement clears bootstrap suppression');
    assert.equal(recognitionCalls(), 1);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('#3868 fulfilled symbolsReady still clears bootstrap suppression', async () => {
  const gate = deferred();
  const { app, recognition, recognitionCalls } = makeApp(gate.promise);
  app.applySlice();
  assert.equal(await app.ensureRecognition(), null);
  assert.equal(recognitionCalls(), 0);

  gate.resolve();
  await gate.promise;
  await nextTurn();

  assert.equal(await app.ensureRecognition(), recognition);
  assert.equal(recognitionCalls(), 1);
});

test('#3868 applySlice throw semantics remain unchanged', () => {
  const gate = deferred();
  const error = new Error('apply failed');
  const { app } = makeApp(gate.promise, { applyError: error });
  assert.throws(() => app.applySlice(), (thrown) => thrown === error);
});
