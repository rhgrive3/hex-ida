import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseELF } from '../../js/binary/elf.js';
import { analysisFromBinaryImage } from '../../js/platform/analysis-result.js';
import { SymbolIndex } from '../../js/symbols.js';
import { buildSemanticModel } from '../../js/blocks.js';
import { decompile } from '../../js/decompile.js';

const BASE = 0x400000n;
const EM_AARCH64 = 183;
const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const SHT_PROGBITS = 1;
const SHT_STRTAB = 3;
const SHT_RELA = 4;
const SHT_DYNSYM = 11;
const SHF_ALLOC = 0x2n;
const SHF_EXECINSTR = 0x4n;
const DT_NULL = 0n;
const DT_PLTRELSZ = 2n;
const DT_PLTGOT = 3n;
const DT_HASH = 4n;
const DT_STRTAB = 5n;
const DT_SYMTAB = 6n;
const DT_RELA = 7n;
const DT_RELAENT = 9n;
const DT_STRSZ = 10n;
const DT_SYMENT = 11n;
const DT_PLTREL = 20n;
const DT_JMPREL = 23n;
const R_AARCH64_JUMP_SLOT = 1026n;

const RESOLVER_OFF = 0x180;
const RESOLVER = BASE + BigInt(RESOLVER_OFF);
const DYNAMIC_OFF = 0x300;
const JMPREL_OFF = 0x400;
const DYNSYM_OFF = 0x480;
const DYNSTR_OFF = 0x520;
const HASH_OFF = 0x580;
const GOT_OFF = 0x600;
const GOT = BASE + BigInt(GOT_OFF);
const SHSTR_OFF = 0x680;
const SHOFF = 0x700;

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

