/**
 * #5520 — a nonzero GNU hash bucket below symoffset is a structural violation.
 *
 * GNU hash buckets hold either 0 (empty) or the first dynamic-symbol index of
 * a chain, where chain indexing is `bucket - symoffset`. A nonzero bucket
 * below symoffset cannot address any chain and was silently skipped, letting
 * sibling buckets launder a malformed table into exact symbol-count evidence.
 * Empty buckets and `bucket === symoffset` stay valid.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProgramDynamic } from '../../../js/binary/elf-dynamic.js';

const BASE = 0x400000n;
const SYMTAB_OFFSET = 0x200;
const STRTAB_OFFSET = 0x300;
const GNU_HASH_OFFSET = 0x400;
const DT_GNU_HASH = 0x6ffffef5;

function reader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    length: bytes.length,
    u8: (off) => view.getUint8(off),
    u16: (off) => view.getUint16(off, true),
    u32: (off) => view.getUint32(off, true),
    i32: (off) => view.getInt32(off, true),
    u64: (off) => view.getBigUint64(off, true),
    i64: (off) => view.getBigInt64(off, true),
    slice: (off, size) => bytes.slice(off, off + size),
    cstring(off, maxLength) {
      const end = Math.min(bytes.length, off + maxLength);
      let stop = off;
      while (stop < end && bytes[stop] !== 0) stop++;
      return new TextDecoder().decode(bytes.subarray(off, stop));
    },
  };
}

function fixture({ symOffset = 1, buckets = [0], chains = [] } = {}) {
  const bytes = new Uint8Array(0x700);
  const view = new DataView(bytes.buffer);
  const strtab = Uint8Array.from([0, ...new TextEncoder().encode('fake'), 0]);

  const putDynamic = (index, tag, value) => {
    const off = index * 16;
    view.setBigInt64(off, BigInt(tag), true);
    view.setBigUint64(off + 8, BigInt(value), true);
  };
  putDynamic(0, 5, BASE + BigInt(STRTAB_OFFSET)); // DT_STRTAB
  putDynamic(1, 10, strtab.length);               // DT_STRSZ
  putDynamic(2, 6, BASE + BigInt(SYMTAB_OFFSET)); // DT_SYMTAB
  putDynamic(3, 11, 24);                          // DT_SYMENT
  putDynamic(4, DT_GNU_HASH, BASE + BigInt(GNU_HASH_OFFSET));
  putDynamic(5, 0, 0);                            // DT_NULL
  bytes.set(strtab, STRTAB_OFFSET);

  const fake = SYMTAB_OFFSET + symOffset * 24;
  view.setUint32(fake, 1, true);       // st_name -> "fake"
  view.setUint8(fake + 4, 0x11);       // STB_GLOBAL | STT_OBJECT
  view.setUint16(fake + 6, 0, true);   // SHN_UNDEF

  view.setUint32(GNU_HASH_OFFSET, buckets.length, true); // nbuckets
  view.setUint32(GNU_HASH_OFFSET + 4, symOffset, true);
  view.setUint32(GNU_HASH_OFFSET + 8, 1, true);          // bloom_size
  view.setUint32(GNU_HASH_OFFSET + 12, 0, true);         // bloom_shift
  view.setBigUint64(GNU_HASH_OFFSET + 16, 0n, true);
  const bucketsOffset = GNU_HASH_OFFSET + 24;
  buckets.forEach((b, i) => view.setUint32(bucketsOffset + i * 4, b, true));
  const chainsOffset = bucketsOffset + buckets.length * 4;
  chains.forEach((c, i) => view.setUint32(chainsOffset + i * 4, c, true));

  const segment = {
    address: BASE, size: 0x700n, fileOffset: 0n, fileSize: 0x700n,
    perms: { read: true, write: true, execute: false },
  };
  const image = {
    warnings: [], libraries: [], metadata: { machine: 62 }, segments: [segment], sections: [],
    symbols: [], imports: [], exports: [], functions: [], relocations: [],
    addressToOffset(address) {
      const d = BigInt(address) - BASE;
      return d >= 0n && d < 0x700n ? Number(d) : null;
    },
    sectionAt() { return null; },
    segmentAt(address) {
      return address >= BASE && address < BASE + 0x700n ? segment : null;
    },
  };
  const result = parseProgramDynamic(
    reader(bytes),
    [{ type: 2, offset: 0n, filesz: 6n * 16n }],
    image,
    64,
  );
  assert.equal(result.parsed, true);
  return image;
}

function fixture32({ symOffset = 1, buckets = [0], chains = [] } = {}) {
  const bytes = new Uint8Array(0x700);
  const view = new DataView(bytes.buffer);
  const strtab = Uint8Array.from([0, ...new TextEncoder().encode('fake'), 0]);

  const putDynamic = (index, tag, value) => {
    const off = index * 8;
    view.setInt32(off, Number(tag), true);
    view.setUint32(off + 4, Number(value), true);
  };
  putDynamic(0, 5, BASE + BigInt(STRTAB_OFFSET)); // DT_STRTAB
  putDynamic(1, 10, strtab.length);               // DT_STRSZ
  putDynamic(2, 6, BASE + BigInt(SYMTAB_OFFSET)); // DT_SYMTAB
  putDynamic(3, 11, 16);                          // DT_SYMENT
  putDynamic(4, DT_GNU_HASH, BASE + BigInt(GNU_HASH_OFFSET));
  putDynamic(5, 0, 0);                            // DT_NULL
  bytes.set(strtab, STRTAB_OFFSET);

  const fake = SYMTAB_OFFSET + symOffset * 16;
  view.setUint32(fake, 1, true);       // st_name -> "fake"
  view.setUint32(fake + 4, 0, true);   // st_value
  view.setUint32(fake + 8, 0, true);   // st_size
  view.setUint8(fake + 12, 0x11);      // STB_GLOBAL | STT_OBJECT
  view.setUint8(fake + 13, 0);         // st_other
  view.setUint16(fake + 14, 0, true);  // SHN_UNDEF

  view.setUint32(GNU_HASH_OFFSET, buckets.length, true); // nbuckets
  view.setUint32(GNU_HASH_OFFSET + 4, symOffset, true);
  view.setUint32(GNU_HASH_OFFSET + 8, 1, true);          // bloom_size
  view.setUint32(GNU_HASH_OFFSET + 12, 0, true);         // bloom_shift
  view.setUint32(GNU_HASH_OFFSET + 16, 0, true);         // 32-bit bloom word
  const bucketsOffset = GNU_HASH_OFFSET + 20;
  buckets.forEach((b, i) => view.setUint32(bucketsOffset + i * 4, b, true));
  const chainsOffset = bucketsOffset + buckets.length * 4;
  chains.forEach((c, i) => view.setUint32(chainsOffset + i * 4, c, true));

  const segment = {
    address: BASE, size: 0x700n, fileOffset: 0n, fileSize: 0x700n,
    perms: { read: true, write: true, execute: false },
  };
  const image = {
    warnings: [], libraries: [], metadata: { machine: 3 }, segments: [segment], sections: [],
    symbols: [], imports: [], exports: [], functions: [], relocations: [],
    addressToOffset(address) {
      const d = BigInt(address) - BASE;
      return d >= 0n && d < 0x700n ? Number(d) : null;
    },
    sectionAt() { return null; },
    segmentAt(address) {
      return address >= BASE && address < BASE + 0x700n ? segment : null;
    },
  };
  const result = parseProgramDynamic(
    reader(bytes),
    [{ type: 2, offset: 0n, filesz: 6n * 8n }],
    image,
    32,
  );
  assert.equal(result.parsed, true);
  return image;
}

test('#5520: bucket=0 stays a valid empty bucket', () => {
  const image = fixture({ symOffset: 1, buckets: [0] });
  assert.equal(image.metadata.programDynamic.symbolCountSource, 'gnu-hash');
  assert.equal(image.metadata.programDynamic.symbolsDeclared, 1);
  assert.equal(image.metadata.programDynamicPartial ?? false, false);
});

test('#5520: bucket=symoffset stays a valid chain head', () => {
  const image = fixture({ symOffset: 1, buckets: [1], chains: [1] });
  assert.equal(image.metadata.programDynamic.symbolCountSource, 'gnu-hash');
  assert.equal(image.metadata.programDynamic.symbolsDeclared, 2);
});

test('#5520: 0 < bucket < symoffset is partial and loses exact evidence', () => {
  const image = fixture({ symOffset: 2, buckets: [1], chains: [] });
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics.some((d) => d.includes('points below symoffset')));
  assert.equal(image.metadata.programDynamic.symbolCountSource, 'none');
  assert.equal(image.metadata.programDynamic.symbolsDeclared, 0);
  assert.equal(image.imports.some((imp) => imp.name === 'fake'), false);
});

test('#5520: a valid sibling bucket cannot launder a malformed bucket into exact evidence', () => {
  const image = fixture({ symOffset: 2, buckets: [1, 2], chains: [1] });
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics.some((d) => d.includes('points below symoffset')));
  assert.equal(image.metadata.programDynamic.symbolCountSource, 'none');
  assert.equal(image.imports.some((imp) => imp.name === 'fake'), false);
});

test('#5520: ELF32 also rejects 0 < bucket < symoffset as exact evidence', () => {
  const image = fixture32({ symOffset: 2, buckets: [1], chains: [] });
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics.some((d) => d.includes('points below symoffset')));
  assert.equal(image.metadata.programDynamic.symbolCountSource, 'none');
  assert.equal(image.metadata.programDynamic.symbolsDeclared, 0);
  assert.equal(image.imports.some((imp) => imp.name === 'fake'), false);
});

test('#5520: ELF32 valid sibling bucket cannot launder a malformed bucket', () => {
  const image = fixture32({ symOffset: 2, buckets: [1, 2], chains: [1] });
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics.some((d) => d.includes('points below symoffset')));
  assert.equal(image.metadata.programDynamic.symbolCountSource, 'none');
  assert.equal(image.imports.some((imp) => imp.name === 'fake'), false);
});
