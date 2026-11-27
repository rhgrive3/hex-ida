import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { scanArm64JumpTables } from '../js/analysis/wasm-jumptable-scanner.js';

const NOP = 0xD503201F;
const RET = 0xD65F03C0;

function encCmpImm32(rn, imm12) {
  return (0x7100001F | ((imm12 & 0xFFF) << 10) | ((rn & 31) << 5)) >>> 0;
}

function encBCond(cond, imm19) {
  return (0x54000000 | ((imm19 & 0x7FFFF) << 5) | (cond & 0xF)) >>> 0;
}

function encBHi(imm19 = 8) {
  return encBCond(8, imm19);
}

function encBHs(imm19 = 8) {
  return encBCond(2, imm19);
}

function encAdrp(rd, pageDeltaPages) {
  const u21 = pageDeltaPages & 0x1FFFFF;
  const immlo = u21 & 3;
  const immhi = (u21 >>> 2) & 0x7FFFF;
  return (0x90000000 | (immlo << 29) | (immhi << 5) | (rd & 31)) >>> 0;
}

function encAdr(rd, byteDelta) {
  const u21 = byteDelta & 0x1FFFFF;
  const immlo = u21 & 3;
  const immhi = (u21 >>> 2) & 0x7FFFF;
  return (0x10000000 | (immlo << 29) | (immhi << 5) | (rd & 31)) >>> 0;
}

