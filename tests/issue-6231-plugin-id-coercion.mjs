import test from 'node:test';
import assert from 'node:assert/strict';
import { PlatformPluginRegistry } from '../js/platform/plugin-api.js';

test('issue 6231: rejects array and object coercion for contribution IDs', () => {
  const reg = new PlatformPluginRegistry();
  const badIds = [
    ['format.demo'],
    { toString() { return 'format.demo'; } },
    12345,
    true,
    false,
    null,
    undefined,
    Symbol('format.demo'),
  ];

  for (const badId of badIds) {
    assert.throws(
      () => reg.registerFormat(badId, { detect: () => true }),
      /plugin contribution id must be stable and non-empty/
    );
    assert.throws(
      () => reg.registerArchitecture(badId, { instructionAlignment: 1 }),
      /plugin contribution id must be stable and non-empty/
    );
    assert.throws(
      () => reg.registerKnowledgeProvider(badId, { lookup: () => [] }),
      /plugin contribution id must be stable and non-empty/
    );
    assert.throws(
      () => reg.registerAnalyzer(badId, { analyze: async () => ({}) }),
      /plugin contribution id must be stable and non-empty/
    );
  }

  assert.equal(reg.list('format').length, 0);
  assert.equal(reg.list('architecture').length, 0);
  assert.equal(reg.list('knowledgeProvider').length, 0);
  assert.equal(reg.list('analyzer').length, 0);
});

test('issue 6231: valid primitive string contribution IDs register and unregister normally', () => {
  const reg = new PlatformPluginRegistry();
  const unregister = reg.registerFormat('format.demo', { detect: () => true });

  const list = reg.list('format');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'format.demo');

  // Duplicate registration should throw
  assert.throws(
    () => reg.registerFormat('format.demo', { detect: () => true }),
    /already registered/
  );

  unregister();
  assert.equal(reg.list('format').length, 0);
});

test('issue 6231: registerAnalyzer works with valid primitive string ID', async () => {
  const reg = new PlatformPluginRegistry();
  const unregister = reg.registerAnalyzer('analyzer.valid', {
    analyze: async () => ({ score: 42 }),
  });

  const list = reg.list('analyzer');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'analyzer.valid');

  const res = await reg.invoke('analyzer', 'analyzer.valid', 'analyze', {});
  assert.equal(res.ok, true);
  assert.equal(res.value?.score, 42);

  unregister();
  assert.equal(reg.list('analyzer').length, 0);
});
