import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFunctions,
  linkWasmStructuralHints,
} from '../js/analysis/wasm-xref-linker.js';

// ARM64 encoding helpers for synthetic test programs.
function encAdrp(rd, pcVa, targetPageVa) {
  const deltaPages = Number((targetPageVa - (pcVa & ~0xFFFn)) >> 12n);
  const imm21 = deltaPages & 0x1FFFFF;
  const immlo = imm21 & 3;
  const immhi = (imm21 >>> 2) & 0x7FFFF;
  return (0x90000000 | (immlo << 29) | (immhi << 5) | (rd & 31)) >>> 0;
}

function encAdr(rd, pcVa, targetVa) {
  const delta = Number(targetVa - pcVa);
  const imm21 = delta & 0x1FFFFF;
  const immlo = imm21 & 3;
  const immhi = (imm21 >>> 2) & 0x7FFFF;
  return (0x10000000 | (immlo << 29) | (immhi << 5) | (rd & 31)) >>> 0;
}

function encAddImm64(rd, rn, imm12, shift = 0) {
  return (0x91000000 | ((shift & 1) << 22) | ((imm12 & 0xFFF) << 10) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
}

function encAddImm32(rd, rn, imm12, shift = 0) {
  return (0x11000000 | ((shift & 1) << 22) | ((imm12 & 0xFFF) << 10) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
}

function encLdrF32(rt, rn, byteOff) {
  const imm12 = (byteOff >>> 2) & 0xFFF;
  return (0xBD400000 | (imm12 << 10) | ((rn & 31) << 5) | (rt & 31)) >>> 0;
}

function encLdrF64(rt, rn, byteOff) {
  const imm12 = (byteOff >>> 3) & 0xFFF;
  return (0xFD400000 | (imm12 << 10) | ((rn & 31) << 5) | (rt & 31)) >>> 0;
}

function encBl(relInsns = 1) {
  return (0x94000000 | (relInsns & 0x03FFFFFF)) >>> 0;
}

function encMovz64(rd, imm16 = 0) {
  return (0xD2800000 | ((imm16 & 0xFFFF) << 5) | (rd & 31)) >>> 0;
}

const NOP = 0xD503201F;

function packInsns(words) {
  const u8 = new Uint8Array(words.length * 4);
  const dv = new DataView(u8.buffer);
  for (let i = 0; i < words.length; i++) {
    dv.setUint32(i * 4, words[i] >>> 0, true);
  }
  return u8;
}

test('1. Vtable firstFnVa links to containing function with vtable_member tag', () => {
  const functions = [
    { start: 0x1000n, end: 0x1040n, name: 'Player::update' },
    { start: 0x1040n, end: 0x1080n, name: 'Enemy::update' },
  ];
  const vtables = {
    vtables: [
      {
        vtableOff: 0x200,
        va: 0x20200n,
        firstFnVa: 0x1008n,
        entryCount: 6,
        hasRtti: true,
        encoding: 'absolute',
        section: '__DATA_CONST,__const',
      },
      {
        vtableOff: 0x300,
        va: 0x20300n,
        firstFnVa: 0x9999n, // Unmatched VA should be ignored safely.
        entryCount: 3,
        hasRtti: false,
      },
    ],
  };

  const res = linkWasmStructuralHints({ functions, vtables });
  assert.equal(res.stats.functionsInput, 2);
  assert.equal(res.stats.functionsLinked, 1);
  assert.equal(res.stats.vtableLinks, 1);
  assert.equal(res.stats.constTableLinks, 0);

  const entry = res.byFunction['0x1000'];
  assert.ok(entry);
  assert.equal(entry.name, 'Player::update');
  assert.deepEqual(entry.tags, ['vtable_member']);
  assert.equal(entry.vtableRefs.length, 1);
  assert.deepEqual(entry.vtableRefs[0], {
    vtableOff: 0x200,
    vtableVa: 0x20200n,
    entryCount: 6,
    hasRtti: true,
    encoding: 'absolute',
    section: '__DATA_CONST,__const',
  });
});

test('2. Interleaved ADRP X8; ADRP X9; ADD X8; ADD X9 resolves both 64-bit const tables', () => {
  const textVa = 0x10000n;
  const pageA = 0x20000n;
  const pageB = 0x21000n;
  const tableA = pageA + 0x120n;
  const tableB = pageB + 0x240n;

  const codeBytes = packInsns([
    encAdrp(8, textVa + 0n, pageA),
    encAdrp(9, textVa + 4n, pageB),
    encAddImm64(8, 8, 0x120),
    encAddImm64(9, 9, 0x240),
  ]);

  const res = linkWasmStructuralHints({
    codeBytes,
    textVa,
    functions: [{ start: textVa, end: textVa + 0x20n, name: 'initTables' }],
    constTables: [
      { va: tableA, byteLen: 32, kind: 1, elementCount: 8, elemSize: 4, stride: 4 },
      { va: tableB, byteLen: 64, kind: 2, elementCount: 8, elemSize: 8, stride: 8 },
    ],
  });

  assert.equal(res.skippedCodeScan, false);
  assert.equal(res.stats.scannedInsns, 4);
  assert.equal(res.stats.constTableLinks, 2);

  const entry = res.byFunction['0x10000'];
  assert.ok(entry);
  assert.equal(entry.constTableRefs.length, 2);
  assert.equal(entry.constTableRefs[0].tableVa, tableA);
  assert.equal(entry.constTableRefs[1].tableVa, tableB);
  assert.deepEqual(entry.tags, ['const_f32_ref', 'const_f64_ref']);
});

test('3. ADRP + LDR S/D resolves f32 and f64 const tables and deduplicates per (tableVa, kind)', () => {
  const textVa = 0x10000n;
  const dataPage = 0x30000n;
  const f32Va = dataPage + 0x40n;
  const f64Va = dataPage + 0x100n;

  const codeBytes = packInsns([
    encAdrp(10, textVa + 0n, dataPage),
    encLdrF32(0, 10, 0x40),
    encLdrF32(1, 10, 0x44), // Same f32 table -> deduplicated
    encLdrF64(2, 10, 0x100),
  ]);

  const res = linkWasmStructuralHints({
    codeBytes,
    textVa,
    functions: [{ start: textVa, end: textVa + 0x20n, name: 'calcPhysics' }],
    constTables: {
      tables: [
        { va: f32Va, byteLen: 32, kind: 1, elementCount: 8, elemSize: 4, stride: 4 },
        { va: f64Va, byteLen: 64, kind: 2, elementCount: 8, elemSize: 8, stride: 8 },
      ],
    },
  });

  assert.equal(res.stats.constTableLinks, 2);
  const entry = res.byFunction['0x10000'];
  assert.equal(entry.constTableRefs.length, 2);
  assert.deepEqual(entry.tags, ['const_f32_ref', 'const_f64_ref']);
});

test('4. ADR resolves strided_id const table with const_strided_id_ref tag', () => {
  const textVa = 0x10000n;
  const stridedVa = textVa + 0x200n;

  const codeBytes = packInsns([
    NOP,
    encAdr(1, textVa + 4n, stridedVa),
  ]);

  const res = linkWasmStructuralHints({
    codeBytes,
    textVa,
    functions: [{ start: textVa, end: textVa + 0x40n, name: 'lookupItemId' }],
    constTables: [
      { va: stridedVa, byteLen: 128, kind: 3, elementCount: 8, elemSize: 4, stride: 16 },
    ],
  });

  assert.equal(res.stats.constTableLinks, 1);
  const entry = res.byFunction['0x10000'];
  assert.ok(entry);
  assert.deepEqual(entry.tags, ['const_strided_id_ref']);
  assert.equal(entry.constTableRefs[0].tableVa, stridedVa);
  assert.equal(entry.constTableRefs[0].kind, 3);
});

test('5. 32-bit ADD (sf=0) and SP destination (rd=31) are not mis-resolved', () => {
  const textVa = 0x10000n;
  const dataPage = 0x40000n;
  const tblVa = dataPage + 0x80n;

  const codeBytes = packInsns([
    encAdrp(8, textVa + 0n, dataPage),
    encAddImm32(8, 8, 0x80),   // 32-bit ADD W8, W8, #0x80 (sf === 0) -> must not resolve
    encAdrp(9, textVa + 8n, dataPage),
    encAddImm64(31, 9, 0x80),  // ADD SP, X9, #0x80 (rd === 31) -> must not resolve
    encAdr(31, textVa + 16n, textVa + 0x100n), // ADR XZR/SP -> must not resolve
  ]);

  const res = linkWasmStructuralHints({
    codeBytes,
    textVa,
    functions: [{ start: textVa, end: textVa + 0x40n, name: 'guardTest' }],
    constTables: [
      { va: tblVa, byteLen: 32, kind: 1 },
      { va: textVa + 0x100n, byteLen: 32, kind: 3 },
    ],
  });

  assert.equal(res.stats.constTableLinks, 0);
  assert.equal(res.stats.functionsLinked, 0);
});

test('6. BL call and register overwrite invalidate pending ADRP tracking', () => {
  const textVa = 0x10000n;
  const dataPage = 0x50000n;
  const tblVa = dataPage + 0x60n;

  const codeBytes = packInsns([
    // Case A: invalidated by BL
    encAdrp(8, textVa + 0n, dataPage),
    encBl(4),
    encAddImm64(8, 8, 0x60),
    // Case B: invalidated by MOVZ X9, #0
    encAdrp(9, textVa + 12n, dataPage),
    encMovz64(9, 0),
    encAddImm64(9, 9, 0x60),
  ]);

  const res = linkWasmStructuralHints({
    codeBytes,
    textVa,
    functions: [{ start: textVa, end: textVa + 0x40n, name: 'clobbered' }],
    constTables: [{ va: tblVa, byteLen: 32, kind: 1 }],
  });

  assert.equal(res.stats.constTableLinks, 0);
  assert.equal(res.stats.functionsLinked, 0);
});

test('7. ConstTable missing va falls back to dataVa + startOff; skips safely when both null', () => {
  const textVa = 0x10000n;
  const dataVa = 0x60000n;
  const startOff = 0x140;
  const codeBytes = packInsns([
    encAdrp(8, textVa + 0n, dataVa),
    encAddImm64(8, 8, startOff),
  ]);

  // Fallback to dataVa + startOff works.
  const resWithDataVa = linkWasmStructuralHints({
    codeBytes,
    textVa,
    dataVa,
    functions: [{ start: textVa, end: textVa + 0x20n }],
    constTables: [{ startOff, byteLen: 32, kind: 1 }],
  });
  assert.equal(resWithDataVa.stats.constTableLinks, 1);
  assert.equal(resWithDataVa.byFunction['0x10000'].constTableRefs[0].tableVa, dataVa + BigInt(startOff));

  // Both va and dataVa null -> skips without crashing.
  const resNoVa = linkWasmStructuralHints({
    codeBytes,
    textVa,
    dataVa: null,
    functions: [{ start: textVa, end: textVa + 0x20n }],
    constTables: [{ startOff, byteLen: 32, kind: 1 }],
  });
  assert.equal(resNoVa.stats.constTableLinks, 0);
  assert.equal(resNoVa.skippedCodeScan, true);
});

test('8. Non-ARM64 sets skippedCodeScan=true while still linking Vtables', () => {
  const textVa = 0x10000n;
  const dataPage = 0x70000n;
  const codeBytes = packInsns([
    encAdrp(8, textVa + 0n, dataPage),
    encAddImm64(8, 8, 0x20),
  ]);

  const res = linkWasmStructuralHints({
    arch: 'x86_64',
    codeBytes,
    textVa,
    functions: [{ start: textVa, end: textVa + 0x40n, name: 'X64Class::run' }],
    vtables: [{ vtableOff: 0x10, va: 0x80010n, firstFnVa: textVa, entryCount: 4, hasRtti: true }],
    constTables: [{ va: dataPage + 0x20n, byteLen: 32, kind: 1 }],
  });

  assert.equal(res.skippedCodeScan, true);
  assert.equal(res.stats.scannedInsns, 0);
  assert.equal(res.stats.constTableLinks, 0);
  assert.equal(res.stats.vtableLinks, 1);
  assert.deepEqual(res.byFunction['0x10000'].tags, ['vtable_member']);
});

test('9. normalizeFunctions handles SymbolIndex, ProgramIndex, {va,size}, {start,end}, and raw addresses', () => {
  // SymbolIndex-like with BigUint64Array + functionList
  const symIdx = {
    funcs: new BigUint64Array([0x2000n, 0x1000n, 0x1000n]),
    functionList() {
      return [
        { addr: 0x1000n, name: 'fnA', size: 0x40n },
        { addr: 0x2000n, name: 'fnB', size: null },
      ];
    },
  };
  const fromSym = normalizeFunctions(symIdx, 0x2100n);
  assert.deepEqual(fromSym, [
    { start: 0x1000n, end: 0x1040n, name: 'fnA' },
    { start: 0x2000n, end: 0x2100n, name: 'fnB' },
  ]);

  // ProgramIndex-like with functionRange + symbols
  const progIdx = {
    symbols: { funcs: [0x3000n, 0x3080n] },
    functionRange(va) {
      if (va === 0x3000n) return { start: 0x3000n, end: 0x3050n, name: 'progA' };
      return null;
    },
  };
  const fromProg = normalizeFunctions(progIdx);
  assert.deepEqual(fromProg, [
    { start: 0x3000n, end: 0x3050n, name: 'progA' },
    { start: 0x3080n, end: 0x3084n, name: null },
  ]);

  // { va, size } and { addr, size } and raw numbers
  const fromVaSize = normalizeFunctions([
    { va: 0x4080, size: 0x20, name: 'vaFn' },
    { addr: 0x4000n },
  ]);
  assert.deepEqual(fromVaSize, [
    { start: 0x4000n, end: 0x4080n, name: null },
    { start: 0x4080n, end: 0x40a0n, name: 'vaFn' },
  ]);

  const fromRaw = normalizeFunctions([0x5020, 0x5000n, 0x5000]);
  assert.deepEqual(fromRaw, [
    { start: 0x5000n, end: 0x5020n, name: null },
    { start: 0x5020n, end: 0x5024n, name: null },
  ]);
});

test('10. arm64e architecture is accepted for ARM64 const-table xref scanning', () => {
  const textVa = 0x100004000n;
  // adrp x8, #12 pages (0x100010000); add x8, x8, #0; ret
  const codeBytes = new Uint8Array(12);
  const dv = new DataView(codeBytes.buffer);
  dv.setUint32(0, 0x90000068, true);
  dv.setUint32(4, 0x91000108, true);
  dv.setUint32(8, 0xd65f03c0, true);

  const res = linkWasmStructuralHints({
    codeBytes,
    textVa,
    functions: [{ start: textVa, end: textVa + 12n, name: 'fn_arm64e' }],
    constTables: [{ startOff: 0, byteLen: 32, kind: 1, va: 0x100010000n }],
    arch: 'arm64e',
  });
  assert.equal(res.skippedCodeScan, false);
  assert.equal(res.stats.constTableLinks, 1);
  const fn = res.byFunction['0x100004000'];
  assert.ok(fn);
  assert.ok(fn.tags.includes('const_f32_ref'));
});