function encodeStringTable(names) {
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

function buildAarch64PltElf({
  symbolNames = ['strlen', 'malloc', 'fabs'],
  sectionless = false,
  corruptNop = false,
  zeroSymIndexAt = -1,
  largeImage = false,
} = {}) {
  const totalSize = largeImage ? 0x130000 : 0x900;
  const bytes = new Uint8Array(totalSize);
  const view = new DataView(bytes.buffer);
  const jumpSlots = symbolNames.map((_, i) => GOT + 0x18n + 8n * BigInt(i));

  const { bytes: dynstr, offsets: dynstrOff } = encodeStringTable(symbolNames);
  const { bytes: shstr, offsets: shName } = encodeStringTable(['.plt', '.dynsym', '.dynstr', '.rela.plt', '.shstrtab']);

  // ELF64 header (little-endian AArch64 ET_DYN)
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  view.setUint16(16, 3, true);
  view.setUint16(18, EM_AARCH64, true);
  writeU32(view, 20, 1);
  writeU64(view, 24, 0n);
  writeU64(view, 32, 64n);
  writeU64(view, 40, sectionless ? 0n : BigInt(SHOFF));
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, 2, true);
  view.setUint16(58, 64, true);
  view.setUint16(60, sectionless ? 0 : 6, true);
  view.setUint16(62, sectionless ? 0 : 5, true);

  const phdr = (index, type, flags, fileOffset, address, fileSize, memorySize) => {
    const p = 64 + index * 56;
    writeU32(view, p, type);
    writeU32(view, p + 4, flags);
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
    [DT_PLTRELSZ, BigInt(jumpSlots.length * 24)],
    [DT_RELAENT, 24n],
    [DT_PLTREL, DT_RELA],
    [DT_JMPREL, BASE + BigInt(JMPREL_OFF)],
    [DT_SYMTAB, BASE + BigInt(DYNSYM_OFF)],
    [DT_SYMENT, 24n],
    [DT_STRTAB, BASE + BigInt(DYNSTR_OFF)],
    [DT_STRSZ, BigInt(dynstr.length)],
    [DT_HASH, BASE + BigInt(HASH_OFF)],
    [DT_NULL, 0n],
  ];
  phdr(1, PT_DYNAMIC, 6, DYNAMIC_OFF, BASE + BigInt(DYNAMIC_OFF), dynamic.length * 16, dynamic.length * 16);
  dynamic.forEach(([tag, value], index) => {
    const p = DYNAMIC_OFF + index * 16;
    writeI64(view, p, tag);
    writeU64(view, p + 8, value);
  });

  // PLT0 + thunks
  writeResolver(view, RESOLVER_OFF, GOT + 0x10n);
  if (corruptNop) writeU32(view, RESOLVER_OFF + 24, 0xd503209f);
  for (let i = 0; i < jumpSlots.length; i++) {
    writeTail(view, RESOLVER_OFF + 32 + i * 16, jumpSlots[i]);
    const p = JMPREL_OFF + i * 24;
    const symIdx = i === zeroSymIndexAt ? 0n : BigInt(i + 1);
    writeU64(view, p, jumpSlots[i]);
    writeU64(view, p + 8, (symIdx << 32n) | R_AARCH64_JUMP_SLOT);
    writeI64(view, p + 16, 0n);
    if (largeImage) {
      writeU64(view, Number(jumpSlots[i] - BASE), RESOLVER);
    }
  }

  // .dynsym: index 0 = STN_UNDEF, 1..N = undefined global STT_FUNC imports
  const symCount = symbolNames.length + 1;
  for (let i = 0; i < symbolNames.length; i++) {
    const p = DYNSYM_OFF + (i + 1) * 24;
    writeU32(view, p, dynstrOff.get(symbolNames[i]));
    bytes[p + 4] = (1 << 4) | 2; // STB_GLOBAL | STT_FUNC
    bytes[p + 5] = 0;
    view.setUint16(p + 6, 0, true); // SHN_UNDEF
    writeU64(view, p + 8, 0n);
    writeU64(view, p + 16, 0n);
  }
  bytes.set(dynstr, DYNSTR_OFF);

  // Minimal SysV DT_HASH (nbucket=1, nchain=symCount)
  writeU32(view, HASH_OFF, 1);
  writeU32(view, HASH_OFF + 4, symCount);

  if (!sectionless) {
    bytes.set(shstr, SHSTR_OFF);
    const shdr = (index, { name = '', type = 0, flags = 0n, addr = 0n, offset = 0n, size = 0n, link = 0, entsize = 0n } = {}) => {
      const p = SHOFF + index * 64;
      writeU32(view, p, name ? shName.get(name) : 0);
      writeU32(view, p + 4, type);
      writeU64(view, p + 8, flags);
      writeU64(view, p + 16, addr);
      writeU64(view, p + 24, offset);
      writeU64(view, p + 32, size);
      writeU32(view, p + 40, link);
      writeU64(view, p + 48, 8n);
      writeU64(view, p + 56, entsize);
    };
    shdr(0);
    shdr(1, { name: '.plt', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: RESOLVER, offset: BigInt(RESOLVER_OFF), size: BigInt(32 + jumpSlots.length * 16) });
    shdr(2, { name: '.dynsym', type: SHT_DYNSYM, flags: SHF_ALLOC, addr: BASE + BigInt(DYNSYM_OFF), offset: BigInt(DYNSYM_OFF), size: BigInt(symCount * 24), link: 3, entsize: 24n });
    shdr(3, { name: '.dynstr', type: SHT_STRTAB, flags: SHF_ALLOC, addr: BASE + BigInt(DYNSTR_OFF), offset: BigInt(DYNSTR_OFF), size: BigInt(dynstr.length) });
    shdr(4, { name: '.rela.plt', type: SHT_RELA, flags: SHF_ALLOC, addr: BASE + BigInt(JMPREL_OFF), offset: BigInt(JMPREL_OFF), size: BigInt(jumpSlots.length * 24), link: 2, entsize: 24n });
    shdr(5, { name: '.shstrtab', type: SHT_STRTAB, offset: BigInt(SHSTR_OFF), size: BigInt(shstr.length) });
  }

  return { bytes, jumpSlots, symbolNames };
}

test('synthetic stripped AArch64 ELF registers stub symbols for each proven PLT thunk', () => {
  const { bytes, jumpSlots, symbolNames } = buildAarch64PltElf();
  const image = parseELF(bytes);

  assert.deepEqual(image.metadata.aarch64PltResolver, { address: RESOLVER, source: 'elf-plt-structure' });
  assert.deepEqual(image.functions.map((fn) => fn.address), [RESOLVER], 'thunks must not become function seeds');

  const pltStubs = image.symbols.filter((sym) => sym.source === 'elf-plt-structure');
  assert.equal(pltStubs.length, symbolNames.length);

  const analysis = analysisFromBinaryImage(image);
  const symbolIndex = new SymbolIndex({ ...analysis });

  for (let i = 0; i < symbolNames.length; i++) {
    const thunkAddress = RESOLVER + 32n + 16n * BigInt(i);
    const stub = pltStubs.find((sym) => sym.address === thunkAddress);
    assert.ok(stub, `expected PLT stub symbol at 0x${thunkAddress.toString(16)}`);
    assert.equal(stub.name, symbolNames[i]);
    assert.equal(stub.kind, 'stub');
    assert.equal(stub.stub, true);
    assert.equal(stub.defined, true);
    assert.equal(stub.size, 16n);
    assert.equal(stub.gotAddress, jumpSlots[i]);
    assert.equal(symbolIndex.nameAt(thunkAddress), symbolNames[i]);
  }
});

