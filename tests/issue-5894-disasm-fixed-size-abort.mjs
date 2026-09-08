// Regression for #5894: the fixed-size ISA disasm path must observe the
// AbortSignal while awaiting backend.fetchChunk — a hung fetch must reject
// with AbortError instead of leaving the script pending forever.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApi } from '../js/script.js';

function makeApp() {
  const region = { id: 'text', section: '__text', name: '__text', vmAddr: 0x1000n, size: 0x100n, exec: true };
  const state = new Map([
    ['regions', [region]],
    ['currentRegion', region],
    ['architecture', 'arm64'],
    ['displayMode', 'asm'],
  ]);
  return {
    store: { get: (k) => state.get(k), set: (o) => { for (const [k, v] of Object.entries(o)) state.set(k, v); } },
    backend: {
      // Never settles: the abort must rescue the await.
      fetchChunk: () => new Promise(() => {}),
    },
    notes: { id: 'n-5894', names: new Map(), comments: new Map(), types: new Map(), vars: new Map(), structs: [], dirty: false, save: () => true },
    symbols: { nameAt: () => null, label: () => null, setFunctionRegions() {}, isFunctionStart: () => false },
    currentSlice: () => null,
  };
}

test('#5894 abort during a hung fixed-size fetchChunk rejects with AbortError', { timeout: 2000 }, async () => {

  const app = makeApp();
  const controller = new AbortController();
  const { api } = createApi(app, () => {});
  const pending = api.disasm(0x1000n, 4, { signal: controller.signal });
  // Give the loop a microtask to reach the first fetchChunk await.
  await Promise.resolve();
  await Promise.resolve();
  controller.abort('stop');
  await assert.rejects(pending, (error) => /abort|cancelled/i.test(error?.message ?? '') || error?.name === 'AbortError');
});

test('#5894 an already-aborted signal rejects before fetching', async () => {
  const app = makeApp();
  const controller = new AbortController();
  controller.abort('stop');
  const { api } = createApi(app, () => {});
  await assert.rejects(api.disasm(0x1000n, 4, { signal: controller.signal }), (error) => /abort|cancelled/i.test(error?.message ?? '') || error?.name === 'AbortError');
});
