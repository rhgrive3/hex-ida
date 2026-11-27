import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  SCRATCH_CHUNK_MAX,
  fingerprintArm64Func,
  simhashHamming64,
  matchFingerprints,
} from '../js/analysis/wasm-func-fingerprint.js';
import { INSN_CLASS } from '../js/analysis/arm64-insn-bits.js';

function packWords(words) {
  const out = new Uint8Array(words.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < words.length; i++) {
    dv.setUint32(i * 4, words[i] >>> 0, true);
  }
  return out;
}

function loadStandaloneWasm() {
  const wasmPath = process.env.HEX_TEST_STANDALONE_WASM;
  if (!wasmPath) return null;
  const bytes = fs.readFileSync(wasmPath);
  const mod = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(mod);
  assert.equal(imports.length, 0, `standalone wasm must have 0 imports, got ${imports.length}`);
  const inst = new WebAssembly.Instance(mod, {});
  return inst.exports;
}

const STANDALONE_WASM = loadStandaloneWasm();
const WASM_OPTS = STANDALONE_WASM ? { engine: 'wasm', wasmExports: STANDALONE_WASM } : {};

// Sample ARM64 encodings across instruction classes
const INSN_STP_PROLOGUE = 0xa9bf7bfd; // stp x29, x30, [sp, #-16]!  (STORE)
const INSN_LDP_EPILOGUE = 0xa8c17bfd; // ldp x29, x30, [sp], #16    (LOAD)
const INSN_LDR_W0       = 0xb9400000; // ldr w0, [x0]               (LOAD)
const INSN_LDR_W1       = 0xb9400401; // ldr w1, [x0, #4]           (LOAD)
const INSN_STR_W0       = 0xb9000000; // str w0, [x0]               (STORE)
const INSN_ADD_W0       = 0x11000400; // add w0, w0, #1             (ARITH)
const INSN_SUB_W0       = 0x51000800; // sub w0, w0, #2             (ARITH)
const INSN_MUL_W0       = 0x1b017c00; // mul w0, w0, w1             (MULDIV)
const INSN_EOR_W0       = 0x4a010000; // eor w0, w0, w1             (BITWISE)
const INSN_FADD_S0      = 0x1e212800; // fadd s0, s0, s1            (FP_SIMD)
const INSN_FMUL_S0      = 0x1e210800; // fmul s0, s0, s1            (FP_SIMD)
const INSN_AESE         = 0x4e284820; // aese v0.16b, v1.16b        (CRYPTO_SYS)
const INSN_CRC32B       = 0x1ac14000; // crc32b w0, w0, w1          (CRYPTO_SYS)
const INSN_CBZ_W0       = 0x34000040; // cbz w0, +8                 (COND_BR)
const INSN_BL_DIR       = 0x94000010; // bl +0x40                   (CALL_DIR)
const INSN_BLR_X8       = 0xd63f0100; // blr x8                     (CALL_IND)
const INSN_MOV_X0_X1    = 0xaa0103e0; // mov x0, x1                 (OTHER)
const INSN_RET          = 0xd65f03c0; // ret                        (UNCOND_BR)

test('standalone WASM module loads with zero imports and exports Track 3 ABI', (t) => {
  if (!STANDALONE_WASM) {
    t.skip('HEX_TEST_STANDALONE_WASM not set');
    return;
  }
  assert.equal(typeof STANDALONE_WASM.hex_fingerprint_arm64_func, 'function');
  assert.equal(typeof STANDALONE_WASM.hex_simhash_hamming64, 'function');
  assert.equal(typeof STANDALONE_WASM.hex_match_fingerprints, 'function');
  assert.ok(STANDALONE_WASM.memory instanceof WebAssembly.Memory);

  // Direct ABI null/zero guards
  assert.equal(STANDALONE_WASM.hex_fingerprint_arm64_func(0, 16, 1024), 0);
  assert.equal(STANDALONE_WASM.hex_fingerprint_arm64_func(1024, 16, 0), 0);
  assert.equal(STANDALONE_WASM.hex_fingerprint_arm64_func(1024, 3, 2048), 0);
  assert.equal(STANDALONE_WASM.hex_match_fingerprints(0, 0, 0, 10, 12, 2048, 8), 0);
  assert.equal(STANDALONE_WASM.hex_match_fingerprints(0, 0, 1024, 0, 12, 2048, 8), 0);
  assert.equal(STANDALONE_WASM.hex_match_fingerprints(0, 0, 1024, 10, 12, 0, 8), 0);
  assert.equal(STANDALONE_WASM.hex_match_fingerprints(0, 0, 1024, 10, 12, 2048, 0), 0);
});

