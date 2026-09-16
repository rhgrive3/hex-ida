import assert from 'node:assert/strict';
import test from 'node:test';
import { BinaryImage } from '../../../js/binary/model.js';
import { ByteView } from '../../../js/binary/reader.js';
import { parsePE } from '../../../js/binary/pe.js';
import { parseTlsDirectory, parseLoadConfig, parseExceptionFunctions } from '../../../js/binary/pe-loader.js';

// Issue #8787: PE function-seed producers proved only that the *first* byte of a
// target was file-backed (or, for ARM64 .pdata, only that the *virtual* range was
// executable). A 4-byte AArch64 instruction aligned on the raw/zero-fill boundary
// therefore got promoted to a high-confidence function seed whose remaining bytes
// are synthesized zero-fill, disagreeing with the model's own
// isInstructionAllowed(). Every fixed-width-ISA seed producer must now prove the
// whole minimum instruction span is file-backed before minting a seed.

const SPAN_REASONS = {
  tls: 'tls:callback-target-span',
  guardcf: 'load-config:guardcf-target-span',
  pdata: 'exception:arm64-pdata-backing',
};

function writeU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}
function writePointer(bytes, offset, value, bits) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bits === 64) view.setBigUint64(offset, BigInt(value), true);
  else view.setUint32(offset, Number(BigInt(value) & 0xffffffffn), true);
}

// Executable .text at RVA 0x2000 mapped to file offset 64. `textFileBytes` is the
// file-backed length, so addresses whose [rva-0x2000, +4) window crosses that
// boundary are aligned but only partially backed (the #8787 counterexample).
function makeArm64Image({ textFileBytes = 63, metadata = {} } = {}) {
  const bytes = new Uint8Array(512);
  const image = new BinaryImage(bytes, { format: 'pe', bits: 64, imageBase: 0n });
  image.metadata = { ...image.metadata, ...metadata };
  image.addSection({
    name: '.text', address: 0x2000n, size: 0x100n, fileOffset: 64n, fileSize: BigInt(textFileBytes),
    perms: { read: true, write: false, execute: true }, source: 'PE-section',
  });
  image.addSegment({
    name: '.text', address: 0x2000n, size: 0x100n, fileOffset: 64n, fileSize: BigInt(textFileBytes),
    perms: { read: true, write: false, execute: true }, source: 'PE-section',
  });
  image.addSegment({
    name: '.rdata', address: 0x1000n, size: 0x100n, fileOffset: 0n, fileSize: 0x100n,
    perms: { read: true, write: false, execute: false },
  });
  return { bytes, image };
}

// textFileBytes = 63 => file-backed RVA 0x2000..0x203E inclusive (offsets 0..0x3E).
//   0x2038: offsets 0x38..0x3B (56..59) all < 63 -> fully backed  (positive)
//   0x203C: offsets 0x3C..0x3F (60..63) -> byte 63 is NOT < 63     (partial: 3 of 4)
const FULLY_BACKED = 0x2038n;
const PARTIAL_BACKED = 0x203cn;

// --- TLS callback ---------------------------------------------------------
test('TLS callback with a partial instruction span mints no seed (#8787)', () => {
  const { bytes, image } = makeArm64Image({ metadata: { machine: 0xaa64 } });
  writePointer(bytes, 24, 0x3000n, 64);
  writePointer(bytes, 256, FULLY_BACKED, 64); // positive control
  writePointer(bytes, 264, PARTIAL_BACKED, 64); // first byte backed, rest zero-fill
  writePointer(bytes, 272, 0n, 64);
  image.addSegment({ name: '.tls', address: 0x3000n, size: 0x100n, fileOffset: 256n, fileSize: 0x100n, perms: { read: true, write: false, execute: false } });
  parseTlsDirectory(new ByteView(bytes), { rva: 0x1000, size: 40 }, image);
  const seeds = image.functions.filter((f) => f.source === 'tls-callback');
  assert.deepEqual(seeds.map((s) => s.address), [FULLY_BACKED], 'only the fully-backed callback mints a seed');
  assert.equal(image.metadata.tls.callbacks.includes(PARTIAL_BACKED), false);
  assert.equal((image.metadata.peMetadata || {}).complete, false, 'partial-span callback lowers completeness');
  assert.ok((image.metadata.peMetadata.reasons || []).includes(SPAN_REASONS.tls));
});

// --- GuardCF function table ----------------------------------------------
test('GuardCF target with a partial instruction span mints no seed (#8787)', () => {
  const { bytes, image } = makeArm64Image({ metadata: { machine: 0xaa64 } });
  const u64 = (o, v) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(o, BigInt(v), true);
  u64(0, 152); u64(128, 0x3000); u64(136, 2); u64(144, 0);
  writeU32(bytes, 256, Number(FULLY_BACKED));
  writeU32(bytes, 260, Number(PARTIAL_BACKED));
  image.addSegment({ name: '.rdata', address: 0x3000n, size: 0x100n, fileOffset: 256n, fileSize: 0x100n, perms: { read: true, write: false, execute: false } });
  parseLoadConfig(new ByteView(bytes), { rva: 0x1000, size: 152 }, image);
  const seeds = image.functions.filter((f) => f.source === 'guard-cf');
  assert.deepEqual(seeds.map((s) => s.address), [FULLY_BACKED]);
  assert.equal((image.metadata.peMetadata || {}).complete, false);
  assert.ok((image.metadata.peMetadata.reasons || []).includes(SPAN_REASONS.guardcf));
});

