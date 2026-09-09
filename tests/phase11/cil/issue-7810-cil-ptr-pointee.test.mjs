import assert from 'node:assert/strict';
import test from 'node:test';

import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { createCilCallSignatureResolver } from '../../../js/managed/cil/call-signatures.js';

function tokenBytes(token) {
  return [token & 0xff, (token >>> 8) & 0xff, (token >>> 16) & 0xff, token >>> 24];
}

// #7810 — ELEMENT_TYPE_PTR (0x0F) is an unmanaged pointer modifier paired with
// its pointee Type (or VOID). Production call semantics must not collapse
// `int32*` / `int64*` / `void*` onto one bare `native-int`: the decoded
// pointee identity flows through the MethodDef, MemberRef, and MethodSpec
// resolution paths (call results and arguments), and a malformed PTR (missing
// pointee) fails closed instead of minting an exact resolved signature.

// Same PE/CLI skeleton as the #1141/#7706 fixtures: TypeDef 'FixtureType',
// MethodDef #2 = static Caller whose body is supplied by the test.
function buildCallPe({
  callerBytecode,
  staticSignature,
  memberRefSignature = null,
  methodSpec = null,
} = {}) {
  const buf = new Uint8Array(0xc00);
  const view = new DataView(buf.buffer);

  buf[0] = 0x4d; buf[1] = 0x5a;
  view.setUint32(0x3c, 0x80, true);
  buf.set([0x50, 0x45, 0, 0], 0x80);
  view.setUint16(0x86, 1, true);
  view.setUint16(0x94, 0xe0, true);
  const optionalOffset = 0x98;
  view.setUint16(optionalOffset, 0x10b, true);
  view.setUint32(optionalOffset + 92, 16, true);
  view.setUint32(optionalOffset + 96 + 14 * 8, 0x2000, true);
  view.setUint32(optionalOffset + 96 + 14 * 8 + 4, 72, true);

  const sectionOffset = optionalOffset + 0xe0;
  view.setUint32(sectionOffset + 8, 0xa00, true);
  view.setUint32(sectionOffset + 12, 0x2000, true);
  view.setUint32(sectionOffset + 16, 0xa00, true);
  view.setUint32(sectionOffset + 20, 0x200, true);

  const cliOffset = 0x200;
  view.setUint32(cliOffset, 72, true);
  view.setUint32(cliOffset + 8, 0x2100, true);
  view.setUint32(cliOffset + 12, 0x400, true);

  const metadataOffset = 0x300;
  view.setUint32(metadataOffset, 0x424a5342, true);
  view.setUint16(metadataOffset + 4, 1, true);
  view.setUint16(metadataOffset + 6, 1, true);
  const version = new TextEncoder().encode('v4.0.30319\0\0');
  view.setUint32(metadataOffset + 12, version.length, true);
  buf.set(version, metadataOffset + 16);

  const flagsOffset = (metadataOffset + 16 + version.length + 3) & ~3;
  const streamCount = methodSpec != null ? 3 : 3;
  view.setUint16(flagsOffset + 2, streamCount, true);
  let streamPos = flagsOffset + 4;
  const addStream = (relativeOffset, size, name) => {
    view.setUint32(streamPos, relativeOffset, true);
    view.setUint32(streamPos + 4, size, true);
    streamPos += 8;
    const bytes = new TextEncoder().encode(`${name}\0`);
    buf.set(bytes, streamPos);
    streamPos = (streamPos + bytes.length + 3) & ~3;
  };
  addStream(0x100, 0x100, '#~');
  addStream(0x200, 0x100, '#Blob');
  addStream(0x300, 0x80, '#Strings');

  const blobOffset = metadataOffset + 0x200;
  buf[blobOffset] = 0;
  let blobCursor = 1;
  const addBlob = (bytes) => {
    assert.ok(bytes.length < 0x80, 'focused fixture uses single-byte blob lengths');
    buf[blobOffset + blobCursor] = bytes.length;
    buf.set(bytes, blobOffset + blobCursor + 1);
    const index = blobCursor;
    blobCursor += 1 + bytes.length;
    return index;
  };
  const staticSignatureIndex = addBlob(staticSignature);
  const callerSignatureIndex = addBlob(Uint8Array.from([0x00, 0x00, 0x01])); // static void()
  const memberRefSignatureIndex = memberRefSignature == null ? 0 : addBlob(memberRefSignature);
  const instantiationIndex = methodSpec == null ? 0 : addBlob(methodSpec);

  const stringsOffset = metadataOffset + 0x300;
  buf[stringsOffset] = 0;
  let stringCursor = 1;
  const addString = (value) => {
    const bytes = new TextEncoder().encode(value);
    const index = stringCursor;
    buf.set(bytes, stringsOffset + index);
    buf[stringsOffset + index + bytes.length] = 0;
    stringCursor += bytes.length + 1;
    return index;
  };
  const staticNameIndex = addString('StaticTarget');
  const callerNameIndex = addString('Caller');
  const memberNameIndex = addString('MemberTarget');

  const tablesOffset = metadataOffset + 0x100;
  const presentTables = methodSpec == null
    ? [[2, 1], [6, 2], [0x0a, 1]]
    : [[2, 1], [6, 2], [0x0a, 1], [0x2b, 1]];
  let valid = 0n;
  for (const [table] of presentTables) valid |= 1n << BigInt(table);
  view.setUint32(tablesOffset + 8, Number(valid & 0xffffffffn), true);
  view.setUint32(tablesOffset + 12, Number(valid >> 32n), true);
  let tablePos = tablesOffset + 24;
  for (const [, count] of presentTables) {
    view.setUint32(tablePos, count, true);
    tablePos += 4;
  }

  const fixtureTypeNameIndex = addString('FixtureType');
  view.setUint32(tablePos, 0, true); tablePos += 4;
  view.setUint16(tablePos, fixtureTypeNameIndex, true); tablePos += 2;
  view.setUint16(tablePos, 0, true); tablePos += 2;
  view.setUint16(tablePos, 0, true); tablePos += 2;
  view.setUint16(tablePos, 1, true); tablePos += 2;
  view.setUint16(tablePos, 1, true); tablePos += 2;

  const addMethodDef = (rva, nameIndex, signatureIndex, accessFlags) => {
    view.setUint32(tablePos, rva, true);
    view.setUint16(tablePos + 6, accessFlags, true);
    view.setUint16(tablePos + 8, nameIndex, true);
    view.setUint16(tablePos + 10, signatureIndex, true);
    view.setUint16(tablePos + 12, 0, true);
    tablePos += 14;
  };
  addMethodDef(0, staticNameIndex, staticSignatureIndex, 0x0010);
  addMethodDef(0x2500, callerNameIndex, callerSignatureIndex, 0x0010);

  // MemberRef #1: owner TypeDef #1 (coded 0x0008), name, signature.
  view.setUint16(tablePos, 0x0008, true); tablePos += 2;
  view.setUint16(tablePos, memberNameIndex, true); tablePos += 2;
  view.setUint16(tablePos, memberRefSignatureIndex || 1, true); tablePos += 2;

  // MethodSpec #1: Method coded index over [MethodDef, MemberRef] — tag 1,
  // rid 1 → 0x0003 (MemberRef #1); instantiation blob.
  if (methodSpec != null) {
    view.setUint16(tablePos, 0x0003, true); tablePos += 2;
    view.setUint16(tablePos, instantiationIndex, true); tablePos += 2;
  }

  assert.ok(callerBytecode.length < 64, 'tiny method body required');
  const methodOffset = 0x700; // RVA 0x2500
  buf[methodOffset] = (callerBytecode.length << 2) | 0x02;
  buf.set(callerBytecode, methodOffset + 1);
  return buf;
}

