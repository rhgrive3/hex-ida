import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteView } from '../../../js/binary/reader.js';
import { parseBaseRelocations } from '../../../js/binary/pe-loader.js';

const BASE = 0x140000000n;

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
    sectionAt() { return null; },
  };
  return { bytes, r: new ByteView(bytes, { littleEndian: true }), image };
}

function writeRelocationBlock(bytes, offset, pageRva, entries) {
  const view = new DataView(bytes.buffer);
  view.setUint32(offset, pageRva, true);
  view.setUint32(offset + 4, 8 + entries.length * 2, true);
  entries.forEach((raw, index) => view.setUint16(offset + 8 + index * 2, raw, true));
}

const reloc = (type, within = 0x20) => (type << 12) | (within & 0xfff);

function parseSingle(machine, type) {
  const { bytes, r, image } = fixture();
  // Keep the block 4-byte aligned: one real slot plus ABSOLUTE padding.
  writeRelocationBlock(bytes, 0x2000, 0x1000, [reloc(type), 0]);
  parseBaseRelocations(r, { rva: 0x2000, size: 12 }, image, machine);
  return image;
}

test('#3673 ARM64/ARM64EC reject reserved type 6 and foreign type 8', () => {
  for (const machine of [0xaa64, 0xa641]) {
    for (const type of [6, 8]) {
      const image = parseSingle(machine, type);
      assert.equal(image.relocations.length, 0, `machine=0x${machine.toString(16)} type=${type}`);
      assert.ok(
        image.warnings.some((warning) => warning.includes(`base relocation type ${type}`)),
        `machine=0x${machine.toString(16)} type=${type} should leave an unsupported-type diagnostic`,
      );
    }
  }
});

test('#3673 ARM64/ARM64EC retain architecture-neutral DIR64 relocation evidence', () => {
  for (const machine of [0xaa64, 0xa641]) {
    const image = parseSingle(machine, 10);
    assert.equal(image.relocations.length, 1);
    assert.equal(image.relocations[0].type, 10);
    assert.equal(image.relocations[0].address, BASE + 0x1020n);
    assert.equal(image.metadata.peMetadata.complete, true);
    assert.equal(image.warnings.length, 0);
  }
});
