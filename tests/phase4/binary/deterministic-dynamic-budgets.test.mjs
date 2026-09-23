import test from 'node:test';
import assert from 'node:assert/strict';

import { createDynamicSymbolBudget } from '../../../js/binary/dynamic-symbol-budget.js';
import { createRelocationBudget } from '../../../js/binary/relocation-budget.js';
import { parseELF } from '../../../js/binary/elf.js';

test('deterministic budgets: dynamic symbol budget without maxWallMs never stops for wall-clock reasons', () => {
  let tick = 0;
  // Clock jumps +10 minutes (600,000 ms) per call
  const now = () => {
    const v = tick;
    tick += 600_000;
    return v;
  };

  const budget = createDynamicSymbolBudget({ limits: { now } });
  assert.equal(budget.limits.maxWallMs, Infinity);
  assert.equal(budget.snapshot().maxWallMs, null);

  // Exercise checkWall and step/operation path many times
  for (let i = 0; i < 10000; i++) {
    assert.equal(budget.checkWall(), true);
    assert.equal(budget.step(1), true);
  }
  assert.equal(budget.stopped, false);
  assert.equal(budget.reason, null);

  // With explicit maxWallMs: 5 it still stops with wall-clock reason
  tick = 0;
  let limitMessage = '';
  const boundedBudget = createDynamicSymbolBudget({
    limits: { maxWallMs: 5, now },
    onLimit: (msg) => { limitMessage = msg; },
  });
  assert.equal(boundedBudget.limits.maxWallMs, 5);
  assert.equal(boundedBudget.snapshot().maxWallMs, 5);
  assert.equal(boundedBudget.step(1), false);
  assert.equal(boundedBudget.stopped, true);
  assert.match(boundedBudget.reason, /wall-clock budget/);
  assert.match(limitMessage, /wall-clock budget/);
});

test('deterministic budgets: relocation budget without maxWallMs never stops for wall-clock reasons', () => {
  let tick = 0;
  const now = () => {
    const v = tick;
    tick += 600_000;
    return v;
  };

  const budget = createRelocationBudget({ limits: { now } });
  assert.equal(budget.limits.maxWallMs, Infinity);
  assert.equal(budget.snapshot().maxWallMs, null);

  for (let i = 0; i < 10000; i++) {
    assert.equal(budget.step(1), true);
  }
  assert.equal(budget.stopped, false);
  assert.equal(budget.reason, null);

  // With explicit maxWallMs: 5 it still stops with wall-clock reason
  tick = 0;
  let limitMessage = '';
  const boundedBudget = createRelocationBudget({
    limits: { maxWallMs: 5, now },
    onLimit: (msg) => { limitMessage = msg; },
  });
  assert.equal(boundedBudget.limits.maxWallMs, 5);
  assert.equal(boundedBudget.snapshot().maxWallMs, 5);
  assert.equal(boundedBudget.step(1), false);
  assert.equal(boundedBudget.stopped, true);
  assert.match(boundedBudget.reason, /decode time exceeds 5 ms/);
  assert.match(limitMessage, /decode time exceeds 5 ms/);
});

