import assert from 'node:assert/strict';
import test from 'node:test';

import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { buildMinimalCil } from './cil-parser.test.mjs';

/**
 * CIL method-body validation and lifter provenance hardening. The parser
 * fails closed with typed errors on malformed bodies; the lifter bounds-checks
 * every operand read, maps EH union fields by clause kind, and anchors
 * provenance ranges at the IL stream start rather than the method header
 * (#5331, #5350, #5356, #5396).
 */

function fatBodyBuffer(localVarSigTok) {
  const buf = new Uint8Array(0x300);
  const view = new DataView(buf.buffer);
  buf[0x100] = 0x42; buf[0x101] = 0x53; buf[0x102] = 0x4a; buf[0x103] = 0x42; // 'BSJB'
  view.setUint16(0x104, 1, true);
  view.setUint16(0x106, 1, true);
  view.setUint32(0x10c, 0, true);
  // Fat header at 0x200: flags 0x3003 (fat, 3-DWORD header), maxStack 8,
  // codeSize 1, LocalVarSigTok, code [ret].
  view.setUint16(0x200, 0x3003, true);
  view.setUint16(0x202, 8, true);
  view.setUint32(0x204, 1, true);
  view.setUint32(0x208, localVarSigTok, true);
  buf[0x20c] = 0x2a; // ret
  return buf;
}

function buildLocalSigPeCli({
  localVarSigTok = 0x11000001,
  includeStandAloneSig = true,
  includeBlobStream = true,
  signatureBlobIndex = 1,
  signatureBlob = Uint8Array.from([0x07, 0x01, 0x08]), // LOCAL_SIG, 1 local, I4
} = {}) {
  const buf = new Uint8Array(0x900);
  const view = new DataView(buf.buffer);

  // One-section PE32 image. RVA 0x2000 maps to file offset 0x200.
  buf[0] = 0x4d; buf[1] = 0x5a;
  view.setUint32(0x3c, 0x80, true);
  buf.set([0x50, 0x45, 0, 0], 0x80);
  view.setUint16(0x86, 1, true); // NumberOfSections
  view.setUint16(0x94, 0xe0, true); // SizeOfOptionalHeader
  const optionalOffset = 0x98;
  view.setUint16(optionalOffset, 0x10b, true);
  view.setUint32(optionalOffset + 92, 16, true); // NumberOfRvaAndSizes
  view.setUint32(optionalOffset + 96 + 14 * 8, 0x2000, true);
  view.setUint32(optionalOffset + 96 + 14 * 8 + 4, 72, true);

  const sectionOffset = optionalOffset + 0xe0;
  view.setUint32(sectionOffset + 8, 0x700, true); // VirtualSize
  view.setUint32(sectionOffset + 12, 0x2000, true); // VirtualAddress
  view.setUint32(sectionOffset + 16, 0x700, true); // SizeOfRawData
  view.setUint32(sectionOffset + 20, 0x200, true); // PointerToRawData

  const cliOffset = 0x200;
  view.setUint32(cliOffset, 72, true);
  view.setUint32(cliOffset + 8, 0x2100, true); // metadata RVA
  view.setUint32(cliOffset + 12, 0x200, true);

  const metadataOffset = 0x300;
  view.setUint32(metadataOffset, 0x424a5342, true); // BSJB
  view.setUint16(metadataOffset + 4, 1, true);
  view.setUint16(metadataOffset + 6, 1, true);
  const version = new TextEncoder().encode('v4.0.30319\0\0');
  view.setUint32(metadataOffset + 12, version.length, true);
  buf.set(version, metadataOffset + 16);

  const flagsOffset = (metadataOffset + 16 + version.length + 3) & ~3;
  view.setUint16(flagsOffset + 2, includeBlobStream ? 2 : 1, true);
  let streamPos = flagsOffset + 4;
  const addStream = (relativeOffset, size, name) => {
    view.setUint32(streamPos, relativeOffset, true);
    view.setUint32(streamPos + 4, size, true);
    streamPos += 8;
    buf.set(new TextEncoder().encode(`${name}\0`), streamPos);
    streamPos = (streamPos + name.length + 1 + 3) & ~3;
  };
  addStream(0x80, 0x80, '#~');
  if (includeBlobStream) addStream(0x100, 0x40, '#Blob');

  const tablesOffset = metadataOffset + 0x80;
  let valid = 1n << 6n; // MethodDef
  if (includeStandAloneSig) valid |= 1n << 17n;
  view.setUint32(tablesOffset + 8, Number(valid & 0xffffffffn), true);
  view.setUint32(tablesOffset + 12, Number(valid >> 32n), true);
  let tablePos = tablesOffset + 24;
  view.setUint32(tablePos, 1, true); // one MethodDef
  tablePos += 4;
  if (includeStandAloneSig) {
    view.setUint32(tablePos, 1, true); // one StandAloneSig
    tablePos += 4;
  }

  // MethodDef row: RVA + ImplFlags + Flags + Name + Signature + ParamList.
  view.setUint32(tablePos, 0x2300, true);
  tablePos += 14;
  if (includeStandAloneSig) {
    view.setUint16(tablePos, signatureBlobIndex, true);
    tablePos += 2;
  }

  if (includeBlobStream) {
    const blobOffset = metadataOffset + 0x100;
    buf[blobOffset] = 0; // canonical null blob
    if (signatureBlobIndex === 1) {
      buf[blobOffset + 1] = signatureBlob.length;
      buf.set(signatureBlob, blobOffset + 2);
    }
  }

  const methodOffset = 0x500;
  view.setUint16(methodOffset, 0x3003, true);
  view.setUint16(methodOffset + 2, 8, true);
  view.setUint32(methodOffset + 4, 1, true);
  view.setUint32(methodOffset + 8, localVarSigTok, true);
  buf[methodOffset + 12] = 0x2a; // ret
  return buf;
}

