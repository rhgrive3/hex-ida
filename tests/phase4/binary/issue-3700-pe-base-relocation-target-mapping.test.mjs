import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteView } from '../../../js/binary/reader.js';
import { parseBaseRelocations } from '../../../js/binary/pe-loader.js';

const BASE = 0x140000000n;
const DIR_RVA = 0x1000;
const DIR_OFFSET = 0x400;

function mapping(rva, size, fileOffset, fileSize, source) {
  return {
    address: BASE + BigInt(rva),
    size: BigInt(size),
    fileOffset: BigInt(fileOffset),
    fileSize: BigInt(fileSize),
    perms: { read: true, write: true, execute: false },
    source,
  };
}

function fixture({ sizeOfImage = 0x4000, extraMappings = [] } = {}) {
  const bytes = new Uint8Array(0x1000);
  const headers = mapping(0, 0x400, 0, 0x400, 'PE-headers');
  const reloc = mapping(0x1000, 0x1000, DIR_OFFSET, 0x100, 'PE-section');
  const zeroFill = mapping(0x2000, 0x1000, 0x500, 0, 'PE-section');
  const sections = [reloc, zeroFill, ...extraMappings];
  const segments = [headers, reloc, zeroFill, ...extraMappings];
  const owners = [...sections, ...segments];
  const image = {
    imageBase: BASE,
    bits: 64,
    sections,
    segments,
    functions: [],
    relocations: [],
    warnings: [],
    metadata: { sizeOfImage },
    addressToOffset(address) {
      const a = BigInt(address);
      for (const owner of owners) {
        if (a < owner.address || a >= owner.address + owner.size) continue;
        const delta = a - owner.address;
        if (delta < owner.fileSize) return owner.fileOffset + delta;
      }
      return null;
    },
  };
  return { bytes, r: new ByteView(bytes, { littleEndian: true }), image };
}

function writeRelocationBlock(bytes, pageRva, within) {
  const view = new DataView(bytes.buffer);
  view.setUint32(DIR_OFFSET, pageRva >>> 0, true);
  view.setUint32(DIR_OFFSET + 4, 12, true);
  view.setUint16(DIR_OFFSET + 8, (10 << 12) | (within & 0xfff), true);
  view.setUint16(DIR_OFFSET + 10, 0, true);
}

function parseTarget({ pageRva, within, ...options }) {
  const { bytes, r, image } = fixture(options);
  writeRelocationBlock(bytes, pageRva, within);
  parseBaseRelocations(r, { rva: DIR_RVA, size: 12 }, image, 0x8664);
  return image;
}

test('#3700 accepts file-backed and zero-fill virtual relocation targets', () => {
  const fileBacked = parseTarget({ pageRva: 0x1000, within: 0x20 });
  assert.equal(fileBacked.relocations.length, 1);
  assert.equal(fileBacked.relocations[0].address, BASE + 0x1020n);
  assert.equal(fileBacked.relocations[0].fileOffset, 0x420n);
  assert.equal(fileBacked.metadata.peMetadata.complete, true);

  const zeroFill = parseTarget({ pageRva: 0x2000, within: 0x08 });
  assert.equal(zeroFill.relocations.length, 1);
  assert.equal(zeroFill.relocations[0].address, BASE + 0x2008n);
  assert.equal(zeroFill.relocations[0].fileOffset, null);
  assert.equal(zeroFill.metadata.peMetadata.complete, true);
});

test('#3700 keeps loader-mapped PE headers eligible', () => {
  const image = parseTarget({ pageRva: 0, within: 0x100 });
  assert.equal(image.relocations.length, 1);
  assert.equal(image.relocations[0].address, BASE + 0x100n);
  assert.equal(image.relocations[0].fileOffset, 0x100n);
});

test('#3700 rejects unmapped targets and marks metadata partial', () => {
  const image = parseTarget({ pageRva: 0x3000, within: 0x08 });
  assert.equal(image.relocations.length, 0);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('relocations:unmapped-target'));
  assert.ok(image.warnings.some((warning) => warning.includes('RVA 0x3008')));
});

test('#3700 rejects targets beyond SizeOfImage even if a synthetic mapping claims them', () => {
  const rogue = mapping(0x5000, 0x1000, 0x600, 0, 'PE-section');
  const image = parseTarget({ pageRva: 0x5000, within: 0x08, extraMappings: [rogue] });
  assert.equal(image.relocations.length, 0);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('relocations:unmapped-target'));
});

test('#3700 rejects 32-bit RVA overflow instead of publishing a huge canonical address', () => {
  const image = parseTarget({ pageRva: 0xffffffff, within: 0x001, sizeOfImage: 0x100000000 });
  assert.equal(image.relocations.length, 0);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('relocations:unmapped-target'));
  assert.ok(image.warnings.some((warning) => warning.includes('RVA 0x100000000')));
});
