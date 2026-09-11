// Regression for #5709: the BigInt wire decoder accepted non-canonical decimal
// spellings (`01`, `00`, `-0`, `-01`) that encodeWireValue() can never emit
// (BigInt.toString(10) produces `0`, `1`, `-1` …), aliasing them onto canonical
// values. The decoder now enforces the exact canonical grammar:
// `0`, `-?[1-9]\d*`.
import assert from 'node:assert/strict';
import { decodeWireValue, encodeWireValue, WIRE_TAG, BIGINT_TAG } from '../../../js/debug/remote-protocol.js';

// Canonical spellings decode, and encode/decode round-trips.
for (const [text, expected] of [['0', 0n], ['1', 1n], ['9007199254740993', 9007199254740993n], ['-1', -1n], ['123456789012345678901234567890', 123456789012345678901234567890n], ['-987654321098765432109876543210', -987654321098765432109876543210n]]) {
  assert.equal(decodeWireValue({ [WIRE_TAG]: BIGINT_TAG, value: text }), expected, `${text} decodes to ${expected}`);
  const wire = encodeWireValue(expected);
  assert.deepEqual(decodeWireValue(wire), expected, `encode/decode round-trips ${expected}`);
  assert.deepEqual(encodeWireValue(decodeWireValue(wire)), wire, 'canonical tagged value round-trips exactly');
  assert.match(wire.value, /^(0|-?[1-9]\d*)$/, 'the encoder emits canonical spellings only');
}

// Non-canonical spellings are rejected, not aliased.
for (const text of ['01', '00', '007', '-0', '-01', '-007', '+1', ' 1', '1 ', '1\n', '1\r', '1\u2028', '1\u2029', '1.0', '', '0x10', '١٢٣']) {
  assert.throws(
    () => decodeWireValue({ [WIRE_TAG]: BIGINT_TAG, value: text }),
    (error) => error?.code === 'malformed-packet',
    `non-canonical spelling ${JSON.stringify(text)} must be rejected`,
  );
}

console.log('issue #5709 bigint wire canonical spelling: PASS');

for (const value of [1, true, {}, null]) {
  assert.throws(() => decodeWireValue({ [WIRE_TAG]: BIGINT_TAG, value }), (error) => error?.code === 'malformed-packet');
}
