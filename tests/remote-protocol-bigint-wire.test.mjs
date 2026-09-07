import assert from 'node:assert/strict';
import {
  BIGINT_TAG,
  WIRE_TAG,
  decodeWireValue,
  encodeWireValue,
} from '../js/debug/remote-protocol.js';

function assertMalformed(value) {
  assert.throws(
    () => decodeWireValue({ [WIRE_TAG]: BIGINT_TAG, value }),
    (error) => error?.code === 'malformed-packet' && /invalid bigint wire value/.test(error.message),
  );
}

assert.equal(decodeWireValue({ [WIRE_TAG]: BIGINT_TAG, value: '1' }), 1n);
assert.equal(
  decodeWireValue({ [WIRE_TAG]: BIGINT_TAG, value: '9007199254740993' }),
  9007199254740993n,
);

assertMalformed(1);
assertMalformed(9007199254740993);
assertMalformed(true);
assertMalformed({});

for (const value of [0n, 1n, -1n, 9007199254740993n]) {
  assert.equal(decodeWireValue(encodeWireValue(value)), value);
}

console.log('remote-protocol BigInt wire payload tests passed');