test('identical, similar, and distinct ARM64 functions produce expected SimHash distances and WASM === JS parity', () => {
  const funcA = packWords([
    INSN_STP_PROLOGUE,
    INSN_LDR_W0,
    INSN_LDR_W1,
    INSN_ADD_W0,
    INSN_SUB_W0,
    INSN_CBZ_W0,
    INSN_STR_W0,
    INSN_LDR_W0,
    INSN_ADD_W0,
    INSN_STR_W0,
    INSN_LDP_EPILOGUE,
    INSN_RET,
  ]);

  // Same structural sequence (different immediates / registers of same classes)
  const funcAExactStruct = packWords([
    INSN_STP_PROLOGUE,
    INSN_LDR_W1,
    INSN_LDR_W0,
    INSN_SUB_W0,
    INSN_ADD_W0,
    INSN_CBZ_W0,
    INSN_STR_W0,
    INSN_LDR_W1,
    INSN_SUB_W0,
    INSN_STR_W0,
    INSN_LDP_EPILOGUE,
    INSN_RET,
  ]);

  // Slightly perturbed version of funcA (one extra arithmetic instruction)
  const funcASimilar = packWords([
    INSN_STP_PROLOGUE,
    INSN_LDR_W0,
    INSN_LDR_W1,
    INSN_ADD_W0,
    INSN_ADD_W0,
    INSN_SUB_W0,
    INSN_CBZ_W0,
    INSN_STR_W0,
    INSN_LDR_W0,
    INSN_ADD_W0,
    INSN_STR_W0,
    INSN_LDP_EPILOGUE,
    INSN_RET,
  ]);

  // Completely different structural profile (FP/SIMD + HW crypto + indirect calls + bitwise/mul)
  const funcB = packWords([
    INSN_FADD_S0,
    INSN_FMUL_S0,
    INSN_AESE,
    INSN_CRC32B,
    INSN_EOR_W0,
    INSN_MUL_W0,
    INSN_BLR_X8,
    INSN_AESE,
    INSN_FADD_S0,
    INSN_EOR_W0,
    INSN_BL_DIR,
    INSN_MOV_X0_X1,
  ]);

  const fpAWasm = fingerprintArm64Func(funcA, WASM_OPTS);
  const fpAJs = fingerprintArm64Func(funcA, { engine: 'js' });
  const fpASameWasm = fingerprintArm64Func(funcAExactStruct, WASM_OPTS);
  const fpASimWasm = fingerprintArm64Func(funcASimilar, WASM_OPTS);
  const fpASimJs = fingerprintArm64Func(funcASimilar, { engine: 'js' });
  const fpBWasm = fingerprintArm64Func(funcB, WASM_OPTS);
  const fpBJs = fingerprintArm64Func(funcB, { engine: 'js' });

  assert.equal(fpAWasm.engine, 'wasm');
  assert.equal(fpASimWasm.engine, 'wasm');
  assert.equal(fpBWasm.engine, 'wasm');
  assert.equal(fpAJs.engine, 'js');

  // Bit-exact WASM === JS parity
  for (const [w, j] of [[fpAWasm, fpAJs], [fpASimWasm, fpASimJs], [fpBWasm, fpBJs]]) {
    assert.equal(w.valid, true);
    assert.equal(w.unsupportedArch, false);
    assert.equal(w.truncated, false);
    assert.equal(w.simhash, j.simhash);
    assert.equal(w.simhashLo, j.simhashLo);
    assert.equal(w.simhashHi, j.simhashHi);
    assert.equal(w.simhash, (BigInt(w.simhashHi) << 32n) | BigInt(w.simhashLo));
    assert.equal(w.insnCount, j.insnCount);
    assert.equal(w.uniqueBigrams, j.uniqueBigrams);
    assert.deepEqual(Array.from(w.classCounts), Array.from(j.classCounts));
    assert.equal(w.classCounts.length, 12);
    const totalClassCount = w.classCounts.reduce((acc, x) => acc + x, 0);
    assert.equal(totalClassCount, w.insnCount);
  }

  // Structural similarity properties
  const distSame = simhashHamming64(fpAWasm.simhash, fpASameWasm.simhash, WASM_OPTS);
  const distSim = simhashHamming64(fpAWasm.simhash, fpASimWasm.simhash, WASM_OPTS);
  const distDiff = simhashHamming64(fpAWasm.simhash, fpBWasm.simhash, WASM_OPTS);

  assert.equal(distSame, 0, 'identical instruction-class sequence must have Hamming distance 0');
  assert.ok(distSim < distDiff, `similar function (${distSim}) must be closer than distinct function (${distDiff})`);
  assert.ok(distDiff >= 10, `distinct functions should be well separated, got ${distDiff}`);

  // simhashHamming64 supports both BigInt and { lo, hi } and matches WASM === JS
  assert.equal(
    simhashHamming64({ lo: fpAWasm.simhashLo, hi: fpAWasm.simhashHi }, { lo: fpBWasm.simhashLo, hi: fpBWasm.simhashHi }, WASM_OPTS),
    distDiff
  );
  assert.equal(simhashHamming64(fpAWasm.simhash, fpBWasm.simhash, { engine: 'js' }), distDiff);
  assert.equal(simhashHamming64(0n, 0xffffffffffffffffn, WASM_OPTS), 64);
  assert.equal(simhashHamming64(0n, 0xffffffffffffffffn, { engine: 'js' }), 64);
  assert.equal(simhashHamming64(0x123456789abcdef0n, 0x123456789abcdef0n, WASM_OPTS), 0);
});

