import assert from 'node:assert/strict';
import { PlatformPluginRegistry } from '../js/platform/plugin-api.js';

function analyzerFor(value) {
  return { analyze: async () => ({ value }) };
}

for (const length of [2, 112, 113, 128]) {
  const registry = new PlatformPluginRegistry();
  const id = 'a'.repeat(length);
  const dispose = registry.registerAnalyzer(id, analyzerFor(length));

  assert.equal(registry.list('analyzer').length, 1, `${length}-char analyzer must register`);
  assert.equal(registry.list('analyzer')[0].id, id, 'legacy contribution id must remain unchanged');

  const [plugin] = registry.listPlugins();
  assert.ok(plugin, 'legacy analyzer must retain a manifest plugin record');
  assert.ok(plugin.id.length <= 128, 'synthetic plugin id must obey manifest length contract');
  assert.match(plugin.id, /^[a-z0-9][a-z0-9._-]{1,127}$/i);
  if (length <= 112) assert.equal(plugin.id, `legacy.analyzer.${id}`, 'short legacy synthetic ids stay byte-for-byte compatible');
  else assert.match(plugin.id, /^legacy\.analyzer-hash\./, 'long legacy ids use the bounded synthetic namespace');

  const result = await registry.invoke('analyzer', id, 'analyze', {});
  assert.equal(result.ok, true);
  assert.equal(result.value.value, length);

  dispose();
  assert.equal(registry.list('analyzer').length, 0);
  assert.equal(registry.listPlugins().length, 0);
}

{
  const registry = new PlatformPluginRegistry();
  const id = 'a'.repeat(129);
  assert.throws(
    () => registry.registerAnalyzer(id, analyzerFor('too-long')),
    /plugin contribution id must be stable and non-empty/,
  );
  assert.equal(registry.list('analyzer').length, 0);
  assert.equal(registry.listPlugins().length, 0);
}

{
  const registry = new PlatformPluginRegistry();
  const common = 'a'.repeat(127);
  const idA = `${common}b`;
  const idB = `${common}c`;
  registry.registerAnalyzer(idA, analyzerFor('A'));
  registry.registerAnalyzer(idB, analyzerFor('B'));
  assert.equal(registry.list('analyzer').length, 2, 'distinct long analyzer ids must coexist');
  const pluginIds = registry.listPlugins().map((plugin) => plugin.id);
  assert.equal(new Set(pluginIds).size, 2, 'bounded synthetic ids must distinguish long analyzer ids');
}

{
  const registry = new PlatformPluginRegistry();
  const shortId = `hash.${'s'.repeat(107)}`;
  const longId = 's'.repeat(128);
  registry.registerAnalyzer(shortId, analyzerFor('short'));
  registry.registerAnalyzer(longId, analyzerFor('long'));
  const ids = registry.listPlugins().map((plugin) => plugin.id);
  assert.ok(ids.some((id) => id.startsWith('legacy.analyzer.')));
  assert.ok(ids.some((id) => id.startsWith('legacy.analyzer-hash.')));
  assert.equal(new Set(ids).size, 2, 'short direct and long hashed synthetic namespaces cannot alias');
}

{
  const registry = new PlatformPluginRegistry();
  const id = 'z'.repeat(128);
  const firstDispose = registry.registerAnalyzer(id, analyzerFor('first'));
  const firstPluginId = registry.listPlugins()[0].id;
  firstDispose();
  const secondDispose = registry.registerAnalyzer(id, analyzerFor('second'));
  const secondPluginId = registry.listPlugins()[0].id;
  assert.equal(secondPluginId, firstPluginId, 'synthetic plugin id mapping must be deterministic');
  secondDispose();
}

{
  const registry = new PlatformPluginRegistry();
  const id = 'd'.repeat(128);
  registry.registerAnalyzer(id, analyzerFor('first'));
  assert.throws(
    () => registry.registerAnalyzer(id, analyzerFor('duplicate')),
    /already registered/,
  );
  assert.equal(registry.list('analyzer').length, 1, 'duplicate rejection must not disturb the current analyzer');
  assert.equal(registry.listPlugins().length, 1, 'duplicate rejection must not disturb the current synthetic plugin');
}

{
  const manifest = (id, contributionId) => ({
    id,
    name: 'native-boundary',
    version: '1.0.0',
    apiVersion: '2.0.0',
    supportedTargets: ['*'],
    contributions: [{
      type: 'analyzer',
      id: contributionId,
      contractVersion: '1.0.0',
      capabilities: [],
    }],
  });

  const registry = new PlatformPluginRegistry();
  const dispose = registry.registerPlugin(
    manifest('p'.repeat(128), 'native.boundary'),
    { 'native.boundary': analyzerFor('native') },
  );
  assert.equal(registry.listPlugins()[0].id.length, 128, 'native 128-char manifest id stays valid');
  dispose();

  assert.throws(
    () => registry.registerPlugin(
      manifest('p'.repeat(129), 'native.too-long'),
      { 'native.too-long': analyzerFor('native') },
    ),
    /plugin-manifest-id-invalid/,
  );
  assert.equal(registry.listPlugins().length, 0, 'native manifest id contract must stay strict');
}

console.log('issue-4949 legacy analyzer id length regression: PASS');
