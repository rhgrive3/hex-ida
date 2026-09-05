import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteView } from '../js/binary/reader.js';
import { parseBaseRelocations } from '../js/binary/pe-loader.js';

// #6282: every PE Base Relocation Block must start on a 32-bit boundary.
// A block with a Block Size that is not a multiple of 4 shifts any following
// block off the 32-bit boundary; the parser must treat such a table as
// malformed instead of decoding the misaligned follower normally.

const BASE = 0x140000000n;

function fixture(size = 0x4000) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  const mapped = { address: BASE, size: BigInt(bytes.length), fileOffset: 0n, fileSize: BigInt(bytes.length), perms: { read: true, write: true } };
  const image = { imageBase: BASE, bits: 64, sections: [mapped], segments: [mapped], functions: [], relocations: [], warnings: [], metadata: {},
    addressToOffset(address) { const d = BigInt(address) - BASE; return d >= 0n && d < BigInt(bytes.length) ? d : null; },
    sectionAt() { return null; } };
  return { bytes, view, r: new ByteView(bytes, { littleEndian: true }), image };
}

function writeBlock(bytes, offset, pageRva, blockSize, entries = []) {
  const view = new DataView(bytes.buffer);
  view.setUint32(offset, pageRva, true);
  view.setUint32(offset + 4, blockSize, true);
  entries.forEach((raw, i) => view.setUint16(offset + 8 + i * 2, raw, true));
}

// 8-bit high | offset 2 -> relocates at pageRva+2
const DIRLOW = (off) => (0x3 << 12) | (off & 0xfff);

test('#6282 aligned blocks with 4-multiple sizes still parse normally', () => {
  const { bytes, r, image } = fixture();
  // Block #1: size 12 (8 header + 2 entries), one ABSOLUTE pad + one DIRLOW
  writeBlock(bytes, 0x2000, 0x1000, 12, [0x0000, DIRLOW(0x8)]);
  // Block #2: size 8, starts at 0x200C (aligned)
  writeBlock(bytes, 0x200C, 0x2000, 8, []);
  parseBaseRelocations(r, { rva: 0x2000, size: 20 }, image, 0x8664);
  assert.equal(image.relocations.length, 1, 'aligned DIRLOW entry decoded');
  assert.equal(image.relocations[0].address, BASE + 0x1008n);
  assert.equal(image.metadata.peMetadata.complete, true, 'no partial diagnostics for a well-formed table');
  assert.equal(image.warnings.length, 0);
});

test('#6282 block size 10 followed by another block rejects the misaligned follower', () => {
  const { bytes, r, image } = fixture();
  // Block #1: size 10 -> next block would start at 0x200A (2 mod 4)
  writeBlock(bytes, 0x2000, 0x1000, 10, [0x0000]);
  // Block #2 at +0x0A: NOT 32-bit aligned, would relocate page 0x3000
  writeBlock(bytes, 0x200A, 0x3000, 8);
  parseBaseRelocations(r, { rva: 0x2000, size: 18 }, image, 0x8664);
  assert.equal(image.metadata.peMetadata.complete, false, 'misaligned structure flagged');
  assert.ok(image.metadata.peMetadata.reasons.includes('relocations:malformed-block'), image.metadata.peMetadata.reasons.join(','));
  assert.ok(image.warnings.some((w) => /Malformed PE base-relocation block/.test(w)));
  const followed = image.relocations.some((x) => x.address >= BASE + 0x3000n);
  assert.equal(followed, false, 'misaligned follower block never decoded');
});

test('#6282 block size 14 followed by another block also rejects', () => {
  const { bytes, r, image } = fixture();
  writeBlock(bytes, 0x2000, 0x1000, 14, [0x0000, 0x0000, DIRLOW(0x4)]);
  writeBlock(bytes, 0x200E, 0x3000, 8);
  parseBaseRelocations(r, { rva: 0x2000, size: 22 }, image, 0x8664);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('relocations:malformed-block'));
  assert.equal(image.relocations.some((x) => x.address >= BASE + 0x3000n), false);
});

