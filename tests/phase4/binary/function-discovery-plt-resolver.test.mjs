import test from 'node:test';
import assert from 'node:assert/strict';
import { parseELF } from '../../../js/binary/elf.js';

const BASE = 0x400000n;
const EM_AARCH64 = 183;
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

function writeU32(view, offset, value) { view.setUint32(offset, Number(value) >>> 0, true); }
function writeU64(view, offset, value) { view.setBigUint64(offset, BigInt(value), true); }
function writeI64(view, offset, value) { view.setBigInt64(offset, BigInt(value), true); }

function adrpX16SamePage() { return 0x90000010; }
function ldrX17FromX16(byteOffset) {
  assert.equal(byteOffset % 8, 0);
  return (0xf9400000 | ((byteOffset / 8) << 10) | (16 << 5) | 17) >>> 0;
}
function addX16X16(byteOffset) {
  assert.ok(byteOffset >= 0 && byteOffset <= 0xfff);
  return (0x91000000 | (byteOffset << 10) | (16 << 5) | 16) >>> 0;
}
function brX17() { return 0xd61f0220; }

function writeTail(view, offset, gotAddress) {
  const pageOffset = Number(gotAddress - BASE);
  writeU32(view, offset, adrpX16SamePage());
  writeU32(view, offset + 4, ldrX17FromX16(pageOffset));
  writeU32(view, offset + 8, addX16X16(pageOffset));
  writeU32(view, offset + 12, brX17());
}

function writeResolver(view, offset, gotAddress = GOT + 0x10n) {
  writeU32(view, offset, 0xa9bf7bf0);
  writeTail(view, offset + 4, gotAddress);
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
} = {}) {
  const bytes = new Uint8Array(0x700);
  const view = new DataView(bytes.buffer);
  const { bytes: shstr, offsets: shName } = sectionNameTable();

  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  view.setUint16(16, 3, true); // ET_DYN
  view.setUint16(18, EM_AARCH64, true);
  view.setUint32(20, 1, true);
  writeU64(view, 24, 0n);
  writeU64(view, 32, 64n);
  writeU64(view, 40, BigInt(SHOFF));
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, 2, true);
  view.setUint16(58, 64, true);
  view.setUint16(60, 6, true);
  view.setUint16(62, 5, true);

  const phdr = (index, type, flags, fileOffset, address, fileSize, memorySize) => {
    const p = 64 + index * 56;
    view.setUint32(p, type, true);
    view.setUint32(p + 4, flags, true);
    writeU64(view, p + 8, BigInt(fileOffset));
    writeU64(view, p + 16, address);
    writeU64(view, p + 24, address);
    writeU64(view, p + 32, BigInt(fileSize));
    writeU64(view, p + 40, BigInt(memorySize));
    writeU64(view, p + 48, type === PT_LOAD ? 0x1000n : 8n);
  };
  phdr(0, PT_LOAD, 7, 0, BASE, bytes.length, bytes.length);

  const dynamic = [
    [DT_PLTGOT, GOT],
    [DT_PLTRELSZ, BigInt(JUMP_SLOTS.length * 24)],
    [DT_RELAENT, 24n],
    [DT_PLTREL, DT_RELA],
  ];
  if (includeJmprel) dynamic.push([DT_JMPREL, BASE + BigInt(JMPREL_OFF)]);
  dynamic.push([DT_NULL, 0n]);
  phdr(1, PT_DYNAMIC, 6, DYNAMIC_OFF, BASE + BigInt(DYNAMIC_OFF), dynamic.length * 16, dynamic.length * 16);
  dynamic.forEach(([tag, value], index) => {
    const p = DYNAMIC_OFF + index * 16;
    writeI64(view, p, tag);
    writeU64(view, p + 8, value);
  });

  writeResolver(view, RESOLVER_OFF, resolverGot);
  for (const off of [20, 24, 28]) writeU32(view, RESOLVER_OFF + off, 0xd503201f);
  for (let i = 0; i < JUMP_SLOTS.length; i++) {
    writeTail(view, RESOLVER_OFF + thunkDelta + i * 16, JUMP_SLOTS[i]);
    const p = JMPREL_OFF + i * 24;
    writeU64(view, p, JUMP_SLOTS[i]);
    writeU64(view, p + 8, (1n << 32n) | relocationType);
    writeI64(view, p + 16, 0n);
  }

  // Executable decoys corresponding to ordinary .text/.init/veneer regions.
  // Each starts with the resolver prologue word, but lacks the dynamic/GOT
  // relation and therefore must never become a synthetic start.
  for (const off of [0x220, 0x260, 0x2a0]) {
    writeU32(view, off, 0xa9bf7bf0);
    writeU32(view, off + 4, 0xd503201f);
  }

  bytes.set(shstr, SHSTR_OFF);
  const shdr = (index, { name = '', type = 0, flags = 0n, addr = 0n, offset = 0n, size = 0n } = {}) => {
    const p = SHOFF + index * 64;
    view.setUint32(p, name ? shName.get(name) : 0, true);
    view.setUint32(p + 4, type, true);
    writeU64(view, p + 8, flags);
    writeU64(view, p + 16, addr);
    writeU64(view, p + 24, offset);
    writeU64(view, p + 32, size);
    writeU64(view, p + 48, 4n);
  };
  shdr(0);
  // Deliberately name the structural PLT bytes .code and start the section
  // before the resolver. A section-name check or executable-region-start seed
  // would therefore fail this fixture.
  shdr(1, { name: structuralSectionName, type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: BASE + 0x160n, offset: 0x160n, size: 0x80n });
  shdr(2, { name: '.text', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: BASE + 0x220n, offset: 0x220n, size: 0x20n });
  shdr(3, { name: '.init', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: BASE + 0x260n, offset: 0x260n, size: 0x20n });
  shdr(4, { name: '.veneer', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: BASE + 0x2a0n, offset: 0x2a0n, size: 0x20n });
  shdr(5, { name: '.shstrtab', type: SHT_STRTAB, offset: BigInt(SHSTR_OFF), size: BigInt(shstr.length) });

  return bytes;
}