test('deterministic budgets: synthetic ELF with 3000 dynamic symbols parses fully without budget diagnostics', () => {
  // Build a synthetic ELF with 3000 dynamic symbols.
  // Layout:
  // [0, 64): ELF header (ET_DYN, x86-64, 2 phdrs)
  // [64, 64 + 2 * 56): phdrs (PT_LOAD, PT_DYNAMIC)
  // [0x100, ...): strtab ('\0foo\0')
  // [0x200, ...): dynamic table (DT_STRTAB, DT_SYMTAB, DT_STRSZ, DT_SYMENT, DT_SYMTABSZ, DT_NULL)
  // [...]: symtab (3000 symbols * 24 bytes)
  const symbolCount = 3000;
  const ehsize = 64;
  const phentsize = 56;
  const phnum = 2;
  const strtab = Buffer.from('\0foo\0', 'latin1');
  const strtabOffset = 0x100;
  const dynamicOffset = 0x200;
  const dynamicEntries = 6;
  const dynamicSize = dynamicEntries * 16;
  const symtabOffset = dynamicOffset + dynamicSize;
  const symtabSize = symbolCount * 24;
  const totalSize = symtabOffset + symtabSize;

  const vaBase = 0x400000n;
  const buf = Buffer.alloc(totalSize);

  // ELF Header (64-bit, little-endian)
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  buf.writeUInt16LE(3, 16); // ET_DYN
  buf.writeUInt16LE(62, 18); // x86-64
  buf.writeUInt32LE(1, 20); // e_version
  buf.writeBigUInt64LE(0n, 24); // e_entry
  buf.writeBigUInt64LE(BigInt(ehsize), 32); // e_phoff
  buf.writeBigUInt64LE(0n, 40); // e_shoff
  buf.writeUInt32LE(0, 48); // e_flags
  buf.writeUInt16LE(ehsize, 52); // e_ehsize
  buf.writeUInt16LE(phentsize, 54); // e_phentsize
  buf.writeUInt16LE(phnum, 56); // e_phnum

  // Phdr 0: PT_LOAD covering whole file
  const p0 = ehsize;
  buf.writeUInt32LE(1, p0 + 0); // PT_LOAD
  buf.writeUInt32LE(5, p0 + 4); // PF_R | PF_X
  buf.writeBigUInt64LE(0n, p0 + 8); // p_offset
  buf.writeBigUInt64LE(vaBase, p0 + 16); // p_vaddr
  buf.writeBigUInt64LE(vaBase, p0 + 24); // p_paddr
  buf.writeBigUInt64LE(BigInt(totalSize), p0 + 32); // p_filesz
  buf.writeBigUInt64LE(BigInt(totalSize), p0 + 40); // p_memsz
  buf.writeBigUInt64LE(0x1000n, p0 + 48); // p_align

  // Phdr 1: PT_DYNAMIC
  const p1 = ehsize + phentsize;
  buf.writeUInt32LE(2, p1 + 0); // PT_DYNAMIC
  buf.writeUInt32LE(6, p1 + 4); // PF_R | PF_W
  buf.writeBigUInt64LE(BigInt(dynamicOffset), p1 + 8);
  buf.writeBigUInt64LE(vaBase + BigInt(dynamicOffset), p1 + 16);
  buf.writeBigUInt64LE(vaBase + BigInt(dynamicOffset), p1 + 24);
  buf.writeBigUInt64LE(BigInt(dynamicSize), p1 + 32);
  buf.writeBigUInt64LE(BigInt(dynamicSize), p1 + 40);
  buf.writeBigUInt64LE(8n, p1 + 48);

  // String table
  buf.set(strtab, strtabOffset);

  // Dynamic entries
  let d = dynamicOffset;
  const writeDyn = (tag, val) => {
    buf.writeBigInt64LE(BigInt(tag), d);
    buf.writeBigUint64LE(BigInt(val), d + 8);
    d += 16;
  };
  writeDyn(5, vaBase + BigInt(strtabOffset)); // DT_STRTAB
  writeDyn(6, vaBase + BigInt(symtabOffset)); // DT_SYMTAB
  writeDyn(10, strtab.length); // DT_STRSZ
  writeDyn(11, 24); // DT_SYMENT
  writeDyn(39, symtabSize); // DT_SYMTABSZ
  writeDyn(0, 0); // DT_NULL

  // Symbols: symbol 0 null; symbols 1..2999 valid st_name pointing to 'foo' (offset 1)
  for (let i = 1; i < symbolCount; i++) {
    const s = symtabOffset + i * 24;
    buf.writeUInt32LE(1, s + 0); // st_name -> 'foo'
    buf.writeUInt8(0x12, s + 4); // STB_GLOBAL | STT_FUNC
    buf.writeUInt8(0, s + 5); // st_other
    buf.writeUInt16LE(1, s + 6); // st_shndx (non-zero)
    buf.writeBigUint64LE(vaBase + 0x1000n, s + 8); // st_value
    buf.writeBigUint64LE(4n, s + 16); // st_size
  }

  const image = parseELF(buf);
  // Symbol count (excluding canonical null sym or including? check image.symbols)
  // Let's verify: parseDynamicSymbols parses `symbolCount` entries (0..2999).
  // Symbol 0 is null so image.symbols will have 2999 symbols.
  // The requirement states: "symbol count equals the dynsym count and metadata has no 'budget exceeded' diagnostic"
  // Let's check image.metadata.programDynamic.symbols vs symbolCount
  assert.equal(image.metadata.programDynamic.symbols, symbolCount);
  assert.equal(image.symbols.length, symbolCount - 1);
  const diagnostics = [
    ...(image.metadata.programDynamicDiagnostics || []),
    ...(image.warnings || []),
  ].join('\n');
  assert.doesNotMatch(diagnostics, /budget exceeded/i);
});
