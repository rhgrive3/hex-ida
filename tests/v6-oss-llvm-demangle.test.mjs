import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import {
  DEMANGLE_KIND,
  detectMangleKind,
  demangleSymbol,
} from '../js/analysis/types/core/symbol-demangler.js';
import {
  getWasmCallCount,
  getFallbackCount,
  resetAllTelemetry,
} from '../js/core/wasm-telemetry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-v6-oss-demangle-'));

const HEX_OK = 0;
const HEX_ERR_INVALID_ARG = 1;
const HEX_ERR_OOM = 2;
const HEX_ERR_RESOURCE_LIMIT = 3;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

try {
  // 1. Create freestanding stub include dir so upstream LLVM headers #include cleanly on wasm32 -nostdlib
  const stubInc = path.join(TMP_DIR, 'freestanding-inc');
  fs.mkdirSync(path.join(stubInc, 'llvm', 'Demangle'), { recursive: true });
  const stubHeaders = [
    'algorithm',
    'array',
    'cassert',
    'cctype',
    'cstdint',
    'cstdio',
    'cstdlib',
    'cstring',
    'limits',
    'new',
    'string_view',
    'type_traits',
    'utility',
    'llvm/Demangle/Demangle.h',
    'llvm/Demangle/StringViewExtras.h',
    'llvm/Demangle/Utility.h',
  ];
  for (const rel of stubHeaders) {
    fs.writeFileSync(path.join(stubInc, rel), '#pragma once\n', 'utf8');
  }

  // 2. Compile cpp/src/analysis/llvm_demangle_wasm.cpp for wasm32 (-Os -nostdlib -fno-exceptions -fno-rtti -mbulk-memory)
  const wasmOut = path.join(TMP_DIR, 'llvm_demangle.wasm');
  console.log('[OSS Track A] Compiling llvm_demangle_wasm.cpp (upstream LLVM Itanium + Rust) to wasm32...');
  execFileSync(
    'clang++',
    [
      '--target=wasm32',
      '-std=c++20',
      '-Os',
      '-nostdlib',
      '-fno-exceptions',
      '-fno-rtti',
      '-mbulk-memory',
      `-I${path.join(ROOT, 'cpp/include')}`,
      `-I${stubInc}`,
      '-Wl,--no-entry',
      '-Wl,--export-dynamic',
      '-Wl,--gc-sections',
      '-Wl,--initial-memory=1048576',
      '-Wl,--max-memory=4194304',
      '-Wl,-z,stack-size=65536',
      '-o',
      wasmOut,
      path.join(ROOT, 'cpp/src/analysis/llvm_demangle_wasm.cpp'),
    ],
    { stdio: 'inherit' }
  );

  const wasmBytes = fs.readFileSync(wasmOut);
  const gzipBytes = gzipSync(wasmBytes, { level: 9 }).length;
  const wasmMod = new WebAssembly.Module(wasmBytes);
  const imports = WebAssembly.Module.imports(wasmMod);
  const exportNames = WebAssembly.Module.exports(wasmMod).map((e) => e.name);

  console.log(
    `[OSS Track A] WASM build: raw=${wasmBytes.length} B (${(wasmBytes.length / 1024).toFixed(2)} KiB), ` +
      `gzip=${gzipBytes} B (${(gzipBytes / 1024).toFixed(2)} KiB), imports=${imports.length}`
  );
  assert.equal(imports.length, 0, `Expected 0 external WASM imports, got: ${JSON.stringify(imports)}`);
  assert(
    wasmBytes.length <= 160 * 1024,
    `Standalone demangler WASM (${wasmBytes.length} B) exceeded 160 KiB target`
  );

  const requiredExports = [
    'hex_demangle_symbol',
    'hex_demangle_detect_kind',
    'hex_demangle_in_buf_ptr',
    'hex_demangle_in_buf_cap',
    'hex_demangle_out_buf_ptr',
    'hex_demangle_out_buf_cap',
    'hex_demangle_out_len_ptr',
  ];
  for (const name of requiredExports) {
    assert(exportNames.includes(name), `Missing required export: ${name}`);
  }

  const instance = await WebAssembly.instantiate(wasmMod, {});
  const ex = instance.exports;

  // Use dedicated fixed I/O buffers exported by llvm_demangle_wasm.cpp
  const IN_PTR = ex.hex_demangle_in_buf_ptr() >>> 0;
  const IN_CAP = ex.hex_demangle_in_buf_cap() >>> 0;
  const OUT_PTR = ex.hex_demangle_out_buf_ptr() >>> 0;
  const OUT_CAP = ex.hex_demangle_out_buf_cap() >>> 0;
  const OUT_LEN_PTR = ex.hex_demangle_out_len_ptr() >>> 0;
  assert(IN_PTR > 0 && IN_CAP === 2048);
  assert(OUT_PTR > 0 && OUT_CAP === 8192);
  assert(OUT_LEN_PTR > 0);

  function wasmDetectKind(sym) {
    const bytes = textEncoder.encode(sym);
    new Uint8Array(ex.memory.buffer).set(bytes, IN_PTR);
    return ex.hex_demangle_detect_kind(IN_PTR, bytes.length);
  }

  function wasmDemangle(sym, outCap = OUT_CAP) {
    const bytes = textEncoder.encode(sym);
    const u8 = new Uint8Array(ex.memory.buffer);
    // Pre-fill output buffer with 0xCC sentinel to prove NUL termination is actively written
    u8.fill(0xcc, OUT_PTR, OUT_PTR + Math.min(outCap, OUT_CAP));
    if (bytes.length <= IN_CAP) u8.set(bytes, IN_PTR);
    const status = ex.hex_demangle_symbol(IN_PTR, bytes.length, OUT_PTR, outCap, OUT_LEN_PTR);
    const len = new DataView(ex.memory.buffer).getUint32(OUT_LEN_PTR, true);
    const nulByte = outCap > 0 && len < outCap ? u8[OUT_PTR + len] : -1;
    const text = len > 0 ? textDecoder.decode(new Uint8Array(ex.memory.buffer, OUT_PTR, len)) : '';
    return { status, len, nulByte, text };
  }

  // 3. NULL / 0-length argument boundary tests
  assert.equal(ex.hex_demangle_detect_kind(0, 10), DEMANGLE_KIND.NONE);
  assert.equal(ex.hex_demangle_detect_kind(IN_PTR, 0), DEMANGLE_KIND.NONE);
  assert.equal(ex.hex_demangle_symbol(0, 10, OUT_PTR, OUT_CAP, OUT_LEN_PTR), HEX_ERR_INVALID_ARG);
  assert.equal(ex.hex_demangle_symbol(IN_PTR, 0, OUT_PTR, OUT_CAP, OUT_LEN_PTR), HEX_ERR_INVALID_ARG);
  assert.equal(ex.hex_demangle_symbol(IN_PTR, 5, 0, OUT_CAP, OUT_LEN_PTR), HEX_ERR_INVALID_ARG);
  assert.equal(ex.hex_demangle_symbol(IN_PTR, 5, OUT_PTR, OUT_CAP, 0), HEX_ERR_INVALID_ARG);
  assert.equal(ex.hex_demangle_symbol(IN_PTR, 5, OUT_PTR, 0, OUT_LEN_PTR), HEX_ERR_OOM);
  console.log('[OSS Track A] PASS: NULL / 0-length / 0-cap argument safety checks.');

  // 4. Kind detection parity (WASM vs JS)
  const kindCases = [
    ['printf', DEMANGLE_KIND.NONE],
    ['_ZN17h0123456789abcdefE', DEMANGLE_KIND.ITANIUM_CPP], // 23 chars (< 24): empty path -> NOT rust legacy
    ['_ZNSt3__16vectorIiNS_9allocatorIiEEE9push_backERKi', DEMANGLE_KIND.ITANIUM_CPP],
    ['__ZN5Unity6Player4HealEf', DEMANGLE_KIND.ITANIUM_CPP],
    ['_RNvNtCs6kQ4x2a1_4core3fmt5write', DEMANGLE_KIND.RUST_V0],
    ['_ZN4core3ptr42drop_in_place$LT$alloc..string..String$GT$17h0123456789abcdefE', DEMANGLE_KIND.RUST_LEGACY],
  ];
  for (const [sym, expectedKind] of kindCases) {
    assert.equal(wasmDetectKind(sym), expectedKind, `WASM detect kind mismatch for ${sym}`);
    assert.equal(detectMangleKind(sym), expectedKind, `JS detect kind mismatch for ${sym}`);
  }

  // 5. Complex C++ Itanium tests (real LLVM ItaniumDemangle.h)
  const cppCases = [
    [
      '_ZNSt3__16vectorIiNS_9allocatorIiEEE9push_backERKi',
      'std::__1::vector<int, std::__1::allocator<int>>::push_back(int const&)',
    ],
    ['_ZTVN3foo3BarE', 'vtable for foo::Bar'],
    ['_ZThn16_N7Derived3fooEi', 'non-virtual thunk to Derived::foo(int)'],
    ['__ZN5Unity6Player4HealEf', 'Unity::Player::Heal(float)'],
    ['_ZNK3app6EngineplERKS0_', 'app::Engine::operator+(app::Engine const&) const'],
  ];
  for (const [mangled, expected] of cppCases) {
    const r = wasmDemangle(mangled);
    assert.equal(r.status, HEX_OK, `Failed to demangle C++ symbol: ${mangled}`);
    assert.equal(r.text, expected, `C++ demangle mismatch for ${mangled}`);
    assert.equal(r.nulByte, 0, `Expected NUL terminator at out_ptr[len] for ${mangled}`);
  }
  console.log(`[OSS Track A] PASS: ${cppCases.length} complex C++ Itanium cases.`);

  // 6. Rust v0 tests (real LLVM RustDemangle.cpp)
  const rustV0Cases = [
    ['_RNvNtCs6kQ4x2a1_4core3fmt5write', 'core::fmt::write'],
    ['_RNvNtCs1234_3foo3bar3baz', 'foo::bar::baz'],
    ['_RNvCs6kQ4x2a1_4core5write', 'core::write'],
  ];
  for (const [mangled, expected] of rustV0Cases) {
    const r = wasmDemangle(mangled);
    assert.equal(r.status, HEX_OK, `Failed to demangle Rust v0 symbol: ${mangled}`);
    assert.equal(r.text, expected, `Rust v0 demangle mismatch for ${mangled}`);
    assert.equal(r.nulByte, 0);
  }
  console.log(`[OSS Track A] PASS: ${rustV0Cases.length} Rust v0 cases.`);

  // 7. Rust legacy tests (hash stripping + $LT$/$GT$/$u20$/.. expansion)
  const rustLegacySym = '_ZN4core3ptr42drop_in_place$LT$alloc..string..String$GT$17h0123456789abcdefE';
  const rl = wasmDemangle(rustLegacySym);
  assert.equal(rl.status, HEX_OK);
  assert.equal(rl.text, 'core::ptr::drop_in_place<alloc::string::String>');
  assert.equal(rl.nulByte, 0);

  const rustLegacySpace = '_ZN3foo15bar$u20$baz$C$117hfedcba9876543210E';
  const rl2 = wasmDemangle(rustLegacySpace);
  assert.equal(rl2.status, HEX_OK);
  assert.equal(rl2.text, 'foo::bar baz,1');
  console.log('[OSS Track A] PASS: Rust legacy hash stripping & escape expansion.');

  // 8. DoS / Security / Truncation tests (Zero WASM traps, strict NUL termination)
  // (a) Itanium 500-deep pointer chain
  assert.equal(wasmDemangle('_Z' + 'P'.repeat(500) + 'i').status, HEX_ERR_RESOURCE_LIMIT);
  // (b) Itanium 200-deep template nesting
  assert.equal(wasmDemangle('_Z' + 'N1aI'.repeat(200) + 'i' + 'EE'.repeat(200)).status, HEX_ERR_RESOURCE_LIMIT);
  // (c) Itanium substitution bomb (100x S_)
  assert.equal(wasmDemangle('_Z1f' + 'S_'.repeat(100)).status, HEX_ERR_RESOURCE_LIMIT);
  // (d) Rust v0 deep reference prefix DoS (200x R)
  assert.equal(wasmDemangle('_R' + 'R'.repeat(200) + 'i').status, HEX_ERR_RESOURCE_LIMIT);
  // (e) Rust v0 deep nested path DoS (80x Nv)
  assert.equal(wasmDemangle('_R' + 'Nv'.repeat(80) + 'C3foo' + '1a'.repeat(80)).status, HEX_ERR_RESOURCE_LIMIT);
  // (f) Oversized input (> 2048 B)
  assert.equal(ex.hex_demangle_symbol(IN_PTR, 3000, OUT_PTR, OUT_CAP, OUT_LEN_PTR), HEX_ERR_RESOURCE_LIMIT);
  // (g) Malformed lengths
  assert.notEqual(wasmDemangle('_ZN999999999fooE').status, HEX_OK);
  assert.notEqual(
    wasmDemangle('_ZN4core3ptr85drop_in_place$LT$alloc..string..String$GT$17h0123456789abcdefE').status,
    HEX_OK
  );
  // (h) Small output buffer truncation (outCap = 16 -> max 15 chars + NUL at index 15)
  const trunc = wasmDemangle('_ZNSt3__16vectorIiNS_9allocatorIiEEE9push_backERKi', 16);
  assert.equal(trunc.status, HEX_ERR_OOM, 'Truncated output must return HEX_ERR_OOM');
  assert.equal(trunc.len, 15, 'copy_result_to_user must reserve 1 byte for NUL terminator');
  assert.equal(trunc.nulByte, 0, 'Truncated output must be NUL-terminated at out_ptr[len]');
  assert.equal(trunc.text, 'std::__1::vecto');
  console.log('[OSS Track A] PASS: Itanium/Rust v0 deep-nesting DoS, subst-bomb, malformed, and NUL-terminated truncation.');

  // 9. JS bridge (symbol-demangler.js) via dedicated I/O buffers (consecutive calls) + telemetry + INV-005
  const jsSrc = fs.readFileSync(path.join(ROOT, 'js/analysis/types/core/symbol-demangler.js'), 'utf8');
  assert(!/from\s+['"][^'"]*targets\/architecture/.test(jsSrc), 'INV-005 violation');
  assert(!jsSrc.includes('hex_engine_scratch_reset'), 'Must not touch shared hex_engine_scratch');
  assert(!jsSrc.includes('hex_type_arena_reset_slot'), 'Must not touch shared hex_type_arena');

  resetAllTelemetry();
  // Consecutive WASM calls via dedicated I/O buffers (no _scratchBase needed!)
  const consecutiveSyms = [
    ['_ZNSt3__16vectorIiNS_9allocatorIiEEE9push_backERKi', 'std::__1::vector<int, std::__1::allocator<int>>::push_back(int const&)'],
    ['_RNvNtCs6kQ4x2a1_4core3fmt5write', 'core::fmt::write'],
    [rustLegacySym, 'core::ptr::drop_in_place<alloc::string::String>'],
    ['_ZTVN3foo3BarE', 'vtable for foo::Bar'],
  ];
  for (const [mangled, expected] of consecutiveSyms) {
    assert.equal(demangleSymbol(mangled, { _wasmExports: ex }), expected);
  }
  assert.equal(getWasmCallCount('symbol_demangle'), consecutiveSyms.length);

  // Non-zero WASM status must record telemetry (no silent failure)
  assert.equal(demangleSymbol('_Z' + 'P'.repeat(500) + 'i', { _wasmExports: ex }), null);
  assert.equal(getFallbackCount('symbol_demangle:wasm_status_3'), 1);

  // HEX_ENGINE=js fallback path
  assert.equal(demangleSymbol('__ZN5Unity6Player4HealEf', { _engine: 'js' }), 'Unity::Player::Heal(float)');
  assert.equal(demangleSymbol('_RNvNtCs6kQ4x2a1_4core3fmt5write', { _engine: 'js' }), 'core::fmt::write');
  assert.equal(demangleSymbol(rustLegacySym, { _engine: 'js' }), 'core::ptr::drop_in_place<alloc::string::String>');
  assert.equal(getFallbackCount('symbol_demangle:wasm_disabled'), 3);

  console.log('[OSS Track A] PASS: Dedicated I/O buffer consecutive calls, telemetry on non-zero status, JS fallback, INV-005.');
  console.log('[OSS Track A] ALL TESTS PASSED (100%).');
} finally {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}