function pltSeeds(image) {
  return image.functions.filter((fn) => fn.source === 'elf-plt-structure');
}

test('A2 prime: dynamic AAELF64 PLT structure adds exactly the resolver stub start', () => {
  const image = parseELF(buildFixture());
  const seeds = pltSeeds(image);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].address, RESOLVER);
  assert.equal(seeds[0].kind, 'stub');
  assert.equal(seeds[0].exactFunctionStart, true);
  assert.equal(seeds[0].confidence, 0.995);
  assert.equal(seeds[0].size, 32n);
  assert.equal(seeds[0].extentConfidence, 0.995);
  assert.match(seeds[0].functionStartEvidence, /DT_PLTGOT.*DT_JMPREL.*R_AARCH64_JUMP_SLOT/);
  assert.deepEqual(image.metadata.aarch64PltResolver, { address: RESOLVER, source: 'elf-plt-structure', size:32n, extent:'validated-classic-aaelf64-plt0' });

  for (let i = 0; i < JUMP_SLOTS.length; i++) {
    const thunk = RESOLVER + 32n + 16n * BigInt(i);
    assert.equal(image.functions.some((fn) => fn.address === thunk), false, 'import thunks are table entries, not function starts');
  }
  assert.deepEqual(image.functions.map((fn) => fn.address), [RESOLVER], 'ordinary .text/.init/veneer executable regions gain no starts');
  assert.notEqual(RESOLVER, BASE + 0x160n, 'resolver evidence is not the executable section start');
});

test('A2 prime negative: executable bytes without DT_JMPREL/JUMP_SLOT evidence add nothing', () => {
  const missingJmprel = parseELF(buildFixture({ includeJmprel: false, structuralSectionName: '.plt' }));
  assert.equal(pltSeeds(missingJmprel).length, 0);
  assert.equal(missingJmprel.functions.length, 0);

  const wrongRelocation = parseELF(buildFixture({ relocationType: R_AARCH64_RELATIVE }));
  assert.equal(pltSeeds(wrongRelocation).length, 0);
  assert.equal(wrongRelocation.functions.length, 0);
});

test('A2 prime portability: non-AAELF64 thunk layout fails closed', () => {
  const image = parseELF(buildFixture({ thunkDelta: 48 }));
  assert.equal(pltSeeds(image).length, 0);
  assert.equal(image.functions.length, 0);
  assert.equal(image.metadata.aarch64PltResolver, undefined);
});

test('A2 prime negative: resolver-shaped code with the wrong PLTGOT relation adds nothing', () => {
  const image = parseELF(buildFixture({ resolverGot: GOT + 0x18n }));
  assert.equal(pltSeeds(image).length, 0);
  assert.equal(image.functions.length, 0);
});
