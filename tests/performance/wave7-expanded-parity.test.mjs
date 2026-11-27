/**
 * Wave 7 Expanded Parity, Rollback Consistency, x86_64 ABI Smoke,
 * and iOS Safari WASM Constraint Verification Test (Lane E9).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import '../../js/words.js';
import { buildSemanticModel } from '../../js/blocks.js';
import { openBinary } from '../../js/binary/index.js';
import { analyzeGraph } from '../../js/controlflow.js';
import { decompile } from '../../js/decompile.js';
import { buildSampleBinary } from '../../js/sample.js';
import {
  HEX_EMIT_FLAG_JS_PARITY,
  HEX_OK,
  getEngineMode,
  isWasmEngineAvailable,
} from '../../js/core/hex-engine-bridge.js';
import {
  HEX_ENGINE_WASM_BASE64,
  getHexEngineExports,
} from '../../js/core/hex-engine-wasm.js';
import {
  getFallbackCount,
  getWasmCallCount,
  getWasmCallCounts,
  resetAllTelemetry,
} from '../../js/core/wasm-telemetry.js';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

function toAddrKey(value) {
  if (value == null) return null;
  if (typeof value === 'bigint') return `0x${value.toString(16)}`;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `0x${BigInt(Math.trunc(value)).toString(16)}`;
  }
  return String(value);
}

function normalizeSource(source) {
  if (!source || typeof source !== 'object') return null;
  const addresses = Array.isArray(source.addresses)
    ? source.addresses.map((a) => toAddrKey(a))
    : [];
  const rows = Array.isArray(source.rows) ? source.rows.map((r) => Number(r)) : [];
  return { addresses, rows };
}

function normalizeLines(result) {
  if (!Array.isArray(result?.lines)) return [];
  return result.lines.map((line) => ({
    text: String(line?.text ?? ''),
    addr: toAddrKey(line?.addr ?? line?.address ?? null),
    row: line?.row ?? null,
    kind: line?.kind ?? null,
    source: normalizeSource(line?.source),
  }));
}

function extractPseudocode(result) {
  if (!result) return '';
  if (typeof result.pseudocode === 'string' && result.pseudocode.length > 0) {
    return result.pseudocode;
  }
  if (Array.isArray(result.lines)) {
    return result.lines.map((l) => String(l?.text ?? '')).join('\n');
  }
  return '';
}

function normalizeSourceMap(result, normalizedLines) {
  if (Array.isArray(result?.sourceMap)) {
    return result.sourceMap.map((entry) => {
      const normSrc = normalizeSource(entry?.source);
      const addresses = normSrc
        ? normSrc.addresses
        : (entry?.address != null || entry?.addr != null
            ? [toAddrKey(entry.address ?? entry.addr)]
            : []);
      const rows = normSrc ? normSrc.rows : [];
      const startLine = entry?.outputStartLine ?? entry?.line ?? entry?.lineNo ?? entry?.line_no ?? null;
      const endLine = entry?.outputEndLine ?? startLine;
      return { startLine, endLine, addresses, rows };
    });
  }
  const derived = [];
  for (let i = 0; i < normalizedLines.length; i += 1) {
    const line = normalizedLines[i];
    const addrs = line.source?.addresses?.length
      ? line.source.addresses
      : (line.addr ? [line.addr] : []);
    if (addrs.length > 0) {
      derived.push({
        startLine: i + 1,
        endLine: i + 1,
        addresses: addrs,
        rows: line.source?.rows ?? (line.row != null ? [line.row] : []),
      });
    }
  }
  return derived;
}

function decodeBase64(b64) {
  const buf = Buffer.from(b64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// ---------------------------------------------------------------------------
// 1. ARM64 expanded instruction set 0-diff parity (JS vs WASM)
// ---------------------------------------------------------------------------
const ARM64_EXPANDED_CASES = [
  {
    name: '_w7_add_imm_w',
    baseAddr: 0x100001000n,
    insns: [
      { row: 0, address: 0x100001000n, size: 4, mn: 'add', ops: 'w0, w0, #1', word: 0x11000400 },
      { row: 1, address: 0x100001004n, size: 4, mn: 'ret', ops: '', word: 0xd65f03c0 },
    ],
  },
  {
    name: '_w7_sub_reg_w',
    baseAddr: 0x100001100n,
    insns: [
      { row: 0, address: 0x100001100n, size: 4, mn: 'sub', ops: 'w0, w0, w1', word: 0x4b010000 },
      { row: 1, address: 0x100001104n, size: 4, mn: 'ret', ops: '', word: 0xd65f03c0 },
    ],
  },
  {
    name: '_w7_sub_imm_x',
    baseAddr: 0x100001200n,
    insns: [
      { row: 0, address: 0x100001200n, size: 4, mn: 'sub', ops: 'x0, x0, #4', word: 0xd1001000 },
      { row: 1, address: 0x100001204n, size: 4, mn: 'ret', ops: '', word: 0xd65f03c0 },
    ],
  },
  {
    name: '_w7_and_reg_w',
    baseAddr: 0x100001300n,
    insns: [
      { row: 0, address: 0x100001300n, size: 4, mn: 'and', ops: 'w0, w0, w1', word: 0x0a010000 },
      { row: 1, address: 0x100001304n, size: 4, mn: 'ret', ops: '', word: 0xd65f03c0 },
    ],
  },
  {
    name: '_w7_eor_reg_x',
    baseAddr: 0x100001400n,
    insns: [
      { row: 0, address: 0x100001400n, size: 4, mn: 'eor', ops: 'x0, x0, x1', word: 0xca010000 },
      { row: 1, address: 0x100001404n, size: 4, mn: 'ret', ops: '', word: 0xd65f03c0 },
    ],
  },
  {
    name: '_w7_nop_add_w',
    baseAddr: 0x100001500n,
    insns: [
      { row: 0, address: 0x100001500n, size: 4, mn: 'nop', ops: '', word: 0xd503201f },
      { row: 1, address: 0x100001504n, size: 4, mn: 'add', ops: 'w0, w0, w1', word: 0x0b010000 },
      { row: 2, address: 0x100001508n, size: 4, mn: 'ret', ops: '', word: 0xd65f03c0 },
    ],
  },
  {
    name: '_w7_movz_imm_w',
    baseAddr: 0x100001600n,
    insns: [
      { row: 0, address: 0x100001600n, size: 4, mn: 'movz', ops: 'w0, #42', word: 0x52800540 },
      { row: 1, address: 0x100001604n, size: 4, mn: 'ret', ops: '', word: 0xd65f03c0 },
    ],
  },
  {
    name: '_w7_frame_prologue_add_epilogue',
    baseAddr: 0x100001700n,
    insns: [
      { row: 0, address: 0x100001700n, size: 4, mn: 'stp', ops: 'x29, x30, [sp, #-16]!', word: 0xa9bf7bfd },
      { row: 1, address: 0x100001704n, size: 4, mn: 'mov', ops: 'x29, sp', word: 0x910003fd },
      { row: 2, address: 0x100001708n, size: 4, mn: 'add', ops: 'w0, w0, w1', word: 0x0b010000 },
      { row: 3, address: 0x10000170cn, size: 4, mn: 'ldp', ops: 'x29, x30, [sp], #16', word: 0xa8c17bfd },
      { row: 4, address: 0x100001710n, size: 4, mn: 'ret', ops: '', word: 0xd65f03c0 },
    ],
  },
];

test('Wave 7 parity: ARM64 expanded instructions produce 0-diff pseudocode, lines, and sourceMap (JS vs WASM)', () => {
  for (const tc of ARM64_EXPANDED_CASES) {
    const model = buildSemanticModel(tc.insns, {
      startRow: 0,
      endRow: tc.insns.length - 1,
      rowOfAddress: () => null,
      symbolFor: () => null,
      name: tc.name,
    });
    const baseOpts = {
      addr: tc.baseAddr,
      name: tc.name,
      beginner: false,
    };

    const jsRes = decompile(model, { ...baseOpts, _engine: 'js' });
    const wasmRes = decompile(model, { ...baseOpts, _engine: 'auto' });

    const jsCode = extractPseudocode(jsRes);
    const wasmCode = extractPseudocode(wasmRes);
    assert.ok(jsCode.length > 0, `${tc.name}: JS pseudocode must be non-empty`);
    assert.equal(wasmCode, jsCode, `${tc.name}: pseudocode mismatch between JS and WASM`);

    const jsLines = normalizeLines(jsRes);
    const wasmLines = normalizeLines(wasmRes);
    assert.deepEqual(wasmLines, jsLines, `${tc.name}: lines array mismatch between JS and WASM`);

    const jsMap = normalizeSourceMap(jsRes, jsLines);
    const wasmMap = normalizeSourceMap(wasmRes, wasmLines);
    assert.deepEqual(wasmMap, jsMap, `${tc.name}: sourceMap mismatch between JS and WASM`);
  }
  assert.ok(getWasmCallCount('decompile') >= 7, `expected >= 7 WASM decompile calls across expanded ARM64 suite, got ${getWasmCallCount('decompile')}`);
});

// ---------------------------------------------------------------------------
// 2. Cross-domain rollback consistency under globalThis.HEX_ENGINE = 'js'
// ---------------------------------------------------------------------------
test('Wave 7 rollback: globalThis.HEX_ENGINE = "js" disables WASM across all domains with consistent telemetry', () => {
  const prevGlobal = globalThis.HEX_ENGINE;
  const prevMode = globalThis.__HEX_ENGINE_MODE__;
  const prevEnv = process.env.HEX_ENGINE;

  try {
    globalThis.HEX_ENGINE = 'js';
    delete globalThis.__HEX_ENGINE_MODE__;
    delete process.env.HEX_ENGINE;
    resetAllTelemetry();

    assert.equal(getEngineMode(), 'js', 'getEngineMode() must return "js"');
    assert.equal(isWasmEngineAvailable(), false, 'isWasmEngineAvailable() must return false');

    // (a) decompile()
    const insns = [
      { row: 0, address: 0x1000n, size: 4, mn: 'add', ops: 'x0, x0, x1', word: 0x8b010000 },
      { row: 1, address: 0x1004n, size: 4, mn: 'ret', ops: '', word: 0xd65f03c0 },
    ];
    const model = buildSemanticModel(insns, {
      startRow: 0,
      endRow: 1,
      rowOfAddress: () => null,
      symbolFor: () => null,
      name: '_rollback_add',
    });
    const decRes = decompile(model, { addr: 0x1000n, name: '_rollback_add', beginner: false });
    assert.ok(extractPseudocode(decRes).length > 0, 'decompile() must succeed via JS fallback');

    // (b) analyzeGraph()
    const cfg = analyzeGraph([[1, 2], [3], [3], []], 0);
    assert.ok(cfg && cfg.reachable, 'analyzeGraph() must succeed via JS fallback');

    // (c) openBinary()
    const img = openBinary(buildSampleBinary(), { strings: true });
    assert.ok(img && img.format, 'openBinary() must succeed via JS fallback');

    // (d) classifyWord()
    const kind = globalThis.Words.classifyWord(0x8b010000);
    assert.ok(kind != null, 'Words.classifyWord() must succeed via JS fallback');

    // Verify 0 WASM calls across all domains
    const counts = getWasmCallCounts();
    const totalWasmCalls = Object.values(counts).reduce((sum, n) => sum + Number(n || 0), 0);
    assert.equal(
      totalWasmCalls,
      0,
      `expected 0 WASM calls under globalThis.HEX_ENGINE="js", got ${JSON.stringify(counts)}`,
    );

    assert.ok(
      getFallbackCount('cfg:wasm_disabled') >= 1,
      'cfg:wasm_disabled fallback count must be >= 1',
    );
    assert.ok(
      getFallbackCount('decompile:wasm_disabled') >= 1,
      'decompile:wasm_disabled fallback count must be >= 1',
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

// ---------------------------------------------------------------------------
// 3. x86_64 WASM decompiler ABI smoke test (auto-runs when exported)
// ---------------------------------------------------------------------------
test('Wave 7 x86_64 WASM ABI smoke: SysV AMD64, Microsoft x64, and truncated input rejection', (t) => {
  const ex = getHexEngineExports();
  if (!ex || typeof ex.hex_engine_decompile_x86_64 !== 'function') {
    t.skip('hex_engine_decompile_x86_64 not yet exported in current unified WASM');
    return;
  }

  const scratchReset = ex.hex_engine_scratch_reset || ex.hex_identity_reset;
  const scratchAlloc = ex.hex_engine_scratch_alloc || ex.hex_identity_alloc;
  const getTextPtr = ex.hex_x86_64_decomp_get_text_ptr || ex.hex_engine_decompile_get_text_ptr || ex.hex_decomp_get_text_ptr;
  const getTextLen = ex.hex_x86_64_decomp_get_text_len || ex.hex_engine_decompile_get_text_len || ex.hex_decomp_get_text_len;
  const getLmPtr = ex.hex_x86_64_decomp_get_linemap_ptr || ex.hex_engine_decompile_get_linemap_ptr || ex.hex_decomp_get_linemap_ptr;
  const getLmCount = ex.hex_x86_64_decomp_get_linemap_count || ex.hex_engine_decompile_get_linemap_count || ex.hex_decomp_get_linemap_count;

  assert.equal(typeof scratchReset, 'function', 'scratch reset export required');
  assert.equal(typeof scratchAlloc, 'function', 'scratch alloc export required');
  assert.equal(typeof getTextPtr, 'function', 'text ptr export required');
  assert.equal(typeof getTextLen, 'function', 'text len export required');
  assert.equal(typeof getLmPtr, 'function', 'linemap ptr export required');
  assert.equal(typeof getLmCount, 'function', 'linemap count export required');

  function runX86Decompile(codeBytes, funcName, abiId, baseAddr = 0x401000n) {
    scratchReset();
    const bytesPtr = scratchAlloc(codeBytes.length);
    assert.ok(bytesPtr > 0, 'bytes scratch allocation must succeed');
    new Uint8Array(ex.memory.buffer, bytesPtr, codeBytes.length).set(codeBytes);

    const nameBytes = TEXT_ENCODER.encode(funcName);
    const namePtr = scratchAlloc(nameBytes.length + 1);
    assert.ok(namePtr > 0, 'name scratch allocation must succeed');
    const nameView = new Uint8Array(ex.memory.buffer, namePtr, nameBytes.length + 1);
    nameView.set(nameBytes, 0);
    nameView[nameBytes.length] = 0;

    const status = ex.hex_engine_decompile_x86_64(
      bytesPtr,
      codeBytes.length,
      baseAddr,
      namePtr,
      nameBytes.length,
      abiId,
      HEX_EMIT_FLAG_JS_PARITY,
    );
    if (status !== HEX_OK) {
      return { status, text: '', linemapCount: 0 };
    }
    const textPtr = getTextPtr();
    const textLen = getTextLen();
    const lmPtr = getLmPtr();
    const lmCount = getLmCount();
    const text = textPtr && textLen
      ? TEXT_DECODER.decode(new Uint8Array(ex.memory.buffer, textPtr, textLen))
      : '';
    return { status, text, linemapPtr: lmPtr, linemapCount: lmCount };
  }

  // SysV AMD64 (abi_id = 0): mov eax, edi; add eax, esi; ret
  const sysv = runX86Decompile(new Uint8Array([0x89, 0xf8, 0x01, 0xf0, 0xc3]), 'sysv_add', 0);
  assert.equal(sysv.status, HEX_OK, `SysV AMD64 decompile expected HEX_OK, got ${sysv.status}`);
  assert.ok(sysv.text.includes('sysv_add'), 'SysV output must include function name');
  assert.ok(sysv.text.includes('return') && sysv.text.includes('+'), 'SysV output must emit addition return');
  assert.ok(sysv.linemapCount > 0, 'SysV output must emit non-empty linemap');

  // Microsoft x64 (abi_id = 1): mov eax, ecx; add eax, edx; ret
  const ms = runX86Decompile(new Uint8Array([0x89, 0xc8, 0x01, 0xd0, 0xc3]), 'ms_add', 1);
  assert.equal(ms.status, HEX_OK, `Microsoft x64 decompile expected HEX_OK, got ${ms.status}`);
  assert.ok(ms.text.includes('ms_add'), 'Microsoft x64 output must include function name');
  assert.ok(ms.text.includes('return') && ms.text.includes('+'), 'Microsoft x64 output must emit addition return');
  assert.ok(ms.linemapCount > 0, 'Microsoft x64 output must emit non-empty linemap');

  // Truncated input: e8 01 00 (incomplete rel32 call)
  const trunc = runX86Decompile(new Uint8Array([0xe8, 0x01, 0x00]), 'trunc_fn', 0);
  assert.notEqual(trunc.status, HEX_OK, 'truncated x86_64 input must fail closed with non-OK status');
});

// ---------------------------------------------------------------------------
// 4. Unified WASM binary health & iOS Safari constraints
// ---------------------------------------------------------------------------
test('Wave 7 WASM binary health: zero external imports, no SharedArrayBuffer, initial linear memory <= 16 MiB', () => {
  assert.equal(typeof HEX_ENGINE_WASM_BASE64, 'string', 'HEX_ENGINE_WASM_BASE64 must be exported');
  const bytes = decodeBase64(HEX_ENGINE_WASM_BASE64);
  assert.ok(bytes.byteLength > 8, 'decoded WASM bytes must be non-empty');

  const mod = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(mod);
  assert.equal(imports.length, 0, `WASM must have 0 external imports, found ${imports.length}`);

  // Inspect WASM memory section flags to verify non-shared, 32-bit memory
  let off = 8;
  let sawMemorySection = false;
  while (off < bytes.length) {
    const id = bytes[off];
    off += 1;
    let size = 0;
    let shift = 0;
    while (off < bytes.length) {
      const b = bytes[off];
      off += 1;
      size |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    if (id === 5) {
      sawMemorySection = true;
      const flags = bytes[off + 1];
      assert.equal(flags & 0x02, 0, 'WASM memory must not be shared (no SharedArrayBuffer)');
      assert.equal(flags & 0x04, 0, 'WASM memory must be memory32 (iOS Safari compatible)');
    }
    off += size;
  }
  assert.ok(sawMemorySection, 'WASM binary must declare a memory section');

  const inst = new WebAssembly.Instance(mod, {});
  assert.ok(inst.exports.memory instanceof WebAssembly.Memory, 'WASM must export linear memory');
  const buf = inst.exports.memory.buffer;
  if (typeof SharedArrayBuffer === 'function') {
    assert.equal(buf instanceof SharedArrayBuffer, false, 'WASM linear memory must not be SharedArrayBuffer');
  }
  const MAX_IOS_INITIAL_BYTES = 16 * 1024 * 1024;
  assert.ok(
    buf.byteLength <= MAX_IOS_INITIAL_BYTES,
    `initial linear memory ${buf.byteLength} bytes exceeds iOS Safari 16 MiB budget (${MAX_IOS_INITIAL_BYTES})`,
  );
});
