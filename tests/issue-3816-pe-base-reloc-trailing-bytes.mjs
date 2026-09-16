import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteView } from '../js/binary/reader.js';
import { parseBaseRelocations } from '../js/binary/pe-loader.js';

// #3816: every declared byte of the Base Relocation Data Directory must be
// consumed. A valid block followed by 1..7 unconsumed tail bytes (or an
// unaligned directory size) must partial the metadata, never stay complete.

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

function writeBlock(view, offset, pageRva, blockSize, entries = []) {
  view.setUint32(offset, pageRva, true);
  view.setUint32(offset + 4, blockSize, true);
  entries.forEach((raw, i) => view.setUint16(offset + 8 + i * 2, raw, true));
}

const DIRLOW = (off) => (0x3 << 12) | (off & 0xfff);

test('#3816 exact 8-byte empty block directory stays complete', () => {
  const { view, r, image } = fixture();
  writeBlock(view, 0x2000, 0x1000, 8);
  parseBaseRelocations(r, { rva: 0x2000, size: 8 }, image, 0x8664);
  assert.equal(image.metadata.peMetadata.complete, true);
  assert.equal(image.relocations.length, 0);
});

test('#3816 issue minimum: 9-byte directory with 8-byte valid block is partial', () => {
  const { view, r, image } = fixture();
  writeBlock(view, 0x2000, 0x1000, 8);
  view.setUint8(0x2008, 0xAA);
  parseBaseRelocations(r, { rva: 0x2000, size: 9 }, image, 0x8664);
  assert.equal(image.metadata.peMetadata.complete, false, 'unconsumed directory tail must partial completeness');
  assert.ok(image.metadata.peMetadata.reasons.includes('relocations:malformed-block'), image.metadata.peMetadata.reasons.join(','));
});

test('#3816 15-byte directory is partial', () => {
  const { view, r, image } = fixture();
  writeBlock(view, 0x2000, 0x1000, 8);
  parseBaseRelocations(r, { rva: 0x2000, size: 15 }, image, 0x8664);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('relocations:malformed-block'));
});

test('#3816 4-aligned trailing remainder after last valid block is partial', () => {
  const { view, r, image } = fixture();
  writeBlock(view, 0x2000, 0x1000, 8);
  parseBaseRelocations(r, { rva: 0x2000, size: 12 }, image, 0x8664);
  assert.equal(image.metadata.peMetadata.complete, false, '4 trailing bytes must not be silently ignored');
  assert.ok(image.metadata.peMetadata.reasons.includes('relocations:malformed-block'));
});

test('#3816 odd block size keeps the existing malformed-block partial', () => {
  const { view, r, image } = fixture();
  writeBlock(view, 0x2000, 0x1000, 10, [0x0000]);
  parseBaseRelocations(r, { rva: 0x2000, size: 10 }, image, 0x8664);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('relocations:malformed-block'));
});

test('#3816 valid relocation entries still decode (no regression)', () => {
  const { view, r, image } = fixture();
  writeBlock(view, 0x2000, 0x1000, 12, [0x0000, DIRLOW(0x8)]);
  parseBaseRelocations(r, { rva: 0x2000, size: 12 }, image, 0x8664);
  assert.equal(image.metadata.peMetadata.complete, true);
  assert.equal(image.relocations.length, 1);
  assert.equal(image.relocations[0].address, BASE + 0x1008n);
});
