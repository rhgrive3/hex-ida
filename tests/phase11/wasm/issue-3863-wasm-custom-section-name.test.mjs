import assert from 'node:assert/strict';
import { parseWasm } from '../../../js/managed/wasm/parser.js';

const HEADER = [
  0x00, 0x61, 0x73, 0x6d,
  0x01, 0x00, 0x00, 0x00,
];

function customSection(payload) {
  assert.ok(payload.length < 0x80, 'fixture uses a one-byte section size');
  return Uint8Array.from([...HEADER, 0x00, payload.length, ...payload]);
}

assert.throws(
  () => parseWasm(customSection([0x01, 0xff])),
  TypeError,
  'invalid UTF-8 in the required custom-section name must fail closed',
);

assert.throws(
  () => parseWasm(customSection([0x02, 0x41])),
  /wasm-truncated-name/,
  'a custom-section name may not extend beyond the section payload',
);

assert.throws(
  () => parseWasm(customSection([0x80, 0x80, 0x80, 0x80, 0x80])),
  /wasm-malformed-uleb128/,
  'malformed name length ULEB128 must not be swallowed',
);

const named = parseWasm(customSection([0x03, 0x66, 0x6f, 0x6f, 0xaa, 0xbb]));
assert.equal(named.customSections.length, 1);
assert.equal(named.customSections[0].name, 'foo');
assert.deepEqual([...named.customSections[0].data], [0xaa, 0xbb]);

const empty = parseWasm(customSection([0x00, 0xde, 0xad]));
assert.equal(empty.customSections.length, 1);
assert.equal(empty.customSections[0].name, '');
assert.deepEqual([...empty.customSections[0].data], [0xde, 0xad]);

console.log('issue-3863 wasm custom-section name validation: ok');
