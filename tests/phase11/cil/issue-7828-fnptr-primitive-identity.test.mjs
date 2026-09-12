import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseCilMethodSignature,
  parseCilMethodSpecInstantiation,
  substituteCilMethodGeneric,
} from '../../../js/managed/cil/call-signature-types.js';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import { buildCil } from '../fixtures/medium-cil.mjs';

// R1 remediation for #7705 — two lossless-identity blockers fixed together:
// (1) FNPTR nested method signatures keep their exact identity through the
//     unified `fnPtr` public schema (#7828 lineage: calling convention,
//     HASTHIS/EXPLICITTHIS, generic arity, VARARG sentinel position,
//     parameters, return type); only the evaluation-stack storage category
//     is native-int.
// (2) The primitive ELEMENT_TYPE family keeps its exact metadata identity
//     (kind/signedness/char/bool/width) as a lossless field while sharing the
//     evaluation-stack category — I4[] and U4[] are different constructed
//     types and must not collide anywhere a decoded Type participates.

const parse = (bytes) => parseCilMethodSignature(Uint8Array.from(bytes));

test('#7828 FNPTR return types keep their nested signature identity', () => {
  // static fnptr static void ()  vs  static fnptr static int32 ()
  const voidFn = parse([0x00, 0x00, 0x1b, 0x00, 0x00, 0x01]).returnValue;
  const intFn = parse([0x00, 0x00, 0x1b, 0x00, 0x00, 0x08]).returnValue;
  assert.equal(voidFn.stackType, 'native-int');
  assert.equal(intFn.stackType, 'native-int');
  assert.deepEqual(voidFn.fnPtr.returnValue, null);
  assert.deepEqual(intFn.fnPtr.returnValue, { stackType: 'int32', bits: 32, primitive: 'i4' });
  assert.notDeepEqual(voidFn, intFn);
});

test('#7828 nested calling convention, hasThis, and parameters survive', () => {
  // static fnptr instance void (int32, int64)  — HASTHIS nested with params
  const fn = parse([0x00, 0x00, 0x1b, 0x20, 0x02, 0x01, 0x08, 0x0a]).returnValue;
  assert.equal(fn.stackType, 'native-int');
  assert.equal(fn.fnPtr.hasThis, true);
  assert.equal(fn.fnPtr.callConvention, 0x20);
  assert.equal(fn.fnPtr.parameters.length, 2);
  assert.deepEqual(fn.fnPtr.parameters[0], { stackType: 'int32', bits: 32, primitive: 'i4' });
  assert.deepEqual(fn.fnPtr.parameters[1], { stackType: 'int64', bits: 64, primitive: 'i8' });
  assert.deepEqual(fn.fnPtr.returnValue, null);
  // nested generic arity is preserved
  const genericFn = parse([0x00, 0x00, 0x1b, 0x10, 0x01, 0x00, 0x1e, 0x00]).returnValue;
  assert.equal(genericFn.fnPtr.genericParameterCount, 1);
  assert.deepEqual(genericFn.fnPtr.returnValue, { stackType: 'method-generic', genericIndex: 0 });
});

test('#7828 EXPLICITTHIS and VARARG sentinel position stay in the fnPtr identity', () => {
  // EXPLICITTHIS (0x40|0x20) nested instance explicit void (int32)
  const explicit = parse([0x00, 0x00, 0x1b, 0x60, 0x01, 0x01, 0x08]).returnValue;
  assert.equal(explicit.fnPtr.explicitThis, true);
  assert.equal(explicit.fnPtr.hasThis, true);
  // VARARG sentinel position: (int32, SENTINEL, int64) vs (SENTINEL, int32)
  // vs (int32, SENTINEL) are three distinct calling shapes.
  const mid = parse([0x05, 0x02, 0x01, 0x08, 0x41, 0x0a]);
  assert.equal(mid.sentinelIndex, 1);
  const lead = parse([0x05, 0x01, 0x01, 0x41, 0x08]);
  assert.equal(lead.sentinelIndex, 0);
  const trail = parse([0x05, 0x03, 0x01, 0x08, 0x08, 0x41, 0x0a]);
  assert.equal(trail.sentinelIndex, 2);
  assert.notDeepEqual(mid, lead);
  assert.notDeepEqual(mid, trail);
  assert.notDeepEqual(lead, trail);
  // The sentinel position survives into the FNPTR projection too.
  const varargFnptr = parse([0x00, 0x00, 0x1b, 0x05, 0x02, 0x01, 0x08, 0x41, 0x0a]).returnValue;
  assert.equal(varargFnptr.fnPtr.sentinelIndex, 1);
  // Non-VARARG signatures carry no sentinel field at all.
  const plain = parse([0x00, 0x00, 0x01]);
  assert.equal('sentinelIndex' in plain, false);
  const voidFnPtr = parse([0x00, 0x00, 0x1b, 0x00, 0x00, 0x01]).returnValue;
  assert.equal('sentinelIndex' in voidFnPtr.fnPtr, false);
});

