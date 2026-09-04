import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProgramDynamic } from '../js/binary/elf-dynamic.js';

const BASE = 0x400000n;
const DYNAMIC_OFFSET = 0x100;
const SYMTAB_OFFSET = 0x200;
const STRTAB_OFFSET = 0x300;
const JMPREL_OFFSET = 0x400;
// R_RISCV_JUMP_SLOT / DT_RISCV_VARIANT_CC are RISC-V psABI constants.
const DT_VARIANT_CC = 0x70000001;

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

// options: { stOther, withTag, machine }
function fixture({ stOther = 0x80, withTag = false, machine = 243 } = {}) {
  const bytes = new Uint8Array(0x800);
  const view = new DataView(bytes.buffer);
  const strtabVa = BASE + BigInt(STRTAB_OFFSET);
  const symtabVa = BASE + BigInt(SYMTAB_OFFSET);
  const jmprelVa = BASE + BigInt(JMPREL_OFFSET);
  const stringBytes = Uint8Array.from([0, ...new TextEncoder().encode('vecfn'), 0]);

  let i = 0;
  putDynamic(view, i++, 5, strtabVa);   // DT_STRTAB
  putDynamic(view, i++, 10, stringBytes.length); // DT_STRSZ
  putDynamic(view, i++, 6, symtabVa);   // DT_SYMTAB
  putDynamic(view, i++, 11, 24);        // DT_SYMENT
  putDynamic(view, i++, 39, 48);        // DT_SYMTABSZ: two symbols
  putDynamic(view, i++, 23, jmprelVa);  // DT_JMPREL
  putDynamic(view, i++, 2, 24);         // DT_PLTRELSZ
  putDynamic(view, i++, 20, 7);         // DT_PLTREL = DT_RELA
  if (withTag) putDynamic(view, i++, DT_VARIANT_CC, 0);
  putDynamic(view, i++, 0, 0);          // DT_NULL
  const entries = i;

  bytes.set(stringBytes, STRTAB_OFFSET);

  view.setUint32(SYMTAB_OFFSET + 24, 1, true); // st_name -> 'vecfn'
  view.setUint8(SYMTAB_OFFSET + 28, 0x12);    // STB_GLOBAL | STT_FUNC
  view.setUint8(SYMTAB_OFFSET + 29, stOther);
  view.setUint16(SYMTAB_OFFSET + 30, 0, true); // SHN_UNDEF: import-like, no function-seed partial
  view.setBigUint64(SYMTAB_OFFSET + 32, BASE + 0x1000n, true);
  view.setBigUint64(SYMTAB_OFFSET + 40, 16n, true);

  // JMPREL: one R_RISCV_JUMP_SLOT (type 5) against symbol 1
  view.setBigUint64(JMPREL_OFFSET, BASE + 0x2000n, true);
  view.setBigUint64(JMPREL_OFFSET + 8, (1n << 32n) | 5n, true);
  view.setBigInt64(JMPREL_OFFSET + 16, 0n, true);

  const segment = {
    address: BASE, size: 0x800n, fileOffset: 0n, fileSize: 0x800n,
    perms: { read: true, write: true, execute: false },
  };
  const image = {
    warnings: [], libraries: [], metadata: { machine }, segments: [segment], sections: [],
    symbols: [], imports: [], exports: [], functions: [], relocations: [],
    addressToOffset(address) { const d = BigInt(address) - BASE; return d >= 0n && d < 0x800n ? Number(d) : null; },
    sectionAt() { return null; },
    segmentAt(address) { const v = BigInt(address); return v >= BASE && v < BASE + 0x800n ? segment : null; },
  };
  parseProgramDynamic(
    reader(bytes),
    [{ type: 2, offset: BigInt(DYNAMIC_OFFSET), filesz: BigInt(entries * 16) }],
    image,
    64,
  );
  return image;
}

function partialReasons(image) {
  return image.warnings.filter((w) => w.includes('DT_RISCV_VARIANT_CC'));
}

test('6071: variant-cc JUMP_SLOT with tag stays valid', () => {
  const image = fixture({ withTag: true });
  assert.equal(image.relocations.length, 1);
  assert.equal(partialReasons(image).length, 0);
  assert.equal(image.metadata.programDynamicPartial ?? false, false);
});

test('6071: variant-cc JUMP_SLOT without tag is partial, not complete', () => {
  const image = fixture({ withTag: false });
  assert.equal(image.relocations.length, 1);
  assert.ok(partialReasons(image).length > 0, 'expected a DT_RISCV_VARIANT_CC diagnostic');
  assert.equal(image.metadata.programDynamicPartial, true);
});

test('6071: ordinary JUMP_SLOT without tag stays valid', () => {
  const image = fixture({ stOther: 0, withTag: false });
  assert.equal(partialReasons(image).length, 0);
});

test('6071: variant symbol without JUMP_SLOT is not rejected', () => {
  const bytes = new Uint8Array(0x800);
  const view = new DataView(bytes.buffer);
  const strtabVa = BASE + BigInt(STRTAB_OFFSET);
  const symtabVa = BASE + BigInt(SYMTAB_OFFSET);
  const stringBytes = Uint8Array.from([0, ...new TextEncoder().encode('vecfn'), 0]);
  putDynamic(view, 0, 5, strtabVa);
  putDynamic(view, 1, 10, stringBytes.length);
  putDynamic(view, 2, 6, symtabVa);
  putDynamic(view, 3, 11, 24);
  putDynamic(view, 4, 39, 48);
  putDynamic(view, 5, 0, 0);
  bytes.set(stringBytes, STRTAB_OFFSET);
  view.setUint32(SYMTAB_OFFSET + 24, 1, true);
  view.setUint8(SYMTAB_OFFSET + 28, 0x12);
  view.setUint8(SYMTAB_OFFSET + 29, 0x80);
  view.setUint16(SYMTAB_OFFSET + 30, 1, true);
  const segment = { address: BASE, size: 0x800n, fileOffset: 0n, fileSize: 0x800n, perms: { read: true, write: true, execute: false } };
  const image = {
    warnings: [], libraries: [], metadata: { machine: 243 }, segments: [segment], sections: [],
    symbols: [], imports: [], exports: [], functions: [], relocations: [],
    addressToOffset(address) { const d = BigInt(address) - BASE; return d >= 0n && d < 0x800n ? Number(d) : null; },
    sectionAt() { return null; },
    segmentAt(address) { const v = BigInt(address); return v >= BASE && v < BASE + 0x800n ? segment : null; },
  };
  parseProgramDynamic(reader(bytes), [{ type: 2, offset: BigInt(DYNAMIC_OFFSET), filesz: BigInt(6 * 16) }], image, 64);
  assert.equal(partialReasons(image).length, 0);
});

test('6071: non-RISC-V machine ignores the invariant', () => {
  const image = fixture({ withTag: false, machine: 62 });
  assert.equal(partialReasons(image).length, 0);
});
