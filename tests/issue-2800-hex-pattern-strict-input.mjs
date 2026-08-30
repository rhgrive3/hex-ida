import assert from 'node:assert/strict';
import { parseHexPattern } from '../js/format.js';

for (const value of [
  ['AA'],
  { toString() { return 'DE AD'; } },
  170,
  true,
  null,
  undefined,
]) {
  assert.equal(parseHexPattern(value), null);
}

const normal = parseHexPattern('0xDE, 0xAD');
assert.deepEqual([...normal.bytes], [0xde, 0xad]);
assert.deepEqual([...normal.mask], [0xff, 0xff]);

const wildcard = parseHexPattern('A? ??');
assert.deepEqual([...wildcard.bytes], [0xa0, 0x00]);
assert.deepEqual([...wildcard.mask], [0xf0, 0x00]);

console.log('hex pattern strict input regression PASS');
