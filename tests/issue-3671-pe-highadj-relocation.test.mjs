import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteView } from '../js/binary/reader.js';
import { parseBaseRelocations } from '../js/binary/pe-loader.js';

const BASE = 0x140000000n;

function fixture(size = 0x4000) {
  const bytes = new Uint8Array(size);
  const mapped = { address: BASE, size: BigInt(bytes.length), fileOffset: 0n, fileSize: BigInt(bytes.length), perms: { read: true, write: true } };
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
    sectionAt() { return null; },
  };
  return { bytes, r: new ByteView(bytes, { littleEndian: true }), image };
}

function writeBlock(bytes, offset, pageRva, entries) {
  const view = new DataView(bytes.buffer);
  view.setUint32(offset, pageRva, true);
  view.setUint32(offset + 4, 8 + entries.length * 2, true);
  entries.forEach((raw, i) => view.setUint16(offset + 8 + i * 2, raw, true));
}

const relocationWord = (type, offset) => ((type & 0xf) << 12) | (offset & 0xfff);

for (const payload of [0x0000, 0x3004, 0xa004, 0xf004]) {
  test(`#3671 HIGHADJ consumes payload word 0x${payload.toString(16)} without re-decoding it`, () => {
    const { bytes, r, image } = fixture();
    writeBlock(bytes, 0x2000, 0x1000, [relocationWord(4, 0x100), payload]);

    parseBaseRelocations(r, { rva: 0x2000, size: 12 }, image, 0x014c);

    assert.equal(image.relocations.length, 1);
    assert.equal(image.relocations[0].type, 4);
    assert.equal(image.relocations[0].address, BASE + 0x1100n);
    assert.equal(image.warnings.length, 0, 'HIGHADJ payload is not an independent relocation header');
    assert.equal(image.metadata.peMetadata.complete, true);
    assert.equal(image.metadata.peMetadata.used.inputBytes, 12, 'both HIGHADJ slots remain budgeted');
    assert.equal(image.metadata.peMetadata.used.records, 3, 'block plus both 16-bit slots remain record-budgeted');
    assert.equal(image.metadata.peMetadata.used.objects, 2, 'payload keeps the previous conservative object charge');
  });
}

test('#3671 HIGHADJ in the final slot is partial and is not emitted without its payload', () => {
  const { bytes, r, image } = fixture();
  writeBlock(bytes, 0x2000, 0x1000, [0x0000, relocationWord(4, 0x100)]);

  parseBaseRelocations(r, { rva: 0x2000, size: 12 }, image, 0x014c);

  assert.equal(image.relocations.length, 0);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('relocations:highadj-payload'));
  assert.ok(image.warnings.some((warning) => /HIGHADJ.*second adjustment slot/.test(warning)));
});

test('#3671 ordinary one-slot HIGHLOW and DIR64 relocations remain unchanged', () => {
  const { bytes, r, image } = fixture();
  writeBlock(bytes, 0x2000, 0x1000, [relocationWord(3, 0x020), relocationWord(10, 0x028)]);

  parseBaseRelocations(r, { rva: 0x2000, size: 12 }, image, 0x8664);

  assert.deepEqual(image.relocations.map((relocation) => [relocation.type, relocation.address]), [
    [3, BASE + 0x1020n],
    [10, BASE + 0x1028n],
  ]);
  assert.equal(image.metadata.peMetadata.complete, true);
});
