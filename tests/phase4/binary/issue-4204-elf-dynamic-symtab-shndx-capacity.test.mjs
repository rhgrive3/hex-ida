import test from 'node:test';
import assert from 'node:assert/strict';
import { dynamicSymbolFileCapacity, parseProgramDynamic } from '../../../js/binary/elf-dynamic.js';

const BASE = 0x400000n;
const DYNAMIC_OFFSET = 0x20;
const SYMTAB_OFFSET = 0x100;
const SHNDX_OFFSET = 0x118;
const STRTAB_OFFSET = 0x130;
const HASH_OFFSET = 0x180;
const FILE_SIZE = 0x240;

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

function makeImage(segments = null) {
  const segment = {
    address: BASE,
    size: BigInt(FILE_SIZE),
    fileOffset: 0n,
    fileSize: BigInt(FILE_SIZE),
    perms: { read: true, write: true, execute: false },
  };
  return {
    warnings: [],
    libraries: [],
    metadata: { machine: 62 },
    segments: segments || [segment],
    sections: [],
    symbols: [],
    imports: [],
    exports: [],
    functions: [],
    relocations: [],
    addressToOffset(address) {
      const value = BigInt(address);
      for (const owner of this.segments) {
        const delta = value - BigInt(owner.address);
        if (delta >= 0n && delta < BigInt(owner.fileSize)) return BigInt(owner.fileOffset) + delta;
      }
      return null;
    },
    sectionAt() { return null; },
    segmentAt(address) {
      const value = BigInt(address);
      return this.segments.find((owner) => value >= BigInt(owner.address) && value < BigInt(owner.address) + BigInt(owner.size)) || null;
    },
  };
}

function buildFixture({ exactHashCount = null } = {}) {
  const bytes = new Uint8Array(FILE_SIZE);
  const view = new DataView(bytes.buffer);
  const symtabVa = BASE + BigInt(SYMTAB_OFFSET);
  const shndxVa = BASE + BigInt(SHNDX_OFFSET);
  const strtabVa = BASE + BigInt(STRTAB_OFFSET);
  let dynamicIndex = 0;
  putDynamic(view, dynamicIndex++, 5, strtabVa);       // DT_STRTAB
  putDynamic(view, dynamicIndex++, 10, 6);             // DT_STRSZ: "\0fake\0"
  putDynamic(view, dynamicIndex++, 6, symtabVa);       // DT_SYMTAB
  putDynamic(view, dynamicIndex++, 11, 24);            // DT_SYMENT
  putDynamic(view, dynamicIndex++, 34, shndxVa);       // DT_SYMTAB_SHNDX
  if (exactHashCount != null) {
    putDynamic(view, dynamicIndex++, 4, BASE + BigInt(HASH_OFFSET)); // DT_HASH
    view.setUint32(HASH_OFFSET, 1, true);              // nbucket
    view.setUint32(HASH_OFFSET + 4, exactHashCount, true); // nchain
    view.setUint32(HASH_OFFSET + 8, 0, true);
    for (let i = 0; i < exactHashCount; i++) view.setUint32(HASH_OFFSET + 12 + i * 4, 0, true);
  }
  putDynamic(view, dynamicIndex++, 0, 0);              // DT_NULL

  // First real dynsym record is the canonical null symbol at SYMTAB_OFFSET.
  // The companion table begins exactly where a second Elf64_Sym would begin.
  // If capacity ignores DT_SYMTAB_SHNDX, these companion bytes are decoded as
  // a fabricated undefined global symbol named "fake".
  view.setUint32(SHNDX_OFFSET, 1, true);               // fake st_name / companion[0]
  view.setUint8(SHNDX_OFFSET + 4, 0x11);               // STB_GLOBAL | STT_OBJECT
  view.setUint8(SHNDX_OFFSET + 5, 0);
  view.setUint16(SHNDX_OFFSET + 6, 0, true);           // SHN_UNDEF
  view.setBigUint64(SHNDX_OFFSET + 8, 0n, true);
  view.setBigUint64(SHNDX_OFFSET + 16, 0n, true);
  bytes.set(Uint8Array.from([0, 0x66, 0x61, 0x6b, 0x65, 0]), STRTAB_OFFSET);

  return { bytes, dynamicEntries: dynamicIndex };
}

