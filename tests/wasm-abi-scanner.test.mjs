import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  inferArm64Abi,
  ABI_RET_KIND,
  SCRATCH_CHUNK_MAX,
} from '../js/analysis/wasm-abi-scanner.js';

function packArm64(words) {
  const buf = new Uint8Array(words.length * 4);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < words.length; i += 1) {
    dv.setUint32(i * 4, words[i] >>> 0, true);
  }
  return buf;
}

function stripEngine(res) {
  const { engine: _engine, ...rest } = res;
  return rest;
}

function loadStandaloneWasmExports() {
  const wasmPath = process.env.HEX_TEST_STANDALONE_WASM;
  if (!wasmPath) return null;
  const bytes = fs.readFileSync(wasmPath);
  const mod = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(mod);
  assert.equal(imports.length, 0, `standalone WASM must have 0 imports, got: ${JSON.stringify(imports)}`);
  const inst = new WebAssembly.Instance(mod, {});
  assert.equal(typeof inst.exports.hex_infer_arm64_abi, 'function');
  return inst.exports;
}

const standaloneExports = loadStandaloneWasmExports();

function runBothEngines(bytes, extraOpts = {}) {
  const wasmOpts = standaloneExports
    ? { ...extraOpts, wasmExports: standaloneExports }
    : { ...extraOpts };
  const wasmRes = inferArm64Abi(bytes, wasmOpts);
  const jsRes = inferArm64Abi(bytes, { ...extraOpts, engine: 'js' });
  assert.equal(wasmRes.engine, 'wasm');
  assert.equal(jsRes.engine, 'js');
  assert.deepEqual(stripEngine(wasmRes), stripEngine(jsRes));
  return { wasmRes, jsRes };
}

test('standalone WASM module has zero imports when HEX_TEST_STANDALONE_WASM is set', () => {
  if (process.env.HEX_TEST_STANDALONE_WASM) {
    assert.ok(standaloneExports, 'expected standalone WASM exports to be loaded');
    assert.equal(typeof standaloneExports.hex_infer_arm64_abi, 'function');
  }
});

test('1. C++ method: stp fp/lr + sub sp + ldr [x0, #0x10] + add w0, w8, w1 + ret', () => {
  const code = packArm64([
    0xA9BF7BFD, // stp x29, x30, [sp, #-16]!
    0xD10083FF, // sub sp, sp, #32
    0xB9401008, // ldr w8, [x0, #0x10]
    0x0B010100, // add w0, w8, w1
    0xD65F03C0, // ret
  ]);

  const { wasmRes } = runBothEngines(code);
  assert.equal(wasmRes.valid, true);
  assert.equal(wasmRes.hasFrame, true);
  assert.equal(wasmRes.hasThis, true);
  assert.equal(wasmRes.hasX8Sret, false);
  assert.equal(wasmRes.gpArgMask, 0b11);
  assert.equal(wasmRes.gpArgCount, 2);
  assert.equal(wasmRes.gpPtrMask, 0b1);
  assert.equal(wasmRes.fpArgMask, 0);
  assert.equal(wasmRes.fpArgCount, 0);
  assert.equal(wasmRes.retKind, ABI_RET_KIND.I32);
  assert.equal(wasmRes.stackFrameBytes, 32);
  assert.equal(wasmRes.insnScanned, 5);
  assert.equal(wasmRes.truncated, false);
  assert.equal(wasmRes.unsupportedArch, false);
});

test('2. FP args + d0 return: fadd d0, d0, d1; ret', () => {
  const code = packArm64([
    0x1E612800, // fadd d0, d0, d1
    0xD65F03C0, // ret
  ]);

  const { wasmRes } = runBothEngines(code);
  assert.equal(wasmRes.valid, true);
  assert.equal(wasmRes.fpArgMask, 0b11);
  assert.equal(wasmRes.fpArgCount, 2);
  assert.equal(wasmRes.gpArgMask, 0);
  assert.equal(wasmRes.gpArgCount, 0);
  assert.equal(wasmRes.gpPtrMask, 0);
  assert.equal(wasmRes.retKind, ABI_RET_KIND.F64);
  assert.equal(wasmRes.hasFrame, false);
  assert.equal(wasmRes.hasThis, false);
  assert.equal(wasmRes.hasX8Sret, false);
  assert.equal(wasmRes.stackFrameBytes, 0);
  assert.equal(wasmRes.insnScanned, 2);
});

