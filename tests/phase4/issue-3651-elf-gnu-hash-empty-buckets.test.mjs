import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProgramDynamic } from '../../js/binary/elf-dynamic.js';

const BASE = 0x400000n;
const DYNAMIC_OFFSET = 0x100;
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

function putDynamic(view, index, tag, value) {
  const off = DYNAMIC_OFFSET + index * 16;
  view.setBigInt64(off, BigInt(tag), true);
  view.setBigUint64(off + 8, BigInt(value), true);
}

function fixture({ symOffset = 1, bucket = 0, chain = 1, buckets = [bucket], chains = [chain] } = {}) {
  const bytes = new Uint8Array(0x700);
  const view = new DataView(bytes.buffer);
  const strtab = Uint8Array.from([0, ...new TextEncoder().encode('fake'), 0]);

  putDynamic(view, 0, 5, BASE + BigInt(STRTAB_OFFSET)); // DT_STRTAB
  putDynamic(view, 1, 10, strtab.length);               // DT_STRSZ
  putDynamic(view, 2, 6, BASE + BigInt(SYMTAB_OFFSET)); // DT_SYMTAB
  putDynamic(view, 3, 11, 24);                          // DT_SYMENT
  putDynamic(view, 4, DT_GNU_HASH, BASE + BigInt(GNU_HASH_OFFSET));
  putDynamic(view, 5, 0, 0);                            // DT_NULL
  bytes.set(strtab, STRTAB_OFFSET);

  // Keep symbols [0, symOffset) blank. Plant a valid-looking undefined
  // global symbol immediately after the count GNU hash is allowed to prove.
  const fake = SYMTAB_OFFSET + symOffset * 24;
  view.setUint32(fake, 1, true);       // st_name -> "fake"
  view.setUint8(fake + 4, 0x11);       // STB_GLOBAL | STT_OBJECT
  view.setUint16(fake + 6, 0, true);   // SHN_UNDEF

  // GNU hash header: one bloom word, then bucket and chain tables.
  view.setUint32(GNU_HASH_OFFSET, buckets.length, true); // nbuckets
  view.setUint32(GNU_HASH_OFFSET + 4, symOffset, true);
  view.setUint32(GNU_HASH_OFFSET + 8, 1, true);          // bloom_size
  view.setUint32(GNU_HASH_OFFSET + 12, 0, true);         // bloom_shift
  view.setBigUint64(GNU_HASH_OFFSET + 16, 0n, true);
  const bucketsOffset = GNU_HASH_OFFSET + 24;
  for (let i = 0; i < buckets.length; i++) view.setUint32(bucketsOffset + i * 4, buckets[i], true);
  const chainsOffset = bucketsOffset + buckets.length * 4;
  for (let i = 0; i < chains.length; i++) view.setUint32(chainsOffset + i * 4, chains[i], true);

  const segment = {
    address: BASE,
    size: 0x700n,
    fileOffset: 0n,
    fileSize: 0x700n,
    perms: { read: true, write: true, execute: false },
  };
  const image = {
    warnings: [],
    libraries: [],
    metadata: { machine: 62 },
    segments: [segment],
    sections: [],
    symbols: [],
    imports: [],
    exports: [],
    functions: [],
    relocations: [],
    addressToOffset(address) {
      const delta = BigInt(address) - BASE;
      return delta >= 0n && delta < 0x700n ? Number(delta) : null;
    },
    sectionAt() { return null; },
    segmentAt(address) {
      const value = BigInt(address);
      return value >= BASE && value < BASE + 0x700n ? segment : null;
    },
  };

  const result = parseProgramDynamic(
    reader(bytes),
    [{ type: 2, offset: BigInt(DYNAMIC_OFFSET), filesz: 6n * 16n }],
    image,
    64,
  );
  assert.equal(result.parsed, true);
  return image;
}

test('empty GNU hash buckets prove exactly symOffset symbols', () => {
  for (const symOffset of [1, 3]) {
    const image = fixture({ symOffset, bucket: 0 });
    assert.equal(image.metadata.programDynamic.symbolCountSource, 'gnu-hash');
    assert.equal(image.metadata.programDynamic.symbolsDeclared, symOffset);
    assert.equal(image.metadata.programDynamic.symbolsExpected, symOffset);
    assert.equal(image.symbols.some((symbol) => symbol.name === 'fake'), false);
    assert.equal(image.imports.some((imp) => imp.name === 'fake'), false);
  }
});

test('non-empty GNU hash bucket still includes the observed hashed symbol', () => {
  const image = fixture({ symOffset: 1, bucket: 1, chain: 1 });
  assert.equal(image.metadata.programDynamic.symbolCountSource, 'gnu-hash');
  assert.equal(image.metadata.programDynamic.symbolsDeclared, 2);
  assert.equal(image.metadata.programDynamic.symbolsExpected, 2);
  assert.equal(image.symbols.some((symbol) => symbol.name === 'fake'), true);
  assert.equal(image.imports.some((imp) => imp.name === 'fake'), true);
});

test('multiple GNU hash buckets and chain entries use the greatest observed symbol index', () => {
  // bucket 1 walks symbols 1 -> 2; bucket 3 walks symbols 3 -> 4.
  // The exact GNU-hash count must therefore be max observed index 4 + 1.
  const image = fixture({
    symOffset: 1,
    buckets: [1, 3],
    chains: [0, 1, 0, 1],
  });
  assert.equal(image.metadata.programDynamic.symbolCountSource, 'gnu-hash');
  assert.equal(image.metadata.programDynamic.symbolsDeclared, 5);
  assert.equal(image.metadata.programDynamic.symbolsExpected, 5);
});
