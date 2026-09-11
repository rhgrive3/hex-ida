import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDelayImports } from '../../../js/binary/pe-loader.js';

const IMAGE_BASE = 0x400000n;
const DIRECTORY_RVA = 0x1000;
const LIBRARY_RVA = 0x1080;
const THUNK_RVA = 0x10a0;
const IAT_RVA = 0x10c0;
const NAME_RVA = 0x10e0;

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.length = bytes.length;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u16(offset) { return this.view.getUint16(offset, true); }
  u32(offset) { return this.view.getUint32(offset, true); }
  u64(offset) { return this.view.getBigUint64(offset, true); }
  slice(start, length) { return this.bytes.slice(start, start + length); }
  cstring(start, max) {
    const end = Math.min(this.length, start + max);
    let cursor = start;
    while (cursor < end && this.bytes[cursor] !== 0) cursor++;
    return String.fromCharCode(...this.bytes.subarray(start, cursor));
  }
}

function writeU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value >>> 0, true);
}

function writePointer(bytes, bits, offset, value) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bits === 64) view.setBigUint64(offset, BigInt(value), true);
  else view.setUint32(offset, Number(BigInt(value) & 0xffffffffn), true);
}

function fixture({
  bits = 32,
  attrs = 1,
  hmodRva = 0x2000,
  hmodSize = null,
  hmodFileSize = 0,
  hmodWritable = true,
} = {}) {
  const bytes = new Uint8Array(0x300);
  const ptrSize = bits === 64 ? 8 : 4;
  const asField = (rva) => attrs & 1 ? rva : Number(IMAGE_BASE) + rva;

  writeU32(bytes, 0, attrs);
  writeU32(bytes, 4, asField(LIBRARY_RVA));
  writeU32(bytes, 8, hmodRva ? asField(hmodRva) : 0);
  writeU32(bytes, 12, asField(IAT_RVA));
  writeU32(bytes, 16, asField(THUNK_RVA));
  bytes.set(Buffer.from('delay.dll\0', 'ascii'), LIBRARY_RVA - DIRECTORY_RVA);
  writePointer(bytes, bits, THUNK_RVA - DIRECTORY_RVA, BigInt(asField(NAME_RVA)));
  writePointer(bytes, bits, THUNK_RVA - DIRECTORY_RVA + ptrSize, 0n);
  writePointer(bytes, bits, IAT_RVA - DIRECTORY_RVA, 0n);
  writePointer(bytes, bits, IAT_RVA - DIRECTORY_RVA + ptrSize, 0n);
  writeU32(bytes, NAME_RVA - DIRECTORY_RVA, 7);
  bytes.set(Buffer.from('DelayedApi\0', 'ascii'), NAME_RVA - DIRECTORY_RVA + 2);

  const storageSize = hmodSize ?? ptrSize;
  const sections = [{
    name: '.rdata',
    address: IMAGE_BASE + BigInt(DIRECTORY_RVA),
    size: BigInt(bytes.length),
    fileOffset: 0n,
    fileSize: BigInt(bytes.length),
    perms: { read: true, write: false, execute: false },
  }];
  if (hmodRva) {
    sections.push({
      name: '.data',
      address: IMAGE_BASE + BigInt(hmodRva),
      size: BigInt(storageSize),
      fileOffset: BigInt(bytes.length),
      fileSize: BigInt(hmodFileSize),
      perms: { read: true, write: hmodWritable, execute: false },
    });
  }
  const image = {
    bits,
    imageBase: IMAGE_BASE,
    sections,
    segments: [],
    metadata: {},
    warnings: [],
    libraries: [],
    imports: [],
    functions: [],
  };

  parseDelayImports(new Reader(bytes), { rva: DIRECTORY_RVA, size: 64 }, image);
  return image;
}

function assertAccepted(image) {
  assert.equal(image.metadata.peMetadata.complete, true);
  assert.deepEqual(image.metadata.peMetadata.reasons, []);
  assert.deepEqual(image.libraries, ['delay.dll']);
  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].name, 'DelayedApi');
  assert.equal(image.imports[0].source, 'PE-delay-import');
}

function assertRejected(image, reason = 'delay-imports:module-handle-span') {
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes(reason));
  assert.deepEqual(image.libraries, []);
  assert.deepEqual(image.imports, []);
}

test('mapped PE32 rvaHmod storage remains canonical (#8100)', () => {
  assertAccepted(fixture({ bits: 32, hmodSize: 4, hmodFileSize: 4 }));
});

test('unmapped rvaHmod is fail-closed before publishing delay imports (#8100)', () => {
  assertRejected(fixture({ hmodRva: 0xf000, hmodSize: 0 }));
});

test('zero rvaHmod on a nonzero descriptor is fail-closed (#8100)', () => {
  assertRejected(fixture({ hmodRva: 0 }));
});

test('PE32 module-handle storage may be zero-fill when its 4-byte span is mapped (#8100)', () => {
  assertAccepted(fixture({ bits: 32, hmodSize: 4, hmodFileSize: 0 }));
});

test('PE32+ module-handle storage may be zero-fill when its 8-byte span is mapped (#8100)', () => {
  assertAccepted(fixture({ bits: 64, hmodSize: 8, hmodFileSize: 0 }));
});

test('PE32+ rvaHmod whose 8-byte span crosses its mapping boundary is rejected (#8100)', () => {
  assertRejected(fixture({ bits: 64, hmodSize: 7, hmodFileSize: 0 }));
});

test('mapped read-only rvaHmod storage is rejected before publication (#8100)', () => {
  assertRejected(
    fixture({ bits: 32, hmodSize: 4, hmodFileSize: 0, hmodWritable: false }),
    'delay-imports:module-handle-non-writable',
  );
});

test('legacy VA-form rvaHmod uses the same mapped-span validation (#8100)', () => {
  assertAccepted(fixture({ bits: 32, attrs: 0, hmodSize: 4, hmodFileSize: 0 }));
  assertRejected(fixture({ bits: 32, attrs: 0, hmodRva: 0xf000, hmodSize: 0 }));
});
