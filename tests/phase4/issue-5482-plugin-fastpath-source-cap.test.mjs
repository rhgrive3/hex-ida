// Regression for #5482: the persisted v3 plugin manifest fast path must be
// bound by install()'s source byte cap. An oversized (>512 KiB) persisted
// source with a VALID digest binding used to restore directly into the
// canonical registry, bypassing MAX_PLUGIN_SOURCE_BYTES; now it falls back to
// install(), which fails closed on the size budget.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageChannel as NodeMessageChannel } from 'node:worker_threads';

import { PluginHost, MAX_PLUGIN_SOURCE_BYTES } from '../../js/plugins.js';
import { stableDigest } from '../../js/core/identity/index.js';

const STORE_KEY = 'hex.plugins';

function withGlobals(run) {
  const descriptors = new Map();
  const set = (name, value) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  set('localStorage', {
    getItem: (key) => run.store.get(key) ?? null,
    setItem: (key, value) => run.store.set(key, String(value)),
    removeItem: (key) => run.store.delete(key),
  });
  const listeners = new Map();
  const on = (type, handler) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(handler); };
  const off = (type, handler) => listeners.get(type)?.delete(handler);
  set('window', { addEventListener: on, removeEventListener: off });
  set('document', {
    createElement() { throw new Error('sandbox execution must not run on the fast path'); },
    body: { append() {} },
  });
  set('MessageChannel', NodeMessageChannel);
  if (run.fetch) set('fetch', run.fetch);
  return Promise.resolve()
    .then(run.fn)
    .finally(() => {
      for (const [name, descriptor] of [...descriptors].reverse()) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    });
}

test('#5482 an oversized digest-bound v3 manifest never restores through the fast path', async () => {
  const store = new Map();
  const oversized = 'x'.repeat(MAX_PLUGIN_SOURCE_BYTES + 1);
  const definitions = [{ index: 0, name: 'A', description: '' }];
  store.set(STORE_KEY, JSON.stringify([{
    v: 3,
    installationId: 'oversized',
    source: oversized,
    origin: 'test',
    definitions,
    sourceDigest: stableDigest(oversized),
    definitionsDigest: stableDigest(definitions),
    enabledIndexes: [0],
  }]));
  await withGlobals({
    store,
    fn: async () => {
      const host = new PluginHost({ store: new Map() });
      await host.ready;
      const restored = host.plugins.filter((p) => p.installationId === 'oversized');
      assert.equal(restored.length, 0, 'an oversized persisted source must not enter the canonical registry');
      assert.equal(host.installations.has('oversized'), false, 'no installation record may be minted for it');
    },
  });
});

test('#5482 the fast path keeps restoring an in-budget digest-bound manifest', async () => {
  const store = new Map();
  const source = 'hex.plugin({ name: "A", description: "A", run() {} });';
  const definitions = [{ index: 0, name: 'A', description: 'A' }];
  store.set(STORE_KEY, JSON.stringify([{
    v: 3,
    installationId: 'in-budget',
    source,
    origin: 'test',
    definitions,
    sourceDigest: stableDigest(source),
    definitionsDigest: stableDigest(definitions),
    enabledIndexes: [0],
  }]));
  await withGlobals({
    store,
    fn: async () => {
      const host = new PluginHost({ store: new Map() });
      await host.ready;
      const restored = host.plugins.filter((p) => p.installationId === 'in-budget');
      assert.equal(restored.length, 1, 'an in-budget bound manifest still takes the fast path');
      assert.equal(restored[0].source, source);
    },
  });
});

test('#5482 a source of exactly MAX bytes still restores through the fast path', async () => {
  const store = new Map();
  const exact = 'x'.repeat(MAX_PLUGIN_SOURCE_BYTES);
  const definitions = [{ index: 0, name: 'A', description: '' }];
  store.set(STORE_KEY, JSON.stringify([{
    v: 3,
    installationId: 'exact-max',
    source: exact,
    origin: 'test',
    definitions,
    sourceDigest: stableDigest(exact),
    definitionsDigest: stableDigest(definitions),
    enabledIndexes: [0],
  }]));
  await withGlobals({
    store,
    fn: async () => {
      const host = new PluginHost({ store: new Map() });
      await host.ready;
      const restored = host.plugins.filter((p) => p.installationId === 'exact-max');
      assert.equal(restored.length, 1, 'a source of exactly the cap is within the budget and restores');
      assert.equal(restored[0].source.length, MAX_PLUGIN_SOURCE_BYTES);
    },
  });
});

