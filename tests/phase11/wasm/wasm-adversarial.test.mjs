import assert from 'node:assert/strict';
import { parseWasm } from '../../../js/managed/wasm/parser.js';

console.log('[phase11] running wasm adversarial tests...');

// 1. Truncated header
assert.throws(() => {
  parseWasm(new Uint8Array([0x00, 0x61, 0x73]));
}, /wasm-unsupported-binary/);

// 2. Truncated section payload
assert.throws(() => {
  parseWasm(new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x20, // section 1 declares 32 bytes but none provided
  ]));
}, /wasm-truncated-section-payload/);

// 3. Corrupted LEB128
assert.throws(() => {
  parseWasm(new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, // infinite LEB128
  ]));
}, /wasm-malformed-uleb128/);

// 4. Recognized but unsupported binary versions must not run through the v1 parser.
const version2 = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d,
  0x02, 0x00, 0x00, 0x00,
]);
assert.throws(() => {
  parseWasm(version2);
}, /wasm-unsupported-version/);

// 5. Arbitrary future/invalid version words are rejected by the v1 parser as well.
assert.throws(() => {
  parseWasm(new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0xff, 0xff, 0xff, 0xff,
  ]));
}, /wasm-unsupported-version/);

console.log('  ok wasm adversarial tests passed');
