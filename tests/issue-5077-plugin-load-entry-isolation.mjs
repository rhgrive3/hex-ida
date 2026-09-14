// Regression for #5077: PluginHost.load() wrapped the whole persisted plugin
// list in a single try/catch, so one corrupted saved installation aborted the
// restore loop itself and every later, perfectly valid plugin silently
// disappeared at startup. Contract now: each saved entry is restored inside its
// own isolation boundary, the v3 fast path validates every definition's shape
// (plain object, canonical integer index, string-or-absent name/description)
// before anything is trusted, a shape-invalid manifest never enters the registry
// from metadata, and only storage that is not JSON at all fails the whole list.
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
      run.frames = (run.frames || 0) + 1;
      if (run.frames <= (run.failFrames || 0)) throw new Error('sandbox realm is unavailable');
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
              run.started?.push(event.data);
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
const OTHER_SOURCE = 'hex.plugin({ name: "C", description: "C", run(_hex, print) { print("C"); } });';
const OTHER_DEFINITIONS = [{ index: 0, name: 'C', description: 'C' }];

const bound = (installationId, source, definitions, extra = {}) => ({
  v: 3,
  installationId,
  source,
  origin: 'test',
  definitions,
  sourceDigest: stableDigest(source),
  definitionsDigest: stableDigest(definitions),
  ...extra,
});

const rawStorage = (entries) => `[${entries.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join(',')}]`;

// A JSON value that parses fine but is too deep to canonicalize: the exact
// shape that made load() throw while it was digesting ONE installation.
const DEEP_DEFS = '['.repeat(3000) + ']'.repeat(3000);
const rawDeepEntry = (installationId) => `{"v":3,"installationId":${JSON.stringify(installationId)},`
  + `"source":${JSON.stringify(SOURCE)},"definitions":[${DEEP_DEFS}],`
  + `"sourceDigest":${JSON.stringify(stableDigest(SOURCE))},"definitionsDigest":"deadbeef"}`;

const pluginsOf = (host, installationId) => host.plugins.filter((plugin) => plugin.installationId === installationId);

const isCanonicalDefinitions = (installation) => Array.isArray(installation?.definitions)
  && installation.definitions.length > 0
  && installation.definitions.every((def) => def && typeof def === 'object' && !Array.isArray(def)
    && Number.isSafeInteger(def.index) && def.index >= 0 && typeof def.name === 'string');

test('#5077 one corrupted v3 entry does not abort the later valid restores', async () => {
  const store = new Map();
  store.set(STORE_KEY, rawStorage([
    rawDeepEntry('broken'),
    bound('good', OTHER_SOURCE, OTHER_DEFINITIONS, { enabledIndexes: [0] }),
  ]));
  await withGlobals({
    store,
    discovered: TRUE_DEFINITIONS.map(({ name, description }) => ({ name, description })),
    fn: async () => {
      const host = new PluginHost({ store: new Map() });
      await host.ready;
      const restored = pluginsOf(host, 'good');
      assert.equal(restored.length, 1, 'a later valid installation must survive an earlier corrupted entry');
      assert.equal(restored[0].name, 'C');
      assert.ok(host.installations.has('good'));
      assert.ok(isCanonicalDefinitions(host.installations.get('broken')),
        'the pathological definitions array never enters the canonical registry');
    },
  });
});

test('#5077 a corrupted entry between two valid entries keeps both neighbours', async () => {
  const store = new Map();
  store.set(STORE_KEY, rawStorage([
    bound('first', SOURCE, TRUE_DEFINITIONS, { enabledIndexes: [0, 1] }),
    rawDeepEntry('broken'),
    bound('last', OTHER_SOURCE, OTHER_DEFINITIONS, { enabledIndexes: [0] }),
  ]));
  await withGlobals({
    store,
    discovered: TRUE_DEFINITIONS.map(({ name, description }) => ({ name, description })),
    fn: async () => {
      const host = new PluginHost({ store: new Map() });
      await host.ready;
      assert.equal(pluginsOf(host, 'first').length, 2, 'the entry before the corrupted one is restored');
      assert.equal(pluginsOf(host, 'last').length, 1, 'the entry after the corrupted one is restored');
    },
  });
});

test('#5077 a self-consistent manifest with malformed definitions is not trusted', async () => {
  const malformed = [{ index: 0 }, null];
  const store = new Map();
  store.set(STORE_KEY, rawStorage([
    bound('forged', SOURCE, malformed, { enabledIndexes: [0] }),
    bound('good', OTHER_SOURCE, OTHER_DEFINITIONS, { enabledIndexes: [0] }),
  ]));
  await withGlobals({
    store,
    discovered: TRUE_DEFINITIONS.map(({ name, description }) => ({ name, description })),
    fn: async () => {
      const host = new PluginHost({ store: new Map() });
      await host.ready;
      const installation = host.installations.get('forged');
      assert.ok(installation, 'the intact source is still recoverable through real discovery');
      assert.ok(isCanonicalDefinitions(installation),
        'a definition array holding null/missing-index entries must never be restored as metadata');
      assert.equal(pluginsOf(host, 'forged').every((plugin) => typeof plugin.name === 'string'
        && typeof plugin.description === 'string'), true);
      assert.equal(pluginsOf(host, 'good').length, 1, 'and the later valid installation is still restored');
    },
  });
});

