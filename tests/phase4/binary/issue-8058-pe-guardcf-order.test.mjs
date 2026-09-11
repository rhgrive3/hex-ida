import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLoadConfig } from '../../../js/binary/pe-loader.js';

const IMAGE_BASE = 0x140000000n;
const LOAD_CONFIG_RVA = 0x1000;
const GUARD_CF_TABLE_RVA = 0x1100;
const TABLE_PRESENT = 0x400;

class Reader {
  constructor(bytes) {
    this.length = bytes.length;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8(off) { return this.view.getUint8(off); }
  u32(off) { return this.view.getUint32(off, true); }
  u64(off) { return this.view.getBigUint64(off, true); }
}

function fixture(entries, { extra = 0 } = {}) {
  const bytes = new Uint8Array(0x300);
  const view = new DataView(bytes.buffer);
  const entrySize = 4 + extra;
  view.setUint32(0, 148, true);
  view.setBigUint64(128, IMAGE_BASE + BigInt(GUARD_CF_TABLE_RVA), true);
  view.setBigUint64(136, BigInt(entries.length), true);
  view.setUint32(144, TABLE_PRESENT | (extra << 28), true);
  entries.forEach(({ rva, flags = 0 }, index) => {
    const p = 0x100 + index * entrySize;
    view.setUint32(p, rva, true);
    if (extra > 0) bytes[p + 4] = flags;
  });

  const sections = [
    {
      name: '.rdata', address: IMAGE_BASE + 0x1000n, size: 0x200n,
      fileOffset: 0n, fileSize: 0x200n,
      perms: { read: true, write: false, execute: false },
    },
    {
      name: '.text', address: IMAGE_BASE + 0x2000n, size: 0x100n,
      fileOffset: 0x200n, fileSize: 0x100n,
      perms: { read: true, write: false, execute: true },
    },
  ];
  const image = {
    bits: 64,
    imageBase: IMAGE_BASE,
    sections,
    segments: [],
    metadata: { machine: 0x8664 },
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

test('sorted GFIDS stays authoritative and complete (#8058)', () => {
  const image = fixture([{ rva: 0x2020 }, { rva: 0x2030 }]);
  assert.deepEqual(image.metadata.loadConfig.guardCFFunctions, [
    IMAGE_BASE + 0x2020n,
    IMAGE_BASE + 0x2030n,
  ]);
  assert.equal(image.functions.filter((f) => f.source === 'guard-cf').length, 2);
  assert.equal(image.metadata.peMetadata.complete, true);
});

test('descending GFIDS is fail-closed before publishing GuardCF authority (#8058)', () => {
  const image = fixture([{ rva: 0x2030 }, { rva: 0x2020 }]);
  assert.deepEqual(image.metadata.loadConfig.guardCFFunctions, []);
  assert.deepEqual(image.metadata.loadConfig.guardCFFunctionMetadata, []);
  assert.equal(image.functions.filter((f) => f.source === 'guard-cf').length, 0);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('load-config:guardcf-order'));
});

test('an inversion in the middle invalidates the whole GFIDS authority (#8058)', () => {
  const image = fixture([
    { rva: 0x2010 },
    { rva: 0x2040 },
    { rva: 0x2030 },
  ]);
  assert.deepEqual(image.metadata.loadConfig.guardCFFunctions, []);
  assert.equal(image.functions.filter((f) => f.source === 'guard-cf').length, 0);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('load-config:guardcf-order'));
});

test('GFIDS ordering uses RVA while preserving metadata stride and suppression (#8058)', () => {
  const image = fixture([
    { rva: 0x2020, flags: 0x01 },
    { rva: 0x2030, flags: 0x02 },
  ], { extra: 1 });
  assert.deepEqual(image.metadata.loadConfig.suppressedGuardCFFunctions, [IMAGE_BASE + 0x2020n]);
  assert.deepEqual(image.metadata.loadConfig.exportSuppressedGuardCFFunctions, [IMAGE_BASE + 0x2030n]);
  assert.deepEqual(image.metadata.loadConfig.guardCFFunctions, [IMAGE_BASE + 0x2030n]);
  assert.equal(image.metadata.peMetadata.complete, true);
});

test('suppression metadata and extended stride cannot bypass GFIDS ordering (#8058)', () => {
  const image = fixture([
    { rva: 0x2040, flags: 0x01 },
    { rva: 0x2030, flags: 0x00 },
  ], { extra: 2 });
  assert.deepEqual(image.metadata.loadConfig.guardCFFunctions, []);
  assert.deepEqual(image.metadata.loadConfig.guardCFFunctionMetadata, []);
  assert.deepEqual(image.metadata.loadConfig.suppressedGuardCFFunctions, []);
  assert.equal(image.functions.filter((f) => f.source === 'guard-cf').length, 0);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('load-config:guardcf-order'));
});
