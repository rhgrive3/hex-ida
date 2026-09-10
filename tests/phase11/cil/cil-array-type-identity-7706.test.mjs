import assert from 'node:assert/strict';
import test from 'node:test';

import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { parseCilMethodSignature } from '../../../js/managed/cil/call-signature-types.js';

function addBlob(buf, offset, cursor, bytes) {
  const index = cursor.value;
  assert.ok(bytes.length < 0x80, 'focused fixture uses single-byte blob lengths');
  buf[offset + index] = bytes.length;
  buf.set(bytes, offset + index + 1);
  cursor.value += 1 + bytes.length;
  return index;
}

function addString(buf, offset, cursor, value) {
  const index = cursor.value;
  const bytes = new TextEncoder().encode(value);
  assert.ok(bytes.length > 0 && index + bytes.length < 0x80, 'focused fixture string heap budget exceeded');
  buf.set(bytes, offset + index);
  buf[offset + index + bytes.length] = 0;
  cursor.value += bytes.length + 1;
  return index;
}

function tokenBytes(token) {
  return [token & 0xff, (token >>> 8) & 0xff, (token >>> 16) & 0xff, token >>> 24];
}

// Same PE/CLI skeleton as the #1141 fixture, but the static target's return
// type is parameterized so distinct array element types stay distinct.
function buildCallPe({ callerBytecode, staticSignature } = {}) {
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
  view.setUint16(flagsOffset + 2, 3, true);
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
  const cursor = { value: 1 };
  const staticSignatureIndex = addBlob(buf, blobOffset, cursor, staticSignature);
  const callerSignatureIndex = addBlob(buf, blobOffset, cursor,
    Uint8Array.from([0x00, 0x00, 0x01])); // static void()

  const stringsOffset = metadataOffset + 0x300;
  buf[stringsOffset] = 0;
  const stringCursor = { value: 1 };
  const staticNameIndex = addString(buf, stringsOffset, stringCursor, 'StaticTarget');
  const callerNameIndex = addString(buf, stringsOffset, stringCursor, 'Caller');

  const tablesOffset = metadataOffset + 0x100;
  const valid = (1n << 2n) | (1n << 6n) | (1n << 10n);
  view.setUint32(tablesOffset + 8, Number(valid & 0xffffffffn), true);
  view.setUint32(tablesOffset + 12, Number(valid >> 32n), true);
  let tablePos = tablesOffset + 24;
  view.setUint32(tablePos, 1, true); tablePos += 4; // TypeDef
  view.setUint32(tablePos, 2, true); tablePos += 4; // MethodDef
  view.setUint32(tablePos, 1, true); tablePos += 4; // MemberRef

  const fixtureTypeNameIndex = addString(buf, stringsOffset, stringCursor, 'FixtureType');
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

  assert.ok(callerBytecode.length < 64, 'tiny method body required');
  const methodOffset = 0x700; // RVA 0x2500
  buf[methodOffset] = (callerBytecode.length << 2) | 0x02;
  buf.set(callerBytecode, methodOffset + 1);
  return buf;
}