test('sectionless AArch64 ELF resolves PLT thunk symbols via PT_DYNAMIC', () => {
  const { bytes, symbolNames } = buildAarch64PltElf({ sectionless: true });
  const image = parseELF(bytes);
  const symbolIndex = new SymbolIndex({ ...analysisFromBinaryImage(image) });

  for (let i = 0; i < symbolNames.length; i++) {
    const thunkAddress = RESOLVER + 32n + 16n * BigInt(i);
    assert.equal(symbolIndex.nameAt(thunkAddress), symbolNames[i]);
  }
});

test('large GOT-anchored AArch64 ELF resolves PLT thunk symbols', () => {
  const { bytes, symbolNames } = buildAarch64PltElf({ largeImage: true });
  const image = parseELF(bytes);
  assert.equal(image.metadata.aarch64PltResolver?.candidate, 'got-initial-value');
  const symbolIndex = new SymbolIndex({ ...analysisFromBinaryImage(image) });

  for (let i = 0; i < symbolNames.length; i++) {
    const thunkAddress = RESOLVER + 32n + 16n * BigInt(i);
    assert.equal(symbolIndex.nameAt(thunkAddress), symbolNames[i]);
  }
});

test('fail-closed: broken PLT structure registers no PLT thunk symbols and STN_UNDEF index is skipped', () => {
  const broken = parseELF(buildAarch64PltElf({ corruptNop: true }).bytes);
  assert.equal(broken.metadata.aarch64PltResolver, undefined);
  assert.equal(broken.symbols.filter((sym) => sym.source === 'elf-plt-structure').length, 0);

  const withUndef = parseELF(buildAarch64PltElf({ zeroSymIndexAt: 1 }).bytes);
  const symbolIndex = new SymbolIndex({ ...analysisFromBinaryImage(withUndef) });
  assert.equal(symbolIndex.nameAt(RESOLVER + 32n), 'strlen');
  assert.equal(symbolIndex.nameAt(RESOLVER + 48n), null);
  assert.equal(symbolIndex.nameAt(RESOLVER + 64n), 'fabs');
});

test('real codefuse-arm64 ELF resolves all PLT thunks and decompile uses real name and prototype', () => {
  const fixturePath = path.resolve('benchmarks/public/codefuse-arm64/inputs/00289a98b1c3c1d8f8a8ebc3d8938d20db9d0b40c0c30cac1fb6573e03d2e604.bin');
  const bytes = fs.readFileSync(fixturePath);
  const image = parseELF(bytes);
  const pltAddr = image.metadata.aarch64PltResolver?.address;
  assert.equal(typeof pltAddr, 'bigint');

  const symbolIndex = new SymbolIndex({ ...analysisFromBinaryImage(image) });
  const symbolFor = (addr) => symbolIndex.nameAt(addr) || null;

  const jumpRelocs = image.relocations.filter((rel) => Number(rel.type) === Number(R_AARCH64_JUMP_SLOT));
  assert.ok(jumpRelocs.length > 0);
  for (let i = 0; i < jumpRelocs.length; i++) {
    const thunkAddress = pltAddr + 32n + 16n * BigInt(i);
    assert.equal(symbolFor(thunkAddress), jumpRelocs[i].symbol, `thunk ${i} should resolve to ${jumpRelocs[i].symbol}`);
  }

  const strlenIndex = jumpRelocs.findIndex((rel) => rel.symbol === 'strlen');
  assert.ok(strlenIndex >= 0, 'fixture should import strlen');
  const strlenThunk = pltAddr + 32n + 16n * BigInt(strlenIndex);
  const callerBase = 0x2000n;
  const raw = [
    { row: 0, addr: callerBase, mn: 'stp', ops: 'x29, x30, [sp, #-16]!' },
    { row: 1, addr: callerBase + 4n, mn: 'mov', ops: 'x29, sp' },
    { row: 2, addr: callerBase + 8n, mn: 'bl', ops: `#0x${strlenThunk.toString(16)}` },
    { row: 3, addr: callerBase + 12n, mn: 'ldp', ops: 'x29, x30, [sp], #16' },
    { row: 4, addr: callerBase + 16n, mn: 'ret', ops: '' },
  ];
  const model = buildSemanticModel(raw, {
    startRow: 0,
    endRow: 4,
    symbolFor,
    rowOfAddress: (a) => (a >= callerBase && a <= callerBase + 16n ? Number((a - callerBase) / 4n) : -1),
    name: 'caller_strlen',
  });
  const dec = decompile(model, { symbolFor, arch: 'arm64' });
  const output = dec.lines ? dec.lines.map((l) => l.text).join('\n') : String(dec.code || '');
  assert.match(output, /\bstrlen\s*\(/, 'decompile output should call strlen by name');
  assert.doesNotMatch(output, new RegExp(`sub_${strlenThunk.toString(16)}`, 'i'), 'decompile output must not fall back to sub_<HEX>');
});
