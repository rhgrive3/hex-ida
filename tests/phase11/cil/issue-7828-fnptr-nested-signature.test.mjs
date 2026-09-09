import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCilMethodSignature,
  parseCilMethodSpecInstantiation,
  substituteCilMethodGeneric,
} from '../../../js/managed/cil/call-signature-types.js';

const parse = (bytes) => parseCilMethodSignature(Uint8Array.from(bytes));

test('#7828 FNPTR return types keep their nested signature identity', () => {
  // static fnptr static void ()  vs  static fnptr static int32 ()
  const voidFn = parse([0x00, 0x00, 0x1b, 0x00, 0x00, 0x01]).returnValue;
  const intFn = parse([0x00, 0x00, 0x1b, 0x00, 0x00, 0x08]).returnValue;
  assert.equal(voidFn.stackType, 'native-int');
  assert.equal(intFn.stackType, 'native-int');
  assert.deepEqual(voidFn.fnPtr.returnValue, null);
  assert.deepEqual(intFn.fnPtr.returnValue, { stackType: 'int32', bits: 32 });
  assert.notDeepEqual(voidFn, intFn);
});

test('#7828 nested calling convention, hasThis, and parameters survive', () => {
  // static fnptr instance void (int32, int64)  — HASTHIS nested with params
  const fn = parse([0x00, 0x00, 0x1b, 0x20, 0x02, 0x01, 0x08, 0x0a]).returnValue;
  assert.equal(fn.stackType, 'native-int');
  assert.equal(fn.fnPtr.hasThis, true);
  assert.equal(fn.fnPtr.callConvention, 0x20);
  assert.equal(fn.fnPtr.parameters.length, 2);
  assert.deepEqual(fn.fnPtr.parameters[0], { stackType: 'int32', bits: 32 });
  assert.deepEqual(fn.fnPtr.parameters[1], { stackType: 'int64', bits: 64 });
  assert.deepEqual(fn.fnPtr.returnValue, null);
  // nested generic arity is preserved
  const genericFn = parse([0x00, 0x00, 0x1b, 0x10, 0x01, 0x00, 0x1e, 0x00]).returnValue;
  assert.equal(genericFn.fnPtr.genericParameterCount, 1);
  assert.deepEqual(genericFn.fnPtr.returnValue, { stackType: 'method-generic', genericIndex: 0 });
});

test('#7828 differently-typed nested signatures stay distinct through the type surface', () => {
  // two signatures whose only difference is the nested FNPTR return element type
  const a = parse([0x00, 0x00, 0x1b, 0x00, 0x00, 0x01]); // static fnptr void()
  const b = parse([0x00, 0x00, 0x1b, 0x00, 0x00, 0x08]); // static fnptr int32()
  assert.equal(a.returnValue.stackType, 'native-int');
  assert.equal(b.returnValue.stackType, 'native-int');
  assert.deepEqual(a.returnValue.fnPtr.returnValue, null);
  assert.deepEqual(b.returnValue.fnPtr.returnValue, { stackType: 'int32', bits: 32 });
  assert.notDeepEqual(a.returnValue, b.returnValue);
  assert.notDeepEqual(a.returnValue.fnPtr, b.returnValue.fnPtr);
  // the same collapse through an FNPTR parameter (conv, count=1, ret=VOID, param=FNPTR)
  const c = parse([0x00, 0x01, 0x01, 0x1b, 0x00, 0x00, 0x01]); // static void (fnptr void())
  const d = parse([0x00, 0x01, 0x01, 0x1b, 0x00, 0x00, 0x08]); // static void (fnptr int32())
  assert.notDeepEqual(c.parameters[0], d.parameters[0]);
  assert.notDeepEqual(c.parameters[0].fnPtr, d.parameters[0].fnPtr);
});

test('#7828 MethodSpec substitution descends into FNPTR nested method generics', () => {
  // outer generic method M<T>: fnptr static !!0 ()
  const signature = parse([0x10, 0x01, 0x00, 0x1b, 0x00, 0x00, 0x1e, 0x00]);
  assert.deepEqual(signature.returnValue.fnPtr.returnValue, { stackType: 'method-generic', genericIndex: 0 });
  const args = parseCilMethodSpecInstantiation(Uint8Array.from([0x0a, 0x01, 0x08])); // <int32>
  const instantiated = substituteCilMethodGeneric(signature.returnValue, args);
  assert.deepEqual(instantiated.fnPtr.returnValue, { stackType: 'int32', bits: 32 });
  assert.notDeepEqual(instantiated, signature.returnValue);
});

test('#7828 malformed nested signatures still fail closed', () => {
  // nested FNPTR body truncated (no return element type)
  assert.throws(() => parse([0x00, 0x00, 0x1b, 0x00]), /cil-call-signature-invalid/);
  // nested FNPTR with an invalid calling convention
  assert.throws(() => parse([0x00, 0x00, 0x1b, 0x0f, 0x00, 0x01]), /cil-call-signature-invalid/);
  // nested FNPTR with an out-of-range MVAR (outer declares no generics)
  assert.throws(() => parse([0x00, 0x00, 0x1b, 0x00, 0x00, 0x1e, 0x00]), /cil-call-signature-invalid/);
});
