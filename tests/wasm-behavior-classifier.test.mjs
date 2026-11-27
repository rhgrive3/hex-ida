import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test, before, after } from 'node:test';
import {
  BEHAVIOR_CATEGORY,
  SCRATCH_CHUNK_MAX,
  classifyArm64Behavior,
  setBehaviorClassifierWasmExportsForTest,
} from '../js/analysis/wasm-behavior-classifier.js';

function packWords(words) {
  const buf = new Uint8Array(words.length * 4);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < words.length; i++) {
    dv.setUint32(i * 4, words[i] >>> 0, true);
  }
  return buf;
}

function stripEngine(res) {
  const { engine: _engine, ...rest } = res;
  return rest;
}

let standaloneLoaded = false;

before(() => {
  const wasmPath = process.env.HEX_TEST_STANDALONE_WASM;
  if (wasmPath) {
    const wasmBytes = fs.readFileSync(wasmPath);
    const mod = new WebAssembly.Module(wasmBytes);
    const imports = WebAssembly.Module.imports(mod);
    assert.equal(imports.length, 0, `Standalone WASM must have zero imports, got: ${JSON.stringify(imports)}`);
    const inst = new WebAssembly.Instance(mod, {});
    assert.equal(typeof inst.exports.hex_classify_arm64_behavior, 'function');
    setBehaviorClassifierWasmExportsForTest(inst.exports);
    standaloneLoaded = true;
  }
});

after(() => {
  setBehaviorClassifierWasmExportsForTest(null);
});

function assertWasmJsParity(bytes, opts = {}) {
  const wasmRes = classifyArm64Behavior(bytes, opts);
  const jsRes = classifyArm64Behavior(bytes, { ...opts, engine: 'js' });
  assert.equal(wasmRes.engine, 'wasm', 'Expected WASM engine to execute');
  assert.equal(jsRes.engine, 'js');
  assert.deepEqual(stripEngine(wasmRes), stripEngine(jsRes), 'WASM and JS outputs must match 1:1');
  return wasmRes;
}

test('1. HP drain + clamp short function classifies as DRAIN and suppresses ACCESSOR', () => {
  // ldr w8, [x0, #0x20]   ; 0xB9402008
  // subs w8, w8, w1       ; 0x6B010108
  // csel w8, wzr, w8, lt  ; 0x1A88B3E8
  // str w8, [x0, #0x20]   ; 0xB9002008
  // ret                   ; 0xD65F03C0
  const code = packWords([
    0xB9402008,
    0x6B010108,
    0x1A88B3E8,
    0xB9002008,
    0xD65F03C0,
  ]);
  const res = assertWasmJsParity(code);
  assert.equal(res.valid, true);
  assert.equal(res.topCategory, BEHAVIOR_CATEGORY.DRAIN);
  assert.equal(res.accessorScore, 0);
  assert.equal(res.drainScore, 490); // 1*450 + 1*40
  assert.equal(res.insnCount, 5);
  assert.equal((res.flags & 1) !== 0, true); // bit0: clamped_sub > 0
  assert.equal((res.flags & 16) === 0, true); // bit4: accessor_score == 0
});

test('2. Simple getter classifies as ACCESSOR', () => {
  // ldr w0, [x0, #0x10]   ; 0xB9401000
  // ret                   ; 0xD65F03C0
  const code = packWords([
    0xB9401000,
    0xD65F03C0,
  ]);
  const res = assertWasmJsParity(code);
  assert.equal(res.valid, true);
  assert.equal(res.topCategory, BEHAVIOR_CATEGORY.ACCESSOR);
  assert.equal(res.accessorScore, 900);
  assert.equal(res.insnCount, 2);
  assert.equal((res.flags & 16) !== 0, true); // bit4: accessor_score > 0
});