test('#7828 differently-typed nested signatures stay distinct through the type surface', () => {
  // two signatures whose only difference is the nested FNPTR return element type
  const a = parse([0x00, 0x00, 0x1b, 0x00, 0x00, 0x01]); // static fnptr void()
  const b = parse([0x00, 0x00, 0x1b, 0x00, 0x00, 0x08]); // static fnptr int32()
  assert.equal(a.returnValue.stackType, 'native-int');
  assert.equal(b.returnValue.stackType, 'native-int');
  assert.deepEqual(a.returnValue.fnPtr.returnValue, null);
  assert.deepEqual(b.returnValue.fnPtr.returnValue, { stackType: 'int32', bits: 32, primitive: 'i4' });
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
  assert.deepEqual(instantiated.fnPtr.returnValue, { stackType: 'int32', bits: 32, primitive: 'i4' });
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

test('primitive ELEMENT_TYPE identity survives evaluation-stack normalization', () => {
  // The eight normalized-by-stack-category primitives all keep their exact
  // kind: BOOLEAN/CHAR/I1/U1/I2/U2/I4/U4 share the int32 stack category but
  // must never collapse as metadata identity.
  const kinds = {
    0x02: 'boolean', 0x03: 'char', 0x04: 'i1', 0x05: 'u1',
    0x06: 'i2', 0x07: 'u2', 0x08: 'i4', 0x09: 'u4',
  };
  const decoded = new Map();
  for (const [byte, kind] of Object.entries(kinds)) {
    const value = parse([0x00, 0x00, Number(byte)]).returnValue;
    assert.equal(value.stackType, 'int32');
    assert.equal(value.bits, 32);
    assert.equal(value.primitive, kind);
    decoded.set(Number(byte), value);
  }
  for (const value of decoded.values()) {
    for (const other of decoded.values()) {
      if (value !== other) assert.notDeepEqual(value, other);
    }
  }
  // I8/U8 share int64; R4/R8 share float; I/U share native-int.
  assert.deepEqual(parse([0x00, 0x00, 0x0a]).returnValue, { stackType: 'int64', bits: 64, primitive: 'i8' });
  assert.deepEqual(parse([0x00, 0x00, 0x0b]).returnValue, { stackType: 'int64', bits: 64, primitive: 'u8' });
  assert.deepEqual(parse([0x00, 0x00, 0x0c]).returnValue, { stackType: 'float', primitive: 'r4' });
  assert.deepEqual(parse([0x00, 0x00, 0x0d]).returnValue, { stackType: 'float', primitive: 'r8' });
  assert.deepEqual(parse([0x00, 0x00, 0x18]).returnValue, { stackType: 'native-int', primitive: 'i' });
  assert.deepEqual(parse([0x00, 0x00, 0x19]).returnValue, { stackType: 'native-int', primitive: 'u' });
  assert.notDeepEqual(parse([0x00, 0x00, 0x0a]).returnValue, parse([0x00, 0x00, 0x0b]).returnValue);
  assert.notDeepEqual(parse([0x00, 0x00, 0x0c]).returnValue, parse([0x00, 0x00, 0x0d]).returnValue);
  assert.notDeepEqual(parse([0x00, 0x00, 0x18]).returnValue, parse([0x00, 0x00, 0x19]).returnValue);
});

test('primitive identity is carried by PTR pointees, array elements, and generic args', () => {
  // PTR I4 vs PTR U4 — previously both pointees deep-equalled.
  assert.deepEqual(parse([0x00, 0x00, 0x0f, 0x08]).returnValue, {
    stackType: 'native-int', pointee: { stackType: 'int32', bits: 32, primitive: 'i4' },
  });
  assert.deepEqual(parse([0x00, 0x00, 0x0f, 0x09]).returnValue, {
    stackType: 'native-int', pointee: { stackType: 'int32', bits: 32, primitive: 'u4' },
  });
  assert.notDeepEqual(parse([0x00, 0x00, 0x0f, 0x08]).returnValue, parse([0x00, 0x00, 0x0f, 0x09]).returnValue);
  // SZARRAY I4[] vs U4[] — the minimal collision of the R1 review.
  const i4Array = parse([0x00, 0x00, 0x1d, 0x08]).returnValue;
  const u4Array = parse([0x00, 0x00, 0x1d, 0x09]).returnValue;
  assert.deepEqual(i4Array.elementType, { stackType: 'int32', bits: 32, primitive: 'i4' });
  assert.deepEqual(u4Array.elementType, { stackType: 'int32', bits: 32, primitive: 'u4' });
  assert.notDeepEqual(i4Array, u4Array);
  // BOOLEAN[] vs I1[] — same stack category, different kind.
  assert.notDeepEqual(parse([0x00, 0x00, 0x1d, 0x02]).returnValue, parse([0x00, 0x00, 0x1d, 0x04]).returnValue);
  // GENERICINST args: N.Base<I4> vs N.Base<U4> differ inside genericArgs.
  const i4Base = parse([0x00, 0x00, 0x15, 0x12, 0x04, 0x01, 0x08]).returnValue;
  const u4Base = parse([0x00, 0x00, 0x15, 0x12, 0x04, 0x01, 0x09]).returnValue;
  assert.deepEqual(i4Base.genericArgs, [{ stackType: 'int32', bits: 32, primitive: 'i4' }]);
  assert.deepEqual(u4Base.genericArgs, [{ stackType: 'int32', bits: 32, primitive: 'u4' }]);
  assert.notDeepEqual(i4Base, u4Base);
  // MethodSpec substitution into a nested primitive slot keeps the kind.
  const generic = parse([0x10, 0x01, 0x00, 0x1e, 0x00]); // static !!0 ()
  const args = parseCilMethodSpecInstantiation(Uint8Array.from([0x0a, 0x01, 0x09])); // <uint32>
  assert.deepEqual(substituteCilMethodGeneric(generic.returnValue, args),
    { stackType: 'int32', bits: 32, primitive: 'u4' });
});

test('production MethodDef call targets do not collide on normalized primitives', async () => {
  // Two full binaries whose static callee signature differs only in the
  // element kind (I4[] vs U4[]): the lifted call bundle's produced value must
  // carry the exact primitive identity for each image, not the shared
  // int32 evaluation-stack category.
  const image = (elementByte) => parseCil(buildCil({
    methods: [
      { name: 'StaticTarget', owner: 0, body: null, signature: [0x00, 0x00, 0x1d, elementByte] },
      {
        name: 'Caller', owner: 0, signature: [0x00, 0x00, 0x01],
        body: [0x28, 0x01, 0x00, 0x00, 0x06, 0x26, 0x2a], // call MethodDef#1; pop; ret
      },
    ],
  }).bytes, { binaryId: 'same' });

  const i4 = liftCilMethod(0, image(0x08));
  const u4 = liftCilMethod(0, image(0x09));
  const callI4 = i4.bundles.find((bundle) => bundle.mnemonic === 'call');
  const callU4 = u4.bundles.find((bundle) => bundle.mnemonic === 'call');
  assert.ok(callI4 && callU4, 'both images lift the static call');
  assert.deepEqual(callI4.producedValues[0].elementType,
    { stackType: 'int32', bits: 32, primitive: 'i4' });
  assert.deepEqual(callU4.producedValues[0].elementType,
    { stackType: 'int32', bits: 32, primitive: 'u4' });
  assert.notDeepEqual(callI4.producedValues, callU4.producedValues);
  assert.notDeepEqual(i4, u4, 'the two images lift to distinct exact semantics');
  assert.equal(callI4.completeness, 'exact');
  assert.equal(callU4.completeness, 'exact');
});

console.log('cil fnptr/primitive identity #7828/#7705-R1: PASS');
