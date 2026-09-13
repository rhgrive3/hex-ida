import test from 'node:test';
import assert from 'node:assert/strict';

import { extraApiInfo } from '../js/api-cross-binary-families.js';
import { apiInfo } from '../js/blocks.js';

test('issue #5064: strtoll/strtoull expose the numeric return contract', () => {
  for (const name of ['strtoll', '_strtoll', 'strtoull', '_strtoull']) {
    const extra = extraApiInfo(name);
    assert.ok(extra, `${name} must be classified in extraApiInfo`);
    assert.equal(extra.id, 'libc_strto', name);
    assert.equal(extra.cat, 'string', name);
    assert.equal(extra.ret, 'number', name);

    const info = apiInfo(name);
    assert.ok(info, `${name} must be resolved by apiInfo`);
    assert.equal(info.id, 'libc_strto', name);
    assert.equal(info.ret, 'number', name);
  }
});

test('issue #5064: libc_strto return contract is symmetric with strtol/strtoul', () => {
  const longRet = apiInfo('strtol').ret;
  const unsignedLongRet = apiInfo('strtoul').ret;
  assert.equal(longRet, 'number');
  assert.equal(unsignedLongRet, 'number');

  assert.equal(apiInfo('strtoll').ret, longRet);
  assert.equal(apiInfo('strtoull').ret, unsignedLongRet);
});

test('issue #5064: the strtoll family keeps its endptr write effect and family identity', () => {
  for (const name of ['strtoll', 'strtoull']) {
    const info = extraApiInfo(name);
    assert.equal(info.id, 'libc_strto', name);
    assert.equal(info.effect, 'write', name);
  }
  assert.equal(apiInfo('strtol').id, 'strtol');
  assert.equal(apiInfo('strtoul').id, 'strtol');
});

console.log('issue #5064 test file loaded.');
