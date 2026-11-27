import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scanArm64RmwFields } from '../js/analysis/wasm-rmw-scanner.js';

function loadStandaloneWasmExports() {
  const wasmPath = process.env.HEX_TEST_STANDALONE_WASM;
  if (!wasmPath) return undefined;

  const wasmBytes = fs.readFileSync(wasmPath);
  const mod = new WebAssembly.Module(wasmBytes);
  assert.strictEqual(
    WebAssembly.Module.imports(mod).length,
    0,
    'standalone track1 WASM module must have zero imports',
  );

  const inst = new WebAssembly.Instance(mod, {});
  const raw = inst.exports;
  const heapBaseVal = typeof raw.__heap_base === 'object' && raw.__heap_base !== null
    ? raw.__heap_base.value
    : raw.__heap_base;
  const heapBase = (Number(heapBaseVal) + 7) & ~7;
  assert.ok(heapBase > 0, `expected positive __heap_base, got ${heapBase}`);

  let cursor = heapBase;
  const hex_engine_scratch_reset = () => {
    cursor = heapBase;
  };
  const hex_engine_scratch_alloc = (size) => {
    const n = size >>> 0;
    if (n === 0) return 0;
    const aligned = (cursor + 7) & ~7;
    const next = aligned + n;
    if (next > raw.memory.buffer.byteLength) return 0;
    cursor = next;
    return aligned;
  };

  return {
    memory: raw.memory,
    hex_scan_arm64_rmw_fields: raw.hex_scan_arm64_rmw_fields,
    hex_engine_scratch_alloc,
    hex_engine_scratch_reset,
  };
}

const STANDALONE_EXPORTS = loadStandaloneWasmExports();

function wasmOpts(extra = {}) {
  return STANDALONE_EXPORTS ? { ...extra, wasmExports: STANDALONE_EXPORTS } : { ...extra };
}

function encodeWords(words) {
  const buf = new Uint8Array(words.length * 4);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < words.length; i++) {
    dv.setUint32(i * 4, words[i] >>> 0, true);
  }
  return buf;
}