function encAddImm64(rd, rn, imm12) {
  return (0x91000000 | ((imm12 & 0xFFF) << 10) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
}

function encLdrswReg(rt, rn, rm) {
  // ldrsw Xt, [Xn, Xm, lsl #2] -> size=2, V=0, opc=2, option=3 (LSL/UXTX), S=1
  return (0xB8A07800 | ((rm & 31) << 16) | ((rn & 31) << 5) | (rt & 31)) >>> 0;
}

function encLdr64Reg(rt, rn, rm) {
  // ldr Xt, [Xn, Xm, lsl #3] -> size=3, V=0, opc=1, option=3, S=1
  return (0xF8607800 | ((rm & 31) << 16) | ((rn & 31) << 5) | (rt & 31)) >>> 0;
}

function encAddReg64(rd, rn, rm) {
  return (0x8B000000 | ((rm & 31) << 16) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
}

function encBr(rn) {
  return (0xD61F0000 | ((rn & 31) << 5)) >>> 0;
}

function packInsns(words) {
  const buf = new Uint8Array(words.length * 4);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < words.length; i++) {
    dv.setUint32(i * 4, words[i] >>> 0, true);
  }
  return buf;
}

function loadStandaloneWasmExports() {
  const wasmPath = process.env.HEX_TEST_STANDALONE_WASM;
  if (!wasmPath) return null;
  const bytes = fs.readFileSync(wasmPath);
  const mod = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(mod);
  assert.equal(imports.length, 0, `standalone WASM must have zero imports, got ${imports.length}`);
  const inst = new WebAssembly.Instance(mod, {});
  return inst.exports;
}

const standaloneWasm = loadStandaloneWasmExports();

function runBothEngines(bytes, opts = {}) {
  const wasmRes = scanArm64JumpTables(bytes, {
    ...opts,
    ...(standaloneWasm ? { wasmExports: standaloneWasm } : {}),
  });
  const jsRes = scanArm64JumpTables(bytes, {
    ...opts,
    engine: 'js',
    ...(standaloneWasm ? { wasmExports: standaloneWasm } : {}),
  });
  if (opts.arch == null || opts.arch === 'arm64') {
    assert.equal(wasmRes.engine, 'wasm');
  }
  assert.equal(jsRes.engine, 'js');
  assert.deepEqual(wasmRes.tables, jsRes.tables);
  assert.equal(wasmRes.truncated, jsRes.truncated);
  assert.equal(wasmRes.unsupportedArch, jsRes.unsupportedArch);
  return { wasmRes, jsRes };
}

test('1. detects classic clang/GCC PIC jump table (cmp + b.hi + adrp/add + ldrsw + adr + add + br)', () => {
  const textVa = 0x100004000n;
  const code = packInsns([
    encCmpImm32(0, 5),          // 0x00: cmp w0, #5
    encBHi(10),                 // 0x04: b.hi default
    encAdrp(8, 2),              // 0x08: adrp x8, +2 pages (pc=0x100004008 -> page=0x100006000)
    encAddImm64(8, 8, 0x240),   // 0x0C: add x8, x8, #0x240 -> 0x100006240
    encLdrswReg(9, 8, 0),       // 0x10: ldrsw x9, [x8, x0, lsl #2]
    encAdr(10, 0x10),           // 0x14: adr x10, base
    encAddReg64(9, 10, 9),      // 0x18: add x9, x10, x9
    encBr(9),                   // 0x1C: br x9
  ]);

  const { wasmRes } = runBothEngines(code, { textVa });
  assert.equal(wasmRes.unsupportedArch, false);
  assert.equal(wasmRes.truncated, false);
  assert.equal(wasmRes.tables.length, 1);

  const t = wasmRes.tables[0];
  assert.deepEqual(t, {
    brOff: 0x1C,
    cmpOff: 0x00,
    entryCount: 6,
    tableVa: 0x100006240n,
    elemWidth: 4,
    indexReg: 0,
    targetReg: 9,
    hasBounds: true,
    relativeAdd: true,
    hasTableVa: true,
    flags: 7,
  });
});

test('2. detects b.hs bounds (entryCount === imm) and standalone adr table base', () => {
  const textVa = 0x400100n;
  const code = packInsns([
    encCmpImm32(2, 8),          // 0x00: cmp w2, #8
    encBHs(12),                 // 0x04: b.hs default (8 entries: 0..7)
    encAdr(11, 0x80),           // 0x08: adr x11, pc+0x80 (pc=0x400108 -> 0x400188)
    encLdr64Reg(12, 11, 2),     // 0x0C: ldr x12, [x11, x2, lsl #3]
    encBr(12),                  // 0x10: br x12
  ]);

  const { wasmRes } = runBothEngines(code, { textVa });
  assert.equal(wasmRes.tables.length, 1);
  assert.deepEqual(wasmRes.tables[0], {
    brOff: 0x10,
    cmpOff: 0x00,
    entryCount: 8,
    tableVa: 0x400188n,
    elemWidth: 8,
    indexReg: 2,
    targetReg: 12,
    hasBounds: true,
    relativeAdd: false,
    hasTableVa: true,
    flags: 5,
  });
});

test('3. detects unbounded br with indexed load + table VA, and ignores bare br / br x30 / post-ret', () => {
  const textVa = 0x200000n;
  const code = packInsns([
    // Unbounded jump table (no cmp/b.hi)
    encAdrp(4, 1),              // 0x00: adrp x4, +1 page (0x201000)
    encAddImm64(4, 4, 0x10),    // 0x04: add x4, x4, #0x10 -> 0x201010
    encLdr64Reg(5, 4, 1),       // 0x08: ldr x5, [x4, x1, lsl #3]
    encBr(5),                   // 0x0C: br x5
    RET,                        // 0x10: ret (barrier)
    // Bare br x6 after ret -> must NOT inherit anything before ret and must not be emitted
    NOP,                        // 0x14
    encBr(6),                   // 0x18: br x6
    // br x30 must be ignored even if preceded by load
    encLdr64Reg(30, 4, 1),      // 0x1C
    encBr(30),                  // 0x20: br x30
  ]);

  const { wasmRes } = runBothEngines(code, { textVa });
  assert.equal(wasmRes.tables.length, 1);
  assert.deepEqual(wasmRes.tables[0], {
    brOff: 0x0C,
    cmpOff: 0xFFFFFFFF,
    entryCount: 0,
    tableVa: 0x201010n,
    elemWidth: 8,
    indexReg: 1,
    targetReg: 5,
    hasBounds: false,
    relativeAdd: false,
    hasTableVa: true,
    flags: 4,
  });
});

test('4. chunk boundary crossing preserves exact chunkTextVa and deduplicates by popcount(flags)', () => {
  // Use small chunkSize = 256 (OVERLAP = 128).
  // Chunk 0: [0, 256), Chunk 1: [128, 384), Chunk 2: [256, 512).
  // Place a jump table straddling offset 256 so chunk 0 misses br, chunk 1 sees full pattern,
  // and chunk 2 sees only tail of pattern (fewer flags) -> chunk 1 must win and compute exact tableVa.
  const totalInsns = 128; // 512 bytes
  const words = new Array(totalInsns).fill(NOP);

  // Jump table A straddling 256 (0x100):
  // cmp at 0xEC (idx 59), b.hi at 0xF0 (idx 60), adrp at 0xF4 (idx 61),
  // add_imm at 0xF8 (idx 62), ldrsw at 0xFC (idx 63), adr at 0x100 (idx 64),
  // add_reg at 0x104 (idx 65), br at 0x108 (idx 66).
  words[59] = encCmpImm32(3, 9);          // 0x0EC: cmp w3, #9 (10 entries)
  words[60] = encBHi(6);                  // 0x0F0: b.hi
  words[61] = encAdrp(8, 3);              // 0x0F4: adrp x8, +3 pages
  words[62] = encAddImm64(8, 8, 0x48);    // 0x0F8: add x8, x8, #0x48
  words[63] = encLdrswReg(9, 8, 3);       // 0x0FC: ldrsw x9, [x8, x3, lsl #2]
  words[64] = encAdr(10, 0x10);           // 0x100: adr x10, base
  words[65] = encAddReg64(9, 10, 9);      // 0x104: add x9, x10, x9
  words[66] = encBr(9);                   // 0x108: br x9

  // Jump table B well inside chunk 2 (> 0x140) to test non-zero chunkTextVa with page crossing:
  // textVa = 0x100000F80n -> insn at 0x160 has pc = 0x1000010E0 (next 4KB page!)
  words[86] = encCmpImm32(1, 4);          // 0x158: cmp w1, #4 (5 entries)
  words[87] = encBHi(6);                  // 0x15C: b.hi
  words[88] = encAdrp(7, 1);              // 0x160: adrp x7, +1 page (pc=0x1000010E0 -> page 0x100002000)
  words[89] = encAddImm64(7, 7, 0x120);   // 0x164: add x7, x7, #0x120 -> 0x100002120
  words[90] = encLdr64Reg(14, 7, 1);      // 0x168: ldr x14, [x7, x1, lsl #3]
  words[91] = encBr(14);                  // 0x16C: br x14

  const code = packInsns(words);
  const textVa = 0x100000F80n;

  // Compare chunked (chunkSize=256) against unchunked (default) in both WASM and JS
  const { wasmRes: chunkedWasm } = runBothEngines(code, { textVa, chunkSize: 256 });
  const { wasmRes: singleWasm } = runBothEngines(code, { textVa });

  assert.deepEqual(chunkedWasm.tables, singleWasm.tables);
  assert.equal(chunkedWasm.tables.length, 2);

  // Table A: adrp at 0xF4 -> pc = 0x100000F80 + 0xF4 = 0x100001074 -> page 0x100001000 + 0x3000 + 0x48 = 0x100004048
  assert.equal(chunkedWasm.tables[0].brOff, 0x108);
  assert.equal(chunkedWasm.tables[0].cmpOff, 0xEC);
  assert.equal(chunkedWasm.tables[0].entryCount, 10);
  assert.equal(chunkedWasm.tables[0].tableVa, 0x100004048n);
  assert.equal(chunkedWasm.tables[0].flags, 7);

  // Table B: adrp at 0x160 -> pc = 0x100000F80 + 0x160 = 0x1000010E0 -> page 0x100001000 + 0x1000 + 0x120 = 0x100002120
  assert.equal(chunkedWasm.tables[1].brOff, 0x16C);
  assert.equal(chunkedWasm.tables[1].cmpOff, 0x158);
  assert.equal(chunkedWasm.tables[1].entryCount, 5);
  assert.equal(chunkedWasm.tables[1].tableVa, 0x100002120n);
  assert.equal(chunkedWasm.tables[1].flags, 5);
});

test('5. non-ARM64 architecture guard returns unsupportedArch: true', () => {
  const code = packInsns([encCmpImm32(0, 5), encBHi(4), encBr(9)]);
  for (const arch of ['x86_64', 'x86-64', 'riscv64', 'arm']) {
    const res = scanArm64JumpTables(code, {
      arch,
      ...(standaloneWasm ? { wasmExports: standaloneWasm } : {}),
    });
    assert.deepEqual(res, {
      tables: [],
      engine: 'js',
      truncated: false,
      unsupportedArch: true,
    });
  }
});

test('6. WASM engine is active when HEX_TEST_STANDALONE_WASM is set and matches JS identically', () => {
  const textVa = 0x0000000180001000n;
  const code = packInsns([
    encCmpImm32(4, 15),
    encBHi(8),
    encAdrp(12, -1),            // negative page delta: 0x180001000 - 0x1000 = 0x180000000
    encAddImm64(12, 12, 0x80),  // 0x180000080
    encLdrswReg(13, 12, 4),
    encAdr(14, 0x08),
    encAddReg64(13, 13, 14),    // reversed operand order (rn=13, rm=14)
    encBr(13),
  ]);

  const { wasmRes, jsRes } = runBothEngines(code, { textVa });
  assert.equal(wasmRes.engine, 'wasm');
  assert.equal(jsRes.engine, 'js');
  assert.deepEqual(wasmRes.tables, jsRes.tables);
  assert.equal(wasmRes.tables.length, 1);
  assert.equal(wasmRes.tables[0].tableVa, 0x180000080n);
  assert.equal(wasmRes.tables[0].entryCount, 16);
  assert.equal(wasmRes.tables[0].relativeAdd, true);
  assert.equal(wasmRes.tables[0].hasBounds, true);
  assert.equal(wasmRes.tables[0].hasTableVa, true);
});

test('7. exact maxOut sets truncated=false while maxOut+1 sets truncated=true with WASM === JS parity', () => {
  const words = [];
  for (let i = 0; i < 4; i++) {
    words.push(
      encCmpImm32(2, 5 + i),
      encBHi(8),
      encAdr(11, 0x40),
      encLdr64Reg(12, 11, 2),
      encBr(12),
      RET,
    );
  }
  const code = packInsns(words);
  const textVa = 0x100000n;

  const { wasmRes: exactRes } = runBothEngines(code, { textVa, maxOut: 4 });
  assert.equal(exactRes.tables.length, 4);
  assert.equal(exactRes.truncated, false);

  const { wasmRes: truncRes } = runBothEngines(code, { textVa, maxOut: 3 });
  assert.equal(truncRes.tables.length, 3);
  assert.equal(truncRes.truncated, true);
});

test('8. multi-chunk merge exceeds legacy 1024 cap and flags single-chunk CHUNK_MAX_OUT saturation', () => {
  const totalCount = 2100;
  const words = new Uint32Array(totalCount * 6);
  for (let i = 0; i < totalCount; i++) {
    const base = i * 6;
    words[base + 0] = encCmpImm32(2, 4 + (i % 16));
    words[base + 1] = encBHi(8);
    words[base + 2] = encAdr(11, 0x40);
    words[base + 3] = encLdr64Reg(12, 11, 2);
    words[base + 4] = encBr(12);
    words[base + 5] = RET;
  }
  const code = packInsns(words);
  const textVa = 0x200000n;

  // Small chunkSize keeps per-chunk tables well below CHUNK_MAX_OUT (2048) and merges all 2100 tables
  const { wasmRes: multiRes } = runBothEngines(code, { textVa, chunkSize: 8192 });
  assert.equal(multiRes.tables.length, totalCount);
  assert.equal(multiRes.truncated, false);

  // Single-chunk scan hits CHUNK_MAX_OUT (2048) < DEFAULT_MAX_OUT (16384) and must report truncated=true
  const { wasmRes: satRes } = runBothEngines(code, { textVa });
  assert.equal(satRes.tables.length, 2048);
  assert.equal(satRes.truncated, true);
});
