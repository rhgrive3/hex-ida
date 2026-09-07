import assert from 'node:assert/strict';
import {
  decodeUleb128,
  decodeSleb128,
  decodeSleb128_64,
  parseWasm,
} from '../../../js/managed/wasm/parser.js';

console.log('[phase11] running issue #3850 LEB128 width tests...');

const bytes = values => Uint8Array.from(values);
const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

assert.equal(decodeUleb128(bytes([0xe5, 0x8e, 0x26]), 0).value, 624485);
assert.equal(decodeUleb128(bytes([0xff, 0xff, 0xff, 0xff, 0x0f]), 0).value, 0xffffffff);
assert.throws(
  () => decodeUleb128(bytes([0x80, 0x80, 0x80, 0x80, 0x10]), 0),
  /wasm-malformed-uleb128/,
);
assert.throws(
  () => decodeUleb128(bytes([0xff, 0xff, 0xff, 0xff, 0x1f]), 0),
  /wasm-malformed-uleb128/,
);

assert.equal(decodeSleb128(bytes([0xff, 0xff, 0xff, 0xff, 0x07]), 0).value, 0x7fffffff);
assert.equal(decodeSleb128(bytes([0x80, 0x80, 0x80, 0x80, 0x78]), 0).value, -0x80000000);
assert.throws(
  () => decodeSleb128(bytes([0x80, 0x80, 0x80, 0x80, 0x08]), 0),
  /wasm-malformed-sleb128/,
);
assert.throws(
  () => decodeSleb128(bytes([0xff, 0xff, 0xff, 0xff, 0x77]), 0),
  /wasm-malformed-sleb128/,
);

const i64Max = [...Array(9).fill(0xff), 0x00];
const i64Min = [...Array(9).fill(0x80), 0x7f];
assert.equal(decodeSleb128_64(bytes(i64Max), 0).value, 0x7fffffffffffffffn);
assert.equal(decodeSleb128_64(bytes(i64Min), 0).value, -0x8000000000000000n);
assert.throws(
  () => decodeSleb128_64(bytes([...Array(9).fill(0x80), 0x01]), 0),
  /wasm-malformed-sleb128-64/,
);
assert.throws(
  () => decodeSleb128_64(bytes([...Array(9).fill(0xff), 0x7e]), 0),
  /wasm-malformed-sleb128-64/,
);

assert.throws(
  () => parseWasm(bytes([
    ...header,
    0x01, 0x80, 0x80, 0x80, 0x80, 0x10,
  ])),
  /wasm-malformed-uleb128/,
);

assert.throws(
  () => parseWasm(bytes([
    ...header,
    0x06, 0x0a,
    0x01, 0x7f, 0x00, 0x41,
    0x80, 0x80, 0x80, 0x80, 0x08,
    0x0b,
  ])),
  /wasm-malformed-sleb128/,
);

assert.throws(
  () => parseWasm(bytes([
    ...header,
    0x06, 0x0f,
    0x01, 0x7e, 0x00, 0x42,
    ...Array(9).fill(0x80), 0x01,
    0x0b,
  ])),
  /wasm-malformed-sleb128-64/,
);

console.log('  ok issue #3850 LEB128 width tests passed');
