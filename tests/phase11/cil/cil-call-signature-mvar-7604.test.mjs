import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCilMethodSignature } from '../../../js/managed/cil/call-signature-types.js';

const parse = (bytes) => parseCilMethodSignature(Uint8Array.from(bytes));
const invalid = /cil-call-signature-invalid/;

test('#7604 accepts an in-range method generic parameter', () => {
  const signature = parse([0x10, 0x01, 0x00, 0x1e, 0x00]); // generic<1> static !!0()
  assert.equal(signature.genericParameterCount, 1);
  assert.equal(signature.returnValue.stackType, 'method-generic');
  assert.equal(signature.returnValue.genericIndex, 0);
});

test('#7604 rejects an out-of-range MVAR in return and parameter types', () => {
  assert.throws(() => parse([0x10, 0x01, 0x00, 0x1e, 0x01]), invalid);
  assert.throws(() => parse([0x10, 0x01, 0x01, 0x01, 0x1e, 0x01]), invalid);
  assert.throws(() => parse([0x00, 0x00, 0x1e, 0x00]), invalid);
});

test('#7604 propagates the method generic bound through nested type constructors', () => {
  // PTR !!1, SZARRAY !!1, ARRAY !!1[rank=1], GENERICINST class #1<!!1>.
  for (const returnType of [
    [0x0f, 0x1e, 0x01],
    [0x1d, 0x1e, 0x01],
    [0x14, 0x1e, 0x01, 0x01, 0x00, 0x00],
    [0x15, 0x12, 0x04, 0x01, 0x1e, 0x01],
  ]) {
    assert.throws(() => parse([0x10, 0x01, 0x00, ...returnType]), invalid);
  }
});

test('#7604 propagates the outer method generic bound into a nested FNPTR signature', () => {
  // generic<1> static fnptr static !!1 ()
  assert.throws(() => parse([0x10, 0x01, 0x00, 0x1b, 0x00, 0x00, 0x1e, 0x01]), invalid);
});
