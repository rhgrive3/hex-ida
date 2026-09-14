import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProgramDynamic } from '../../../js/binary/elf-dynamic.js';

// Issue #4168: symbolCountFromGnuHash() capped the GNU hash chain walk with the
// data-shape heuristic `min(10_000_000, max(4096, nbuckets * 64))`. GNU hash has
// no per-bucket 64-symbol or 4096-entry chain limit, so a single legal chain of
// 4097 entries (all symbols landing in one bucket) was cut off just before its
// terminating word and reported "GNU hash chain traversal exceeded the global
// budget", throwing away exact dynsym count evidence on a fully valid table.
//
// The hard DoS budget must stay, but it must be derived from the real data
// boundary (the file-backed chain span) rather than from the bucket count. The
// GNU-hash table is placed at the tail of a single file-backed PT_LOAD so that a
// terminator-less chain genuinely runs off the mapped end.

const BASE = 0x400000n;
const STRTAB_OFFSET = 0x40;
const DYNAMIC_OFFSET = 0x100;
const SYMTAB_OFFSET = 0x200;
const GNU_HASH_OFFSET = 0x24000;
const SEG_END = 0x2A000;
const DT_GNU_HASH = 0x6ffffef5;
const SYMENT = 24;

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
      const start = off, end = Math.min(bytes.length, off + maxLength);
      let stop = start;
      while (stop < end && bytes[stop] !== 0) stop++;
      return new TextDecoder().decode(bytes.subarray(start, stop));
    },
  };
}

function buildGnuHashImage({ buckets = [1], chainWords = 4097, terminate = true } = {}) {
  const bytes = new Uint8Array(SEG_END);
  const view = new DataView(bytes.buffer);
  const strtab = Uint8Array.from([0, ...new TextEncoder().encode('name'), 0]);
  bytes.set(strtab, STRTAB_OFFSET);

  const putDynamic = (index, tag, value) => {
    const off = DYNAMIC_OFFSET + index * 16;
    view.setBigInt64(off, BigInt(tag), true);
    view.setBigUint64(off + 8, BigInt(value), true);
  };
  putDynamic(0, 5, BASE + BigInt(STRTAB_OFFSET));  // DT_STRTAB
  putDynamic(1, 10, strtab.length);                // DT_STRSZ
  putDynamic(2, 6, BASE + BigInt(SYMTAB_OFFSET));  // DT_SYMTAB
  putDynamic(3, 11, SYMENT);                       // DT_SYMENT
  putDynamic(4, DT_GNU_HASH, BASE + BigInt(GNU_HASH_OFFSET));
  putDynamic(5, 0, 0);                             // DT_NULL

  view.setUint32(GNU_HASH_OFFSET, buckets.length, true); // nbuckets
  view.setUint32(GNU_HASH_OFFSET + 4, 1, true);          // symoffset
  view.setUint32(GNU_HASH_OFFSET + 8, 1, true);          // bloom_size
  view.setUint32(GNU_HASH_OFFSET + 12, 0, true);         // bloom_shift
  view.setBigUint64(GNU_HASH_OFFSET + 16, 0xffffffffffffffffn, true); // bloom[0]
  const bucketsOffset = GNU_HASH_OFFSET + 24;
  buckets.forEach((b, i) => view.setUint32(bucketsOffset + i * 4, b, true));
  const chainsOffset = bucketsOffset + buckets.length * 4;
  for (let i = 0; i < chainWords; i++) view.setUint32(chainsOffset + i * 4, 0, true);
  if (terminate && chainWords > 0) view.setUint32(chainsOffset + (chainWords - 1) * 4, 1, true);

  const segment = {
    address: BASE, size: BigInt(SEG_END), fileOffset: 0n, fileSize: BigInt(SEG_END),
    perms: { read: true, write: true, execute: false },
  };
  const image = {
    warnings: [], libraries: [], metadata: { machine: 62 }, segments: [segment], sections: [],
    symbols: [], imports: [], exports: [], functions: [], relocations: [],
    addressToOffset(address) { const d = BigInt(address) - BASE; return d >= 0n && d < BigInt(SEG_END) ? Number(d) : null; },
    sectionAt() { return null; },
    segmentAt(address) { const v = BigInt(address); return v >= BASE && v < BASE + BigInt(SEG_END) ? segment : null; },
  };
  parseProgramDynamic(
    reader(bytes),
    [{ type: 2, offset: BigInt(DYNAMIC_OFFSET), filesz: 6n * 16n }],
    image, 64, { symbols: false },
  );
  return image;
}

test('a single legal 4096-entry chain still yields exact count (regression guard)', () => {
  const image = buildGnuHashImage({ buckets: [1], chainWords: 4096 });
  assert.equal(image.metadata.programDynamicPartial, undefined);
  const pd = image.metadata.programDynamic;
  assert.equal(pd.symbolCountSource, 'gnu-hash');
  assert.equal(pd.symbolsDeclared, 4097);
});

test('a single legal 4097-entry chain is no longer false-rejected (#4168)', () => {
  const image = buildGnuHashImage({ buckets: [1], chainWords: 4097 });
  assert.equal((image.metadata.programDynamicDiagnostics || []).some((d) => /global budget/i.test(d)), false,
    'a valid chain must not be cut off by the bucket-count heuristic');
  assert.equal(image.metadata.programDynamicPartial, undefined);
  const pd = image.metadata.programDynamic;
  assert.equal(pd.symbolCountSource, 'gnu-hash');
  assert.equal(pd.symbolsDeclared, 4098);
});

test('an even longer legal chain within the file span and hard budget succeeds', () => {
  const image = buildGnuHashImage({ buckets: [1], chainWords: 6000 });
  assert.equal(image.metadata.programDynamicPartial, undefined);
  const pd = image.metadata.programDynamic;
  assert.equal(pd.symbolCountSource, 'gnu-hash');
  assert.equal(pd.symbolsDeclared, 6001);
});

test('a chain without a terminator stays fail-closed at the file boundary', () => {
  const image = buildGnuHashImage({ buckets: [1], chainWords: 4097, terminate: false });
  assert.notEqual(image.metadata.programDynamic.symbolCountSource, 'gnu-hash');
  assert.equal(image.metadata.programDynamicPartial, true);
});

test('empty buckets still prove exactly symoffset symbols (#3651 compatibility)', () => {
  const pd = buildGnuHashImage({ buckets: [0], chainWords: 0, terminate: false }).metadata.programDynamic;
  assert.equal(pd.symbolCountSource, 'gnu-hash');
  assert.equal(pd.symbolsDeclared, 1);
});
