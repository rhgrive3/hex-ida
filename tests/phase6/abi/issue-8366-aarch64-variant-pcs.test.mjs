import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSymbols, STO_AARCH64_VARIANT_PCS, EM_AARCH64 } from '../../../js/binary/elf-core.js';
import { parseProgramDynamic } from '../../../js/binary/elf-dynamic.js';
import { AAPCS64_ABI, classifyAAPCS64Arguments, classifyAAPCS64CallReturn, classifyAAPCS64FunctionReturn } from '../../../js/targets/abi/aapcs64-core.js';

const BASE = 0x400000n;
const DYNAMIC_OFFSET = 0x100;
const SYMTAB_OFFSET = 0x200;
const STRTAB_OFFSET = 0x300;

function createReader(bytes) {
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

function dynamicFixture(stOther, { machine = 183, executable = true } = {}) {
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

  // symbol 0: null
  // symbol 1: GLOBAL FUNC vecfn
  view.setUint32(SYMTAB_OFFSET + 24, 1, true);
  view.setUint8(SYMTAB_OFFSET + 28, 0x12); // STB_GLOBAL | STT_FUNC
  view.setUint8(SYMTAB_OFFSET + 29, stOther);
  view.setUint16(SYMTAB_OFFSET + 30, 1, true);
  view.setBigUint64(SYMTAB_OFFSET + 32, BASE + 0x40n, true);
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
    metadata: { machine },
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
  parseProgramDynamic(
    createReader(bytes),
    [{ type: 2, offset: BigInt(DYNAMIC_OFFSET), filesz: BigInt(6 * 16) }],
    image,
    64,
  );
  return { image };
}

function sectionFixture(stOther, { machine = 183 } = {}) {
  const bytes = new Uint8Array(0x400);
  const view = new DataView(bytes.buffer);
  const stringBytes = Uint8Array.from([0, ...new TextEncoder().encode('vecfn'), 0]);
  const strtabOffset = 0x200;
  bytes.set(stringBytes, strtabOffset);

  // symbol 0: null
  // symbol 1: GLOBAL FUNC vecfn
  view.setUint32(24, 1, true);
  view.setUint8(28, 0x12); // STB_GLOBAL | STT_FUNC
  view.setUint8(29, stOther);
  view.setUint16(30, 1, true); // section 1
  view.setBigUint64(32, 0x1000n, true); // address
  view.setBigUint64(40, 16n, true); // size

  const section = {
    index: 1,
    name: '.text',
    address: 0x1000n,
    size: 0x100n,
    fileOffset: 0x100n,
    perms: { read: true, write: false, execute: true },
  };

  const segment = {
    address: 0x1000n,
    size: 0x100n,
    fileOffset: 0x100n,
    perms: { read: true, write: false, execute: true },
  };

  const image = {
    arch: machine === 183 ? 'arm64' : 'x86_64',
    warnings: [],
    metadata: { machine },
    segments: [segment],
    sections: [
      { index: 0, name: '', address: 0n, size: 0n },
      section,
    ],
    symbols: [],
    imports: [],
    exports: [],
    functions: [],
    addressToOffset(addr) {
      const d = BigInt(addr) - 0x1000n;
      return d >= 0n && d < 0x100n ? Number(0x100n + d) : null;
    },
    sectionAt(addr) {
      const d = BigInt(addr) - 0x1000n;
      return d >= 0n && d < 0x100n ? section : null;
    },
    segmentAt(addr) {
      const d = BigInt(addr) - 0x1000n;
      return d >= 0n && d < 0x100n ? segment : null;
    },
  };

  const table = {
    index: 2,
    type: 11, // SHT_DYNSYM
    entsize: 24n,
    size: 48n,
    offset: 0n,
    link: 3,
  };
  const sections = [
    image.sections[0],
    image.sections[1],
    table,
    { index: 3, type: 3, offset: BigInt(strtabOffset), size: BigInt(stringBytes.length) },
  ];

  const budget = {
    take: () => true,
    partial: () => {},
    remainingStringBytes: 1024,
  };

  parseSymbols(createReader(bytes), table, sections, image, 64, 2 /* ET_EXEC */, budget);
  return { image };
}

test('8366: section-backed symbol table decodes STO_AARCH64_VARIANT_PCS for AArch64', () => {
  const { image } = sectionFixture(0x80, { machine: 183 });
  const sym = image.symbols.find((s) => s.name === 'vecfn');
  assert.ok(sym, 'symbol must exist');
  assert.equal(sym.aarch64VariantPcs, true);
  assert.equal(sym.aarch64VariantPcsFlag, true);
  assert.equal(sym.callingConvention, 'aarch64-variant-pcs');
  assert.equal(sym.stOther, 0x80);

  const fn = image.functions.find((f) => f.name === 'vecfn');
  assert.ok(fn, 'function seed must exist');
  assert.equal(fn.callingConvention, 'aarch64-variant-pcs');
  assert.deepEqual(fn.abiMetadata, { aarch64VariantPcs: true, stOther: 0x80 });

  assert.ok(Array.isArray(image.metadata.aarch64VariantPcsFunctions));
  assert.equal(image.metadata.aarch64VariantPcsFunctions.length, 1);
  assert.equal(image.metadata.aarch64VariantPcsFunctions[0].name, 'vecfn');
});

test('8366: PT_DYNAMIC dynsym decodes STO_AARCH64_VARIANT_PCS for AArch64', () => {
  const { image } = dynamicFixture(0x80, { machine: 183 });
  const sym = image.symbols.find((s) => s.name === 'vecfn');
  assert.ok(sym, 'symbol must exist');
  assert.equal(sym.aarch64VariantPcs, true);
  assert.equal(sym.aarch64VariantPcsFlag, true);
  assert.equal(sym.callingConvention, 'aarch64-variant-pcs');
  assert.equal(sym.stOther, 0x80);

  const fn = image.functions.find((f) => f.name === 'vecfn');
  assert.ok(fn, 'function seed must exist');
  assert.equal(fn.callingConvention, 'aarch64-variant-pcs');
  assert.deepEqual(fn.abiMetadata, { aarch64VariantPcs: true, stOther: 0x80 });
});

test('8366: ordinary st_other stays non-variant on AArch64', () => {
  const { image } = sectionFixture(0, { machine: 183 });
  const sym = image.symbols.find((s) => s.name === 'vecfn');
  assert.ok(sym, 'symbol must exist');
  assert.equal(sym.aarch64VariantPcs, false);
  assert.equal(sym.callingConvention, null);

  const fn = image.functions.find((f) => f.name === 'vecfn');
  assert.ok(fn, 'function seed must exist');
  assert.equal(fn.callingConvention, null);
  assert.equal(fn.abiMetadata, null);
});

test('8366: non-AArch64 machine does not claim aarch64-variant-pcs for st_other 0x80', () => {
  const { image } = sectionFixture(0x80, { machine: 62 /* EM_X86_64 */ });
  const sym = image.symbols.find((s) => s.name === 'vecfn');
  assert.ok(sym, 'symbol must exist');
  assert.equal(sym.aarch64VariantPcs, false);
  assert.equal(sym.callingConvention, null);
});

test('8366: AAPCS64 ABI classifies aarch64-variant-pcs call/function as unsupported/partial', () => {
  const args = classifyAAPCS64Arguments(null, { callingConvention: 'aarch64-variant-pcs' });
  assert.equal(args.unsupported, true);
  assert.equal(args.partial, true);
  assert.equal(args.reason, 'aapcs64-variant-pcs-unsupported');

  const callRet = classifyAAPCS64CallReturn({ callingConvention: 'aarch64-variant-pcs' }, { returnType: 'int' });
  assert.equal(callRet.unsupported, true);
  assert.equal(callRet.partial, true);
  assert.equal(callRet.reason, 'aapcs64-variant-pcs-unsupported');

  const funcRet = classifyAAPCS64FunctionReturn({ callingConvention: 'aarch64-variant-pcs', returnType: 'int' });
  assert.equal(funcRet.unsupported, true);
  assert.equal(funcRet.partial, true);
  assert.equal(funcRet.reason, 'aapcs64-variant-pcs-unsupported');
});
