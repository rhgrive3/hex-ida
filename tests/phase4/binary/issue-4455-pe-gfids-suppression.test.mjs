import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLoadConfig } from '../../../js/binary/pe-loader.js';

const IMAGE_BASE = 0x140000000n;
const LOAD_CONFIG_RVA = 0x1000;
const GUARD_CF_TABLE_RVA = 0x1100;
const FIRST_TARGET_RVA = 0x2020;
const SECOND_TARGET_RVA = 0x2030;
const FID_SUPPRESSED = 0x01;
const EXPORT_SUPPRESSED = 0x02;

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.length = bytes.length;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8(off) { return this.view.getUint8(off); }
  u32(off) { return this.view.getUint32(off, true); }
  u64(off) { return this.view.getBigUint64(off, true); }
}

function fixture(entries, { extra = 1 } = {}) {
  const bytes = new Uint8Array(0x300);
  const view = new DataView(bytes.buffer);
  const entrySize = 4 + extra;

  view.setUint32(0, 148, true);
  view.setBigUint64(128, IMAGE_BASE + BigInt(GUARD_CF_TABLE_RVA), true);
  view.setBigUint64(136, BigInt(entries.length), true);
  view.setUint32(144, extra << 28, true);
  entries.forEach(({ rva, flags }, index) => {
    const offset = 0x100 + index * entrySize;
    view.setUint32(offset, rva, true);
    if (extra > 0) bytes[offset + 4] = flags;
  });

  const sections = [
    {
      name: '.rdata',
      address: IMAGE_BASE + 0x1000n,
      size: 0x200n,
      fileOffset: 0n,
      fileSize: 0x200n,
      perms: { read: true, write: false, execute: false },
    },
    {
      name: '.text',
      address: IMAGE_BASE + 0x2000n,
      size: 0x100n,
      fileOffset: 0x200n,
      fileSize: 0x40n,
      perms: { read: true, write: false, execute: true },
    },
  ];
  const image = {
    bits: 64,
    imageBase: IMAGE_BASE,
    sections,
    segments: [],
    metadata: {},
    warnings: [],
    functions: [],
    sectionAt(address) {
      return sections.find((section) => (
        address >= section.address && address < section.address + section.size
      )) || null;
    },
  };

  parseLoadConfig(new Reader(bytes), { rva: LOAD_CONFIG_RVA, size: 148 }, image);
  return image;
}

test('GFIDS metadata flags are read without changing the entry stride', () => {
  const image = fixture([
    { rva: FIRST_TARGET_RVA, flags: 0 },
    { rva: SECOND_TARGET_RVA, flags: 0 },
  ]);

  assert.deepEqual(image.metadata.loadConfig.guardCFFunctions, [
    IMAGE_BASE + BigInt(FIRST_TARGET_RVA),
    IMAGE_BASE + BigInt(SECOND_TARGET_RVA),
  ]);
  assert.deepEqual(image.metadata.loadConfig.guardCFFunctionMetadata, [
    { rva: FIRST_TARGET_RVA, address: IMAGE_BASE + BigInt(FIRST_TARGET_RVA), flags: 0 },
    { rva: SECOND_TARGET_RVA, address: IMAGE_BASE + BigInt(SECOND_TARGET_RVA), flags: 0 },
  ]);
  assert.equal(image.functions.length, 2);
});

test('FID_SUPPRESSED entries are not valid GuardCF targets or function seeds', () => {
  const image = fixture([{ rva: FIRST_TARGET_RVA, flags: FID_SUPPRESSED }]);

  assert.deepEqual(image.metadata.loadConfig.guardCFFunctions, []);
  assert.deepEqual(image.metadata.loadConfig.suppressedGuardCFFunctions, [
    IMAGE_BASE + BigInt(FIRST_TARGET_RVA),
  ]);
  assert.deepEqual(image.metadata.loadConfig.exportSuppressedGuardCFFunctions, []);
  assert.equal(image.functions.length, 0);
  assert.equal(image.metadata.peMetadata.complete, true);
});

test('EXPORT_SUPPRESSED metadata is preserved while the CFG target remains usable', () => {
  const image = fixture([{ rva: FIRST_TARGET_RVA, flags: EXPORT_SUPPRESSED }]);

  assert.deepEqual(image.metadata.loadConfig.guardCFFunctions, [
    IMAGE_BASE + BigInt(FIRST_TARGET_RVA),
  ]);
  assert.deepEqual(image.metadata.loadConfig.exportSuppressedGuardCFFunctions, [
    IMAGE_BASE + BigInt(FIRST_TARGET_RVA),
  ]);
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].source, 'guard-cf');
});

test('suppressed and unsuppressed entries can be mixed without losing following entries', () => {
  const image = fixture([
    { rva: FIRST_TARGET_RVA, flags: FID_SUPPRESSED },
    { rva: SECOND_TARGET_RVA, flags: 0 },
  ]);

  assert.deepEqual(image.metadata.loadConfig.guardCFFunctions, [
    IMAGE_BASE + BigInt(SECOND_TARGET_RVA),
  ]);
  assert.deepEqual(image.metadata.loadConfig.suppressedGuardCFFunctions, [
    IMAGE_BASE + BigInt(FIRST_TARGET_RVA),
  ]);
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].address, IMAGE_BASE + BigInt(SECOND_TARGET_RVA));
});

test('the legacy four-byte table remains unchanged when no metadata byte exists', () => {
  const image = fixture([{ rva: FIRST_TARGET_RVA, flags: FID_SUPPRESSED }], { extra: 0 });

  assert.deepEqual(image.metadata.loadConfig.guardCFFunctions, [
    IMAGE_BASE + BigInt(FIRST_TARGET_RVA),
  ]);
  assert.deepEqual(image.metadata.loadConfig.guardCFFunctionMetadata, [
    { rva: FIRST_TARGET_RVA, address: IMAGE_BASE + BigInt(FIRST_TARGET_RVA), flags: 0 },
  ]);
  assert.equal(image.functions.length, 1);
});

console.log('issue #4455 PE GFIDS suppression metadata: PASS');
