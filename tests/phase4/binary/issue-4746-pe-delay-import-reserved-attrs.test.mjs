import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDelayImports } from '../../../js/binary/pe-loader.js';

const IMAGE_BASE = 0x400000n;
const DIRECTORY_RVA = 0x1000;
const DESCRIPTOR_SIZE = 32;
const HMOD_OFFSET = 0x60;
const LIBRARY_OFFSET = 0x100;
const THUNK_OFFSET = 0x140;
const IAT_OFFSET = 0x180;
const NAME_OFFSET = 0x1c0;

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

function rva(offset) {
  return DIRECTORY_RVA + offset;
}

function writeU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .setUint32(offset, value >>> 0, true);
}

function writeDescriptor(bytes, index, attrs, { libraryOffset = LIBRARY_OFFSET, thunkOffset = THUNK_OFFSET, iatOffset = IAT_OFFSET } = {}) {
  const off = index * DESCRIPTOR_SIZE;
  const field = (offset) => (attrs & 1) ? rva(offset) : Number(IMAGE_BASE) + rva(offset);
  writeU32(bytes, off, attrs);
  writeU32(bytes, off + 4, field(libraryOffset));
  writeU32(bytes, off + 8, field(HMOD_OFFSET));
  writeU32(bytes, off + 12, field(iatOffset));
  writeU32(bytes, off + 16, field(thunkOffset));
}

function makeFixture({ descriptors }) {
  const bytes = new Uint8Array(0x280);
  bytes.set(Buffer.from('delay.dll\0', 'ascii'), LIBRARY_OFFSET);
  const firstAttrs = descriptors[0] ?? 1;
  writeU32(bytes, THUNK_OFFSET, (firstAttrs & 1) ? rva(NAME_OFFSET) : Number(IMAGE_BASE) + rva(NAME_OFFSET));
  writeU32(bytes, THUNK_OFFSET + 4, 0);
  writeU32(bytes, IAT_OFFSET, 0);
  writeU32(bytes, IAT_OFFSET + 4, 0);
  writeU32(bytes, NAME_OFFSET, 7);
  bytes.set(Buffer.from('DelayedApi\0', 'ascii'), NAME_OFFSET + 2);

  descriptors.forEach((attrs, index) => writeDescriptor(bytes, index, attrs));
  // The Uint8Array is zero-filled, so the next 32-byte descriptor terminates the table.

  const image = {
    bits: 32,
    imageBase: IMAGE_BASE,
    sections: [{
      name: '.rdata',
      address: IMAGE_BASE + BigInt(DIRECTORY_RVA),
      size: BigInt(bytes.length),
      fileOffset: 0n,
      fileSize: BigInt(bytes.length),
      perms: { read: true, write: false, execute: false },
    }],
    segments: [],
    metadata: {},
    warnings: [],
    libraries: [],
    imports: [],
    functions: [],
  };

  parseDelayImports(
    new Reader(bytes),
    { rva: DIRECTORY_RVA, size: (descriptors.length + 1) * DESCRIPTOR_SIZE },
    image,
  );
  return image;
}

for (const attrs of [1, 0]) {
  test(`delay-import Attributes ${attrs} keeps the supported RVA/VA mode (#4746)`, () => {
    const image = makeFixture({ descriptors: [attrs] });

    assert.equal(image.metadata.peMetadata.complete, true);
    assert.deepEqual(image.metadata.peMetadata.reasons, []);
    assert.deepEqual(image.libraries, ['delay.dll']);
    assert.equal(image.imports.length, 1);
    assert.equal(image.imports[0].name, 'DelayedApi');
    assert.equal(image.imports[0].source, 'PE-delay-import');
  });
}

for (const attrs of [2, 3, 0x80000001]) {
  test(`delay-import reserved Attributes value 0x${attrs.toString(16)} is fail-closed (#4746)`, () => {
    const image = makeFixture({ descriptors: [attrs] });

    assert.equal(image.metadata.peMetadata.complete, false);
    assert.ok(image.metadata.peMetadata.reasons.includes('delay-imports:reserved-attributes'));
    assert.deepEqual(image.libraries, []);
    assert.deepEqual(image.imports, []);
  });
}

test('a reserved-Attributes descriptor does not suppress a later valid descriptor (#4746)', () => {
  const bytes = new Uint8Array(0x300);
  const secondLibraryOffset = 0x220;
  const secondThunkOffset = 0x240;
  const secondIatOffset = 0x260;
  const secondNameOffset = 0x280;

  // First descriptor is structurally invalid because reserved bit 1 is set.
  writeDescriptor(bytes, 0, 3);
  // Second descriptor is valid RVA-based and uses disjoint support data.
  writeDescriptor(bytes, 1, 1, {
    libraryOffset: secondLibraryOffset,
    thunkOffset: secondThunkOffset,
    iatOffset: secondIatOffset,
  });
  bytes.set(Buffer.from('second.dll\0', 'ascii'), secondLibraryOffset);
  writeU32(bytes, secondThunkOffset, rva(secondNameOffset));
  writeU32(bytes, secondThunkOffset + 4, 0);
  writeU32(bytes, secondIatOffset, 0);
  writeU32(bytes, secondIatOffset + 4, 0);
  writeU32(bytes, secondNameOffset, 9);
  bytes.set(Buffer.from('SecondApi\0', 'ascii'), secondNameOffset + 2);

  const image = {
    bits: 32,
    imageBase: IMAGE_BASE,
    sections: [{
      name: '.rdata',
      address: IMAGE_BASE + BigInt(DIRECTORY_RVA),
      size: BigInt(bytes.length),
      fileOffset: 0n,
      fileSize: BigInt(bytes.length),
      perms: { read: true, write: false, execute: false },
    }],
    segments: [],
    metadata: {},
    warnings: [],
    libraries: [],
    imports: [],
    functions: [],
  };

  parseDelayImports(new Reader(bytes), { rva: DIRECTORY_RVA, size: 3 * DESCRIPTOR_SIZE }, image);

  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('delay-imports:reserved-attributes'));
  assert.deepEqual(image.libraries, ['second.dll']);
  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].name, 'SecondApi');
  assert.equal(image.imports[0].library, 'second.dll');
});
