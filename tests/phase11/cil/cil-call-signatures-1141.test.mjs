import assert from 'node:assert/strict';
import test from 'node:test';

import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import { parseCil } from '../../../js/managed/cil/parser.js';

function addBlob(buf, offset, cursor, bytes) {
  const index = cursor.value;
  assert.ok(bytes.length < 0x80, 'focused fixture uses single-byte blob lengths');
  buf[offset + index] = bytes.length;
  buf.set(bytes, offset + index + 1);
  cursor.value += 1 + bytes.length;
  return index;
}

function tokenBytes(token) {
  return [token & 0xff, (token >>> 8) & 0xff, (token >>> 16) & 0xff, token >>> 24];
}

function buildCallPe({
  callerBytecode,
  staticSignature = Uint8Array.from([0x00, 0x01, 0x08, 0x08]), // static int32(int32)
} = {}) {
  const buf = new Uint8Array(0xc00);
  const view = new DataView(buf.buffer);

  // One-section PE32 image. RVA 0x2000 maps to file offset 0x200.
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
  view.setUint16(flagsOffset + 2, 2, true);
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

  const blobOffset = metadataOffset + 0x200;
  buf[blobOffset] = 0;
  const cursor = { value:1 };
  const staticSignatureIndex = addBlob(buf, blobOffset, cursor, staticSignature);
  const genericSignatureIndex = addBlob(buf, blobOffset, cursor,
    Uint8Array.from([0x10, 0x01, 0x01, 0x1e, 0x00, 0x1e, 0x00])); // static !!0(!!0)
  const callerSignatureIndex = addBlob(buf, blobOffset, cursor,
    Uint8Array.from([0x00, 0x00, 0x01])); // static void()
  const memberRefSignatureIndex = addBlob(buf, blobOffset, cursor,
    Uint8Array.from([0x20, 0x02, 0x01, 0x0a, 0x11, 0x04])); // instance void(int64, valuetype #1)
  const instantiationIndex = addBlob(buf, blobOffset, cursor,
    Uint8Array.from([0x0a, 0x01, 0x08])); // GENERICINST<int32>

  const tablesOffset = metadataOffset + 0x100;
  const valid = (1n << 6n) | (1n << 10n) | (1n << 43n);
  view.setUint32(tablesOffset + 8, Number(valid & 0xffffffffn), true);
  view.setUint32(tablesOffset + 12, Number(valid >> 32n), true);
  let tablePos = tablesOffset + 24;
  view.setUint32(tablePos, 3, true); tablePos += 4; // MethodDef
  view.setUint32(tablePos, 1, true); tablePos += 4; // MemberRef
  view.setUint32(tablePos, 1, true); tablePos += 4; // MethodSpec

  const addMethodDef = (rva, signatureIndex) => {
    view.setUint32(tablePos, rva, true);
    view.setUint16(tablePos + 8, 0, true); // Name
    view.setUint16(tablePos + 10, signatureIndex, true);
    view.setUint16(tablePos + 12, 0, true); // ParamList
    tablePos += 14;
  };
  addMethodDef(0, staticSignatureIndex);
  addMethodDef(0, genericSignatureIndex);
  addMethodDef(0x2500, callerSignatureIndex);

  // MemberRefParent = MethodDef RID 1, tag 3 => (1 << 3) | 3.
  view.setUint16(tablePos, 11, true);
  view.setUint16(tablePos + 2, 0, true);
  view.setUint16(tablePos + 4, memberRefSignatureIndex, true);
  tablePos += 6;

  // MethodSpec.Method = MethodDef RID 2, tag 0 => (2 << 1) | 0.
  view.setUint16(tablePos, 4, true);
  view.setUint16(tablePos + 2, instantiationIndex, true);

  assert.ok(callerBytecode.length < 64, 'tiny method body required');
  const methodOffset = 0x700; // RVA 0x2500
  buf[methodOffset] = (callerBytecode.length << 2) | 0x02;
  buf.set(callerBytecode, methodOffset + 1);
  return buf;
}

