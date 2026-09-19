import test from 'node:test';
import assert from 'node:assert/strict';
import { parseELF } from '../../../js/binary/elf.js';

/*
 * Adversarial counterexamples for the structural AArch64 PLT resolver (#9221).
 *
 * These fixtures exist because a mutation run over the happy-path suite showed
 * that several safety guards could be deleted while every existing test still
 * passed (false-green). Each case below is built to fail closed and makes one
 * guard load-bearing:
 *
 *   - the resolver must be anchored on DT_PLTGOT + 16, not merely "resolves";
 *   - an import GOT slot is never a resolver slot;
 *   - DT_PLTREL must be RELA and every tag must be unambiguous;
 *   - at most one structurally complete resolver may exist;
 *   - the `.rela.plt` record order must match the thunk order;
 *   - only little-endian AArch64 images are in scope;
 *   - only 4-byte-aligned addresses are candidates.
 *
 * No benchmark case id, name, or address participates.
 */

const BASE = 0x400000n;
const EM_AARCH64 = 183;
const EM_X86_64 = 62;
const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const SHT_PROGBITS = 1;
const SHT_STRTAB = 3;
const SHF_ALLOC = 0x2n;
const SHF_EXECINSTR = 0x4n;
const DT_NULL = 0n;
const DT_PLTRELSZ = 2n;
const DT_PLTGOT = 3n;
const DT_RELAENT = 9n;
const DT_REL = 17n;
const DT_PLTREL = 20n;
const DT_JMPREL = 23n;
const DT_RELA = 7n;
const R_AARCH64_JUMP_SLOT = 1026n;
const R_AARCH64_RELATIVE = 1027n;

const RESOLVER_OFF = 0x180;
const RESOLVER = BASE + BigInt(RESOLVER_OFF);
const GOT = BASE + 0x420n;
const JUMP_SLOTS = [GOT + 0x18n, GOT + 0x20n];
const JMPREL_OFF = 0x380;
const DYNAMIC_OFF = 0x300;
const SHSTR_OFF = 0x480;
const SHOFF = 0x500;
const DUPLICATE_RESOLVER_OFF = 0x1e0;

function byteWriter(view, le) {
  return {
    u32: (offset, value) => view.setUint32(offset, Number(value) >>> 0, le),
    u64: (offset, value) => view.setBigUint64(offset, BigInt(value), le),
    i64: (offset, value) => view.setBigInt64(offset, BigInt(value), le),
  };
}

function adrpX16SamePage() { return 0x90000010; }
function ldrX17FromX16(byteOffset) {
  return (0xf9400000 | ((byteOffset / 8) << 10) | (16 << 5) | 17) >>> 0;
}
function addX16X16(byteOffset) {
  return (0x91000000 | (byteOffset << 10) | (16 << 5) | 16) >>> 0;
}
function brX17() { return 0xd61f0220; }

function writeTail(w, offset, gotAddress) {
  const pageOffset = Number(gotAddress - BASE);
  w.u32(offset, adrpX16SamePage());
  w.u32(offset + 4, ldrX17FromX16(pageOffset));
  w.u32(offset + 8, addX16X16(pageOffset));
  w.u32(offset + 12, brX17());
}

function writeResolver(w, offset, gotAddress) {
  w.u32(offset, 0xa9bf7bf0);
  writeTail(w, offset + 4, gotAddress);
}

function sectionNameTable() {
  const names = ['.code', '.plt', '.text', '.init', '.veneer', '.shstrtab'];
  const parts = ['\0'];
  const offsets = new Map();
  let cursor = 1;
  for (const name of names) {
    offsets.set(name, cursor);
    parts.push(name, '\0');
    cursor += name.length + 1;
  }
  return { bytes: new TextEncoder().encode(parts.join('')), offsets };
}

