import test from "node:test";
import assert from "node:assert/strict";
import { parseBaseRelocations, createPEMetadataBudget } from "../js/binary/pe-loader.js";
import { ByteView } from "../js/binary/reader.js";

const BASE = 0x140000000n;

function createFixture(size = 0x200) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  const sec = {
    index: 1,
    name: ".reloc",
    address: BASE + 0x2000n,
    size: 0x1000n,
    fileOffset: 0x40n,
    fileSize: 0x1000n,
    perms: { read: true, write: false, execute: false },
  };
  const image = {
    imageBase: BASE,
    sections: [sec],
    sectionAt: (addr) => (addr >= sec.address && addr < sec.address + sec.size ? sec : null),
    addressToOffset: (addr) => addr - BASE - 0x2000n + 0x40n,
    relocations: [],
    warnings: [],
    metadata: {},
  };
  return { bytes, view, r: new ByteView(bytes, { littleEndian: true }), image };
}

test("PE reloc: aligned start with Block Size=8 is valid (empty block)", () => {
  const { view, r, image } = createFixture();
  // Block 1 at offset 0x40 (RVA 0x2000)
  view.setUint32(0x40, 0x2000, true); // page RVA
  view.setUint32(0x44, 8, true);      // block size 8
  parseBaseRelocations(r, { rva: 0x2000, size: 8 }, image, 0x8664);

  assert.equal(image.relocations.length, 0);
  assert.equal(image.metadata.peMetadata?.complete, true);
});

test("PE reloc: aligned start with Block Size=12 (2 entries) is valid", () => {
  const { view, r, image } = createFixture();
  // Block 1 at offset 0x40 (RVA 0x2000)
  view.setUint32(0x40, 0x2000, true); // page RVA
  view.setUint32(0x44, 12, true);     // block size 12
  // Entry 1: HIGHLOW (type 3) at offset 0x10 -> raw 0x3010
  view.setUint16(0x48, (3 << 12) | 0x10, true);
  // Entry 2: DIR64 (type 10) at offset 0x20 -> raw 0xa020
  view.setUint16(0x4a, (10 << 12) | 0x20, true);

  parseBaseRelocations(r, { rva: 0x2000, size: 12 }, image, 0x8664);

  assert.equal(image.relocations.length, 2);
  assert.equal(image.relocations[0].type, 3);
  assert.equal(image.relocations[0].address, BASE + 0x2010n);
  assert.equal(image.relocations[1].type, 10);
  assert.equal(image.relocations[1].address, BASE + 0x2020n);
  assert.equal(image.metadata.peMetadata?.complete, true);
});

test("PE reloc: Block Size=10 followed by second block fails alignment and rejects second block", () => {
  const { view, r, image } = createFixture();
  // Directory RVA 0x2000, size 18
  // Block 1: Page RVA 0x2000, Block Size 10 (8-byte header + 1 entry of 2 bytes)
  view.setUint32(0x40, 0x2000, true);
  view.setUint32(0x44, 10, true);
  view.setUint16(0x48, (10 << 12) | 0x10, true);

  // Block 2: Starts at 0x40 + 10 = 0x4a (misaligned, 2 mod 4)
  view.setUint32(0x4a, 0x3000, true);
  view.setUint32(0x4e, 8, true);

  parseBaseRelocations(r, { rva: 0x2000, size: 18 }, image, 0x8664);

  // Must not decode second block from misaligned offset
  assert.equal(image.metadata.peMetadata?.complete, false);
  assert.ok(image.metadata.peMetadata?.reasons?.some((r) => r.includes("relocations:malformed-block")));
  // Ensure no relocations from second block exist
  assert.ok(!image.relocations.some((rel) => rel.address >= BASE + 0x3000n));
});

test("PE reloc: Block Size=14 followed by second block fails alignment", () => {
  const { view, r, image } = createFixture();
  // Directory size 22
  view.setUint32(0x40, 0x2000, true);
  view.setUint32(0x44, 14, true); // 14 is not multiple of 4
  view.setUint16(0x48, (10 << 12) | 0x10, true);
  view.setUint16(0x4a, (10 << 12) | 0x20, true);
  view.setUint16(0x4c, (10 << 12) | 0x30, true);

  // Block 2 at 0x4e
  view.setUint32(0x4e, 0x3000, true);
  view.setUint32(0x52, 8, true);

  parseBaseRelocations(r, { rva: 0x2000, size: 22 }, image, 0x8664);

  assert.equal(image.metadata.peMetadata?.complete, false);
  assert.ok(image.metadata.peMetadata?.reasons?.some((r) => r.includes("relocations:malformed-block")));
});

test("PE reloc: IMAGE_REL_BASED_ABSOLUTE (type 0) pads block to 4-byte multiple and allows valid second block", () => {
  const { view, r, image } = createFixture();
  // Block 1: 1 entry (DIR64) + 1 ABSOLUTE (type 0) padding entry = 12 bytes
  view.setUint32(0x40, 0x2000, true);
  view.setUint32(0x44, 12, true);
  view.setUint16(0x48, (10 << 12) | 0x10, true); // DIR64
  view.setUint16(0x4a, 0, true);                 // ABSOLUTE padding

  // Block 2: at 0x40 + 12 = 0x4c (4-byte aligned), size 12
  view.setUint32(0x4c, 0x3000, true);
  view.setUint32(0x50, 12, true);
  view.setUint16(0x54, (10 << 12) | 0x08, true); // DIR64
  view.setUint16(0x56, 0, true);                 // ABSOLUTE padding

  parseBaseRelocations(r, { rva: 0x2000, size: 24 }, image, 0x8664);

  assert.equal(image.metadata.peMetadata?.complete, true);
  assert.equal(image.relocations.length, 2);
  assert.equal(image.relocations[0].address, BASE + 0x2010n);
  assert.equal(image.relocations[1].address, BASE + 0x3008n);
});

test("PE reloc: misaligned directory start RVA is rejected", () => {
  const { r, image } = createFixture();
  parseBaseRelocations(r, { rva: 0x2001, size: 12 }, image, 0x8664);

  assert.equal(image.relocations.length, 0);
  assert.equal(image.metadata.peMetadata?.complete, false);
  assert.ok(image.metadata.peMetadata?.reasons?.some((r) => r.includes("relocations:directory-alignment")));
});
