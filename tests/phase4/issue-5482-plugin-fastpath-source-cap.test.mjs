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