test('#5077 primitive and non-canonical definition fields never become plugin records', async () => {
  const cases = [
    ['null definition', [null]],
    ['primitive definitions', [7, 'x', true]],
    ['array definition', [[0]]],
    ['missing index', [{ name: 'A', description: 'A' }]],
    ['non-integer index', [{ index: 1.5, name: 'A', description: 'A' }]],
    ['object name', [{ index: 0, name: {}, description: 'A' }]],
    ['non-string description', [{ index: 0, name: 'A', description: 42 }]],
  ];
  for (const [label, definitions] of cases) {
    const store = new Map();
    store.set(STORE_KEY, rawStorage([
      bound('subject', SOURCE, definitions, { enabledIndexes: [0] }),
      bound('good', OTHER_SOURCE, OTHER_DEFINITIONS, { enabledIndexes: [0] }),
    ]));
    await withGlobals({
      store,
      discovered: TRUE_DEFINITIONS.map(({ name, description }) => ({ name, description })),
      fn: async () => {
        const host = new PluginHost({ store: new Map() });
        await host.ready;
        const polluted = pluginsOf(host, 'subject').filter((plugin) => typeof plugin.name !== 'string'
          || typeof plugin.index !== 'number' || typeof plugin.description !== 'string');
        assert.equal(polluted.length, 0, `${label}: no malformed definition may reach the plugin registry`);
        assert.ok(isCanonicalDefinitions(host.installations.get('subject')),
          `${label}: the installation only ever carries canonical definitions`);
        assert.equal(pluginsOf(host, 'good').length, 1, `${label}: the later valid entry is still restored`);
      },
    });
  }
});

test('#5077 malformed enabledIndexes are dropped without cascading', async () => {
  const store = new Map();
  store.set(STORE_KEY, rawStorage([
    bound('coerced', SOURCE, TRUE_DEFINITIONS, { enabledIndexes: [['0'], true] }),
    bound('good', OTHER_SOURCE, OTHER_DEFINITIONS, { enabledIndexes: [0] }),
  ]));
  await withGlobals({
    store,
    discovered: null,
    fn: async () => {
      const host = new PluginHost({ store: new Map() });
      await host.ready;
      assert.equal(pluginsOf(host, 'coerced').length, 0,
        'structured/coerced indexes must not enable canonical definitions');
      assert.deepEqual(host.installations.get('coerced').enabledIndexes, [],
        'malformed indexes are dropped, not coerced');
      assert.equal(pluginsOf(host, 'good').length, 1, 'and the following installation is still restored');
    },
  });
});

test('#5077 one failing legacy restore does not cascade to later entries', async () => {
  const store = new Map();
  store.set(STORE_KEY, rawStorage([
    { source: OTHER_SOURCE, origin: 'legacy' },
    bound('good', OTHER_SOURCE, OTHER_DEFINITIONS, { enabledIndexes: [0] }),
  ]));
  await withGlobals({
    store,
    failFrames: 1,
    discovered: OTHER_DEFINITIONS.map(({ name, description }) => ({ name, description })),
    fn: async () => {
      const host = new PluginHost({ store: new Map() });
      await host.ready;
      assert.equal(pluginsOf(host, 'good').length, 1,
        'a v1/v2 entry whose restore throws must not take the following installations down');
    },
  });
});

test('#5077 storage that is not JSON at all still restores nothing', async () => {
  const store = new Map();
  store.set(STORE_KEY, '[{"v":3,"installationId":"a","source":"s","definitions":');
  await withGlobals({
    store,
    discovered: null,
    fn: async () => {
      const host = new PluginHost({ store: new Map() });
      await host.ready;
      assert.deepEqual(host.plugins, []);
      assert.equal(host.installations.size, 0);
    },
  });
});

test('#5077 the canonical v3 fast path still restores without re-executing the sandbox', async () => {
  const store = new Map();
  store.set(STORE_KEY, rawStorage([bound('demo', SOURCE, TRUE_DEFINITIONS, { enabledIndexes: [0, 1] })]));
  const run = {
    store,
    discovered: null,
    fn: async () => {
      const host = new PluginHost({ store: new Map() });
      await host.ready;
      assert.deepEqual(pluginsOf(host, 'demo').map((plugin) => plugin.id), ['demo:0', 'demo:1']);
    },
  };
  await withGlobals(run);
  assert.equal(run.frames || 0, 0, 'a bound, shape-valid manifest must not need discovery again');
});