const CALL_METHODDEF = Uint8Array.from([0x28, ...tokenBytes(0x06000001), 0x26, 0x2a]);
const CALL_MEMBERREF = Uint8Array.from([0x28, ...tokenBytes(0x0a000001), 0x26, 0x2a]);
const CALL_METHODSPEC = Uint8Array.from([0x28, ...tokenBytes(0x2b000001), 0x26, 0x2a]);

function projectCall(staticSignature, { callerBytecode = CALL_METHODDEF, memberRefSignature, methodSpec } = {}) {
  const image = parseCil(buildCallPe({ callerBytecode, staticSignature, memberRefSignature, methodSpec }));
  const fx = liftCilMethod(0, image);
  const call = fx.bundles.find((b) => b.mnemonic === 'call');
  return {
    producedValues: call.producedValues,
    consumedValues: call.consumedValues,
    callEffects: call.callEffects,
    completeness: call.completeness,
    unknownEffects: call.unknownEffects,
  };
}

test('#7810 MethodDef pointer return keeps its pointee identity', () => {
  const i4 = projectCall(Uint8Array.from([0x00, 0x00, 0x0f, 0x08])); // static int32* f()
  const i8 = projectCall(Uint8Array.from([0x00, 0x00, 0x0f, 0x0a])); // static int64* f()
  assert.deepEqual(i4.producedValues, [{
    id: 'call-result',
    stackType: 'native-int',
    pointee: { stackType: 'int32', bits: 32 },
  }]);
  assert.deepEqual(i8.producedValues, [{
    id: 'call-result',
    stackType: 'native-int',
    pointee: { stackType: 'int64', bits: 64 },
  }]);
  assert.notDeepEqual(i4.producedValues, i8.producedValues);
  assert.equal(i4.completeness, 'exact');
  assert.equal(i8.completeness, 'exact');
  assert.deepEqual(i4.unknownEffects, []);
});

