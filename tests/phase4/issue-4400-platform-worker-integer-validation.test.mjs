import assert from 'node:assert/strict';
import {
  boundedOffset,
  checkedChunkIndex,
  chunkLength,
  exactExternalInteger,
  regionSize,
} from '../../js/platform/worker-validation.js';

const structuredIntegers = [
  [],
  [1],
  new Number(1),
  new String('1'),
  { valueOf() { return 1; } },
  { toString() { return '1'; } },
  { [Symbol.toPrimitive]() { return 1; } },
];

for (const value of structuredIntegers) {
  assert.throws(
    () => checkedChunkIndex(value),
    RangeError,
    `${Object.prototype.toString.call(value)} must not coerce into a chunk index`,
  );
  assert.throws(
    () => regionSize(value),
    RangeError,
    `${Object.prototype.toString.call(value)} must not coerce into a region size`,
  );
}

assert.equal(checkedChunkIndex(0), 0);
assert.equal(checkedChunkIndex(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
assert.equal(checkedChunkIndex(1n), 1);
assert.equal(checkedChunkIndex('1'), 1);
assert.equal(checkedChunkIndex(' 1 '), 1);
assert.equal(checkedChunkIndex('0x10'), 16);

assert.equal(regionSize(0), 0n);
assert.equal(regionSize(8n), 8n);
assert.equal(regionSize('8'), 8n);
assert.equal(regionSize(' 8 '), 8n);
assert.equal(regionSize('0x10'), 16n);

assert.throws(() => checkedChunkIndex(Number.MAX_SAFE_INTEGER + 1), RangeError);
assert.throws(() => regionSize(Number.MAX_SAFE_INTEGER + 1), RangeError);
assert.throws(() => regionSize(-1), RangeError);
assert.throws(() => regionSize(''), RangeError);
assert.throws(() => regionSize(true), RangeError);
assert.throws(() => regionSize(null), RangeError);

assert.throws(() => boundedOffset([1], 8), RangeError);
assert.throws(() => boundedOffset(1, [8]), RangeError);
assert.throws(() => chunkLength([8], 4), RangeError);
assert.throws(() => exactExternalInteger([8]), RangeError);

assert.equal(boundedOffset('12', '8'), 8n, 'existing numeric-string compatibility must remain');
assert.equal(chunkLength('8', 4), 4);
assert.equal(exactExternalInteger('8'), 8);
assert.equal(exactExternalInteger('9007199254740992'), 9007199254740992n);

console.log('issue #4400 platform worker integer validation: PASS');
