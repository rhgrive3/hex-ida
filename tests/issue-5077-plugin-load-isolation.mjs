import assert from 'node:assert/strict';
import { PluginHost } from '../js/plugins.js';

function stubStorage(raw) {
  globalThis.localStorage = {
    getItem: () => raw,
    setItem: () => {},
  };
}
function clearStorage() {
  delete globalThis.localStorage;
}

// 1. [broken, valid]: validだけ復元される
{
  stubStorage(JSON.stringify([
    { v: 3, installationId: 'broken', source: 'hex.plugin({})', definitions: [null] },
    {
      v: 3, installationId: 'good', source: 'good source', origin: 'test',
      definitions: [{ index: 0, name: 'Good', description: 'valid' }],
      enabledIndexes: [0],
    },
  ]));
  const host = new PluginHost({});
  await host.ready;
  assert.equal(host.plugins.length, 1);
  assert.equal(host.plugins[0].installationId, 'good');
  assert.equal(host.plugins[0].name, 'Good');
  assert.ok(host.installations.has('good'));
  assert.ok(!host.installations.has('broken'));
  clearStorage();
}

// 2. [valid, broken, valid]: 前後のvalidが両方復元される
{
  const mk = (id) => ({
    v: 3, installationId: id, source: `source ${id}`, origin: 'test',
    definitions: [{ index: 0, name: `N-${id}`, description: 'd' }],
    enabledIndexes: [0],
  });
  stubStorage(JSON.stringify([
    mk('first'),
    { v: 3, installationId: 'broken', source: 'hex.plugin({})', definitions: [null] },
    mk('third'),
  ]));
  const host = new PluginHost({});
  await host.ready;
  const ids = host.plugins.map((p) => p.installationId).sort();
  assert.deepEqual(ids, ['first', 'third']);
  clearStorage();
}

// 3. 各種malformed definitionsを個別に扱う (primitive / missing index / non-integer index)
{
  const good = {
    v: 3, installationId: 'good', source: 'good source', origin: 'test',
    definitions: [{ index: 0, name: 'Good', description: 'valid' }],
    enabledIndexes: [0],
  };
  for (const badDefs of [[42], [{ name: 'NoIndex' }], [{ index: 1.5, name: 'X' }], [{ index: '0', name: 'X' }]]) {
    stubStorage(JSON.stringify([
      { v: 3, installationId: 'broken', source: 's', definitions: badDefs },
      good,
    ]));
    const host = new PluginHost({});
    await host.ready;
    assert.equal(host.plugins.length, 1, `badDefs=${JSON.stringify(badDefs)}`);
    assert.equal(host.plugins[0].installationId, 'good');
    clearStorage();
  }
}

// 4. JSON全体が壊れている場合は従来どおり空で安全に復帰
{
  stubStorage('{{{not json');
  const host = new PluginHost({});
  await host.ready;
  assert.equal(host.plugins.length, 0);
  assert.equal(host.installations.size, 0);
  clearStorage();
}

// 5. 正常v3 fast pathはsandbox再実行なしで復元される
{
  stubStorage(JSON.stringify([
    {
      v: 3, installationId: 'ok1', source: 'source ok', origin: 'test',
      definitions: [
        { index: 0, name: 'A', description: 'da' },
        { index: 1, name: 'B', description: 'db' },
      ],
      enabledIndexes: [0, 1],
    },
  ]));
  const host = new PluginHost({});
  await host.ready;
  assert.equal(host.plugins.length, 2);
  assert.deepEqual(host.plugins.map((p) => p.id).sort(), ['ok1:0', 'ok1:1']);
  clearStorage();
}

console.log('issue #5077 plugin load entry isolation: PASS');