test('single instruction, empty/short input, non-ARM64 guard, and >SCRATCH_CHUNK_MAX truncation', () => {
  // Single instruction (RET)
  const singleBytes = packWords([INSN_RET]);
  const singleWasm = fingerprintArm64Func(singleBytes, WASM_OPTS);
  const singleJs = fingerprintArm64Func(singleBytes, { engine: 'js' });
  assert.equal(singleWasm.engine, 'wasm');
  assert.equal(singleWasm.valid, true);
  assert.equal(singleWasm.insnCount, 1);
  assert.equal(singleWasm.uniqueBigrams, 0);
  assert.equal(singleWasm.classCounts[INSN_CLASS.UNCOND_BR], 1);
  assert.equal(singleWasm.simhash, singleJs.simhash);
  assert.deepEqual(Array.from(singleWasm.classCounts), Array.from(singleJs.classCounts));

  // Trailing partial bytes (< 4B tail ignored cleanly)
  const sixBytes = new Uint8Array(6);
  sixBytes.set(singleBytes, 0);
  sixBytes[4] = 0xaa;
  sixBytes[5] = 0xbb;
  const sixWasm = fingerprintArm64Func(sixBytes, WASM_OPTS);
  assert.equal(sixWasm.valid, true);
  assert.equal(sixWasm.insnCount, 1);
  assert.equal(sixWasm.simhash, singleWasm.simhash);

  // Empty & < 4B inputs
  for (const bad of [new Uint8Array(0), new Uint8Array([1, 2, 3]), null, undefined]) {
    const res = fingerprintArm64Func(bad, WASM_OPTS);
    assert.equal(res.valid, false);
    assert.equal(res.unsupportedArch, false);
    assert.equal(res.truncated, false);
    assert.equal(res.insnCount, 0);
    assert.equal(res.uniqueBigrams, 0);
    assert.equal(res.simhash, 0n);
    assert.equal(res.classCounts.length, 12);
  }

  // Non-ARM64 arch guard
  for (const arch of ['x86_64', 'x86-64', 'riscv64', 'arm32']) {
    const res = fingerprintArm64Func(singleBytes, { ...WASM_OPTS, arch });
    assert.equal(res.valid, false);
    assert.equal(res.unsupportedArch, true);
    assert.equal(res.truncated, false);
    assert.equal(res.simhash, 0n);
    assert.equal(res.insnCount, 0);
  }

  // > SCRATCH_CHUNK_MAX truncation parity
  const big = new Uint8Array(SCRATCH_CHUNK_MAX + 64);
  const dv = new DataView(big.buffer);
  const pattern = [INSN_LDR_W0, INSN_ADD_W0, INSN_STR_W0, INSN_CBZ_W0];
  for (let off = 0; off < big.length; off += 4) {
    dv.setUint32(off, pattern[(off >>> 2) & 3], true);
  }
  const bigWasm = fingerprintArm64Func(big, WASM_OPTS);
  const bigJs = fingerprintArm64Func(big, { engine: 'js' });
  assert.equal(bigWasm.engine, 'wasm');
  assert.equal(bigWasm.valid, true);
  assert.equal(bigWasm.truncated, true);
  assert.equal(bigJs.truncated, true);
  assert.equal(bigWasm.insnCount, SCRATCH_CHUNK_MAX >>> 2);
  assert.equal(bigWasm.simhash, bigJs.simhash);
  assert.equal(bigWasm.uniqueBigrams, bigJs.uniqueBigrams);
  assert.deepEqual(Array.from(bigWasm.classCounts), Array.from(bigJs.classCounts));
});