function buildFixture({
  relocationType = R_AARCH64_JUMP_SLOT,
  includeJmprel = true,
  thunkDelta = 32,
  resolverGot = GOT + 0x10n,
  structuralSectionName = '.code',
  pltrel = DT_RELA,
  duplicateJmprel = false,
  duplicateResolver = false,
  thunkSlotOrder = null,
  machine = EM_AARCH64,
  dataEncoding = 1,
  resolverOffset = RESOLVER_OFF,
} = {}) {
  const le = dataEncoding === 1;
  const bytes = new Uint8Array(0x700);
  const view = new DataView(bytes.buffer);
  const w = byteWriter(view, le);
  const { bytes: shstr, offsets: shName } = sectionNameTable();

  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, dataEncoding, 1, 0], 0);
  view.setUint16(16, 3, le); // ET_DYN
  view.setUint16(18, machine, le);
  w.u32(20, 1);
  w.u64(24, 0n);
  w.u64(32, 64n);
  w.u64(40, BigInt(SHOFF));
  view.setUint16(52, 64, le);
  view.setUint16(54, 56, le);
  view.setUint16(56, 2, le);
  view.setUint16(58, 64, le);
  view.setUint16(60, 6, le);
  view.setUint16(62, 5, le);

  const phdr = (index, type, flags, fileOffset, address, fileSize, memorySize) => {
    const p = 64 + index * 56;
    view.setUint32(p, type, le);
    view.setUint32(p + 4, flags, le);
    w.u64(p + 8, BigInt(fileOffset));
    w.u64(p + 16, address);
    w.u64(p + 24, address);
    w.u64(p + 32, BigInt(fileSize));
    w.u64(p + 40, BigInt(memorySize));
    w.u64(p + 48, type === PT_LOAD ? 0x1000n : 8n);
  };
  phdr(0, PT_LOAD, 7, 0, BASE, bytes.length, bytes.length);

  const dynamic = [
    [DT_PLTGOT, GOT],
    [DT_PLTRELSZ, BigInt(JUMP_SLOTS.length * 24)],
    [DT_RELAENT, 24n],
    [DT_PLTREL, pltrel],
  ];
  if (includeJmprel) dynamic.push([DT_JMPREL, BASE + BigInt(JMPREL_OFF)]);
  if (duplicateJmprel) dynamic.push([DT_JMPREL, BASE + BigInt(JMPREL_OFF)]);
  dynamic.push([DT_NULL, 0n]);
  phdr(1, PT_DYNAMIC, 6, DYNAMIC_OFF, BASE + BigInt(DYNAMIC_OFF), dynamic.length * 16, dynamic.length * 16);
  dynamic.forEach(([tag, value], index) => {
    const p = DYNAMIC_OFF + index * 16;
    w.i64(p, tag);
    w.u64(p + 8, value);
  });

  const order = thunkSlotOrder || JUMP_SLOTS.map((_, index) => index);
  const writeStructure = (resolverAt) => {
    writeResolver(w, resolverAt, resolverGot);
    for (let i = 0; i < JUMP_SLOTS.length; i++) {
      writeTail(w, resolverAt + thunkDelta + i * 16, JUMP_SLOTS[order[i]]);
    }
  };
  writeStructure(resolverOffset);
  if (duplicateResolver) writeStructure(DUPLICATE_RESOLVER_OFF);

  for (let i = 0; i < JUMP_SLOTS.length; i++) {
    const p = JMPREL_OFF + i * 24;
    w.u64(p, JUMP_SLOTS[i]);
    w.u64(p + 8, (1n << 32n) | relocationType);
    w.i64(p + 16, 0n);
  }

  // Executable decoys that begin with the resolver prologue word but carry no
  // dynamic/GOT relation. They must never become starts.
  for (const off of [0x220, 0x260, 0x2a0]) {
    w.u32(off, 0xa9bf7bf0);
    w.u32(off + 4, 0xd503201f);
  }

  bytes.set(shstr, SHSTR_OFF);
  const shdr = (index, { name = '', type = 0, flags = 0n, addr = 0n, offset = 0n, size = 0n } = {}) => {
    const p = SHOFF + index * 64;
    view.setUint32(p, name ? shName.get(name) : 0, le);
    view.setUint32(p + 4, type, le);
    w.u64(p + 8, flags);
    w.u64(p + 16, addr);
    w.u64(p + 24, offset);
    w.u64(p + 32, size);
    w.u64(p + 48, 4n);
  };
  shdr(0);
  // The structural bytes are deliberately named `.code` and the section starts
  // before the resolver, so neither a section-name check nor a region-start seed
  // would pass this fixture.
  shdr(1, { name: structuralSectionName, type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: BASE + 0x160n, offset: 0x160n, size: 0xa0n });
  shdr(2, { name: '.text', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: BASE + 0x220n, offset: 0x220n, size: 0x20n });
  shdr(3, { name: '.init', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: BASE + 0x260n, offset: 0x260n, size: 0x20n });
  shdr(4, { name: '.veneer', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: BASE + 0x2a0n, offset: 0x2a0n, size: 0x20n });
  shdr(5, { name: '.shstrtab', type: SHT_STRTAB, offset: BigInt(SHSTR_OFF), size: BigInt(shstr.length) });

  return bytes;
}

