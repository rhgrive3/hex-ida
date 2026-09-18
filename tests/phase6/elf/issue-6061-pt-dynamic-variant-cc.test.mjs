import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProgramDynamic } from '../../../js/binary/elf-dynamic.js';

const BASE = 0x400000n;
const DYNAMIC_OFFSET = 0x100;
const SYMTAB_OFFSET = 0x200;
const STRTAB_OFFSET = 0x300;

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

// stOther: 0x80 = STO_RISCV_VARIANT_CC, 0 = ordinary
function fixture(stOther, { executable = false, symbolValue = BASE + 0x1000n } = {}) {
  const bytes = new Uint8Array(0x800);
  const view = new DataView(bytes.buffer);
  const strtabVa = BASE + BigInt(STRTAB_OFFSET);
  const symtabVa = BASE + BigInt(SYMTAB_OFFSET);
  const stringBytes = Uint8Array.from([0, ...new TextEncoder().encode('vecfn'), 0]);

  putDynamic(view, 0, 5, strtabVa);            // DT_STRTAB
  putDynamic(view, 1, 10, stringBytes.length); // DT_STRSZ
  putDynamic(view, 2, 6, symtabVa);            // DT_SYMTAB
  putDynamic(view, 3, 11, 24);                 // DT_SYMENT
  putDynamic(view, 4, 39, 48);                 // DT_SYMTABSZ: two symbols
  putDynamic(view, 5, 0, 0);                   // DT_NULL

  bytes.set(stringBytes, STRTAB_OFFSET);

  // symbol 0: null entry
  view.setUint32(SYMTAB_OFFSET, 0, true);
  view.setUint8(SYMTAB_OFFSET + 4, 0);
  view.setUint8(SYMTAB_OFFSET + 5, 0);
  // symbol 1: GLOBAL FUNC vecfn with the given st_other
  view.setUint32(SYMTAB_OFFSET + 24, 1, true);
  view.setUint8(SYMTAB_OFFSET + 28, 0x12); // STB_GLOBAL | STT_FUNC
  view.setUint8(SYMTAB_OFFSET + 29, stOther);
  view.setUint16(SYMTAB_OFFSET + 30, 1, true);
  view.setBigUint64(SYMTAB_OFFSET + 32, symbolValue, true);
  view.setBigUint64(SYMTAB_OFFSET + 40, 16n, true);

  const segment = {
    address: BASE,
    size: 0x800n,
    fileOffset: 0n,
    fileSize: 0x800n,
    perms: executable
      ? { read: true, write: false, execute: true }
      : { read: true, write: true, execute: false },
  };
  const image = {
    warnings: [],
    libraries: [],
    metadata: { machine: 243 },
    segments: [segment],
    sections: [],
    symbols: [],
    imports: [],
    exports: [],
    functions: [],
    relocations: [],
    addressToOffset(address) {
      const delta = BigInt(address) - BASE;
      return delta >= 0n && delta < 0x800n ? Number(delta) : null;
    },
    sectionAt() { return null; },
    segmentAt(address) {
      const value = BigInt(address);
      return value >= BASE && value < BASE + 0x800n ? segment : null;
    },
  };
  const result = parseProgramDynamic(
    reader(bytes),
    [{ type: 2, offset: BigInt(DYNAMIC_OFFSET), filesz: BigInt(6 * 16) }],
    image,
    64,
  );
  return { result, image };
}

test('6061: sectionless PT_DYNAMIC dynsym keeps STO_RISCV_VARIANT_CC', () => {
  const { image } = fixture(0x80);
  const sym = image.symbols.find((s) => s.name === 'vecfn');
  assert.ok(sym, 'vecfn must be decoded');
  assert.equal(sym.riscvVariantCc, true);
  assert.equal(sym.callingConvention, 'riscv-vector-variant');
  assert.equal(sym.stOther, 0x80);
});

test('6061: ordinary st_other stays non-variant', () => {
  const { image } = fixture(0);
  const sym = image.symbols.find((s) => s.name === 'vecfn');
  assert.ok(sym, 'vecfn must be decoded');
  assert.equal(sym.riscvVariantCc, false);
  assert.equal(sym.callingConvention, null);
});

test('6061: non-RISC-V machine never claims variant-cc', () => {
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
    warnings: [], libraries: [], metadata: { machine: 62 }, segments: [segment], sections: [],
    symbols: [], imports: [], exports: [], functions: [], relocations: [],
    addressToOffset(address) { const d = BigInt(address) - BASE; return d >= 0n && d < 0x800n ? Number(d) : null; },
    sectionAt() { return null; },
    segmentAt(address) { const v = BigInt(address); return v >= BASE && v < BASE + 0x800n ? segment : null; },
  };
  parseProgramDynamic(reader(bytes), [{ type: 2, offset: BigInt(DYNAMIC_OFFSET), filesz: BigInt(6 * 16) }], image, 64);
  const sym = image.symbols.find((s) => s.name === 'vecfn');
  assert.ok(sym, 'vecfn must be decoded');
  assert.equal(sym.riscvVariantCc, false);
});

// #6061 residual: the section-backed parser propagates variant-cc evidence
// into function seeds (callingConvention/abiMetadata) and registers the
// function in metadata.riscvVariantCcFunctions; the PT_DYNAMIC path must
// mint identical evidence for the same byte.
test('6061: PT_DYNAMIC STT_FUNC seed carries variant-cc calling-convention evidence', () => {
  const { image } = fixture(0x80, { executable: true, symbolValue: BASE + 0x20n });
  const seed = image.functions.find((f) => f.name === 'vecfn');
  assert.ok(seed, 'variant-cc function seed must be minted from the dynamic symbol');
  assert.equal(seed.exactFunctionStart, true);
  assert.equal(seed.callingConvention, 'riscv-vector-variant');
  assert.deepEqual(seed.abiMetadata, { riscvVariantCc: true, stOther: 0x80 });
  assert.deepEqual(image.metadata.riscvVariantCcFunctions, [
    { name: 'vecfn', address: BASE + 0x20n, symbolIndex: 1, tableIndex: -1, stOther: 0x80, callingConvention: 'riscv-vector-variant' },
  ]);
});

test('6061: ordinary PT_DYNAMIC function seed keeps null calling convention and no registry', () => {
  const { image } = fixture(0, { executable: true, symbolValue: BASE + 0x20n });
  const seed = image.functions.find((f) => f.name === 'vecfn');
  assert.ok(seed, 'ordinary function seed must still be minted');
  assert.equal(seed.callingConvention, null);
  assert.equal(seed.abiMetadata, null);
  assert.equal(image.metadata.riscvVariantCcFunctions, undefined);
});
