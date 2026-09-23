import test from 'node:test';
import assert from 'node:assert/strict';
import { parseELF } from '../../../js/binary/index.js';
import { parseSourceRanges } from '../../../js/binary/source-reader.js';

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

const RESOLVER_OFF = 0x180;
const RESOLVER = BASE + BigInt(RESOLVER_OFF);
const GOT = BASE + 0x420n;
const JUMP_SLOTS = [GOT + 0x18n, GOT + 0x20n];
const JMPREL_OFF = 0x380;
const DYNAMIC_OFF = 0x300;
const SHSTR_OFF = 0x480;
const SHOFF = 0x500;

// Large image: executable segment > 1 MiB (1.2 MiB)
const LARGE_EXEC_SIZE = 0x130000; // 1,245,184 bytes (~1.2 MiB)
const SECOND_RESOLVER_OFF = 0x80000; // well past 1 MiB scan limit

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
  writeU32(view, offset + 20, 0xd503201f);
  writeU32(view, offset + 24, 0xd503201f);
  writeU32(view, offset + 28, 0xd503201f);
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

function buildLargeFixture({
  gotValues = [RESOLVER, RESOLVER],
  thunkDelta = 32,
  resolverGot = GOT + 0x10n,
  secondResolver = false,
  secondResolverThunkDelta = 32,
} = {}) {
  const bytes = new Uint8Array(LARGE_EXEC_SIZE);
  const view = new DataView(bytes.buffer);
  const { bytes: shstr, offsets: shName } = sectionNameTable();

  // ELF Header
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  view.setUint16(16, 3, true); // ET_DYN
  view.setUint16(18, EM_AARCH64, true);
  view.setUint32(20, 1, true);
  writeU64(view, 24, 0n);
  writeU64(view, 32, 64n);
  writeU64(view, 40, BigInt(SHOFF));
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, 2, true); // 2 program headers: PT_LOAD and PT_DYNAMIC
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
  // Segment 0: executable PT_LOAD, size = LARGE_EXEC_SIZE > 1 MiB
  phdr(0, PT_LOAD, 7, 0, BASE, bytes.length, bytes.length);

  const dynamic = [
    [DT_PLTGOT, GOT],
    [DT_PLTRELSZ, BigInt(JUMP_SLOTS.length * 24)],
    [DT_RELAENT, 24n],
    [DT_PLTREL, DT_RELA],
    [DT_JMPREL, BASE + BigInt(JMPREL_OFF)],
    [DT_NULL, 0n],
  ];
  phdr(1, PT_DYNAMIC, 6, DYNAMIC_OFF, BASE + BigInt(DYNAMIC_OFF), dynamic.length * 16, dynamic.length * 16);
  dynamic.forEach(([tag, value], index) => {
    const p = DYNAMIC_OFF + index * 16;
    writeI64(view, p, tag);
    writeU64(view, p + 8, value);
  });

  // Primary resolver and thunks
  writeResolver(view, RESOLVER_OFF, resolverGot);
  for (let i = 0; i < JUMP_SLOTS.length; i++) {
    writeTail(view, RESOLVER_OFF + thunkDelta + i * 16, JUMP_SLOTS[i]);
    const p = JMPREL_OFF + i * 24;
    writeU64(view, p, JUMP_SLOTS[i]);
    writeU64(view, p + 8, (1n << 32n) | R_AARCH64_JUMP_SLOT);
    writeI64(view, p + 16, 0n);
  }

  // Populate GOT slots with initial values
  for (let i = 0; i < JUMP_SLOTS.length; i++) {
    const slotOffset = Number(JUMP_SLOTS[i] - BASE);
    const val = gotValues[i] != null ? gotValues[i] : 0n;
    writeU64(view, slotOffset, val);
  }

  // Optional second structurally complete resolver copy elsewhere in the big segment
  if (secondResolver) {
    writeResolver(view, SECOND_RESOLVER_OFF, resolverGot);
    for (let i = 0; i < JUMP_SLOTS.length; i++) {
      writeTail(view, SECOND_RESOLVER_OFF + secondResolverThunkDelta + i * 16, JUMP_SLOTS[i]);
    }
  }

  // Section headers
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
  shdr(1, { name: '.code', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: BASE + 0x160n, offset: 0x160n, size: 0x80n });
  shdr(2, { name: '.text', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: BASE + 0x220n, offset: 0x220n, size: 0x20n });
  shdr(3, { name: '.init', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: BASE + 0x260n, offset: 0x260n, size: 0x20n });
  shdr(4, { name: '.veneer', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: BASE + 0x2a0n, offset: 0x2a0n, size: 0x20n });
  shdr(5, { name: '.shstrtab', type: SHT_STRTAB, offset: BigInt(SHSTR_OFF), size: BigInt(shstr.length) });

  return bytes;
}