test('#7810 MethodDef pointer argument keeps its pointee identity', () => {
  const i4 = projectCall(Uint8Array.from([0x00, 0x01, 0x01, 0x0f, 0x08])); // static void f(int32*)
  const i8 = projectCall(Uint8Array.from([0x00, 0x01, 0x01, 0x0f, 0x0a])); // static void f(int64*)
  assert.deepEqual(i4.consumedValues, [{ id: 'arg0', stackType: 'native-int', pointee: { stackType: 'int32', bits: 32 } }]);
  assert.deepEqual(i8.consumedValues, [{ id: 'arg0', stackType: 'native-int', pointee: { stackType: 'int64', bits: 64 } }]);
  assert.notDeepEqual(i4.consumedValues, i8.consumedValues);
  assert.equal(i4.completeness, 'exact');
  assert.equal(i8.completeness, 'exact');
});

test('#7810 MemberRef pointer identity survives resolution', () => {
  const i4 = projectCall(Uint8Array.from([0x00, 0x00, 0x0f, 0x08]), {
    callerBytecode: CALL_MEMBERREF,
    memberRefSignature: Uint8Array.from([0x00, 0x00, 0x0f, 0x08]),
  });
  const i8 = projectCall(Uint8Array.from([0x00, 0x00, 0x0f, 0x0a]), {
    callerBytecode: CALL_MEMBERREF,
    memberRefSignature: Uint8Array.from([0x00, 0x00, 0x0f, 0x0a]),
  });
  assert.equal(i4.callEffects[0].signatureResolved, true);
  assert.equal(i8.callEffects[0].signatureResolved, true);
  assert.deepEqual(i4.producedValues, [{
    id: 'call-result',
    stackType: 'native-int',
    pointee: { stackType: 'int32', bits: 32 },
  }]);
  assert.deepEqual(i8.producedValues, [{
    id: 'call-result',
    stackType: 'native-int',
    pointee: { stackType: 'int64', bits: 64 },
  }]);
  assert.notDeepEqual(i4, i8);
});

test('#7810 MethodSpec instantiation resolves substituted pointee identity', () => {
  // Base MemberRef: generic static <T> T* f() — [0x30] GENERIC|1 gen param,
  // 0 params, return PTR MVAR 0. The instantiation substitutes the MVAR.
  const base = Uint8Array.from([0x30, 0x01, 0x00, 0x0f, 0x1e, 0x00]);
  const i4 = projectCall(Uint8Array.from([0x00, 0x00, 0x01]), {
    callerBytecode: CALL_METHODSPEC,
    memberRefSignature: base,
    methodSpec: Uint8Array.from([0x0a, 0x01, 0x08]), // <int32*>
  });
  const i8 = projectCall(Uint8Array.from([0x00, 0x00, 0x01]), {
    callerBytecode: CALL_METHODSPEC,
    memberRefSignature: base,
    methodSpec: Uint8Array.from([0x0a, 0x01, 0x0a]), // <int64*>
  });
  assert.equal(i4.callEffects[0].signatureResolved, true);
  assert.equal(i8.callEffects[0].signatureResolved, true);
  assert.deepEqual(i4.producedValues, [{
    id: 'call-result',
    stackType: 'native-int',
    pointee: { stackType: 'int32', bits: 32 },
  }]);
  assert.deepEqual(i8.producedValues, [{
    id: 'call-result',
    stackType: 'native-int',
    pointee: { stackType: 'int64', bits: 64 },
  }]);
  assert.notDeepEqual(i4, i8);
});

test('#7810 void* pointee stays distinct from int32*', () => {
  const voidPtr = projectCall(Uint8Array.from([0x00, 0x00, 0x0f, 0x01])); // static void* f()
  const i4Ptr = projectCall(Uint8Array.from([0x00, 0x00, 0x0f, 0x08])); // static int32* f()
  assert.deepEqual(voidPtr.producedValues, [{
    id: 'call-result',
    stackType: 'native-int',
    pointee: { stackType: 'void' },
  }]);
  assert.notDeepEqual(voidPtr.producedValues, i4Ptr.producedValues);
  assert.equal(voidPtr.completeness, 'exact');
});

test('#7810 a malformed PTR (missing pointee) fails closed', () => {
  const bytes = buildCallPe({
    callerBytecode: CALL_METHODDEF,
    staticSignature: Uint8Array.from([0x00, 0x00, 0x0f]),
    memberRefSignature: Uint8Array.from([0x00, 0x00, 0x0f]),
  });
  const image = parseCil(bytes);
  const resolution = createCilCallSignatureResolver(image)(0x06000001);
  assert.equal(resolution.complete, false);
  assert.match(resolution.reason, /^cil-call-signature/);
  const fx = liftCilMethod(0, image);
  const call = fx.bundles.find((b) => b.mnemonic === 'call');
  assert.equal(call.callEffects[0].signatureResolved, false);
  assert.notEqual(call.completeness, 'exact');
});
