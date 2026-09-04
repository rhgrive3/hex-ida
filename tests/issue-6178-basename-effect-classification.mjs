import test from 'node:test';
import assert from 'node:assert/strict';
import { extraApiInfo } from '../js/api-cross-binary-families.js';
import { apiInfo } from '../js/blocks.js';

test('issue #6178: basename is classified as string with pointer return and write effect', () => {
  for (const name of ['basename', '_basename']) {
    const extra = extraApiInfo(name);
    assert.ok(extra, `${name} must be classified in extraApiInfo`);
    assert.equal(extra.id, 'libc_basename');
    assert.equal(extra.cat, 'string');
    assert.deepEqual(extra.args, ['path']);
    assert.equal(extra.ret, 'ptr');
    assert.equal(extra.effect, 'write');

    const info = apiInfo(name);
    assert.ok(info, `${name} must be resolved by apiInfo`);
    assert.equal(info.id, 'libc_basename');
    assert.equal(info.cat, 'string');
    assert.notEqual(info.cat, 'io');
    assert.notEqual(info.effect, 'io');
    assert.equal(info.ret, 'ptr');
    assert.equal(info.effect, 'write');
    assert.deepEqual(info.args, ['path']);
  }
});

test('issue #6178: posix_io family retains valid filesystem/descriptor APIs', () => {
  for (const name of ['opendir', 'readdir', 'fstat', 'fcntl', 'getcwd', 'nftw', 'rename']) {
    const info = extraApiInfo(name);
    assert.ok(info, `${name} must remain classified`);
    assert.equal(info.id, 'posix_io');
    assert.equal(info.cat, 'io');
    assert.equal(info.effect, 'io');
  }
});

console.log('issue #6178 test file loaded.');