function pltSeeds(image) {
  return image.functions.filter((fn) => fn.source === 'elf-plt-structure');
}

function assertNoStructuralSeed(options, label) {
  const image = parseELF(buildFixture(options));
  assert.equal(pltSeeds(image).length, 0, label);
  assert.equal(image.metadata.aarch64PltResolver, undefined, `${label}: metadata must not be published`);
}

test('fixture sanity: the baseline structural layout still yields exactly one seed', () => {
  const image = parseELF(buildFixture());
  const seeds = pltSeeds(image);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].address, RESOLVER);
  assert.deepEqual(image.metadata.aarch64PltResolver, { address: RESOLVER, source: 'elf-plt-structure' });
});

test('counterexample: DT_PLTREL other than RELA fails closed', () => {
  assertNoStructuralSeed({ pltrel: DT_REL }, 'DT_PLTREL=DT_REL must not authorise a resolver');
});

test('counterexample: an ambiguous duplicate DT_JMPREL tag fails closed', () => {
  assertNoStructuralSeed({ duplicateJmprel: true }, 'two DT_JMPREL values are not a singleton anchor');
});

test('counterexample: two structurally complete resolvers fail closed', () => {
  assertNoStructuralSeed({ duplicateResolver: true }, 'more than one candidate is ambiguous');
});

test('counterexample: .rela.plt order disagreeing with thunk order fails closed', () => {
  // Both slots are valid import GOT slots; only their table order differs.
  assertNoStructuralSeed({ thunkSlotOrder: [1, 0] }, 'record order must match thunk order');
});

test('counterexample: an import GOT slot can never be the resolver slot', () => {
  // GOT + 0x18 is JUMP_SLOTS[0]; a resolver that materialises an import slot is
  // not a resolver.
  assertNoStructuralSeed({ resolverGot: GOT + 0x18n }, 'resolver GOT slot must not be an import');
});

test('counterexample: a resolver whose GOT slot is neither &GOT[2] nor an import fails closed', () => {
  // GOT + 0x28 is neither DT_PLTGOT+16 nor any jump slot, so this case isolates
  // the DT_PLTGOT anchor from the import-collision guard.
  assertNoStructuralSeed({ resolverGot: GOT + 0x28n }, 'the resolver must materialise exactly &GOT[2]');
});

test('counterexample: a non-RELA relocation table type fails closed', () => {
  assertNoStructuralSeed({ relocationType: R_AARCH64_RELATIVE }, 'non-JUMP_SLOT records cannot anchor a PLT');
});

test('counterexample: big-endian images are out of scope and fail closed', () => {
  assertNoStructuralSeed({ dataEncoding: 2 }, 'big-endian AArch64 must not be recognised');
});

test('counterexample: a non-AArch64 machine fails closed', () => {
  assertNoStructuralSeed({ machine: EM_X86_64 }, 'the resolver model is AArch64-only');
});

test('counterexample: a resolver-shaped structure at an unaligned address is not a candidate', () => {
  assertNoStructuralSeed({ resolverOffset: RESOLVER_OFF + 2 }, 'only 4-byte-aligned addresses are candidates');
});
