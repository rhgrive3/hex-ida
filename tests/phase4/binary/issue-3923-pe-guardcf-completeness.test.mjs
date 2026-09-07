import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLoadConfig } from '../../../js/binary/pe-loader.js';

const IMAGE_BASE = 0x140000000n;
const LOAD_CONFIG_RVA = 0x1000;
const GUARD_CF_TABLE_RVA = 0x1100;
const VALID_TARGET_RVA = 0x2020;
const ZERO_FILL_TARGET_RVA = 0x2080;
const NON_EXEC_TARGET_RVA = 0x3000;

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.length = bytes.length;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u32(off) {
    return this.view.getUint32(off, true);
  }

  u64(off) {
    return this.view.getBigUint64(off, true);
  }
}

function fixture(targets, { count = targets.length } = {}) {
  const bytes = new Uint8Array(0x300);
  const view = new DataView(bytes.buffer);

  // PE32+ load config through GuardFlags.
  view.setUint32(0, 148, true);
  view.setBigUint64(128, IMAGE_BASE + BigInt(GUARD_CF_TABLE_RVA), true);
  view.setBigUint64(136, BigInt(count), true);
  view.setUint32(144, 0, true);

  targets.forEach((rva, index) => {
    view.setUint32(0x100 + index * 4, rva, true);
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
    {
      name: '.data',
      address: IMAGE_BASE + 0x3000n,
      size: 0x100n,
      fileOffset: 0x240n,
      fileSize: 0x40n,
      perms: { read: true, write: true, execute: false },
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

  parseLoadConfig(
    new Reader(bytes),
    { rva: LOAD_CONFIG_RVA, size: 148 },
    image,
  );
  return image;
}

test('PE GuardCF keeps executable file-backed targets authoritative (#3923)', () => {
  const image = fixture([VALID_TARGET_RVA]);

  assert.deepEqual(
    image.metadata.loadConfig.guardCFFunctions,
    [IMAGE_BASE + BigInt(VALID_TARGET_RVA)],
  );
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].address, IMAGE_BASE + BigInt(VALID_TARGET_RVA));
  assert.equal(image.metadata.peMetadata.complete, true);
  assert.deepEqual(image.metadata.peMetadata.reasons, []);
});

test('PE GuardCF marks non-executable targets partial (#3923)', () => {
  const image = fixture([NON_EXEC_TARGET_RVA]);

  assert.deepEqual(image.metadata.loadConfig.guardCFFunctions, []);
  assert.equal(image.functions.length, 0);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(
    image.metadata.peMetadata.reasons.includes(
      'load-config:guardcf-target-non-executable',
    ),
  );
});

test('PE GuardCF marks executable zero-fill targets partial (#3923)', () => {
  const image = fixture([ZERO_FILL_TARGET_RVA]);

  assert.deepEqual(image.metadata.loadConfig.guardCFFunctions, []);
  assert.equal(image.functions.length, 0);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(
    image.metadata.peMetadata.reasons.includes(
      'load-config:guardcf-target-not-file-backed',
    ),
  );
});

test('PE GuardCF preserves valid targets while rejecting later invalid evidence (#3923)', () => {
  const image = fixture([VALID_TARGET_RVA, NON_EXEC_TARGET_RVA]);

  assert.deepEqual(
    image.metadata.loadConfig.guardCFFunctions,
    [IMAGE_BASE + BigInt(VALID_TARGET_RVA)],
  );
  assert.equal(image.functions.length, 1);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(
    image.metadata.peMetadata.reasons.includes(
      'load-config:guardcf-target-non-executable',
    ),
  );
});

test('PE GuardCF retains the existing count-vs-mapped-capacity partial contract (#3923)', () => {
  const image = fixture([], { count: 65 });

  assert.deepEqual(image.metadata.loadConfig.guardCFFunctions, []);
  assert.equal(image.functions.length, 0);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(
    image.metadata.peMetadata.reasons.includes('load-config:guardcf-count-span'),
  );
});