test('3. x8 sret struct return detection (and ignores overwritten x8)', () => {
  const sretCode = packArm64([
    0xF9000100, // str x0, [x8, #0]
    0xF9000501, // str x1, [x8, #8]
    0xD65F03C0, // ret
  ]);
  const { wasmRes } = runBothEngines(sretCode);
  assert.equal(wasmRes.valid, true);
  assert.equal(wasmRes.hasX8Sret, true);
  assert.equal(wasmRes.hasThis, false);
  assert.equal(wasmRes.gpArgMask, 0b11);
  assert.equal(wasmRes.gpArgCount, 2);
  assert.equal(wasmRes.gpPtrMask, 0);
  assert.equal(wasmRes.retKind, ABI_RET_KIND.VOID);
  assert.equal(wasmRes.insnScanned, 3);

  // Overwriting x8 before dereferencing must NOT flag hasX8Sret
  const overwrittenX8 = packArm64([
    0xAA0003E8, // mov x8, x0
    0xF9000101, // str x1, [x8, #0]
    0xD65F03C0, // ret
  ]);
  const { wasmRes: res2 } = runBothEngines(overwrittenX8);
  assert.equal(res2.hasX8Sret, false);
  assert.equal(res2.gpArgMask, 0b11);
});

test('4. Multiple ret paths + bl lookback barrier', () => {
  // Single ret preceded by mov w0, #1; bl +0x20; ret -> bl cuts off lookback => void (0)
  const blCutCode = packArm64([
    0x52800020, // movz w0, #1
    0x94000008, // bl +0x20
    0xD65F03C0, // ret
  ]);
  const { wasmRes: blCutRes } = runBothEngines(blCutCode);
  assert.equal(blCutRes.valid, true);
  assert.equal(blCutRes.retKind, ABI_RET_KIND.VOID);

  // Multiple ret paths:
  // Path 1: movz w0, #1; bl +0x20; ret  -> void (0) because bl stops lookback
  // Path 2: mov x0, x1; ret             -> i64 (2)
  // Path 3: fmov s0, s1; ret            -> f32 (3)  (highest priority)
  // Also Pass A stops at cbz x0 so x1/s1 in later blocks are not counted as entry args
  const multiRetCode = packArm64([
    0xB4000080, // cbz x0, +16  (reads x0, then breaks Pass A)
    0x52800020, // movz w0, #1
    0x94000008, // bl +0x20
    0xD65F03C0, // ret (path 1 -> void)
    0xAA0103E0, // mov x0, x1
    0xD65F03C0, // ret (path 2 -> i64)
    0x1E204020, // fmov s0, s1
    0xD65F03C0, // ret (path 3 -> f32)
  ]);
  const { wasmRes: multiRes } = runBothEngines(multiRetCode);
  assert.equal(multiRes.valid, true);
  assert.equal(multiRes.gpArgMask, 0b1);
  assert.equal(multiRes.gpArgCount, 1);
  assert.equal(multiRes.fpArgMask, 0);
  assert.equal(multiRes.retKind, ABI_RET_KIND.F32);
  assert.equal(multiRes.insnScanned, 8);
});

test('5. Non-ARM64 guard, short buffer guard, and > SCRATCH_CHUNK_MAX truncation', () => {
  const sample = packArm64([0xD65F03C0]);

  const x86Res = inferArm64Abi(sample, {
    arch: 'x86_64',
    ...(standaloneExports ? { wasmExports: standaloneExports } : {}),
  });
  assert.equal(x86Res.valid, false);
  assert.equal(x86Res.unsupportedArch, true);
  assert.equal(x86Res.engine, 'js');
  assert.equal(x86Res.truncated, false);
  assert.equal(x86Res.insnScanned, 0);

  const rvRes = inferArm64Abi(sample, { arch: 'riscv64' });
  assert.equal(rvRes.valid, false);
  assert.equal(rvRes.unsupportedArch, true);
  assert.equal(rvRes.engine, 'js');

  const shortRes = inferArm64Abi(new Uint8Array([0x01, 0x02]));
  assert.equal(shortRes.valid, false);
  assert.equal(shortRes.unsupportedArch, false);

  // Oversized buffer > SCRATCH_CHUNK_MAX: clipped to head + truncated: true
  const big = new Uint8Array(SCRATCH_CHUNK_MAX + 64);
  const dv = new DataView(big.buffer);
  dv.setUint32(0, 0x1E612800, true); // fadd d0, d0, d1
  dv.setUint32(4, 0xD65F03C0, true); // ret
  const { wasmRes: bigRes } = runBothEngines(big);
  assert.equal(bigRes.valid, true);
  assert.equal(bigRes.truncated, true);
  assert.equal(bigRes.fpArgMask, 0b11);
  assert.equal(bigRes.retKind, ABI_RET_KIND.F64);
  assert.equal(bigRes.insnScanned, 4096);
});

test('6. Direct WASM null/short-length guard returns 0', () => {
  if (!standaloneExports) return;
  assert.equal(standaloneExports.hex_infer_arm64_abi(0, 16, 1024), 0);
  assert.equal(standaloneExports.hex_infer_arm64_abi(1024, 16, 0), 0);
  assert.equal(standaloneExports.hex_infer_arm64_abi(1024, 3, 2048), 0);
});
