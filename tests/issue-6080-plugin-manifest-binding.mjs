// Regression for #6080: the persisted v3 plugin manifest must be bound to the
// source it claims. A drifted manifest (displayed name/index pointing at a
// different definition than the source's discovery order) must not enter the
// fast-path registry — the loader falls back to real discovery so the
// executed defs[index] always matches the displayed metadata.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageChannel as NodeMessageChannel } from 'node:worker_threads';

import { PluginHost } from '../js/plugins.js';
import { stableDigest } from '../js/core/identity/index.js';

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
  const on = (type, handler) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(handler);
  };
  const off = (type, handler) => listeners.get(type)?.delete(handler);
  const emit = (type, event) => {
    for (const handler of [...(listeners.get(type) || [])]) handler(event);
  };
  set('window', { addEventListener: on, removeEventListener: off });
  set('document', {
    createElement(tag) {
      assert.equal(tag, 'iframe');
      return {
        hidden: false, referrerPolicy: '', srcdoc: '', setAttribute() {}, remove() {},
        contentWindow: {
          postMessage(message, _origin, transfer) {
            if (message?.t !== 'init') return;
            const port = transfer?.[0];
            assert.ok(port, 'sandbox init must transfer a MessagePort');
            port.onmessage = (event) => {
              if (event.data?.t === 'terminate') { port.close(); return; }
              if (event.data?.t === 'start') port.postMessage({ t: 'done', value: run.discovered });
            };
            port.start?.();
            port.postMessage({ t: 'ready' });
          },
        },
      };
    },
    body: {
      append(frame) {
        queueMicrotask(() => emit('message', { source: frame.contentWindow, data: { t: 'hexSandboxFrameReady' } }));
      },
    },
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

const SOURCE = [
  'hex.plugin({ name: "A", description: "A", run(_hex, print) { print("A"); } });',
  'hex.plugin({ name: "B", description: "B", run(_hex, print) { print("B"); } });',
].join('\n');
const TRUE_DEFINITIONS = [
  { index: 0, name: 'A', description: 'A' },
  { index: 1, name: 'B', description: 'B' },
];

test('#6080 a drifted manifest never surfaces a forged name/index binding', async () => {
  const store = new Map();
  store.set(STORE_KEY, JSON.stringify([{
    v: 3,
    installationId: 'demo',
    source: SOURCE,
    definitions: [{ index: 1, name: 'A', description: 'A' }],
    enabledIndexes: [1],
    // No digests: a forged/drifted manifest.
  }]));
  await withGlobals({
    store,
    discovered: TRUE_DEFINITIONS.map(({ name, description }) => ({ name, description })),
    fn: async () => {
      const host = new PluginHost({ store: new Map() });
      await host.ready;
      // Re-discovery replaced the forged binding with the truth: index 1 is B.
      const restored = host.plugins.filter((plugin) => plugin.installationId === 'demo');
      assert.equal(restored.length, 1, 'only the enabled index is restored');
      assert.equal(restored[0].name, 'B');
      assert.equal(restored[0].index, 1);
      const installation = host.installations.get('demo');
      assert.equal(installation.sourceDigest, stableDigest(SOURCE));
      assert.equal(installation.definitionsDigest, stableDigest(TRUE_DEFINITIONS));
    },
  });
});

test('#6080 a tampered digest fails closed into re-discovery', async () => {
  const store = new Map();
  store.set(STORE_KEY, JSON.stringify([{
    v: 3,
    installationId: 'demo',
    source: SOURCE,
    definitions: TRUE_DEFINITIONS,
    enabledIndexes: [1],
    sourceDigest: 'deadbeef',
    definitionsDigest: stableDigest([{ index: 0, name: 'A', description: 'A' }]),
  }]));
  await withGlobals({
    store,
    discovered: TRUE_DEFINITIONS.map(({ name, description }) => ({ name, description })),
    fn: async () => {
      const host = new PluginHost({ store: new Map() });
      await host.ready;
      const restored = host.plugins.filter((plugin) => plugin.installationId === 'demo');
      assert.equal(restored.length, 1);
      assert.equal(restored[0].name, 'B');
      assert.equal(restored[0].index, 1);
    },
  });
});

test('#6080 a bound manifest keeps the sandbox-free fast path', async () => {
  const store = new Map();
  store.set(STORE_KEY, JSON.stringify([{
    v: 3,
    installationId: 'demo',
    source: SOURCE,
    definitions: TRUE_DEFINITIONS,
    enabledIndexes: [0, 1],
    sourceDigest: stableDigest(SOURCE),
    definitionsDigest: stableDigest(TRUE_DEFINITIONS),
  }]));
  // No discovery harness beyond the shell globals: the fast path must not
  // execute the sandbox (a real discovery would need a responding frame).
  await withGlobals({
    store,
    discovered: null,
    fn: async () => {
      const host = new PluginHost({ store: new Map() });
      await host.ready;
      assert.equal(host.plugins.length, 2);
      assert.deepEqual(host.plugins.map((plugin) => plugin.name), ['A', 'B']);
      assert.deepEqual(host.plugins.map((plugin) => plugin.index), [0, 1]);
      const installation = host.installations.get('demo');
      assert.equal(installation.sourceDigest, stableDigest(SOURCE));
    },
  });
});

test('#6080 save() persists the binding digests for the next restore', async () => {
  const store = new Map();
  store.set(STORE_KEY, JSON.stringify([{
    v: 3,
    installationId: 'demo',
    source: SOURCE,
    definitions: TRUE_DEFINITIONS,
    enabledIndexes: [0],
    sourceDigest: stableDigest(SOURCE),
    definitionsDigest: stableDigest(TRUE_DEFINITIONS),
  }]));
  await withGlobals({
    store,
    discovered: null,
    fn: async () => {
      const host = new PluginHost({ store: new Map() });
      await host.ready;
      assert.equal(host.save().ok, true);
      const saved = JSON.parse(store.get(STORE_KEY));
      assert.equal(saved[0].sourceDigest, stableDigest(SOURCE));
      assert.equal(saved[0].definitionsDigest, stableDigest(TRUE_DEFINITIONS));
      const host2 = new PluginHost({ store: new Map() });
      await host2.ready;
      assert.equal(host2.plugins.length, 1);
      assert.equal(host2.plugins[0].name, 'A');
    },
  });
});
