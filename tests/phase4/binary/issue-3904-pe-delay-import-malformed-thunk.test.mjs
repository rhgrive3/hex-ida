import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDelayImports } from '../../../js/binary/pe-loader.js';

const IMAGE_BASE = 0x400000n;
const DIRECTORY_RVA = 0x1000;
const LIBRARY_OFFSET = 0x80;
const THUNK_OFFSET = 0xa0;
const IAT_OFFSET = 0xc0;
const NAME_OFFSET = 0xe0;

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

function writeThunk(bytes, bits, offset, value) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bits === 64) view.setBigUint64(offset, BigInt(value), true);
  else view.setUint32(offset, Number(BigInt(value) & 0xffffffffn), true);
}

function fixture({ bits = 32, attrs = 1, thunk = BigInt(rva(NAME_OFFSET)), thunks = null, unterminatedName = false } = {}) {
  const bytes = new Uint8Array(0x200);
  const ptrSize = bits === 64 ? 8 : 4;

  // One delay descriptor followed by an all-zero terminator. dlattrRva selects
  // whether its pointer fields (and named thunks) are RVAs or image VAs.
  const field = (offset) => attrs & 1 ? rva(offset) : Number(IMAGE_BASE) + rva(offset);
  writeU32(bytes, 0, attrs);
  writeU32(bytes, 4, field(LIBRARY_OFFSET));
  writeU32(bytes, 12, field(IAT_OFFSET));
  writeU32(bytes, 16, field(THUNK_OFFSET));
  bytes.set(Buffer.from('delay.dll\0', 'ascii'), LIBRARY_OFFSET);

  const thunkValues = thunks || [thunk];
  thunkValues.forEach((value, index) => {
    writeThunk(bytes, bits, THUNK_OFFSET + index * ptrSize, value);
    writeThunk(bytes, bits, IAT_OFFSET + index * ptrSize, 0n);
  });
  writeThunk(bytes, bits, THUNK_OFFSET + thunkValues.length * ptrSize, 0n);
  writeThunk(bytes, bits, IAT_OFFSET + thunkValues.length * ptrSize, 0n);

  if (unterminatedName) {
    const tailOffset = 0x1f8;
    writeU32(bytes, tailOffset, 0x41410000); // hint + first two non-NUL name bytes
    bytes.fill(0x41, tailOffset + 2);
  } else {
    writeU32(bytes, NAME_OFFSET, 7); // hint=7; name starts at +2.
    bytes.set(Buffer.from('DelayedApi\0', 'ascii'), NAME_OFFSET + 2);
  }

  const image = {
    bits,
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

  parseDelayImports(new Reader(bytes), { rva: DIRECTORY_RVA, size: 64 }, image);
  return image;
}

test('valid named delay-import thunk remains complete (#3904)', () => {
  const image = fixture();

  assert.equal(image.metadata.peMetadata.complete, true);
  assert.deepEqual(image.metadata.peMetadata.reasons, []);
  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].name, 'DelayedApi');
  assert.equal(image.imports[0].library, 'delay.dll');
  assert.equal(image.imports[0].source, 'PE-delay-import');
});

test('unmapped PE32 delay-import name RVA is fail-closed despite a following zero thunk (#3904)', () => {
  const image = fixture({ thunk: 0x5000n });

  assert.equal(image.imports.length, 0);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('delay-imports:malformed-thunk'));
  assert.ok(image.warnings.some((warning) => warning.includes('malformed PE delay-import thunk')));
  assert.ok(!image.metadata.peMetadata.reasons.includes('delay-imports:unterminated-thunk'));
});


test('valid delay-import evidence is preserved before a later malformed thunk (#3904)', () => {
  const image = fixture({ thunks: [BigInt(rva(NAME_OFFSET)), 0x5000n] });

  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].name, 'DelayedApi');
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('delay-imports:malformed-thunk'));
  assert.ok(!image.metadata.peMetadata.reasons.includes('delay-imports:unterminated-thunk'));
});

test('PE32+ delay-import name RVA above the 32-bit RVA domain is fail-closed (#3904)', () => {
  const image = fixture({ bits: 64, thunk: 0x100000000n });

  assert.equal(image.imports.length, 0);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('delay-imports:malformed-thunk'));
  assert.ok(image.warnings.some((warning) => warning.includes('malformed PE delay-import thunk')));
  assert.ok(!image.metadata.peMetadata.reasons.includes('delay-imports:unterminated-thunk'));
});


test('invalid VA-mode delay-import name pointer is fail-closed (#3904)', () => {
  const image = fixture({ attrs: 0, thunk: 0x1234n });

  assert.equal(image.imports.length, 0);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('delay-imports:malformed-thunk'));
  assert.ok(!image.metadata.peMetadata.reasons.includes('delay-imports:malformed-descriptor'));
});

test('valid ordinal delay-import thunk remains complete (#3904)', () => {
  const image = fixture({ thunk: 0x8000002an });

  assert.equal(image.metadata.peMetadata.complete, true);
  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].name, '#42');
  assert.equal(image.imports[0].ordinal, 42);
});

test('unterminated delay-import name remains partial and is classified as a malformed thunk (#3904)', () => {
  const image = fixture({ thunk: BigInt(rva(0x1f8)), unterminatedName: true });

  assert.equal(image.imports.length, 0);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('PE delay import name:unterminated-string'));
  assert.ok(image.metadata.peMetadata.reasons.includes('delay-imports:malformed-thunk'));
});