test('matchFingerprints across dbChunk boundaries preserves (hamming ASC, idx ASC), limit truncation, and WASM === JS parity', () => {
  const query = 0x0f0f0f0f0f0f0f0fn;
  const flipBits = (base, count) => {
    let x = base;
    for (let b = 0; b < count; b++) {
      x ^= (1n << BigInt(b));
    }
    return x;
  };

  // Build 40 entries with deliberate ties and distances spanning multiple chunks (dbChunk = 7)
  const distances = [
    20, 3, 15, 1, 5, 0, 12,   // chunk 0 (0..6)
    2, 1, 25, 0, 4, 12, 3,    // chunk 1 (7..13)
    13, 2, 1, 30, 0, 6, 2,    // chunk 2 (14..20)
    4, 12, 1, 3, 50, 0, 2,    // chunk 3 (21..27)
    11, 5, 64, 1, 2, 3, 0,    // chunk 4 (28..34)
    12, 2, 4, 1, 18,          // chunk 5 (35..39)
  ];
  const dbArray = distances.map((d) => flipBits(query, d));
  const dbBigUint = BigUint64Array.from(dbArray);

  // Case 1: Truncated at limit = 10 across chunk boundaries (dbChunk = 7)
  const resWasm = matchFingerprints(query, dbArray, {
    ...WASM_OPTS,
    maxHamming: 12,
    limit: 10,
    dbChunk: 7,
  });
  const resJs = matchFingerprints(query, dbArray, {
    engine: 'js',
    maxHamming: 12,
    limit: 10,
    dbChunk: 7,
  });

  assert.equal(resWasm.engine, 'wasm');
  assert.equal(resJs.engine, 'js');
  assert.equal(resWasm.truncated, true);
  assert.equal(resJs.truncated, true);
  assert.equal(resWasm.matches.length, 10);
  assert.deepEqual(resWasm.matches, resJs.matches);

  // Verify strict (hamming ASC, idx ASC) order
  for (let i = 1; i < resWasm.matches.length; i++) {
    const prev = resWasm.matches[i - 1];
    const cur = resWasm.matches[i];
    assert.ok(
      prev.hamming < cur.hamming || (prev.hamming === cur.hamming && prev.idx < cur.idx),
      `sort violation at ${i}: ${JSON.stringify(prev)} vs ${JSON.stringify(cur)}`
    );
  }
  // All 5 zero-distance matches (idx 5, 10, 18, 26, 34) must come first in idx ASC order
  assert.deepEqual(
    resWasm.matches.slice(0, 5),
    [
      { idx: 5, hamming: 0 },
      { idx: 10, hamming: 0 },
      { idx: 18, hamming: 0 },
      { idx: 26, hamming: 0 },
      { idx: 34, hamming: 0 },
    ]
  );

  // Case 2: BigUint64Array input with non-truncated limit
  const resFullWasm = matchFingerprints(query, dbBigUint, {
    ...WASM_OPTS,
    maxHamming: 2,
    limit: 100,
    dbChunk: 9,
  });
  const resFullJs = matchFingerprints(query, dbBigUint, {
    engine: 'js',
    maxHamming: 2,
    limit: 100,
    dbChunk: 9,
  });
  assert.equal(resFullWasm.engine, 'wasm');
  assert.equal(resFullWasm.truncated, false);
  assert.equal(resFullJs.truncated, false);
  assert.deepEqual(resFullWasm.matches, resFullJs.matches);
  assert.ok(resFullWasm.matches.every((m) => m.hamming <= 2));

  // Case 3: Exact boundary when qualifying count === limit (truncated must be false)
  const exactCount = resFullWasm.matches.length;
  const resExactWasm = matchFingerprints(query, dbBigUint, {
    ...WASM_OPTS,
    maxHamming: 2,
    limit: exactCount,
    dbChunk: 9,
  });
  const resExactJs = matchFingerprints(query, dbBigUint, {
    engine: 'js',
    maxHamming: 2,
    limit: exactCount,
    dbChunk: 9,
  });
  assert.equal(resExactWasm.truncated, false);
  assert.equal(resExactJs.truncated, false);
  assert.deepEqual(resExactWasm.matches, resExactJs.matches);
});

test('randomized instruction streams maintain 100% bit-exact WASM === JS parity', () => {
  let seed = 0x9e3779b9;
  const nextU32 = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let trial = 0; trial < 20; trial++) {
    const insns = 1 + (nextU32() % 128);
    const buf = new Uint8Array(insns * 4);
    const dv = new DataView(buf.buffer);
    for (let i = 0; i < insns; i++) {
      dv.setUint32(i * 4, nextU32(), true);
    }
    const w = fingerprintArm64Func(buf, WASM_OPTS);
    const j = fingerprintArm64Func(buf, { engine: 'js' });
    assert.equal(w.engine, 'wasm');
    assert.equal(w.simhash, j.simhash, `trial ${trial} simhash mismatch`);
    assert.equal(w.simhashLo, j.simhashLo);
    assert.equal(w.simhashHi, j.simhashHi);
    assert.equal(w.insnCount, j.insnCount);
    assert.equal(w.uniqueBigrams, j.uniqueBigrams);
    assert.deepEqual(Array.from(w.classCounts), Array.from(j.classCounts));
  }
});
