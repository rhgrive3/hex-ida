import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseCilMethodSignature,
  parseCilMethodSpecInstantiation,
} from '../../../js/managed/cil/call-signature-types.js';

const rows = Object.freeze([1, 1, 1]); // tag 0 TypeDef, tag 1 TypeRef, tag 2 TypeSpec
const parse = (bytes) => parseCilMethodSignature(Uint8Array.from(bytes), rows);
const invalid = /cil-call-signature-invalid/;

test('#7603 accepts an existing TypeDefOrRef and preserves structural-only parsing without authority', () => {
  const signature = parse([0x00, 0x00, 0x12, 0x04]); // static class TypeDef#1()
  assert.equal(signature.returnValue.stackType, 'object-ref');
  assert.equal(signature.returnValue.typeToken, 0x04);

  const structural = parseCilMethodSignature(Uint8Array.from([0x00, 0x00, 0x12, 0x08]));
  assert.equal(structural.returnValue.typeToken, 0x08, 'standalone parser has no metadata row-count authority');
});

test('#7603 rejects out-of-range TypeDef, TypeRef, and TypeSpec RIDs', () => {
  assert.throws(() => parse([0x00, 0x00, 0x12, 0x08]), invalid); // TypeDef#2
  assert.throws(() => parse([0x00, 0x00, 0x11, 0x09]), invalid); // TypeRef#2
  assert.throws(() => parse([0x00, 0x00, 0x12, 0x0a]), invalid); // TypeSpec#2
  assert.throws(() => parse([0x00, 0x00, 0x12, 0x07]), invalid); // tag 3 remains invalid
});

test('#7603 validates custom modifiers and GENERICINST type references against row counts', () => {
  assert.throws(() => parse([0x00, 0x00, 0x20, 0x08, 0x01]), invalid); // modopt TypeDef#2 + void
  assert.throws(() => parse([0x00, 0x00, 0x15, 0x12, 0x08, 0x01, 0x08]), invalid); // class TypeDef#2<int32>
});

test('#7603 validates MethodSpec generic argument TypeDefOrRef references', () => {
  const valid = parseCilMethodSpecInstantiation(Uint8Array.from([0x0a, 0x01, 0x12, 0x04]), rows);
  assert.equal(valid[0].typeToken, 0x04);
  assert.throws(
    () => parseCilMethodSpecInstantiation(Uint8Array.from([0x0a, 0x01, 0x12, 0x08]), rows),
    /cil-call-signature-methodspec-invalid/,
  );
});