test('#4204 DT_SYMTAB_SHNDX is a same-segment dynsym capacity boundary', () => {
  const image = makeImage();
  const tags = new Map([
    [5n, [BASE + BigInt(STRTAB_OFFSET)]],
    [34n, [BASE + BigInt(SHNDX_OFFSET)]],
  ]);
  const capacity = dynamicSymbolFileCapacity({ length: FILE_SIZE }, image, tags, BASE + BigInt(SYMTAB_OFFSET), 24n);
  assert.equal(capacity, 1);
});

test('#4204 PT_DYNAMIC does not reinterpret DT_SYMTAB_SHNDX companion bytes as a second dynsym', () => {
  const { bytes, dynamicEntries } = buildFixture();
  const image = makeImage();
  const result = parseProgramDynamic(
    reader(bytes),
    [{ type: 2, offset: BigInt(DYNAMIC_OFFSET), filesz: BigInt(dynamicEntries * 16) }],
    image,
    64,
  );
  assert.equal(result.parsed, true);
  assert.equal(image.metadata.programDynamic.symbolsDeclared, 2, 'layout heuristic still observes two 24-byte slots before STRTAB');
  assert.equal(image.metadata.programDynamic.symbolFileCapacity, 1, 'companion table clamps physical dynsym capacity');
  assert.equal(image.metadata.programDynamic.symbolsExpected, 1);
  assert.equal(image.imports.some((entry) => entry.name === 'fake'), false, 'companion bytes must not become a fabricated import');
  assert.equal(image.metadata.programDynamicPartial, true, 'layout/capacity disagreement stays explicit and fail-closed');
});

test('#4204 exact hash count remains authoritative while capacity stays bounded by the companion table', () => {
  const { bytes, dynamicEntries } = buildFixture({ exactHashCount: 1 });
  const image = makeImage();
  parseProgramDynamic(
    reader(bytes),
    [{ type: 2, offset: BigInt(DYNAMIC_OFFSET), filesz: BigInt(dynamicEntries * 16) }],
    image,
    64,
  );
  assert.equal(image.metadata.programDynamic.symbolsDeclared, 1);
  assert.equal(image.metadata.programDynamic.symbolCountSource, 'sysv-hash');
  assert.equal(image.metadata.programDynamic.symbolFileCapacity, 1);
  assert.equal(image.metadata.programDynamic.symbolsExpected, 1);
});

test('#4204 only a later DT_SYMTAB_SHNDX in the same mapped segment constrains capacity', () => {
  const symtabVa = BASE + BigInt(SYMTAB_OFFSET);
  const strtabVa = BASE + BigInt(STRTAB_OFFSET);
  const image = makeImage();
  const baseline = dynamicSymbolFileCapacity(
    { length: FILE_SIZE }, image,
    new Map([[5n, [strtabVa]]]), symtabVa, 24n,
  );
  assert.equal(baseline, 2);

  const before = dynamicSymbolFileCapacity(
    { length: FILE_SIZE }, image,
    new Map([[5n, [strtabVa]], [34n, [BASE + 0x80n]]]), symtabVa, 24n,
  );
  assert.equal(before, 2, 'a companion before SYMTAB cannot create negative/short capacity');

  const otherSegment = {
    address: BASE + 0x1000n,
    size: 0x100n,
    fileOffset: BigInt(FILE_SIZE),
    fileSize: 0x100n,
    perms: { read: true, write: false, execute: false },
  };
  const splitImage = makeImage([image.segments[0], otherSegment]);
  const elsewhere = dynamicSymbolFileCapacity(
    { length: FILE_SIZE + 0x100 }, splitImage,
    new Map([[5n, [strtabVa]], [34n, [BASE + 0x1018n]]]), symtabVa, 24n,
  );
  assert.equal(elsewhere, 2, 'a companion in another PT_LOAD is not a contiguous SYMTAB boundary');
});
