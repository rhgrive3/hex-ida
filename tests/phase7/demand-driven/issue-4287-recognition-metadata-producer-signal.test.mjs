import assert from 'node:assert/strict';
import test from 'node:test';

import { installDemandDrivenAnalysis } from '../../../js/analysis/demand-driven-runtime.js';

const BOUNDED_WAIT_MS = 200;

async function outcomeWithin(promise, ms) {
  let timer;
  const pending = new Promise((resolve) => { timer = setTimeout(() => resolve('pending'), ms); });
  try {
    return await Promise.race([
      promise.then(() => 'resolved', () => 'rejected'),
      pending,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function stubApp(extra) {
  return {
    backend: { gen: 1 },
    symbols: { gen: 0 },
    knowledge: { revision: 0 },
    store: { get: (key) => (key === 'sliceIndex' ? 0 : null) },
    async ensureRecognition() { return { ok: true }; },
    ...extra,
  };
}

test('#4287 ObjC-only demand recognition forwards the consumer AbortSignal to the metadata producer', async () => {
  const controller = new AbortController();
  let objcOptions;
  let releaseObjc;
  let recognitionCalls = 0;
  const app = stubApp({
    async ensureObjc(index, options = {}) {
      objcOptions = options;
      await new Promise((resolve) => { releaseObjc = resolve; });
      return {};
    },
    async ensureRecognition() { recognitionCalls++; return { ok: true }; },
  });
  installDemandDrivenAnalysis(app);

  const pending = app.ensureRecognition({ signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(objcOptions?.signal, controller.signal, 'consumer AbortSignal must reach ensureObjc');

  controller.abort();
  assert.equal(await outcomeWithin(pending, BOUNDED_WAIT_MS), 'rejected',
    'aborted consumer must leave without waiting for the metadata producer');
  assert.equal(recognitionCalls, 0, 'recognition must not start after cancellation');
  releaseObjc?.();
});

test('#4287 Swift-only demand recognition forwards the consumer AbortSignal to the metadata producer', async () => {
  const controller = new AbortController();
  let swiftOptions;
  let releaseSwift;
  let recognitionCalls = 0;
  const app = stubApp({
    async ensureSwift(options = {}) {
      swiftOptions = options;
      await new Promise((resolve) => { releaseSwift = resolve; });
      return {};
    },
    async ensureRecognition() { recognitionCalls++; return { ok: true }; },
  });
  installDemandDrivenAnalysis(app);

  const pending = app.ensureRecognition({ signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(swiftOptions?.signal, controller.signal, 'consumer AbortSignal must reach ensureSwift');

  controller.abort();
  assert.equal(await outcomeWithin(pending, BOUNDED_WAIT_MS), 'rejected',
    'aborted consumer must leave without waiting for the metadata producer');
  assert.equal(recognitionCalls, 0, 'recognition must not start after cancellation');
  releaseSwift?.();
});

test('#4287 both producers receive the signal and a healthy run still completes recognition', async () => {
  let objcOptions;
  let swiftOptions;
  let resolveObjc;
  let resolveSwift;
  const app = stubApp({
    async ensureObjc(index, options = {}) {
      objcOptions = options;
      await new Promise((resolve) => { resolveObjc = resolve; });
      return {};
    },
    async ensureSwift(options = {}) {
      swiftOptions = options;
      await new Promise((resolve) => { resolveSwift = resolve; });
      return {};
    },
    async ensureRecognition() { return { ok: true }; },
  });
  installDemandDrivenAnalysis(app);

  const controller = new AbortController();
  const pending = app.ensureRecognition({ signal: controller.signal, priority: 'background', budget: 5 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(objcOptions?.signal, controller.signal, 'ObjC producer must observe the consumer signal');
  assert.equal(swiftOptions?.signal, controller.signal, 'Swift producer must observe the consumer signal');
  assert.equal(objcOptions?.priority, 'background', 'producer options keep the requested priority');
  assert.equal(objcOptions?.budget, 5, 'producer options keep the requested budget');
  resolveObjc();
  resolveSwift();
  assert.deepEqual(await pending, { ok: true }, 'uncancelled recognition still runs to completion');
});

test('#4287 metadata producer failure remains best-effort for a live consumer', async () => {
  const app = stubApp({
    async ensureObjc() { throw new Error('objc-metadata-failed'); },
    async ensureRecognition() { return { ok: true }; },
  });
  installDemandDrivenAnalysis(app);
  assert.deepEqual(await app.ensureRecognition({}), { ok: true });
});

test('#4287 a pre-aborted consumer does not start any metadata producer', async () => {
  let objcCalls = 0;
  let recognitionCalls = 0;
  const controller = new AbortController();
  controller.abort();
  const app = stubApp({
    async ensureObjc() { objcCalls++; return {}; },
    async ensureRecognition() { recognitionCalls++; return { ok: true }; },
  });
  installDemandDrivenAnalysis(app);
  await assert.rejects(app.ensureRecognition({ signal: controller.signal }), (error) => error?.name === 'AbortError');
  assert.equal(objcCalls, 0, 'pre-aborted consumer must not start metadata work');
  assert.equal(recognitionCalls, 0, 'pre-aborted consumer must not start recognition');
});