function pltSeeds(image) {
  return image.functions.filter((fn) => fn.source === 'elf-plt-structure');
}

test('Case 1: GOT slots initialised with resolver address -> exactly one seed, candidate got-initial-value', () => {
  const bytes = buildLargeFixture({ gotValues: [RESOLVER, RESOLVER] });
  const image = parseELF(bytes);
  const seeds = pltSeeds(image);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].address, RESOLVER);
  assert.equal(seeds[0].kind, 'stub');
  assert.equal(seeds[0].size, 32n);
  assert.equal(seeds[0].exactFunctionStart, true);
  assert.equal(image.metadata.aarch64PltResolver?.candidate, 'got-initial-value');
  assert.equal(image.metadata.aarch64PltResolver?.address, RESOLVER);
  assert.equal(image.metadata.aarch64PltResolver?.source, 'elf-plt-structure');
});

test('Case 2: GOT slots disagree -> no seed', () => {
  const bytes = buildLargeFixture({ gotValues: [RESOLVER, RESOLVER + 4n] });
  const image = parseELF(bytes);
  assert.equal(pltSeeds(image).length, 0);
  assert.equal(image.metadata.aarch64PltResolver, undefined);
});

test('Case 3: GOT slots all zero -> no seed and no exception', () => {
  const bytes = buildLargeFixture({ gotValues: [0n, 0n] });
  assert.doesNotThrow(() => {
    const image = parseELF(bytes);
    assert.equal(pltSeeds(image).length, 0);
    assert.equal(image.metadata.aarch64PltResolver, undefined);
  });
});

test('Case 4: GOT points to address whose structure is broken -> no seed', () => {
  // Wrong thunk order (thunkDelta 48 instead of 32)
  const bytes = buildLargeFixture({ thunkDelta: 48, gotValues: [RESOLVER, RESOLVER] });
  const image = parseELF(bytes);
  assert.equal(pltSeeds(image).length, 0);
  assert.equal(image.metadata.aarch64PltResolver, undefined);
});

test('Case 5: second structurally complete resolver copy in big segment does not create second seed or change anchored result', () => {
  const bytes = buildLargeFixture({
    gotValues: [RESOLVER, RESOLVER],
    secondResolver: true,
  });
  const image = parseELF(bytes);
  const seeds = pltSeeds(image);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].address, RESOLVER);
  assert.equal(image.metadata.aarch64PltResolver?.candidate, 'got-initial-value');
  assert.equal(image.metadata.aarch64PltResolver?.address, RESOLVER);
});

test('Case 6: source-backed parse with small maxCachedBytes succeeds and yields same seed', async () => {
  const bytes = buildLargeFixture({ gotValues: [RESOLVER, RESOLVER] });
  const byteSource = {
    size: BigInt(bytes.length),
    maxReadLength: 1 << 24,
    read: async (o, l) => bytes.subarray(Number(o), Number(o) + l),
    readExactly: async (o, l) => bytes.slice(Number(o), Number(o) + l),
  };

  const image = await parseSourceRanges(
    byteSource,
    (backing) => parseELF(backing),
    {},
    { maxCachedBytes: 512 * 1024 },
  );

  const seeds = pltSeeds(image);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].address, RESOLVER);
  assert.equal(image.metadata.aarch64PltResolver?.candidate, 'got-initial-value');
  assert.equal(image.metadata.aarch64PltResolver?.address, RESOLVER);
});
