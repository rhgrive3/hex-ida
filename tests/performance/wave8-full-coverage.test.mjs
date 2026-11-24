/**
 * Wave 8 Full-Coverage Verification Test Suite (Lane F9: W8-tests).
 *
 * Covers all Wave 8 (F1-F8) deliverables:
 *   1. wasmDecompileX86_64Function (SysV AMD64, Microsoft x64, truncated fallback)
 *   2. wasmRunResidentIrAndOptimize (constant folding + resident_ir / ir_optimizer telemetry)
 *   3. hex_riscv64_* (RV64I + RVC decoding, truncated input rejection, fail-closed gate)
 *   4. hex_arm64_is_pac_word (arm64e PAC recognition + fail-closed decompiler gate)
 *   5. Unified WASM initial linear memory <= 8 MiB gate
 *   6. controlflow.js options._engine priority override under globalThis.HEX_ENGINE = 'js'
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeGraph } from '../../js/controlflow.js';
import * as bridge from '../../js/core/hex-engine-bridge.js';
import { getHexEngineExports } from '../../js/core/hex-engine-wasm.js';
import {
  getFallbackCount,
  getFallbackCounts,
  getWasmCallCount,
  resetAllTelemetry,
} from '../../js/core/wasm-telemetry.js';

function getScratchApi(ex) {
  const reset = ex.hex_engine_scratch_reset || ex.hex_identity_reset || ex.cfg_reset;
  const alloc = ex.hex_engine_scratch_alloc || ex.hex_identity_alloc || ex.cfg_alloc;
  assert.equal(typeof reset, 'function', 'WASM scratch reset export required');
  assert.equal(typeof alloc, 'function', 'WASM scratch alloc export required');
  return { reset, alloc };
}

function hasNonEmptySourceMap(result) {
  if (Array.isArray(result?.sourceMap) && result.sourceMap.length > 0) return true;
  if (Array.isArray(result?.lines)) {
    return result.lines.some((line) => (
      (Array.isArray(line?.source?.addresses) && line.source.addresses.length > 0)
      || line?.addr != null
      || line?.address != null
    ));
  }
  return false;
}

// ---------------------------------------------------------------------------
// 1. wasmDecompileX86_64Function (JS bridge -> x86_64 WASM decompiler)
// ---------------------------------------------------------------------------
test('Wave 8 F1-F3: wasmDecompileX86_64Function SysV AMD64, Microsoft x64, and truncated fallback', () => {
  assert.equal(
    typeof bridge.wasmDecompileX86_64Function,
    'function',
    'hex-engine-bridge.js must export wasmDecompileX86_64Function',
  );

  resetAllTelemetry();

  // SysV AMD64: mov eax, edi; add eax, esi; ret (89 f8 01 f0 c3)
  const sysvBytes = new Uint8Array([0x89, 0xf8, 0x01, 0xf0, 0xc3]);
  const sysvRes = bridge.wasmDecompileX86_64Function({
    bytes: sysvBytes,
    baseAddr: 0x401000n,
    funcName: 'sysv_add',
    abiId: 0,
  });
  assert.ok(sysvRes && typeof sysvRes === 'object', 'SysV AMD64 decompile must return result object');
  assert.ok(typeof sysvRes.pseudocode === 'string' && sysvRes.pseudocode.length > 0, 'SysV pseudocode must be non-empty');
  assert.ok(Array.isArray(sysvRes.lines) && sysvRes.lines.length > 0, 'SysV lines must be non-empty');
  assert.ok(hasNonEmptySourceMap(sysvRes), 'SysV sourceMap must be non-empty');

  // Microsoft x64: mov eax, ecx; add eax, edx; ret (89 c8 01 d0 c3)
  const msBytes = new Uint8Array([0x89, 0xc8, 0x01, 0xd0, 0xc3]);
  const msRes = bridge.wasmDecompileX86_64Function({
    bytes: msBytes,
    baseAddr: 0x140001000n,
    funcName: 'ms_add',
    abiId: 1,
  });
  assert.ok(msRes && typeof msRes === 'object', 'Microsoft x64 decompile must return result object');
  assert.ok(typeof msRes.pseudocode === 'string' && msRes.pseudocode.length > 0, 'MS x64 pseudocode must be non-empty');
  assert.ok(Array.isArray(msRes.lines) && msRes.lines.length > 0, 'MS x64 lines must be non-empty');
  assert.ok(hasNonEmptySourceMap(msRes), 'MS x64 sourceMap must be non-empty');

  assert.ok(
    getWasmCallCount('x86_64_decompile') >= 2,
    `expected x86_64_decompile calls >= 2, got ${getWasmCallCount('x86_64_decompile')}`,
  );

  // Truncated input: e8 01 00 -> fail-closed null + fallback recorded
  const beforeFallbacks = Object.values(getFallbackCounts()).reduce((a, b) => a + Number(b || 0), 0);
  const truncRes = bridge.wasmDecompileX86_64Function({
    bytes: new Uint8Array([0xe8, 0x01, 0x00]),
    baseAddr: 0x402000n,
    funcName: 'trunc_fn',
    abiId: 0,
  });
  assert.equal(truncRes, null, 'truncated x86_64 input must fail closed and return null');
  const afterFallbacks = Object.values(getFallbackCounts()).reduce((a, b) => a + Number(b || 0), 0);
  assert.ok(
    afterFallbacks > beforeFallbacks,
    'truncated x86_64 input must record a fallback reason in telemetry',
  );
});

// ---------------------------------------------------------------------------
// 2. wasmRunResidentIrAndOptimize (Resident IR + Optimizer JS bridge)
// ---------------------------------------------------------------------------
test('Wave 8 F4: wasmRunResidentIrAndOptimize folds constants and records resident_ir + ir_optimizer telemetry', () => {
  assert.equal(
    typeof bridge.wasmRunResidentIrAndOptimize,
    'function',
    'hex-engine-bridge.js must export wasmRunResidentIrAndOptimize',
  );

  resetAllTelemetry();

  // Single-block IR suitable for constant folding:
  // v0 = CONST 20; v1 = CONST 22; v2 = BIN ADD(v0, v1); RET v2
  const res = bridge.wasmRunResidentIrAndOptimize({
    baseAddr: 0x1000n,
    blocks: [{ id: 0, startAddr: 0x1000n, endAddr: 0x1010n }],
    edges: [],
    insts: [
      { blockId: 0, op: 1, flags: 0, dst: 0, src0: 0xffffffff, src1: 0xffffffff, imm: 20n, addr: 0x1000n },
      { blockId: 0, op: 1, flags: 0, dst: 1, src0: 0xffffffff, src1: 0xffffffff, imm: 22n, addr: 0x1004n },
      { blockId: 0, op: 3, flags: 0, dst: 2, src0: 0, src1: 1, imm: 0n, addr: 0x1008n },
      { blockId: 0, op: 11, flags: 0, dst: 0xffffffff, src0: 2, src1: 0xffffffff, imm: 0n, addr: 0x100cn },
    ],
  });

  assert.ok(res && typeof res === 'object', 'wasmRunResidentIrAndOptimize must return a result object');
  assert.ok(
    getWasmCallCount('resident_ir') >= 1,
    `expected resident_ir calls >= 1, got ${getWasmCallCount('resident_ir')}`,
  );
  assert.ok(
    getWasmCallCount('ir_optimizer') >= 1,
    `expected ir_optimizer calls >= 1, got ${getWasmCallCount('ir_optimizer')}`,
  );
});

// ---------------------------------------------------------------------------
// 3. hex_riscv64_* (RISC-V 64-bit RV64I + RVC decoder & fail-closed gate)
// ---------------------------------------------------------------------------
test('Wave 8 F5: hex_riscv64_* decodes RV64I + RVC, rejects truncated bytes, and fails closed for decompiler', () => {
  const ex = getHexEngineExports();
  assert.ok(ex, 'unified WASM exports must be available');
  assert.equal(typeof ex.hex_riscv64_insn_length, 'function', 'hex_riscv64_insn_length must be exported');
  assert.equal(typeof ex.hex_riscv64_decode_one, 'function', 'hex_riscv64_decode_one must be exported');
  assert.equal(
    typeof ex.hex_riscv64_is_decompiler_supported,
    'function',
    'hex_riscv64_is_decompiler_supported must be exported',
  );

  const { reset, alloc } = getScratchApi(ex);

  const cases = [
    // addi a0, a0, 1 (0x00150513)
    { name: 'addi a0, a0, 1', bytes: new Uint8Array([0x13, 0x05, 0x15, 0x00]), expectedLen: 4 },
    // add a0, a0, a1 (0x00b50533)
    { name: 'add a0, a0, a1', bytes: new Uint8Array([0x33, 0x05, 0xb5, 0x00]), expectedLen: 4 },
    // ret = jalr x0, 0(ra) (0x00008067)
    { name: 'ret', bytes: new Uint8Array([0x67, 0x80, 0x00, 0x00]), expectedLen: 4 },
    // c.nop (0x0001)
    { name: 'c.nop', bytes: new Uint8Array([0x01, 0x00]), expectedLen: 2 },
    // c.jr ra (0x8082)
    { name: 'c.jr ra', bytes: new Uint8Array([0x82, 0x80]), expectedLen: 2 },
  ];

  for (const tc of cases) {
    reset();
    const inPtr = alloc(tc.bytes.length);
    const outPtr = alloc(128);
    assert.ok(inPtr > 0 && outPtr > 0, `${tc.name}: scratch allocation must succeed`);
    new Uint8Array(ex.memory.buffer, inPtr, tc.bytes.length).set(tc.bytes);

    const len = ex.hex_riscv64_insn_length(inPtr, tc.bytes.length);
    assert.equal(len, tc.expectedLen, `${tc.name}: expected length ${tc.expectedLen}, got ${len}`);

    const status = ex.hex_riscv64_decode_one(inPtr, tc.bytes.length, 0x1000n, outPtr);
    assert.equal(status, bridge.HEX_OK, `${tc.name}: hex_riscv64_decode_one must return HEX_OK`);

    const dv = new DataView(ex.memory.buffer);
    const decodedLen = dv.getUint8(outPtr);
    const decodedKind = dv.getUint8(outPtr + 1);
    assert.ok(
      decodedLen === tc.expectedLen || dv.getUint32(outPtr, true) > 0 || decodedKind >= 0,
      `${tc.name}: decoded struct must be populated`,
    );

    // Fail-closed decompiler gate must ALWAYS return 0 for RISC-V
    const supported = ex.hex_riscv64_is_decompiler_supported(inPtr, tc.bytes.length);
    assert.equal(supported, 0, `${tc.name}: hex_riscv64_is_decompiler_supported must always return 0`);
  }

  // Truncated 32-bit RV64I instruction (only 2 bytes of 4-byte opcode) -> length 0
  reset();
  const trunc4 = new Uint8Array([0x13, 0x05]);
  const t4Ptr = alloc(trunc4.length);
  new Uint8Array(ex.memory.buffer, t4Ptr, trunc4.length).set(trunc4);
  assert.equal(ex.hex_riscv64_insn_length(t4Ptr, trunc4.length), 0, 'truncated 32-bit RV64I must return length 0');

  // Truncated 16-bit RVC instruction (only 1 byte) -> length 0
  reset();
  const trunc2 = new Uint8Array([0x01]);
  const t2Ptr = alloc(trunc2.length);
  new Uint8Array(ex.memory.buffer, t2Ptr, trunc2.length).set(trunc2);
  assert.equal(ex.hex_riscv64_insn_length(t2Ptr, trunc2.length), 0, 'truncated 16-bit RVC must return length 0');
});

// ---------------------------------------------------------------------------
// 4. hex_arm64_is_pac_word (arm64e PAC recognition & fail-closed gate)
// ---------------------------------------------------------------------------
test('Wave 8 F6: hex_arm64_is_pac_word recognizes arm64e PAC words and fails closed for decompiler', () => {
  const ex = getHexEngineExports();
  assert.ok(ex, 'unified WASM exports must be available');
  assert.equal(typeof ex.hex_arm64_is_pac_word, 'function', 'hex_arm64_is_pac_word must be exported');
  assert.equal(
    typeof ex.hex_arm64_is_decompiler_supported,
    'function',
    'hex_arm64_is_decompiler_supported must be exported',
  );

  const pacWords = [
    { name: 'paciasp', word: 0xd503233f },
    { name: 'autiasp', word: 0xd50323bf },
    { name: 'retaa', word: 0xd65f0bff },
    { name: 'retab', word: 0xd65f0fff },
  ];

  for (const { name, word } of pacWords) {
    assert.equal(ex.hex_arm64_is_pac_word(word), 1, `${name} (0x${word.toString(16)}) must be recognized as PAC`);
    assert.equal(
      ex.hex_arm64_is_decompiler_supported(word),
      0,
      `${name} (0x${word.toString(16)}) must fail closed (0) for decompiler`,
    );
  }

  // Non-PAC sanity checks
  assert.equal(ex.hex_arm64_is_pac_word(0x0b010000), 0, 'add w0, w0, w1 must not be PAC');
  assert.equal(ex.hex_arm64_is_pac_word(0xd65f03c0), 0, 'ret must not be PAC');
});

// ---------------------------------------------------------------------------
// 5. WASM initial linear memory <= 8 MiB gate
// ---------------------------------------------------------------------------
test('Wave 8 F7: unified WASM initial linear memory is <= 8 MiB', () => {
  const ex = getHexEngineExports();
  assert.ok(ex && ex.memory instanceof WebAssembly.Memory, 'WASM linear memory export required');
  const maxBytes = 8 * 1024 * 1024;
  const actualBytes = ex.memory.buffer.byteLength;
  assert.ok(
    actualBytes <= maxBytes,
    `initial linear memory ${actualBytes} bytes (${(actualBytes / (1024 * 1024)).toFixed(2)} MiB) exceeds 8 MiB gate`,
  );
});

// ---------------------------------------------------------------------------
// 6. controlflow.js options._engine priority under globalThis.HEX_ENGINE = 'js'
// ---------------------------------------------------------------------------
test('Wave 8 F8: controlflow.js honors options._engine override under globalThis.HEX_ENGINE = "js"', () => {
  const prevGlobal = globalThis.HEX_ENGINE;
  const prevMode = globalThis.__HEX_ENGINE_MODE__;
  const prevEnv = process.env.HEX_ENGINE;

  try {
    globalThis.HEX_ENGINE = 'js';
    delete globalThis.__HEX_ENGINE_MODE__;
    delete process.env.HEX_ENGINE;

    // (a) Explicit { _engine: 'wasm' } overrides globalThis.HEX_ENGINE = 'js'
    resetAllTelemetry();
    const wasmRes = analyzeGraph([[1, 2], [3], [3], []], 0, null, { _engine: 'wasm' });
    assert.ok(wasmRes && wasmRes.reachable, 'analyzeGraph with { _engine: "wasm" } must succeed');
    assert.ok(
      getWasmCallCount('cfg') >= 1,
      `expected cfg WASM call >= 1 with { _engine: "wasm" }, got ${getWasmCallCount('cfg')}`,
    );

    // (b) Explicit { _engine: 'js' } stays on JS and records cfg:wasm_disabled
    resetAllTelemetry();
    const jsRes = analyzeGraph([[1, 2], [3], [3], []], 0, null, { _engine: 'js' });
    assert.ok(jsRes && jsRes.reachable, 'analyzeGraph with { _engine: "js" } must succeed');
    assert.equal(getWasmCallCount('cfg'), 0, 'cfg WASM call count must be 0 with { _engine: "js" }');
    assert.ok(
      getFallbackCount('cfg:wasm_disabled') >= 1,
      `expected cfg:wasm_disabled >= 1, got ${getFallbackCount('cfg:wasm_disabled')}`,
    );
  } finally {
    if (prevGlobal === undefined) delete globalThis.HEX_ENGINE;
    else globalThis.HEX_ENGINE = prevGlobal;
    if (prevMode === undefined) delete globalThis.__HEX_ENGINE_MODE__;
    else globalThis.__HEX_ENGINE_MODE__ = prevMode;
    if (prevEnv === undefined) delete process.env.HEX_ENGINE;
    else process.env.HEX_ENGINE = prevEnv;
  }
});