function project(staticSignature) {
  const image = parseCil(buildCallPe({
    callerBytecode: Uint8Array.from([
      0x28, ...tokenBytes(0x06000001), // call MethodDef #1
      0x26, // pop
      0x2a, // ret
    ]),
    staticSignature,
  }));
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

test('#7706 SZARRAY element type identity is retained in call results', () => {
  const i4 = project(Uint8Array.from([0x00, 0x00, 0x1d, 0x08])); // static int32[] f()
  const i8 = project(Uint8Array.from([0x00, 0x00, 0x1d, 0x0a])); // static int64[] f()
  assert.deepEqual(i4.producedValues, [{
    id: 'call-result',
    stackType: 'object-ref',
    arrayShape: { rank: 1, sizes: [], lowerBounds: [] },
    elementType: { stackType: 'int32', bits: 32, primitive: 'i4' },
  }]);
  assert.deepEqual(i8.producedValues, [{
    id: 'call-result',
    stackType: 'object-ref',
    arrayShape: { rank: 1, sizes: [], lowerBounds: [] },
    elementType: { stackType: 'int64', bits: 64, primitive: 'i8' },
  }]);
  assert.notDeepEqual(i4.producedValues, i8.producedValues);
  // The call stays exact: identity retention must not degrade resolution.
  assert.equal(i4.completeness, 'exact');
  assert.equal(i8.completeness, 'exact');
  assert.deepEqual(i4.unknownEffects, []);
  // Both call sites resolve to the same token; only the signature differs.
  assert.deepEqual(i4.callEffects.map((c) => c.token), i8.callEffects.map((c) => c.token));
});

test('#7706 ARRAY shape identity is retained in call results', () => {
  // static int32[rank 2, lower bound 1 per dim] f() — ArrayShape: rank=2,
  // 0 sizes, 2 lower bounds (compressed 1 each).
  const shaped = project(Uint8Array.from([0x00, 0x00, 0x14, 0x08, 0x02, 0x00, 0x02, 0x01, 0x01]));
  assert.deepEqual(shaped.producedValues, [{
    id: 'call-result',
    stackType: 'object-ref',
    arrayShape: { rank: 2, sizes: [], lowerBounds: [1, 1] },
    elementType: { stackType: 'int32', bits: 32, primitive: 'i4' },
  }]);
  // A rank-1 SZARRAY of the same element is a different exact type.
  const szarray = project(Uint8Array.from([0x00, 0x00, 0x1d, 0x08]));
  assert.notDeepEqual(shaped.producedValues, szarray.producedValues);
  assert.equal(shaped.completeness, 'exact');
});

test('#7706 nested and generic element identities stay lossless', () => {
  // static int32[][] f(): SZARRAY SZARRAY I4.
  const nested = project(Uint8Array.from([0x00, 0x00, 0x1d, 0x1d, 0x08]));
  assert.deepEqual(nested.producedValues, [{
    id: 'call-result',
    stackType: 'object-ref',
    arrayShape: { rank: 1, sizes: [], lowerBounds: [] },
    elementType: {
      stackType: 'object-ref',
      arrayShape: { rank: 1, sizes: [], lowerBounds: [] },
      elementType: { stackType: 'int32', bits: 32, primitive: 'i4' },
    },
  }]);
  // Generic element: static G<int32>[] f() — SZARRAY GENERICINST CLASS #1 <I4>
  // with TypeDef#1 declared via the fixture's single TypeDef row. GENERICINST
  // retains its decoded argument list (#7609 family), composed under the
  // SZARRAY element identity retained for #7706.
  const genericElement = project(Uint8Array.from([0x00, 0x00, 0x1d, 0x15, 0x12, 0x04, 0x01, 0x08]));
  assert.deepEqual(genericElement.producedValues, [{
    id: 'call-result',
    stackType: 'object-ref',
    arrayShape: { rank: 1, sizes: [], lowerBounds: [] },
    elementType: {
      stackType: 'object-ref',
      typeToken: 4,
      genericArgs: [{ stackType: 'int32', bits: 32, primitive: 'i4' }],
    },
  }]);
  assert.equal(genericElement.completeness, 'exact');
});

test('#7706 signature layer: parameter positions carry the same identity', () => {
  // void(int32[]) vs void(int64[]): conv, count=1, void return, param type.
  const i4 = parseCilMethodSignature(Uint8Array.from([0x00, 0x01, 0x01, 0x1d, 0x08]), [1, 0, 0]);
  const i8 = parseCilMethodSignature(Uint8Array.from([0x00, 0x01, 0x01, 0x1d, 0x0a]), [1, 0, 0]);
  assert.deepEqual(i4.parameters[0], {
    stackType: 'object-ref',
    arrayShape: { rank: 1, sizes: [], lowerBounds: [] },
    elementType: { stackType: 'int32', bits: 32, primitive: 'i4' },
  });
  assert.deepEqual(i8.parameters[0], {
    stackType: 'object-ref',
    arrayShape: { rank: 1, sizes: [], lowerBounds: [] },
    elementType: { stackType: 'int64', bits: 64, primitive: 'i8' },
  });
  assert.notDeepEqual(i4.parameters, i8.parameters);
});