test('#5331 fat LocalVarSigTok resolves through StandAloneSig and #Blob authority', () => {
  const noLocals = parseCil(buildLocalSigPeCli({
    localVarSigTok: 0,
    includeStandAloneSig: false,
    includeBlobStream: false,
  }));
  assert.equal(noLocals.methodBodies.length, 1);
  assert.equal(noLocals.methodBodies[0].localVarSigTok, 0);

  const valid = parseCil(buildLocalSigPeCli());
  assert.equal(valid.methodBodies.length, 1);
  assert.equal(valid.methodBodies[0].localVarSigTok, 0x11000001);

  assert.throws(
    () => parseCil(buildLocalSigPeCli({ localVarSigTok:0x01000001 })),
    /cil-invalid-local-var-sig-token/,
    'wrong-table tokens must fail closed',
  );
  assert.throws(
    () => parseCil(buildLocalSigPeCli({ includeStandAloneSig:false })),
    /cil-local-var-sig-row-missing/,
    'nonexistent StandAloneSig RIDs must fail closed',
  );
  assert.throws(
    () => parseCil(buildLocalSigPeCli({ includeBlobStream:false })),
    /cil-local-var-sig-blob-heap-missing/,
    'a missing #Blob heap must fail closed',
  );
  assert.throws(
    () => parseCil(buildLocalSigPeCli({ signatureBlobIndex:0x40 })),
    /cil-local-var-sig-blob-missing/,
    'a StandAloneSig row must point at an existing #Blob entry',
  );
  assert.throws(
    () => parseCil(buildLocalSigPeCli({ signatureBlob:Uint8Array.from([0x00, 0x00, 0x01]) })),
    /cil-invalid-local-var-signature/,
    'METHOD signatures are not valid LocalVarSig blobs',
  );
  assert.throws(
    () => parseCil(buildLocalSigPeCli({ signatureBlob:Uint8Array.from([0x07, 0x01, 0x12]) })),
    /cil-invalid-local-var-signature/,
    'truncated local type signatures must fail closed',
  );
  assert.throws(
    () => parseCil(buildLocalSigPeCli({ signatureBlob:Uint8Array.from([0x07, 0x80]) })),
    /cil-invalid-local-var-signature/,
    'truncated compressed local counts must fail closed',
  );

  const legacyUnresolved = parseCil(fatBodyBuffer(0x11000001));
  assert.equal(legacyUnresolved.methodBodies.length, 0,
    'raw compatibility scanning must not publish a nonzero locals token without metadata authority');
});

