import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteView } from '../../../js/binary/reader.js';
import { parseBaseRelocations } from '../../../js/binary/pe-loader.js';

const BASE = 0x140000000n;
const DIR_RVA = 0x2000;

function fixture(size = 0x4000) {
  const bytes = new Uint8Array(size);
  const mapped = {
    address: BASE,
    size: BigInt(bytes.length),
    fileOffset: 0n,
    fileSize: BigInt(bytes.length),
    perms: { read: true, write: true },
  };
  const image = {
    imageBase: BASE,
    bits: 64,
    sections: [mapped],
    segments: [mapped],
    functions: [],
    relocations: [],
    warnings: [],
    metadata: {},
    addressToOffset(address) {
      const delta = BigInt(address) - BASE;
      return delta >= 0n && delta < BigInt(bytes.length) ? delta : null;
    },
  };
  return { bytes, r: new ByteView(bytes, { littleEndian: true }), image };
}

const reloc = (type, within = 0x20) => (type << 12) | (within & 0xfff);

function parseEntries(entries) {
  const { bytes, r, image } = fixture();
  const blockSize = 8 + entries.length * 2;
  const view = new DataView(bytes.buffer);
  view.setUint32(DIR_RVA, 0x1000, true);
  view.setUint32(DIR_RVA + 4, blockSize, true);
  entries.forEach((raw, index) => view.setUint16(DIR_RVA + 8 + index * 2, raw, true));
  parseBaseRelocations(r, { rva: DIR_RVA, size: blockSize }, image, 0x8664);
  return image;
}

test('#3898 keeps supported DIR64 relocation complete', () => {
  const image = parseEntries([reloc(10), 0]);
  assert.equal(image.relocations.length, 1);
  assert.equal(image.relocations[0].type, 10);
  assert.equal(image.metadata.peMetadata.complete, true);
  assert.ok(!image.metadata.peMetadata.reasons.includes('relocations:unsupported-type'));
});

test('#3898 keeps ABSOLUTE padding complete', () => {
  const image = parseEntries([0, 0]);
  assert.equal(image.relocations.length, 0);
  assert.equal(image.metadata.peMetadata.complete, true);
  assert.ok(!image.metadata.peMetadata.reasons.includes('relocations:unsupported-type'));
});

test('#3898 marks unsupported x64 relocation type partial', () => {
  const image = parseEntries([reloc(6), 0]);
  assert.equal(image.relocations.length, 0);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('relocations:unsupported-type'));
  assert.ok(image.warnings.some((warning) => warning.includes('base relocation type 6')));
});

test('#3898 preserves supported evidence in a mixed block while marking the artifact partial', () => {
  const image = parseEntries([reloc(10, 0x20), reloc(6, 0x30)]);
  assert.equal(image.relocations.length, 1);
  assert.equal(image.relocations[0].type, 10);
  assert.equal(image.relocations[0].address, BASE + 0x1020n);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('relocations:unsupported-type'));
});