// --- ARM64 .pdata packed extent ------------------------------------------
test('.pdata extent crossing zero-fill mints no high-confidence seed (#8787)', () => {
  const { bytes, image } = makeArm64Image({ metadata: { machine: 0xaa64 } });
  image.addSegment({ name: '.pdata', address: 0x1000n, size: 16n, fileOffset: 0n, fileSize: 16n, perms: { read: true, write: false, execute: false } });
  // Positive record (fully-backed extent) followed by the partial-extent record.
  writeU32(bytes, 0, Number(FULLY_BACKED));
  writeU32(bytes, 4, 0x1 | (1 << 2)); // flag=1, FunctionLength=1 (4 bytes)
  writeU32(bytes, 8, Number(PARTIAL_BACKED));
  writeU32(bytes, 12, 0x1 | (1 << 2));
  parseExceptionFunctions(new ByteView(bytes), { rva: 0x1000, size: 16 }, image, 0xaa64);
  const seeds = image.functions.filter((f) => f.source === 'exception');
  assert.deepEqual(seeds.map((s) => s.address), [FULLY_BACKED], 'only the fully-backed extent seeds');
  assert.equal(image.metadata.exceptionDirectory?.invalidRecords, 1);
  assert.ok((image.metadata.peMetadata?.reasons || []).includes(SPAN_REASONS.pdata));
});

// --- entrypoint through the public parsePE() path ------------------------
// SizeOfRawData is rounded up to FileAlignment, so to obtain a short *backed*
// tail for the entry we truncate the actual file to just past PointerToRawData
// (0x200). A 4-aligned entry whose remaining bytes fall past the truncated file
// must be rejected (#8787).
function makePE({ machine, entryRva, fileLen }) {
  const bytes = new Uint8Array(fileLen);
  const view = new DataView(bytes.buffer);
  const pe = 0x80, coff = pe + 4, optionalSize = 0xf0, opt = coff + 20, section = opt + optionalSize;
  view.setUint16(0, 0x5a4d, true);
  view.setUint32(0x3c, pe, true);
  view.setUint32(pe, 0x00004550, true);
  view.setUint16(coff, machine, true);
  view.setUint16(coff + 2, 1, true);
  view.setUint16(coff + 16, optionalSize, true);
  view.setUint16(coff + 18, 0x0002, true);
  view.setUint16(opt, 0x20b, true);
  view.setUint32(opt + 16, entryRva, true);
  view.setBigUint64(opt + 24, 0x140000000n, true);
  view.setUint32(opt + 32, 0x1000, true);
  view.setUint32(opt + 36, 0x200, true);
  view.setUint32(opt + 56, 0x2000, true);
  view.setUint32(opt + 60, 0x200, true);
  view.setUint16(opt + 68, 3, true);
  view.setUint32(opt + 108, 0, true);
  bytes.set(new TextEncoder().encode('.text'), section);
  view.setUint32(section + 8, 0x200, true);   // VirtualSize
  view.setUint32(section + 12, 0x1000, true); // VirtualAddress
  view.setUint32(section + 16, 0x200, true);  // SizeOfRawData (rounds to FileAlignment 0x200)
  view.setUint32(section + 20, 0x200, true);  // PointerToRawData
  view.setUint32(section + 36, 0x60000020, true); // RX
  return bytes;
}

test('ARM64 entrypoint needs its whole 4-byte instruction span file-backed (#8787)', () => {
  // PointerToRawData 0x200 + file 0x203 => only RVA 0x1000 bytes [0,3) are backed;
  // entry 0x1000 is 4-aligned but its instruction extends into zero-fill.
  const partial = parsePE(makePE({ machine: 0xaa64, entryRva: 0x1000, fileLen: 0x203 }));
  assert.equal(partial.metadata.entrypointValid, false);
  assert.match(partial.metadata.entrypointDiagnostic, /not fully file-backed/);
  assert.ok(!partial.functions.some((s) => s.source === 'entrypoint'));

  const full = parsePE(makePE({ machine: 0xaa64, entryRva: 0x1000, fileLen: 0x204 }));
  assert.equal(full.metadata.entrypointValid, true);
  assert.equal(full.functions.find((s) => s.source === 'entrypoint')?.address, 0x140001000n);
});

test('x86_64 one-byte instruction-start policy is unchanged (#8787)', () => {
  const { bytes, image } = makeArm64Image({ textFileBytes: 63, metadata: { machine: 0x8664 } });
  writePointer(bytes, 24, 0x3000n, 64);
  writePointer(bytes, 256, PARTIAL_BACKED, 64);
  writePointer(bytes, 264, 0n, 64);
  image.addSegment({ name: '.tls', address: 0x3000n, size: 0x100n, fileOffset: 256n, fileSize: 0x100n, perms: { read: true, write: false, execute: false } });
  parseTlsDirectory(new ByteView(bytes), { rva: 0x1000, size: 40 }, image);
  assert.equal(image.functions.filter((f) => f.source === 'tls-callback').length, 1, 'x86_64 callback is not span-gated beyond one byte');
});

console.log('issue #8787 PE partial-instruction-span seed regression: PASS');
