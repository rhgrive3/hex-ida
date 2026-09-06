import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginHost, pluginManifestDigest } from '../../js/plugins.js';

function storage() {
  const store = new Map();
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

const SOURCE = [
  'hex.plugin({ name: "A", description: "runs A", run(_hex, print) { print("A"); } });',
  'hex.plugin({ name: "B", description: "runs B", run(_hex, print) { print("B"); } });',
].join('\n');
const TRUTH = [
  { index: 0, name: 'A', description: 'runs A' },
  { index: 1, name: 'B', description: 'runs B' },
];

test('6080: digest binds source to definitions', () => {
  const good = pluginManifestDigest(SOURCE, TRUTH);
  assert.match(good, /^plugin-manifest-v1:[0-9a-f]{16}$/);
  assert.equal(pluginManifestDigest(SOURCE, TRUTH), good, 'digest must be deterministic');
  const swapped = [{ index: 1, name: 'A', description: 'runs A' }];
  assert.notEqual(pluginManifestDigest(SOURCE, swapped), good, 'index/name drift must change the digest');
  assert.notEqual(pluginManifestDigest(`${SOURCE}\n`, TRUTH), good, 'source drift must change the digest');
});

test('6080: drifted manifest is not trusted on load', async () => {
  const previous = globalThis.localStorage;
  globalThis.localStorage = storage();
  try {
    // The issue's repro: display says A, persisted index points at B, no digest.
    globalThis.localStorage.setItem('hex.plugins', JSON.stringify([{
      v: 3,
      installationId: 'demo',
      source: SOURCE,
      definitions: [{ index: 1, name: 'A', description: 'runs A' }],
      enabledIndexes: [1],
    }]));
    const host = new PluginHost({ store: new Map() });
    await host.ready;
    const drifted = host.plugins.find((p) => p.installationId === 'demo' && p.name === 'A' && p.index === 1);
    assert.equal(drifted, undefined, 'drifted display metadata must never enter the registry');
  } finally {
    globalThis.localStorage = previous;
  }
});

test('6080: sealed manifest still fast-paths without sandbox', async () => {
  const previous = globalThis.localStorage;
  globalThis.localStorage = storage();
  try {
    globalThis.localStorage.setItem('hex.plugins', JSON.stringify([{
      v: 3,
      installationId: 'sealed',
      source: SOURCE,
      origin: 'test',
      definitions: TRUTH,
      digest: pluginManifestDigest(SOURCE, TRUTH),
      enabledIndexes: [0, 1],
    }]));
    const host = new PluginHost({ store: new Map() });
    await host.ready;
    assert.equal(host.plugins.length, 2);
    assert.deepEqual(host.plugins.map((p) => p.name), ['A', 'B']);
  } finally {
    globalThis.localStorage = previous;
  }
});

test('6080: run refuses a drifted in-memory binding without executing', async () => {
  const host = new PluginHost({ store: new Map() });
  await host.ready;
  host.installations.set('demo', {
    v: 3, installationId: 'demo', source: SOURCE, origin: 'test',
    definitions: TRUTH, enabledIndexes: [0, 1],
  });
  host.plugins.push({
    id: 'demo:1', installationId: 'demo', name: 'A', description: 'runs A',
    index: 1, source: SOURCE, origin: 'test',
  });
  const printed = [];
  const result = await host.run('demo:1', { print: (...args) => printed.push(args.join(' ')) });
  assert.ok(result?.error, 'drifted binding must be refused');
  assert.match(result.error, /一致しません/);
  assert.deepEqual(printed, [], 'the wrong definition must not execute');
});
