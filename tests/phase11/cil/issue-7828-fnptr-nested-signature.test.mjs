import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCilMethodSignature,
  parseCilMethodSpecInstantiation,
  substituteCilMethodGeneric,
} from '../../../js/managed/cil/call-signature-types.js';

const parse = (bytes) => parseCilMethodSignature(Uint8Array.from(bytes));

test('#7828 FNPTR return types keep their nested signature identity', () => {
  const voidFn = parse([0x00, 0x00, 0x1b, 0x00, 0x00, 0x01]).returnValue;
  const intFn = parse([0x00, 0x00, 0x1b, 0x00, 0x00, 0x08]).returnValue;
  assert.equal(voidFn.stackType, 'native-int');
  assert.equal(intFn.stackType, 'native-int');
  assert.equal(voidFn.fnPtr.kind, 0x00);
  assert.equal(intFn.fnPtr.kind, 0x00);
  assert.equal(voidFn.fnPtr.returnValue, null);
  assert.equal(intFn.fnPtr.returnValue.stackType, 'int32');
  assert.equal(intFn.fnPtr.returnValue.bits, 32);
  assert.equal(intFn.fnPtr.returnValue.primitive, 'i4');
  assert.notDeepEqual(voidFn, intFn);
});

test('#7828 nested calling convention, this-shape, generic arity, and parameters survive', () => {
  const fn = parse([0x00, 0x00, 0x1b, 0x20, 0x02, 0x01, 0x08, 0x0a]).returnValue;
  assert.equal(fn.stackType, 'native-int');
  assert.equal(fn.fnPtr.hasThis, true);
  assert.equal(fn.fnPtr.explicitThis, false);
  assert.equal(fn.fnPtr.callConvention, 0x20);
  assert.equal(fn.fnPtr.kind, 0x00);
  assert.equal(fn.fnPtr.parameters.length, 2);
  assert.equal(fn.fnPtr.parameters[0].primitive, 'i4');
  assert.equal(fn.fnPtr.parameters[1].primitive, 'i8');
  assert.equal(fn.fnPtr.returnValue, null);

  const explicit = parse([0x00, 0x00, 0x1b, 0x60, 0x00, 0x01]).returnValue;
  assert.equal(explicit.fnPtr.hasThis, true);
  assert.equal(explicit.fnPtr.explicitThis, true);

  const genericFn = parse([0x00, 0x00, 0x1b, 0x10, 0x01, 0x00, 0x1e, 0x00]).returnValue;
  assert.equal(genericFn.fnPtr.genericParameterCount, 1);
  assert.deepEqual(genericFn.fnPtr.returnValue, { stackType: 'method-generic', genericIndex: 0 });
});

test('#7828 nested VARARG sentinel position is exact FNPTR identity', () => {
  const beforeI4 = parse([0x00, 0x00, 0x1b, 0x05, 0x02, 0x01, 0x41, 0x08, 0x0a]).returnValue;
  const beforeI8 = parse([0x00, 0x00, 0x1b, 0x05, 0x02, 0x01, 0x08, 0x41, 0x0a]).returnValue;
  assert.equal(beforeI4.fnPtr.kind, 0x05);
  assert.equal(beforeI8.fnPtr.kind, 0x05);
  assert.equal(beforeI4.fnPtr.sentinelIndex, 0);
  assert.equal(beforeI8.fnPtr.sentinelIndex, 1);
  assert.deepEqual(beforeI4.fnPtr.parameters.map((p) => p.primitive), ['i4', 'i8']);
  assert.deepEqual(beforeI8.fnPtr.parameters.map((p) => p.primitive), ['i4', 'i8']);
  assert.notDeepEqual(beforeI4.fnPtr, beforeI8.fnPtr);
  assert.notDeepEqual(beforeI4, beforeI8);
});

test('#7828 differently-typed nested signatures stay distinct through return and parameter surfaces', () => {
  const a = parse([0x00, 0x00, 0x1b, 0x00, 0x00, 0x01]);
  const b = parse([0x00, 0x00, 0x1b, 0x00, 0x00, 0x08]);
  assert.equal(a.returnValue.stackType, 'native-int');
  assert.equal(b.returnValue.stackType, 'native-int');
  assert.equal(a.returnValue.fnPtr.returnValue, null);
  assert.equal(b.returnValue.fnPtr.returnValue.primitive, 'i4');
  assert.notDeepEqual(a.returnValue, b.returnValue);
  assert.notDeepEqual(a.returnValue.fnPtr, b.returnValue.fnPtr);

  const c = parse([0x00, 0x01, 0x01, 0x1b, 0x00, 0x00, 0x01]);
  const d = parse([0x00, 0x01, 0x01, 0x1b, 0x00, 0x00, 0x08]);
  assert.notDeepEqual(c.parameters[0], d.parameters[0]);
  assert.notDeepEqual(c.parameters[0].fnPtr, d.parameters[0].fnPtr);
});

test('#7828 MethodSpec substitution descends into FNPTR nested method generics', () => {
  const signature = parse([0x10, 0x01, 0x00, 0x1b, 0x00, 0x00, 0x1e, 0x00]);
  assert.deepEqual(signature.returnValue.fnPtr.returnValue, { stackType: 'method-generic', genericIndex: 0 });
  const args = parseCilMethodSpecInstantiation(Uint8Array.from([0x0a, 0x01, 0x08]));
  const instantiated = substituteCilMethodGeneric(signature.returnValue, args);
  assert.equal(instantiated.fnPtr.returnValue.stackType, 'int32');
  assert.equal(instantiated.fnPtr.returnValue.bits, 32);
  assert.equal(instantiated.fnPtr.returnValue.primitive, 'i4');
  assert.notDeepEqual(instantiated, signature.returnValue);
});

test('#7828 malformed nested signatures still fail closed', () => {
  assert.throws(() => parse([0x00, 0x00, 0x1b, 0x00]), /cil-call-signature-invalid/);
  assert.throws(() => parse([0x00, 0x00, 0x1b, 0x0f, 0x00, 0x01]), /cil-call-signature-invalid/);
  assert.throws(() => parse([0x00, 0x00, 0x1b, 0x00, 0x00, 0x1e, 0x00]), /cil-call-signature-invalid/);
  assert.throws(() => parse([0x00, 0x00, 0x1b, 0x05, 0x01, 0x01, 0x41]), /cil-call-signature-invalid/);
  assert.throws(() => parse([0x00, 0x00, 0x1b, 0x00, 0x01, 0x01, 0x41, 0x08]), /cil-call-signature-invalid/);
});
