// Regression for #7301: ECMA-335 II.22.26 rule 2 — every MethodDef row has
// exactly one TypeDef owner. A TypeDef-less metadata table with MethodDef rows
// used to parse successfully and the orphan method was published as a
// spec-valid method (declaringTypeId: null, validation 'valid').
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCil } from '../js/managed/cil/parser.js';
import { overlayCilMetadata } from '../js/managed/cil/parser-overlay.js';
import { parseCil as parseCilBase } from '../js/managed/cil/parser-base.js';
import { CilFrontend } from '../js/managed/cil/frontend.js';

function buildOrphanPe({ withTypeDef = false } = {}) {
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
  view.setUint16(flagsOffset + 2, 3, true); // #~, #Blob, #Strings
  let streamPos = flagsOffset + 4;
  const addStream = (relativeOffset, size, name) => {
    view.setUint32(streamPos, relativeOffset, true);
    view.setUint32(streamPos + 4, size, true);
    streamPos += 8;
    buf.set(new TextEncoder().encode(`${name}\0`), streamPos);
    streamPos = (streamPos + name.length + 1 + 3) & ~3;
  };
  addStream(0x100, 0x100, '#~');
  addStream(0x200, 0x100, '#Blob');
  addStream(0x300, 0x80, '#Strings');
  const stringsOffset = metadataOffset + 0x300;
  buf[stringsOffset] = 0;
  const nameIndex = 1;
  buf.set(new TextEncoder().encode('Orphan\0'), stringsOffset + nameIndex);
  const blobOffset = metadataOffset + 0x200;
  buf[blobOffset] = 0;
  // static void() signature blob at #Blob index 1
  buf[blobOffset + 1] = 3;
  buf.set(Uint8Array.from([0x00, 0x00, 0x01]), blobOffset + 2);
  const signatureIndex = 1;
  // TypeDef bit (1<<2) is only set for the owned control fixture.
  const valid = withTypeDef ? (1n << 2n) | (1n << 6n) : (1n << 6n);
  const tablesOffset = metadataOffset + 0x100;
  view.setUint32(tablesOffset + 8, Number(valid & 0xffffffffn), true);
  view.setUint32(tablesOffset + 12, Number(valid >> 32n), true);
  let tablePos = tablesOffset + 24;
  if (withTypeDef) {
    view.setUint32(tablePos, 1, true); // one TypeDef row
    tablePos += 4;
  }
  view.setUint32(tablePos, 1, true); // one MethodDef row
  tablePos += 4;
  if (withTypeDef) {
    // TypeDef row (14 bytes): Flags, Name, Namespace, Extends, FieldList, MethodList.
    view.setUint32(tablePos, 0, true); tablePos += 4;
    view.setUint16(tablePos, 0, true); tablePos += 2; // Name (index 0 = legacy null)
    view.setUint16(tablePos, 0, true); tablePos += 2; // Namespace
    view.setUint16(tablePos, 0, true); tablePos += 2; // Extends = null
    view.setUint16(tablePos, 1, true); tablePos += 2; // FieldList
    view.setUint16(tablePos, 1, true); tablePos += 2; // MethodList
  }
  // MethodDef row: RVA, ImplFlags, Flags, Name, Signature, ParamList.
  view.setUint32(tablePos, 0x2500, true);
  view.setUint16(tablePos + 4, 0, true); // implFlags
  view.setUint16(tablePos + 6, 6, true); // public static
  view.setUint16(tablePos + 8, nameIndex, true);
  view.setUint16(tablePos + 10, signatureIndex, true); // signature
  view.setUint16(tablePos + 12, 1, true); // ParamList
  const methodOffset = 0x700; // RVA 0x2500
  buf[methodOffset] = (1 << 2) | 0x02; // tiny header, 1 byte
  buf[methodOffset + 1] = 0x2a; // ret (static void() — empty stack)
  return buf;
}

test('#7301 orphan MethodDef without a TypeDef owner fails closed', () => {
  // parseCil funnels every overlay failure through its unsupported probe, so
  // pin the root-cause diagnostic directly on the overlay boundary.
  const bytes = buildOrphanPe({ withTypeDef: false });
  assert.throws(
    () => overlayCilMetadata(bytes, parseCilBase(bytes, { binaryId: 'orphan-repro-7301' })),
    /cil-methoddef-owner-missing/,
  );
  assert.throws(
    () => parseCil(bytes, { binaryId: 'orphan-repro-7301' }),
    /cil-unsupported-binary/,
  );
});

test('#7301 owned MethodDef with a TypeDef row still parses and binds the owner', async () => {
  const image = parseCil(buildOrphanPe({ withTypeDef: true }), { binaryId: 'owned-repro-7301' });
  assert.equal(image.types.length, 1);
  assert.equal(image.methods.length, 1);
  assert.equal(image.methods[0].declaringTypeToken, '0x02000001');
  assert.deepEqual(image.types[0].methodTokens, ['0x06000001']);

  const frontend = new CilFrontend();
  const methods = [];
  for await (const m of frontend.enumerateMethods(image)) methods.push(m);
  const decoded = await frontend.decodeMethod(methods[0], { image });
  assert.equal(methods[0].declaringTypeId != null, true);
  // The resolved signature blob is `static void()` — a zero-slot return shape.
  const validation = await frontend.validateMethod(decoded, { image, returnStackSlots: 0 });
  assert.equal(validation.status, 'valid', JSON.stringify(validation.errors));
});

test('#7301 probe does not advertise a binary whose metadata has orphan methods', () => {
  // probeCil swallows overlay failures: the unsupported verdict keeps the
  // orphan metadata from ever being lifted into a spec-valid method.
  assert.throws(
    () => parseCil(buildOrphanPe({ withTypeDef: false }), { binaryId: 'orphan-probe-7301' }),
    /cil-unsupported-binary/,
  );
});
