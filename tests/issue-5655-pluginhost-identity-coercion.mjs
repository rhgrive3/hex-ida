// Regression for #5655: PluginHost's v3 persisted-manifest restore and
// install() boundary coerced installationId via String() and enabled/definition
// indexes via Number(), letting Arrays / booleans / numeric strings alias a
// canonical installation's Map key or enable definitions the user never did.
// Contract now: installationId is a non-empty primitive string; enabled and
// definition indexes are non-negative safe integers; malformed values are
// dropped (or the whole entry skipped) without aliasing canonical identities.
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
  const on = (type, handler) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(handler); };
  const off = (type, handler) => listeners.get(type)?.delete(handler);
  const emit = (type, event) => { for (const handler of [...(listeners.get(type) || [])]) handler(event); };
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
              if (event.data?.t !== 'start') return;
              port.postMessage({ t: 'done', value: run.discovered });
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
const BOUND = {
  sourceDigest: stableDigest(SOURCE),
  definitionsDigest: stableDigest(TRUE_DEFINITIONS),
};

test('#5655 a structured installationId never aliases a canonical installation', async () => {
  const store = new Map();
  store.set(STORE_KEY, JSON.stringify([
    {
      v: 3,
      installationId: ['pkg-A'],
      source: SOURCE,
      definitions: TRUE_DEFINITIONS,
      enabledIndexes: [0],
      ...BOUND,
    },
  ]));
  await withGlobals({
    store,
    fn: async () => {
      const host = new PluginHost({ store: new Map() });
      await host.ready;
      assert.equal(host.installations.get('pkg-A'), undefined,
        "a structured installationId must not enter the canonical 'pkg-A' identity namespace");
      assert.equal(host.plugins.filter((p) => p.installationId === 'pkg-A').length, 0,
        'no plugin record may be minted under the laundered installationId');
    },
  });
});

test('#5655 structured enabledIndexes cannot enable canonical definitions', async () => {
  const store = new Map();
  store.set(STORE_KEY, JSON.stringify([
    {
      v: 3,
      installationId: 'pkg-B',
      source: SOURCE,
      definitions: TRUE_DEFINITIONS,
      enabledIndexes: [['0'], true],
      ...BOUND,
    },
  ]));
  await withGlobals({
    store,
    fn: async () => {
      const host = new PluginHost({ store: new Map() });
      await host.ready;
      assert.equal(host.plugins.length, 0,
        "Number(['0'])/Number(true) must not become canonical enable indexes");
      const installation = host.installations.get('pkg-B');
      assert.ok(installation, 'the canonical installation itself is still restored');
      assert.deepEqual(installation.enabledIndexes, [], 'malformed indexes are dropped, not coerced');
    },
  });
});

test('#5655 a structured definition index never becomes a plugin record', async () => {
  const store = new Map();
  store.set(STORE_KEY, JSON.stringify([
    {
      v: 3,
      installationId: 'pkg-C',
      source: SOURCE,
      definitions: [{ index: ['0'], name: 'A', description: 'A' }, ...TRUE_DEFINITIONS.slice(1)],
      ...BOUND,
    },
  ]));
  await withGlobals({
    store,
    fn: async () => {
      const host = new PluginHost({ store: new Map() });
      await host.ready;
      const restored = host.plugins.filter((p) => p.installationId === 'pkg-C');
      assert.equal(restored.length, 0,
        'a definition with a structured index must not be restored as a plugin');
    },
  });
});

test('#5655 canonical v3 manifests keep the fast-path restore', async () => {
  const store = new Map();
  store.set(STORE_KEY, JSON.stringify([
    {
      v: 3,
      installationId: 'pkg-D',
      source: SOURCE,
      definitions: TRUE_DEFINITIONS,
      enabledIndexes: [0, 1],
      ...BOUND,
    },
  ]));
  await withGlobals({
    store,
    fn: async () => {
      const host = new PluginHost({ store: new Map() });
      await host.ready;
      const restored = host.plugins.filter((p) => p.installationId === 'pkg-D');
      assert.equal(restored.length, 2, 'canonical enabled indexes restore both definitions');
      assert.deepEqual(restored.map((p) => p.id), ['pkg-D:0', 'pkg-D:1']);
    },
  });
});

test('#5655 install() drops structured enabledIndexes instead of coercing them', async () => {
  await withGlobals({
    store: new Map(),
    discovered: TRUE_DEFINITIONS.map(({ name, description }) => ({ name, description })),
    fn: async () => {
      const host = new PluginHost({ store: new Map() });
      await host.ready;
      const result = await host.install(SOURCE, 'テスト', { enabledIndexes: [['0'], true] });
      assert.equal(result.error, undefined, 'the installation itself still succeeds');
      assert.equal(host.plugins.length, 0,
        "install() must not launder ['0']/true into canonical enable indexes");
      const id = result.installationId;
      assert.ok(typeof id === 'string' && id, 'a canonical installation id is still minted');
    },
  });
});

test('#5655 install() never String-coerces a structured installationId', async () => {
  await withGlobals({
    store: new Map(),
    discovered: TRUE_DEFINITIONS.map(({ name, description }) => ({ name, description })),
    fn: async () => {
      const host = new PluginHost({ store: new Map() });
      await host.ready;
      const result = await host.install(SOURCE, 'テスト', { installationId: ['pkg-E'] });
      assert.equal(result.error, undefined);
      assert.notEqual(result.installationId, 'pkg-E',
        "String(['pkg-E']) must not mint the canonical 'pkg-E' identity");
      assert.equal(host.installations.has('pkg-E'), false,
        'no installation may be registered under the laundered id');
    },
  });
});