function lift(bytecode, options = {}) {
  const image = parseCil(buildCallPe({ callerBytecode:Uint8Array.from(bytecode), ...options }));
  assert.equal(image.methodBodies.length, 1);
  return liftCilMethod(0, image);
}

test('#1141 MethodDef static call consumes parameters and produces non-void return', () => {
  const lifted = lift([0x1b, 0x28, ...tokenBytes(0x06000001), 0x2a]);
  const call = lifted.bundles[1];
  assert.equal(call.mnemonic, 'call');
  assert.equal(call.completeness, 'exact');
  assert.deepEqual(call.consumedValues.map((value) => value.stackType), ['int32']);
  assert.deepEqual(call.producedValues.map((value) => value.stackType), ['int32']);
  assert.equal(call.callEffects[0].signatureResolved, true);
  assert.equal(call.callEffects[0].signatureProvenance.table, 'MethodDef');
});

test('#1141 instance/constructor calls apply receiver, 64-bit, and value-type stack contracts', () => {
  const callvirt = lift([0x6f, ...tokenBytes(0x0a000001), 0x2a]).bundles[0];
  assert.equal(callvirt.completeness, 'exact');
  assert.equal(callvirt.consumedValues.length, 3);
  assert.equal(callvirt.consumedValues[0].stackType, 'value-type');
  assert.equal(callvirt.consumedValues[1].stackType, 'int64');
  assert.equal(callvirt.consumedValues[1].bits, 64);
  assert.equal(callvirt.consumedValues[2].id, 'this');
  assert.equal(callvirt.producedValues.length, 0);

  const newobj = lift([0x73, ...tokenBytes(0x0a000001), 0x2a]).bundles[0];
  assert.equal(newobj.completeness, 'exact');
  assert.equal(newobj.consumedValues.length, 2, 'newobj consumes constructor args but not an existing receiver');
  assert.equal(newobj.producedValues.length, 1);
  assert.equal(newobj.producedValues[0].stackType, 'object-ref');
});

test('#1141 MethodSpec validates instantiation and substitutes method generic stack types', () => {
  const call = lift([0x28, ...tokenBytes(0x2b000001), 0x2a]).bundles[0];
  assert.equal(call.completeness, 'exact');
  assert.equal(call.consumedValues[0].stackType, 'int32');
  assert.equal(call.producedValues[0].stackType, 'int32');
  assert.equal(call.callEffects[0].signatureProvenance.table, 'MethodSpec');
  assert.equal(call.callEffects[0].signatureProvenance.resolvedToken, 0x06000002);
});

test('#1141 void calls produce nothing and invalid token/signature authority fails partial', () => {
  const voidCall = lift([0x28, ...tokenBytes(0x06000003), 0x2a]).bundles[0];
  assert.equal(voidCall.completeness, 'exact');
  assert.equal(voidCall.consumedValues.length, 0);
  assert.equal(voidCall.producedValues.length, 0);

  const wrongTable = lift([0x28, ...tokenBytes(0x04000001), 0x2a]).bundles[0];
  assert.equal(wrongTable.completeness, 'partial');
  assert.equal(wrongTable.callEffects[0].signatureResolved, false);
  assert.ok(wrongTable.unknownEffects.some((effect) => effect.category === 'stack'));

  const malformed = lift([0x28, ...tokenBytes(0x06000001), 0x2a], {
    staticSignature:Uint8Array.from([0x00, 0x01, 0x08]), // missing declared parameter
  }).bundles[0];
  assert.equal(malformed.completeness, 'partial');
  assert.equal(malformed.callEffects[0].signatureResolved, false);
  assert.equal(malformed.consumedValues.length, 0, 'unknown stack delta must not be fabricated');
  assert.equal(malformed.producedValues.length, 0, 'unknown return semantics must not be fabricated');
});