test('#5350 truncated operands fail closed with a typed error', () => {
  const image = parseCil(buildMinimalCil());
  for (const bytecode of [
    Uint8Array.from([0x0e]), // ldarg.s without its index
    Uint8Array.from([0x20, 0x01]), // ldc.i4 without its 4 bytes
    Uint8Array.from([0xfe]), // prefix without its second byte
    Uint8Array.from([0x28, 0x01, 0x02]), // call without its token
  ]) {
    const bad = { ...image, methodBodies: [{ ...image.methodBodies[0], bytecode }] };
    assert.throws(() => liftCilMethod(0, bad), /cil-truncated-operand/,
      `truncated ${[...bytecode].map((b) => b.toString(16))} must not lift`);
  }
  // Complete operands still lift exactly.
  const good = liftCilMethod(0, image);
  assert.equal(good.bundles[0].mnemonic, 'ldc.i4.5');
  assert.equal(good.aggregateCompleteness, 'exact');
});

test('#5356 filter clauses publish filterOffset, not catchToken', () => {
  const body = {
    headerOffset: 0x100, codeOffset: 0x10c, isTiny: false, maxStack: 8, codeSize: 24,
    localVarSigTok: 0,
    bytecode: Uint8Array.from({ length: 24 }, (_, index) => (index === 23 ? 0x2a : 0x00)),
    exceptionClauses: [
      { kind: 'filter', tryOffset: 0, tryLength: 4, handlerOffset: 20, handlerLength: 4, classTokenOrFilter: 8 },
      { kind: 'catch', tryOffset: 0, tryLength: 4, handlerOffset: 20, handlerLength: 4, classTokenOrFilter: 0x01000001 },
      { kind: 'finally', tryOffset: 4, tryLength: 4, handlerOffset: 16, handlerLength: 4, classTokenOrFilter: 0xdeadbeef },
      { kind: 'fault', tryOffset: 8, tryLength: 4, handlerOffset: 12, handlerLength: 4, classTokenOrFilter: 0xcafebabe },
    ],
  };
  const lifted = liftCilMethod(0, { moduleId: 'test', vmSpecEdition: 'v4.0.30319', methodBodies: [body] });
  assert.equal(lifted.exceptionRegions[0].filterOffset, 8);
  assert.ok(!('catchToken' in lifted.exceptionRegions[0]), 'filter regions must not carry a catch token');
  assert.equal(lifted.exceptionRegions[1].catchToken, 0x01000001);
  assert.ok(!('filterOffset' in lifted.exceptionRegions[1]), 'catch regions must not carry a filter offset');
  for (const [index, kind] of [[2, 'finally'], [3, 'fault']]) {
    const region = lifted.exceptionRegions[index];
    assert.equal(region.handlerKind, kind);
    assert.ok(!('catchToken' in region), `${kind} regions must not carry a catch token`);
    assert.ok(!('filterOffset' in region), `${kind} regions must not carry a filter offset`);
  }
});

test('#5396 operation provenance starts at the IL stream, not the header', () => {
  const image = parseCil(buildMinimalCil());
  const body = image.methodBodies[0];
  assert.equal(body.codeOffset, body.headerOffset + 1, 'tiny code starts one byte past the header');
  const lifted = liftCilMethod(0, image);
  const ranges = lifted.bundles.map((bundle) => bundle.origin.byteRanges[0]);
  assert.equal(ranges[0].start, String(body.headerOffset + 1));
  assert.equal(ranges[ranges.length - 1].end, String(body.headerOffset + 1 + body.codeSize));
  for (const range of ranges) {
    assert.ok(BigInt(range.start) >= BigInt(body.headerOffset + 1), 'no range may point into the header');
  }
});
