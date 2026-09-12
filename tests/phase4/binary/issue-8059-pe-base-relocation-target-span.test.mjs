import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteView } from '../../../js/binary/reader.js';
import { parseBaseRelocations } from '../../../js/binary/pe-loader.js';

const BASE = 0x140000000n;
const SIZE_OF_IMAGE = 0x3000;
const DIR_RVA = 0x1000;
const DIR_OFFSET = 0x400;

function mapping(rva, size, fileOffset, fileSize, source = 'PE-section') {
  return {
    address: BASE + BigInt(rva),
    size: BigInt(size),
    fileOffset: BigInt(fileOffset),
    fileSize: BigInt(fileSize),
    perms: { read: true, write: true, execute: false },
    source,
  };
}

function fixture({ targetFileSize = 0x1000 } = {}) {
  const bytes = new Uint8Array(0x2000);
  const reloc = mapping(DIR_RVA, 0x1000, DIR_OFFSET, 0x100);
  const target = mapping(0x2000, 0x1000, 0x800, targetFileSize);
  const sections = [reloc, target];
  const image = {
    imageBase: BASE,
    bits: 64,
    sections,
    segments: [],
    functions: [],
    relocations: [],
    warnings: [],
    metadata: { sizeOfImage: SIZE_OF_IMAGE },
    addressToOffset(address) {
      const a = BigInt(address);
      for (const owner of sections) {
        if (a < owner.address || a >= owner.address + owner.size) continue;
        const delta = a - owner.address;
        if (delta < owner.fileSize) return owner.fileOffset + delta;
      }
      return null;
    },
  };
  return { bytes, image, r: new ByteView(bytes, { littleEndian: true }) };
}

const relocationWord = (type, offset) => ((type & 0xf) << 12) | (offset & 0xfff);

function writeBlock(bytes, pageRva, entries) {
  const blockSize = 8 + entries.length * 2;
  assert.equal(blockSize & 3, 0, 'test relocation blocks must remain 4-byte aligned');
  const view = new DataView(bytes.buffer);
  view.setUint32(DIR_OFFSET, pageRva >>> 0, true);
  view.setUint32(DIR_OFFSET + 4, blockSize, true);
  entries.forEach((raw, index) => view.setUint16(DIR_OFFSET + 8 + index * 2, raw, true));
  return blockSize;
}

function parseSingle({ machine, type, targetRva, targetFileSize = 0x1000 }) {
  const { bytes, image, r } = fixture({ targetFileSize });
  const pageRva = targetRva & ~0xfff;
  const within = targetRva & 0xfff;
  const entries = type === 4
    ? [relocationWord(type, within), 0x1234]
    : [relocationWord(type, within), 0x0000];
  const size = writeBlock(bytes, pageRva, entries);
  parseBaseRelocations(r, { rva: DIR_RVA, size }, image, machine);
  return image;
}

function assertAccepted({ machine, type, targetRva, targetFileSize }) {
  const image = parseSingle({ machine, type, targetRva, targetFileSize });
  assert.equal(image.relocations.length, 1, `type ${type} at RVA 0x${targetRva.toString(16)} should fit`);
  assert.equal(image.relocations[0].address, BASE + BigInt(targetRva));
  assert.equal(image.metadata.peMetadata.complete, true);
  return image;
}

function assertSpanRejected({ machine, type, targetRva }) {
  const image = parseSingle({ machine, type, targetRva });
  assert.equal(image.relocations.length, 0, `type ${type} at RVA 0x${targetRva.toString(16)} crosses the loaded image`);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('relocations:target-span'));
}

test('#8059 DIR64 requires its complete 8-byte target field inside SizeOfImage', () => {
  assertAccepted({ machine: 0x8664, type: 10, targetRva: SIZE_OF_IMAGE - 8 });
  for (let delta = 7; delta >= 1; delta--) {
    assertSpanRejected({ machine: 0x8664, type: 10, targetRva: SIZE_OF_IMAGE - delta });
  }
});

test('#8059 x86/x64 HIGHLOW requires its complete 4-byte target field', () => {
  for (const machine of [0x014c, 0x8664]) {
    assertAccepted({ machine, type: 3, targetRva: SIZE_OF_IMAGE - 4 });
    for (let delta = 3; delta >= 1; delta--) {
      assertSpanRejected({ machine, type: 3, targetRva: SIZE_OF_IMAGE - delta });
    }
  }
});

test('#8059 HIGH, LOW, and HIGHADJ require complete 2-byte target fields', () => {
  for (const type of [1, 2, 4]) {
    assertAccepted({ machine: 0x014c, type, targetRva: SIZE_OF_IMAGE - 2 });
    assertSpanRejected({ machine: 0x014c, type, targetRva: SIZE_OF_IMAGE - 1 });
  }
});

test('#8059 machine-specific instruction relocations validate their complete instruction span', () => {
  // ARM/Thumb MOV32 relocations patch a consecutive MOVW/MOVT pair (8 bytes).
  for (const [machine, type] of [[0x01c0, 5], [0x01c4, 7]]) {
    assertAccepted({ machine, type, targetRva: SIZE_OF_IMAGE - 8 });
    assertSpanRejected({ machine, type, targetRva: SIZE_OF_IMAGE - 7 });
  }

  // ARM64 PAGEBASE_REL21 and RISC-V HIGH20/LOW12I/LOW12S patch 4-byte instructions.
  assertAccepted({ machine: 0xaa64, type: 4, targetRva: SIZE_OF_IMAGE - 4 });
  assertSpanRejected({ machine: 0xaa64, type: 4, targetRva: SIZE_OF_IMAGE - 3 });
  for (const type of [5, 7, 8]) {
    assertAccepted({ machine: 0x5064, type, targetRva: SIZE_OF_IMAGE - 4 });
    assertSpanRejected({ machine: 0x5064, type, targetRva: SIZE_OF_IMAGE - 3 });
  }
});

test('#8059 HIGHADJ still consumes its payload slot when its target span is invalid', () => {
  const { bytes, image, r } = fixture();
  const entries = [
    relocationWord(4, 0xfff),
    0xa004, // payload: must never be decoded as a standalone DIR64 relocation
    relocationWord(1, 0xffe),
    0x0000,
  ];
  const size = writeBlock(bytes, 0x2000, entries);
  parseBaseRelocations(r, { rva: DIR_RVA, size }, image, 0x014c);

  assert.deepEqual(image.relocations.map(({ type, address }) => [type, address]), [
    [1, BASE + 0x2ffen],
  ]);
  assert.ok(image.metadata.peMetadata.reasons.includes('relocations:target-span'));
});

test('#8059 virtual zero-fill remains eligible when the complete field is mapped', () => {
  const image = assertAccepted({ machine: 0x8664, type: 10, targetRva: SIZE_OF_IMAGE - 8, targetFileSize: 0 });
  assert.equal(image.relocations[0].fileOffset, null);
});

test('#8059 preserves the older start-unmapped diagnostic from #3700', () => {
  const image = parseSingle({ machine: 0x8664, type: 10, targetRva: SIZE_OF_IMAGE });
  assert.equal(image.relocations.length, 0);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('relocations:unmapped-target'));
  assert.ok(!image.metadata.peMetadata.reasons.includes('relocations:target-span'));
});