test('#5482 an oversized entry is skipped without losing later stored plugins', async () => {
  const store = new Map();
  const oversized = 'x'.repeat(MAX_PLUGIN_SOURCE_BYTES + 1);
  const goodSource = 'hex.plugin({ name: "Good", description: "Good", run() {} });';
  const oversizedDefs = [{ index: 0, name: 'Big', description: '' }];
  const goodDefs = [{ index: 0, name: 'Good', description: 'Good' }];
  store.set(STORE_KEY, JSON.stringify([
    {
      v: 3,
      installationId: 'oversized-first',
      source: oversized,
      origin: 'test',
      definitions: oversizedDefs,
      sourceDigest: stableDigest(oversized),
      definitionsDigest: stableDigest(oversizedDefs),
      enabledIndexes: [0],
    },
    {
      v: 3,
      installationId: 'good-second',
      source: goodSource,
      origin: 'test',
      definitions: goodDefs,
      sourceDigest: stableDigest(goodSource),
      definitionsDigest: stableDigest(goodDefs),
      enabledIndexes: [0],
    },
  ]));
  await withGlobals({
    store,
    fn: async () => {
      const host = new PluginHost({ store: new Map() });
      await host.ready;
      assert.equal(host.plugins.filter((p) => p.installationId === 'oversized-first').length, 0,
        'the oversized stored entry must not restore');
      assert.equal(host.installations.has('oversized-first'), false);
      const good = host.plugins.filter((p) => p.installationId === 'good-second');
      assert.equal(good.length, 1, 'the following good stored entry must still restore');
      assert.equal(host.installations.has('good-second'), true);
    },
  });
});

test('#5482 install() keeps failing closed on an oversized source', async () => {
  await withGlobals({
    store: new Map(),
    fn: async () => {
      const host = new PluginHost({ store: new Map() });
      await host.ready;
      const result = await host.install('x'.repeat(MAX_PLUGIN_SOURCE_BYTES + 1), 'テスト');
      assert.match(result?.error ?? '', /大きすぎます/, 'the install-path byte cap must stay enforced');
      assert.equal(host.plugins.length, 0);
    },
  });
});

test('#5482 legacy v1/v2 restore paths keep the same oversized-source cap', async () => {
  const store = new Map();
  const oversized = 'x'.repeat(MAX_PLUGIN_SOURCE_BYTES + 1);
  store.set(STORE_KEY, JSON.stringify([
    { v: 1, source: oversized, origin: 'legacy-v1' },
    { v: 2, installationId: 'legacy-v2', source: oversized, origin: 'legacy-v2', enabledIndexes: [0] },
  ]));
  await withGlobals({
    store,
    fn: async () => {
      const host = new PluginHost({ store: new Map() });
      await host.ready;
      assert.equal(host.plugins.length, 0, 'oversized legacy entries must not restore');
      assert.equal(host.installations.size, 0, 'legacy fallback must remain bound by install()');
    },
  });
});

test('#5482 installFromUrl() keeps enforcing the response byte cap', async () => {
  const oversizedLength = MAX_PLUGIN_SOURCE_BYTES + 1;
  await withGlobals({
    store: new Map(),
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => name.toLowerCase() === 'content-length' ? String(oversizedLength) : null },
      body: null,
      text: async () => 'x'.repeat(oversizedLength),
    }),
    fn: async () => {
      const host = new PluginHost({ store: new Map() });
      await host.ready;
      const result = await host.installFromUrl('https://example.invalid/oversized.js');
      assert.match(result?.error ?? '', /大きすぎます/, 'remote source cap must remain fail-closed');
      assert.equal(result?.ok, undefined);
      assert.equal(host.plugins.length, 0);
      assert.equal(host.installations.size, 0);
    },
  });
});