// Common ARM64 instruction encoders for test readability
const NOP = 0xD503201F;
const BL_PLUS_0x40 = 0x94000010;
const ldrW = (rt, rn, off) => (0xB9400000 | (((off >>> 2) & 0xFFF) << 10) | ((rn & 31) << 5) | (rt & 31)) >>> 0;
const strW = (rt, rn, off) => (0xB9000000 | (((off >>> 2) & 0xFFF) << 10) | ((rn & 31) << 5) | (rt & 31)) >>> 0;
const ldrS = (rt, rn, off) => (0xBD400000 | (((off >>> 2) & 0xFFF) << 10) | ((rn & 31) << 5) | (rt & 31)) >>> 0;
const strS = (rt, rn, off) => (0xBD000000 | (((off >>> 2) & 0xFFF) << 10) | ((rn & 31) << 5) | (rt & 31)) >>> 0;
const subWReg = (rd, rn, rm) => (0x4B000000 | ((rm & 31) << 16) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
const subWImm = (rd, rn, imm12) => (0x51000000 | ((imm12 & 0xFFF) << 10) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
const addWImm = (rd, rn, imm12) => (0x11000000 | ((imm12 & 0xFFF) << 10) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
const addXImm = (rd, rn, imm12) => (0x91000000 | ((imm12 & 0xFFF) << 10) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
const cmpWImm = (rn, imm12) => (0x7100001F | ((imm12 & 0xFFF) << 10) | ((rn & 31) << 5)) >>> 0;
const cselW = (rd, rn, rm, cond) => (0x1A800000 | ((rm & 31) << 16) | ((cond & 15) << 12) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
const fsubS = (rd, rn, rm) => (0x1E203800 | ((rm & 31) << 16) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
const fmaxS = (rd, rn, rm) => (0x1E204800 | ((rm & 31) << 16) | ((rn & 31) << 5) | (rd & 31)) >>> 0;

test('1. integer clamped subtraction RMW matches between WASM and JS', () => {
  // ldr w8,[x0,#0x374]; sub w8,w8,w1; cmp w8,#0; csel w8,wzr,w8,lt; str w8,[x0,#0x374]
  const code = encodeWords([
    ldrW(8, 0, 0x374),
    subWReg(8, 8, 1),
    cmpWImm(8, 0),
    cselW(8, 31, 8, 0xB), // LT = 0xB
    strW(8, 0, 0x374),
  ]);

  const wasmRes = scanArm64RmwFields(code, wasmOpts());
  const jsRes = scanArm64RmwFields(code, { engine: 'js' });

  assert.strictEqual(wasmRes.engine, 'wasm');
  assert.strictEqual(jsRes.engine, 'js');
  assert.strictEqual(wasmRes.unsupportedArch, false);
  assert.strictEqual(wasmRes.truncated, false);
  assert.deepStrictEqual(wasmRes.hits, jsRes.hits);
  assert.strictEqual(wasmRes.hits.length, 1);
  assert.deepStrictEqual(wasmRes.hits[0], {
    loadOff: 0,
    storeOff: 16,
    arithOff: 4,
    disp: 0x374,
    baseReg: 0,
    opKind: 1,
    clamped: true,
    isFloat: false,
    width: 4,
    flags: 1,
  });
});

test('2. floating-point RMW with S31 register is valid and matches WASM === JS', () => {
  // ldr s31,[x0,#0x10]; fsub s31,s31,s1; fmax s31,s31,s2; str s31,[x0,#0x10]
  const code = encodeWords([
    ldrS(31, 0, 0x10),
    fsubS(31, 31, 1),
    fmaxS(31, 31, 2),
    strS(31, 0, 0x10),
  ]);

  const wasmRes = scanArm64RmwFields(code, wasmOpts());
  const jsRes = scanArm64RmwFields(code, { engine: 'js' });

  assert.strictEqual(wasmRes.engine, 'wasm');
  assert.strictEqual(jsRes.engine, 'js');
  assert.deepStrictEqual(wasmRes.hits, jsRes.hits);
  assert.strictEqual(wasmRes.hits.length, 1);
  assert.strictEqual(wasmRes.hits[0].loadOff, 0);
  assert.strictEqual(wasmRes.hits[0].storeOff, 12);
  assert.strictEqual(wasmRes.hits[0].arithOff, 4);
  assert.strictEqual(wasmRes.hits[0].disp, 0x10);
  assert.strictEqual(wasmRes.hits[0].baseReg, 0);
  assert.strictEqual(wasmRes.hits[0].opKind, 1);
  assert.strictEqual(wasmRes.hits[0].isFloat, true);
  assert.strictEqual(wasmRes.hits[0].width, 4);
  assert.strictEqual((wasmRes.hits[0].flags & 2) !== 0, true);
});

test('3. integer addition RMW matches WASM === JS', () => {
  // ldr w9,[x1,#0x20]; add w9,w9,#5; str w9,[x1,#0x20]
  const code = encodeWords([
    ldrW(9, 1, 0x20),
    addWImm(9, 9, 5),
    strW(9, 1, 0x20),
  ]);

  const wasmRes = scanArm64RmwFields(code, wasmOpts());
  const jsRes = scanArm64RmwFields(code, { engine: 'js' });

  assert.strictEqual(wasmRes.engine, 'wasm');
  assert.strictEqual(jsRes.engine, 'js');
  assert.deepStrictEqual(wasmRes.hits, jsRes.hits);
  assert.strictEqual(wasmRes.hits.length, 1);
  assert.deepStrictEqual(wasmRes.hits[0], {
    loadOff: 0,
    storeOff: 8,
    arithOff: 4,
    disp: 0x20,
    baseReg: 1,
    opKind: 2,
    clamped: false,
    isFloat: false,
    width: 4,
    flags: 0,
  });
});

test('4. exclusions (SP, FP, across bl, base_reg overwrite) and non-ARM64 guard', () => {
  const excludedCode = encodeWords([
    // SP base (rn=31) -> excluded
    ldrW(8, 31, 0x10),
    subWImm(8, 8, 1),
    strW(8, 31, 0x10),
    // FP base (rn=29) -> excluded
    ldrW(8, 29, 0x14),
    subWImm(8, 8, 1),
    strW(8, 29, 0x14),
    // Across bl -> excluded
    ldrW(8, 0, 0x18),
    subWImm(8, 8, 1),
    BL_PLUS_0x40,
    strW(8, 0, 0x18),
    // base_reg overwritten (x0 modified before store) -> excluded
    ldrW(8, 0, 0x1C),
    subWImm(8, 8, 1),
    addXImm(0, 0, 8),
    strW(8, 0, 0x1C),
  ]);

  const wasmRes = scanArm64RmwFields(excludedCode, wasmOpts());
  const jsRes = scanArm64RmwFields(excludedCode, { engine: 'js' });
  assert.strictEqual(wasmRes.engine, 'wasm');
  assert.deepStrictEqual(wasmRes.hits, []);
  assert.deepStrictEqual(wasmRes.hits, jsRes.hits);

  // Non-ARM64 guard
  const x64Res = scanArm64RmwFields(excludedCode, wasmOpts({ arch: 'x86_64' }));
  assert.deepStrictEqual(x64Res, {
    hits: [],
    engine: 'js',
    truncated: false,
    unsupportedArch: true,
  });

  // Case-insensitive AARCH64 accepted
  const aarch64Res = scanArm64RmwFields(
    encodeWords([ldrW(8, 2, 0x8), addWImm(8, 8, 1), strW(8, 2, 0x8)]),
    wasmOpts({ arch: 'AARCH64' }),
  );
  assert.strictEqual(aarch64Res.engine, 'wasm');
  assert.strictEqual(aarch64Res.unsupportedArch, false);
  assert.strictEqual(aarch64Res.hits.length, 1);
});

test('5. small chunkSize cross-boundary merge, subview byteOffset, and deduplication', () => {
  const words = [];
  // Hit 0 at offset 0..16
  words.push(
    ldrW(8, 0, 0x40),
    subWReg(8, 8, 1),
    cmpWImm(8, 0),
    cselW(8, 31, 8, 0xB),
    strW(8, 0, 0x40),
  );
  // Pad to offset 152 (38 words) so Hit 1 straddles a 160-byte chunk boundary (152..168)
  while (words.length < 38) words.push(NOP);
  words.push(
    ldrS(31, 2, 0x10),
    fsubS(31, 31, 1),
    fmaxS(31, 31, 2),
    strS(31, 2, 0x10),
  );
  // Pad to offset 220 (55 words) for Hit 2
  while (words.length < 55) words.push(NOP);
  words.push(
    ldrW(10, 3, 0x80),
    addWImm(10, 10, 7),
    strW(10, 3, 0x80),
  );

  // Wrap inside a larger buffer to test non-zero byteOffset Uint8Array subview
  const rawCode = encodeWords(words);
  const padded = new Uint8Array(rawCode.length + 32);
  padded.fill(0xAA);
  padded.set(rawCode, 16);
  const subview = padded.subarray(16, 16 + rawCode.length);

  const wasmChunked = scanArm64RmwFields(subview, wasmOpts({ chunkSize: 160 }));
  const jsChunked = scanArm64RmwFields(subview, { engine: 'js', chunkSize: 160 });
  const wasmFull = scanArm64RmwFields(subview, wasmOpts());

  assert.strictEqual(wasmChunked.engine, 'wasm');
  assert.strictEqual(jsChunked.engine, 'js');
  assert.strictEqual(wasmChunked.hits.length, 3);
  assert.deepStrictEqual(wasmChunked.hits, jsChunked.hits);
  assert.deepStrictEqual(wasmChunked.hits, wasmFull.hits);
  assert.deepStrictEqual(
    wasmChunked.hits.map((h) => [h.loadOff, h.storeOff, h.disp, h.opKind, h.isFloat]),
    [
      [0, 16, 0x40, 1, false],
      [152, 164, 0x10, 1, true],
      [220, 228, 0x80, 2, false],
    ],
  );
});

test('6. OOM scratch_alloc === 0 degrades gracefully to JS fallback with identical results', () => {
  const code = encodeWords([
    ldrW(8, 0, 0x374),
    subWReg(8, 8, 1),
    cmpWImm(8, 0),
    cselW(8, 31, 8, 0xB),
    strW(8, 0, 0x374),
  ]);

  const oomExports = {
    memory: new WebAssembly.Memory({ initial: 1 }),
    hex_scan_arm64_rmw_fields: () => 0,
    hex_engine_scratch_alloc: () => 0,
    hex_engine_scratch_reset: () => {},
  };

  const fallbackRes = scanArm64RmwFields(code, { wasmExports: oomExports });
  const jsRes = scanArm64RmwFields(code, { engine: 'js' });
  assert.strictEqual(fallbackRes.engine, 'js');
  assert.deepStrictEqual(fallbackRes.hits, jsRes.hits);
});

test('7. FMAX clamped FP RMW and arm64e arch support match WASM === JS', () => {
  // ldr s0, [x0, #0x10]  (0xbd401000)
  // fsub s0, s0, s1      (0x1e213800)
  // fmax s0, s0, s2      (0x1e224800)
  // str s0, [x0, #0x10]  (0xbd001000)
  const code = encodeWords([0xbd401000, 0x1e213800, 0x1e224800, 0xbd001000]);
  const w = scanArm64RmwFields(code, wasmOpts({ arch: 'arm64e' }));
  const j = scanArm64RmwFields(code, { arch: 'arm64e', engine: 'js' });
  assert.equal(w.engine, 'wasm');
  assert.equal(w.unsupportedArch, false);
  assert.equal(w.hits.length, 1);
  assert.equal(w.hits[0].clamped, true);
  assert.equal(w.hits[0].isFloat, true);
  assert.equal(w.hits[0].disp, 0x10);
  assert.deepEqual(w.hits, j.hits);
});