test('3. Hardware crypto + bitwise classifies as CRYPTO while MOV aliases yield cryptoScore === 0', () => {
  // aese v0.16b, v1.16b   ; 0x4E284820
  // eor x0, x0, x1        ; 0xCA010000
  // ret                   ; 0xD65F03C0
  const cryptoCode = packWords([
    0x4E284820,
    0xCA010000,
    0xD65F03C0,
  ]);
  const cryptoRes = assertWasmJsParity(cryptoCode);
  assert.equal(cryptoRes.valid, true);
  assert.equal(cryptoRes.topCategory, BEHAVIOR_CATEGORY.CRYPTO);
  assert.equal(cryptoRes.cryptoScore, 580); // 1*500 + 1*80
  assert.equal((cryptoRes.flags & 2) !== 0, true); // bit1: hw_crypto > 0

  // MOV aliases (ORR reg with Rn=31, ORR imm with Rn=31) must NOT count as BITWISE
  // mov x0, x1 (orr x0, xzr, x1)  ; 0xAA0103E0
  // mov w2, w3 (orr w2, wzr, w3)  ; 0x2A0303E2
  // mov w4, #1 (orr w4, wzr, #1)  ; 0x320003E4
  // mov x5, x6 (orr x5, xzr, x6)  ; 0xAA0603E5
  // ret                           ; 0xD65F03C0
  const movAliasCode = packWords([
    0xAA0103E0,
    0x2A0303E2,
    0x320003E4,
    0xAA0603E5,
    0xD65F03C0,
  ]);
  const movRes = assertWasmJsParity(movAliasCode);
  assert.equal(movRes.valid, true);
  assert.equal(movRes.cryptoScore, 0);
  assert.equal(movRes.topCategory, BEHAVIOR_CATEGORY.NONE);
  assert.equal(movRes.flags, 0);
});

test('4. Multiply/divide + FP ratio calculation classifies as RATIO', () => {
  // mul w8, w0, w1        ; 0x1B017C08
  // udiv w9, w8, w2       ; 0x1AC20909
  // fdiv s0, s0, s1       ; 0x1E211800
  // ret                   ; 0xD65F03C0
  const code = packWords([
    0x1B017C08,
    0x1AC20909,
    0x1E211800,
    0xD65F03C0,
  ]);
  const res = assertWasmJsParity(code);
  assert.equal(res.valid, true);
  assert.equal(res.topCategory, BEHAVIOR_CATEGORY.RATIO);
  assert.equal(res.ratioScore, 560); // 2*220 + 1*120
  assert.equal((res.flags & 4) !== 0, true); // bit2: muldiv_ops > 0
});

test('5. Add RMW classifies as ACCUM', () => {
  // ldr w8, [x0, #0x18]   ; 0xB9401808
  // add w8, w8, w1        ; 0x0B010108
  // str w8, [x0, #0x18]   ; 0xB9001808
  // ret                   ; 0xD65F03C0
  const code = packWords([
    0xB9401808,
    0x0B010108,
    0xB9001808,
    0xD65F03C0,
  ]);
  const res = assertWasmJsParity(code);
  assert.equal(res.valid, true);
  assert.equal(res.topCategory, BEHAVIOR_CATEGORY.ACCUM);
  assert.equal(res.accumScore, 390); // 1*350 + 1*40
  assert.equal(res.accessorScore, 0);
  assert.equal((res.flags & 8) !== 0, true); // bit3: add_rmw > 0
});

test('6. Non-ARM64 architecture guard and short/truncated buffer handling', () => {
  const getter = packWords([0xB9401000, 0xD65F03C0]);

  const x64 = classifyArm64Behavior(getter, { arch: 'x86_64' });
  assert.deepEqual(x64, {
    valid: false,
    drainScore: 0,
    accumScore: 0,
    ratioScore: 0,
    cryptoScore: 0,
    accessorScore: 0,
    topCategory: BEHAVIOR_CATEGORY.NONE,
    insnCount: 0,
    flags: 0,
    engine: 'js',
    truncated: false,
    unsupportedArch: true,
  });

  const shortRes = classifyArm64Behavior(new Uint8Array([0x00, 0x01, 0x02]));
  assert.equal(shortRes.valid, false);
  assert.equal(shortRes.unsupportedArch, false);
  assert.equal(shortRes.truncated, false);
  assert.equal(shortRes.engine, 'js');

  // Oversized buffer > SCRATCH_CHUNK_MAX clips to SCRATCH_CHUNK_MAX and sets truncated: true
  const big = new Uint8Array(SCRATCH_CHUNK_MAX + 16);
  const dv = new DataView(big.buffer);
  dv.setUint32(0, 0x4E284820, true); // aese
  dv.setUint32(4, 0x4E284820, true); // aese
  const bigRes = assertWasmJsParity(big);
  assert.equal(bigRes.valid, true);
  assert.equal(bigRes.truncated, true);
  assert.equal(bigRes.insnCount, SCRATCH_CHUNK_MAX >>> 2);
  assert.equal(bigRes.cryptoScore, 1000);
  assert.equal(bigRes.topCategory, BEHAVIOR_CATEGORY.CRYPTO);
});
