import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProgramDynamic } from '../../../js/binary/elf-dynamic.js';

const BASE = 0x400000n;
const DYNAMIC_OFFSET = 0x100;
const SYMTAB_OFFSET = 0x200;
const STRTAB_OFFSET = 0x300;
const DEFAULT_GNU_HASH_OFFSET = 0x400;
const DT_GNU_HASH = 0x6ffffef5;
const DT_SYMTABSZ = 39;

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

function fixture({
  bloomSize = 1,
  symOffset = 1,
  buckets = [1],
  chains = [1],
  withSymtabSize = false,
  gnuHashOffset = DEFAULT_GNU_HASH_OFFSET,
  segmentFileSize = 0x700,
} = {}) {
  const bytes = new Uint8Array(0x800);
  const view = new DataView(bytes.buffer);
  const strtab = Uint8Array.from([0, ...new TextEncoder().encode('fake'), 0]);
  let dynamicIndex = 0;
  const putDynamic = (tag, value) => {
    const off = DYNAMIC_OFFSET + dynamicIndex++ * 16;
    view.setBigInt64(off, BigInt(tag), true);
    view.setBigUint64(off + 8, BigInt(value), true);
  };

  putDynamic(5, BASE + BigInt(STRTAB_OFFSET));           // DT_STRTAB
  putDynamic(10, strtab.length);                         // DT_STRSZ
  putDynamic(6, BASE + BigInt(SYMTAB_OFFSET));           // DT_SYMTAB
  putDynamic(11, 24);                                    // DT_SYMENT
  putDynamic(DT_GNU_HASH, BASE + BigInt(gnuHashOffset));
  if (withSymtabSize) putDynamic(DT_SYMTABSZ, 48);       // two exact dynsym records
  putDynamic(0, 0);                                      // DT_NULL
  bytes.set(strtab, STRTAB_OFFSET);

  const fake = SYMTAB_OFFSET + 24;
  view.setUint32(fake, 1, true);       // st_name -> "fake"
  view.setUint8(fake + 4, 0x11);       // STB_GLOBAL | STT_OBJECT
  view.setUint16(fake + 6, 0, true);   // SHN_UNDEF

  view.setUint32(gnuHashOffset, buckets.length, true);
  view.setUint32(gnuHashOffset + 4, symOffset, true);
  view.setUint32(gnuHashOffset + 8, bloomSize, true);
  view.setUint32(gnuHashOffset + 12, 5, true);
  let cursor = gnuHashOffset + 16;
  for (let i = 0; i < bloomSize; i++, cursor += 8) view.setBigUint64(cursor, 0n, true);
  for (const bucket of buckets) { view.setUint32(cursor, bucket, true); cursor += 4; }
  for (const chain of chains) { view.setUint32(cursor, chain, true); cursor += 4; }

  const segment = {
    address: BASE,
    size: BigInt(segmentFileSize),
    fileOffset: 0n,
    fileSize: BigInt(segmentFileSize),
    perms: { read: true, write: true, execute: false },
  };
  const image = {
    warnings: [], libraries: [], metadata: { machine: 62 }, segments: [segment], sections: [],
    symbols: [], imports: [], exports: [], functions: [], relocations: [],
    addressToOffset(address) {
      const delta = BigInt(address) - BASE;
      return delta >= 0n && delta < BigInt(segmentFileSize) ? Number(delta) : null;
    },
    sectionAt() { return null; },
    segmentAt(address) {
      const value = BigInt(address);
      return value >= BASE && value < BASE + BigInt(segmentFileSize) ? segment : null;
    },
  };
  const result = parseProgramDynamic(
    reader(bytes),
    [{ type: 2, offset: BigInt(DYNAMIC_OFFSET), filesz: BigInt(dynamicIndex * 16) }],
    image,
    64,
  );
  assert.equal(result.parsed, true);
  return image;
}

function assertMalformedBloom(image, bloomSize) {
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics.some((d) =>
    d.includes(`DT_GNU_HASH bloom_size ${bloomSize} is not a non-zero power of two`)));
  assert.notEqual(image.metadata.programDynamic.symbolCountSource, 'gnu-hash');
}

test('#4218: valid power-of-two bloom sizes remain exact GNU hash evidence', () => {
  for (const bloomSize of [1, 2, 4]) {
    const image = fixture({ bloomSize });
    assert.equal(image.metadata.programDynamicPartial ?? false, false);
    assert.equal(image.metadata.programDynamic.symbolCountSource, 'gnu-hash');
    assert.equal(image.metadata.programDynamic.symbolsDeclared, 2);
  }
});

test('#4218: zero bloom size is malformed and cannot ground symbol-count evidence', () => {
  const image = fixture({ bloomSize: 0 });
  assertMalformedBloom(image, 0);
  assert.equal(image.metadata.programDynamic.symbolCountSource, 'none');
  assert.equal(image.metadata.programDynamic.symbolsDeclared, 0);
  assert.equal(image.imports.some((imp) => imp.name === 'fake'), false);
});

test('#4218: non-power-of-two bloom sizes are malformed and cannot ground exact evidence', () => {
  for (const bloomSize of [3, 5]) {
    const image = fixture({ bloomSize });
    assertMalformedBloom(image, bloomSize);
    assert.equal(image.metadata.programDynamic.symbolCountSource, 'none');
    assert.equal(image.metadata.programDynamic.symbolsDeclared, 0);
  }
});

test('#4218: malformed GNU hash stays partial when another exact count source exists', () => {
  const image = fixture({ bloomSize: 3, withSymtabSize: true });
  assertMalformedBloom(image, 3);
  assert.equal(image.metadata.programDynamic.symbolCountSource, 'dt-symtabsz');
  assert.equal(image.metadata.programDynamic.symbolsDeclared, 2);
});

test('#4218: valid empty buckets preserve #3651 exact symOffset semantics', () => {
  const image = fixture({ bloomSize: 4, symOffset: 3, buckets: [0], chains: [] });
  assert.equal(image.metadata.programDynamicPartial ?? false, false);
  assert.equal(image.metadata.programDynamic.symbolCountSource, 'gnu-hash');
  assert.equal(image.metadata.programDynamic.symbolsDeclared, 3);
});

test('#4218: bloom/bucket span crossing file-backed PT_LOAD remains fail-closed', () => {
  const image = fixture({ bloomSize: 4, gnuHashOffset: 0x6e0, segmentFileSize: 0x700 });
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics.some((d) =>
    d.includes('DT_GNU_HASH header/buckets cross a file-backed PT_LOAD boundary')));
  assert.notEqual(image.metadata.programDynamic.symbolCountSource, 'gnu-hash');
});
