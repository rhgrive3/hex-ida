import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTlsDirectory } from '../../../js/binary/pe-loader.js';

const IMAGE_BASE = 0x140000000n;
const TLS_RVA = 0x1000;
const CALLBACK_TABLE_RVA = 0x1100;
const VALID_CALLBACK = IMAGE_BASE + 0x2020n;
const ZERO_FILL_CALLBACK = IMAGE_BASE + 0x2080n;
const NON_EXEC_CALLBACK = IMAGE_BASE + 0x3000n;

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

function fixture(callbacks) {
  const bytes = new Uint8Array(0x300);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(24, IMAGE_BASE + BigInt(CALLBACK_TABLE_RVA), true);
  callbacks.forEach((address, index) => {
    view.setBigUint64(0x100 + index * 8, address, true);
  });
  view.setBigUint64(0x100 + callbacks.length * 8, 0n, true);

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
      size: 0x200n,
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

  parseTlsDirectory(
    new Reader(bytes),
    { rva: TLS_RVA, size: 40 },
    image,
  );
  return image;
}

test('PE TLS keeps executable file-backed callbacks authoritative (#3916)', () => {
  const image = fixture([VALID_CALLBACK]);

  assert.deepEqual(image.metadata.tls.callbacks, [VALID_CALLBACK]);
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].address, VALID_CALLBACK);
  assert.equal(image.metadata.peMetadata.complete, true);
  assert.deepEqual(image.metadata.peMetadata.reasons, []);
});

test('PE TLS marks non-executable callback targets partial (#3916)', () => {
  const image = fixture([NON_EXEC_CALLBACK]);

  assert.deepEqual(image.metadata.tls.callbacks, []);
  assert.equal(image.functions.length, 0);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('tls:callback-target-non-executable'));
});

test('PE TLS marks executable zero-fill callbacks partial (#3916)', () => {
  const image = fixture([ZERO_FILL_CALLBACK]);

  assert.deepEqual(image.metadata.tls.callbacks, []);
  assert.equal(image.functions.length, 0);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('tls:callback-target-not-file-backed'));
});

test('PE TLS preserves valid callbacks while rejecting later invalid evidence (#3916)', () => {
  const image = fixture([VALID_CALLBACK, NON_EXEC_CALLBACK]);

  assert.deepEqual(image.metadata.tls.callbacks, [VALID_CALLBACK]);
  assert.equal(image.functions.length, 1);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('tls:callback-target-non-executable'));
  assert.ok(!image.metadata.peMetadata.reasons.includes('tls:unterminated-callback-table'));
});
