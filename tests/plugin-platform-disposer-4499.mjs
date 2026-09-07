import assert from 'node:assert/strict';
import { PlatformPluginRegistry } from '../js/platform/plugin-api.js';

function analyzerManifest(version = '1.0.0') {
  return {
    id: 'stale.plugin',
    name: 'Stale disposer regression plugin',
    version,
    apiVersion: '2.0.0',
    permissions: { binaryRead: false },
    supportedTargets: ['*'],
    contributions: [{
      type: 'analyzer',
      id: 'stale.analyzer',
      contractVersion: '1.0.0',
      capabilities: [],
    }],
  };
}

{
  const registry = new PlatformPluginRegistry();
  const disposeA = registry.registerFormat('stale.format', { detect: () => 'A' });
  disposeA();

  const disposeB = registry.registerFormat('stale.format', { detect: () => 'B' });
  disposeA();
  disposeA();

  const formats = registry.list('format');
  assert.equal(formats.length, 1, 'stale direct disposer must not remove a newer registration');
  assert.equal(formats[0].contribution.detect(), 'B');

  disposeB();
  disposeB();
  assert.equal(registry.list('format').length, 0, 'current direct disposer remains idempotent');
}

{
  const registry = new PlatformPluginRegistry();
  const disposeA = registry.registerPlugin(analyzerManifest('1.0.0'), {
    'stale.analyzer': { analyze: async () => 'A' },
  });
  disposeA();

  const disposeB = registry.registerPlugin(analyzerManifest('1.0.1'), {
    'stale.analyzer': { analyze: async () => 'B' },
  });
  disposeA();
  disposeA();

  const plugins = registry.listPlugins();
  assert.equal(plugins.length, 1, 'stale plugin disposer must not remove the newer plugin generation');
  assert.equal(plugins[0].id, 'stale.plugin');
  assert.equal(plugins[0].version, '1.0.1');
  assert.equal(registry.list('analyzer').length, 1, 'plugin and contribution registries must remain consistent');

  const result = await registry.invoke('analyzer', 'stale.analyzer', 'analyze', {});
  assert.equal(result.ok, true);
  assert.equal(result.value, 'B', 'newer contribution must remain invokable after stale disposal');

  disposeB();
  disposeB();
  assert.equal(registry.listPlugins().length, 0, 'current plugin disposer removes its own plugin record');
  assert.equal(registry.list('analyzer').length, 0, 'current plugin disposer removes its own contribution record');
}
