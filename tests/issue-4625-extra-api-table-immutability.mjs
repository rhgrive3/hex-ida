import test from 'node:test';
import assert from 'node:assert/strict';
import { extraApiInfo } from '../js/api-cross-binary-families.js';
import { apiInfo } from '../js/blocks.js';

test('issue #4625: extraApiInfo returned entry is deeply frozen and immutable', () => {
  const info = extraApiInfo('strndup');
  assert.ok(info);
  assert.equal(info.id, 'libc_strndup');
  assert.equal(info.effect, 'alloc');
  assert.deepEqual(info.args, ['str', 'maxlen']);

  // Modifying entry properties directly must throw TypeError in strict mode
  assert.throws(() => {
    info.effect = 'pure';
  }, TypeError);

  assert.throws(() => {
    info.cat = 'io';
  }, TypeError);

  assert.throws(() => {
    info.ret = 'number';
  }, TypeError);

  assert.throws(() => {
    info.id = 'tampered';
  }, TypeError);

  // Modifying nested args array must throw TypeError
  assert.throws(() => {
    info.args.push('tampered_arg');
  }, TypeError);

  assert.throws(() => {
    info.args[0] = 'tampered_str';
  }, TypeError);

  // Subsequent lookups must be completely unaffected
  const nextInfo = extraApiInfo('strndup');
  assert.equal(nextInfo.id, 'libc_strndup');
  assert.equal(nextInfo.effect, 'alloc');
  assert.equal(nextInfo.cat, 'string');
  assert.equal(nextInfo.ret, 'heap');
  assert.deepEqual(nextInfo.args, ['str', 'maxlen']);
});

test('issue #4625: all returned entries across families are frozen', () => {
  const sampleNames = ['basename', 'SecCertificateCopyData', 'vImageScale_ARGB8888', 'qsort', 'difftime', 'reallocf'];
  for (const name of sampleNames) {
    const info = extraApiInfo(name);
    assert.ok(info, `${name} should be found`);
    assert.ok(Object.isFrozen(info), `${name} entry should be frozen`);
    if (info.args) {
      assert.ok(Object.isFrozen(info.args), `${name} args array should be frozen`);
    }
  }
});

test('issue #4625: apiInfo maintains precise table precedence over frozen extraApiInfo', () => {
  // malloc is in blocks-base.js with exact heap return
  const mallocInfo = apiInfo('malloc');
  assert.ok(mallocInfo);
  assert.equal(mallocInfo.id, 'malloc');

  // free is in blocks-base.js
  const freeInfo = apiInfo('free');
  assert.ok(freeInfo);
  assert.equal(freeInfo.id, 'free');
});

console.log('issue #4625 test file loaded.');
