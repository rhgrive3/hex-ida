import assert from 'node:assert/strict';
import test from 'node:test';

import { createHexAIContext } from '../../../js/ai/ui/hex-context-legacy.js';
import { createHexToolRegistry } from '../../../js/ai/tools/registry-base.js';

function baseApp(overrides = {}) {
  return {
    store: { get() { return null; } },
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function decompileApp(ensureObjc) {
  const region = { id: 'text', vmAddr: 0x1000n, size: 8n, exec: true };
  return {
    store: {
      get(key) {
        return {
          architecture: 'arm64',
          canDisassemble: true,
          instructionAlignment: 4,
          regions: [region],
          currentRegion: region,
        }[key] ?? null;
      },
    },
    symbols: {
      gen: 0,
      functionCount: 1,
      functionAt() { return { start: 0x1000n, end: 0x1008n }; },
      nameAt() { return 'legacy_demo'; },
    },
    backend: {
      gen: 0,
      async fetchChunk() { return { mn: ['ret', 'ret'], ops: ['', ''], bytes: new Uint8Array(8) }; },
    },
    ensureObjc,
  };
}

test('legacy string fallback preserves exact preabort reason and leaves producer untouched', async () => {
  const controller = new AbortController();
  const reason = false;
  controller.abort(reason);
  let producerCalls = 0;
  const ctx = createHexAIContext(baseApp({
    ensureStrings() { producerCalls++; return Promise.resolve([{ text: 'x', addr: 1n }]); },
  }));

  await assert.rejects(ctx.searchStrings('x', { signal: controller.signal }), (error) => error === reason);
  assert.equal(producerCalls, 0);
});

test('legacy string fallback cancels one waiter without cancelling the shared producer', async () => {
  const pending = deferred();
  let producerCancelled = false;
  pending.promise.cancel = () => { producerCancelled = true; };
  const app = baseApp({ ensureStrings() { return pending.promise; } });
  const ctx = createHexAIContext(app);
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = ctx.searchStrings('needle', { signal: firstController.signal });
  const second = ctx.searchStrings('needle', { signal: secondController.signal });
  await Promise.resolve();

  const reason = '';
  firstController.abort(reason);
  await assert.rejects(first, (error) => error === reason);
  pending.resolve([{ text: 'needle', addr: 0x1000n }]);
  const result = await second;
  assert.deepEqual(result.map((row) => row.text), ['needle']);
  assert.equal(producerCancelled, false);
});

test('legacy function fallback forwards signal and preserves exact mid-await cancellation', async () => {
  const pending = deferred();
  let producerSignal = null;
  const app = baseApp({
    ensureRecognition(options) { producerSignal = options.signal; return pending.promise; },
    recognition: { records: [] },
  });
  const ctx = createHexAIContext(app);
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = ctx.searchFunctions('demo', { signal: firstController.signal });
  const second = ctx.searchFunctions('demo', { signal: secondController.signal });
  await Promise.resolve();

  const reason = 0;
  firstController.abort(reason);
  await assert.rejects(first, (error) => error === reason);
  app.recognition = {
    records: [{ address: 0x1000n, name: 'demo', score: 1 }],
    complete: true,
    scannedCount: 1,
    total: 1,
  };
  pending.resolve(app.recognition);
  const result = await second;
  assert.deepEqual(result.map((row) => row.name), ['demo']);
  assert.equal(typeof producerSignal?.addEventListener, 'function');
});

test('legacy decompile forwards options through the registry and retains a successful path', async () => {
  let receivedOptions = null;
  const registry = createHexToolRegistry({
    addressExists: () => true,
    decompile: async (_address, options) => {
      receivedOptions = options;
      return 'void demo(void) {}';
    },
  });
  const result = await registry.execute('decompile_function', { functionAddress: '0x1000' });
  assert.match(result.result.pseudocodeExcerpt, /void demo/);
  assert.equal(typeof receivedOptions?.signal?.addEventListener, 'function');
});

test('legacy decompile cancellation keeps exact reason and successful awaited metadata path', async () => {
  const pending = deferred();
  const app = decompileApp((_slice, options) => {
    assert.equal(typeof options?.signal?.addEventListener, 'function');
    return pending.promise;
  });
  const ctx = createHexAIContext(app);
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = ctx.decompile(0x1000n, { signal: firstController.signal });
  const second = ctx.decompile(0x1000n, { signal: secondController.signal });
  await Promise.resolve();

  const reason = null;
  firstController.abort(reason);
  await assert.rejects(first, (error) => error === reason);
  pending.resolve(null);
  const result = await second;
  assert.match(result, /return/);
});