test('#6282 4-byte padded ABSOLUTE entries keep the table valid', () => {
  const { bytes, r, image } = fixture();
  // Block #1: size 16 (8 header + 2 entries of ABSOLUTE padding)
  writeBlock(bytes, 0x2000, 0x1000, 16, [0x0000, 0x0000]);
  // Block #2 aligned at 0x2010 with one real entry
  writeBlock(bytes, 0x2010, 0x2000, 12, [0x0000, DIRLOW(0xC)]);
  parseBaseRelocations(r, { rva: 0x2000, size: 28 }, image, 0x8664);
  assert.equal(image.metadata.peMetadata.complete, true);
  assert.equal(image.relocations.length, 1);
  assert.equal(image.relocations[0].address, BASE + 0x200Cn);
});

test('#6282 truncated and odd blocks keep their existing diagnostics', () => {
  const { bytes, r, image } = fixture();
  writeBlock(bytes, 0x2000, 0x1000, 9, []);
  parseBaseRelocations(r, { rva: 0x2000, size: 9 }, image, 0x8664);
  assert.equal(image.relocations.length, 0);
  assert.ok(image.warnings.some((w) => /Malformed PE base-relocation block/.test(w)));

  const t2 = fixture();
  writeBlock(t2.bytes, 0x2000, 0x1000, 32, []);
  parseBaseRelocations(t2.r, { rva: 0x2000, size: 16 }, t2.image, 0x8664);
  assert.ok(t2.image.warnings.some((w) => /Malformed PE base-relocation block/.test(w)), 'block exceeding directory bounds stays malformed');
});

test('#6282 misaligned initial directory or block RVA fails closed', () => {
  const { bytes, r, image } = fixture();
  // Relocation directory starting at unaligned RVA 0x2002 with otherwise-valid BlockSize = 8
  writeBlock(bytes, 0x2002, 0x1000, 8, []);
  parseBaseRelocations(r, { rva: 0x2002, size: 8 }, image, 0x8664);
  assert.equal(image.metadata.peMetadata.complete, false, 'misaligned directory RVA must be marked incomplete');
  assert.ok(image.metadata.peMetadata.reasons.includes('relocations:malformed-block'), image.metadata.peMetadata.reasons.join(','));
  assert.ok(image.warnings.some((w) => /Malformed PE base-relocation block/.test(w)));
  assert.equal(image.relocations.length, 0, 'no relocations published from misaligned directory');
});

test('#6282 trailing partial block header fails closed', () => {
  const { bytes, r, image } = fixture();
  // One valid 12-byte block followed by 4 declared bytes that cannot form a block header.
  writeBlock(bytes, 0x2000, 0x1000, 12, [0x0000, 0x0000]);
  bytes.set([0xaa, 0xbb, 0xcc, 0xdd], 0x200C);
  parseBaseRelocations(r, { rva: 0x2000, size: 16 }, image, 0x8664);
  assert.equal(image.metadata.peMetadata.complete, false, 'declared trailing bytes must not look complete');
  assert.ok(image.metadata.peMetadata.reasons.includes('relocations:malformed-block'), image.metadata.peMetadata.reasons.join(','));
  assert.ok(image.warnings.some((w) => /Malformed PE base-relocation block/.test(w)));
  assert.equal(image.relocations.length, 0, 'ABSOLUTE-only valid prefix publishes no relocations');
});

test('#6282 initial undersized directory size 1..7 fails closed', () => {
  const { bytes, r, image } = fixture();
  bytes.set([0x11, 0x22, 0x33, 0x44], 0x2000);
  parseBaseRelocations(r, { rva: 0x2000, size: 4 }, image, 0x8664);
  assert.equal(image.metadata.peMetadata.complete, false, 'undersized initial directory must be marked incomplete');
  assert.ok(image.metadata.peMetadata.reasons.includes('relocations:malformed-block'), image.metadata.peMetadata.reasons.join(','));
  assert.ok(image.warnings.some((w) => /Malformed PE base-relocation block/.test(w)));
  assert.equal(image.relocations.length, 0, 'no relocations published from undersized directory');
});

