/**
 * Track C OSS Real Integration Test Suite:
 * - Parses Ghidra official generic_clib_64.gdt (Apache-2.0) + real /usr/include POSIX C11 headers
 * - Builds into isolated os.tmpdir() (never dirties repo dist/)
 * - Verifies deterministic 2-run SHA-256 bit reproducibility & missing /usr/include fallback
 * - Verifies zero 1-2 char garbage callback names & zero non-pointer void (0x1) in paramHexTypes
 * - Verifies enum HEX_KIND.SCALAR preservation & strict budgets (core <= 160 KiB, pack <= 256 KiB)
 * - Mounts core-til-lite.til1 & posix-clib-full.til1 directly into REAL C++ WASM hex_til_mount
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as fflate from '../js/vendor/fflate.js';

import {
  TIL_PRIM,
  HEX_KIND,
} from '../js/analysis/types/core/til-lite-data.js';
import {
  DEFAULT_GDT_PATH,
  parseGhidraGdt,
  parseSystemPosixHeaders,
  extractPosixAndGhidraManifest,
} from '../scripts/import-ghidra-gdt.mjs';
import {
  buildTilHub,
  TIL1_PACK_SLOT_MAX_BYTES,
} from '../scripts/build-til-hub.mjs';
import {
  TIL1_CORE_MAX_BYTES,
  validateTil1Buffer,
  parseTil1Buffer,
  Til1View,
} from '../js/analysis/types/core/til-binary-compiler.js';
import { getHexEngineExports } from '../js/core/hex-engine-wasm.js';

const HEX_OK = 0;
const HEX_TIL_LOOKUP_DEFAULT = 0x06;

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(err);
  }
}

console.log('=== Track C: Ghidra generic_clib_64.gdt + POSIX Headers + WASM hex_til_mount Test ===');

// ---------------------------------------------------------------------------
// 1. Direct Ghidra generic_clib_64.gdt extraction & callback filtering
// ---------------------------------------------------------------------------
await test('parseGhidraGdt extracts real functions/structs/typedefs and filters callback pointer defs', () => {
  assert.ok(fs.existsSync(DEFAULT_GDT_PATH), `Missing Ghidra GDT at ${DEFAULT_GDT_PATH}`);
  const gdt = parseGhidraGdt(DEFAULT_GDT_PATH);
  assert.ok(gdt.functions.length >= 4000, `Expected >= 4000 GDT functions, got ${gdt.functions.length}`);
  assert.ok(gdt.structs.length >= 500, `Expected >= 500 GDT structs, got ${gdt.structs.length}`);
  assert.ok(gdt.typedefs.length >= 400, `Expected >= 400 GDT typedefs, got ${gdt.typedefs.length}`);
  assert.ok(gdt.skippedCallbackDefs > 0, 'Expected Pointers-referenced callback definitions to be filtered');

  const fnNames = new Set(gdt.functions.map((f) => f.name));
  for (const sym of ['fopen', 'malloc', 'pthread_create', 'socket', 'mmap', 'qsort', 'select']) {
    assert.ok(fnNames.has(sym), `Ghidra GDT missing expected POSIX symbol '${sym}'`);
  }
});

// ---------------------------------------------------------------------------
// 2. Real /usr/include POSIX C11 headers extraction + missing dir fallback
// ---------------------------------------------------------------------------
await test('parseSystemPosixHeaders parses real /usr/include/*.h and degrades cleanly when missing', () => {
  const posix = parseSystemPosixHeaders();
  assert.ok(posix.parsedFiles.length >= 10, `Expected >= 10 real POSIX headers parsed, got ${posix.parsedFiles.length}`);
  assert.ok(posix.functions.length >= 200, `Expected >= 200 real POSIX prototypes, got ${posix.functions.length}`);

  // Missing /usr/include fallback must not throw and must still produce valid GDT-backed manifest
  const fallbackManifest = extractPosixAndGhidraManifest({
    includeSystemHeaders: true,
    searchDirs: ['/nonexistent-usr-include-path-for-test'],
  });
  assert.equal(fallbackManifest.sources.posixHeadersParsed, 0);
  assert.ok(fallbackManifest.functions.length >= 1500);
});

// ---------------------------------------------------------------------------
// 3. Isolated tmpdir build, 2-run SHA-256 determinism, quality guards & budgets
// ---------------------------------------------------------------------------
await test('buildTilHub in tmpdir: 2-run SHA-256 determinism, zero void params, zero 1-2 char junk, budgets', async () => {
  const tmp1 = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-oss-til-run1-'));
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-oss-til-run2-'));
  try {
    const m1 = await buildTilHub({ outDir: tmp1, quiet: true });
    const m2 = await buildTilHub({ outDir: tmp2, quiet: true });

    // 2 consecutive runs must have 100% identical manifest & SHA-256 hashes
    assert.deepEqual(m1, m2, 'Two consecutive buildTilHub runs must be 100% bit-identical');
    assert.equal(m1.schema, 'til-hub-manifest/v1');
    assert.ok(m1.totalPacks >= 9);

    const totalDefs = m1.totalEntries + m1.totalTypes;
    assert.ok(totalDefs >= 1500, `Expected >= 1,500 total defs across packs, got ${totalDefs}`);

    const corePack = m1.packs.find((p) => p.id === 'core-til-lite');
    const posixPack = m1.packs.find((p) => p.id === 'posix-clib-full');
    assert.ok(corePack && posixPack);
    assert.ok(corePack.rawBytes <= TIL1_CORE_MAX_BYTES, `core-til-lite (${corePack.rawBytes}B) > 160 KiB`);
    assert.ok(posixPack.rawBytes <= TIL1_PACK_SLOT_MAX_BYTES, `posix-clib-full (${posixPack.rawBytes}B) > 256 KiB`);
    assert.ok(posixPack.entryCount >= 1500);

    // Verify .til1 and .til1.gz bit parity
    const posixRaw = new Uint8Array(fs.readFileSync(path.join(tmp1, posixPack.file)));
    const posixGz = new Uint8Array(fs.readFileSync(path.join(tmp1, posixPack.gzFile)));
    assert.deepEqual(fflate.gunzipSync(posixGz), posixRaw);
    assert.equal(validateTil1Buffer(posixRaw).ok, true);

    // Parse full posix-clib-full.til1 and run strict quality assertions
    const parsed = parseTil1Buffer(posixRaw, { tidBase: 0x1000, tidCap: 0x0a00 });
    const badShortNames = ['c', 'cb', 'ck', 'dh', 'f', 'fn', 'fp', 'go'];
    const fnNames = new Set(parsed.functions.map((f) => f.name));
    for (const bad of badShortNames) {
      assert.equal(fnNames.has(bad), false, `Garbage callback name '${bad}' must not appear in posix-clib-full`);
    }

    // Zero non-pointer TIL_PRIM.VOID (0x00000001) in paramHexTypes!
    let voidParamCount = 0;
    for (const fn of parsed.functions) {
      for (const pHex of fn.paramHexTypes) {
        if (pHex === TIL_PRIM.VOID) voidParamCount++;
      }
    }
    assert.equal(voidParamCount, 0, `Found ${voidParamCount} non-pointer void (0x1) entries in paramHexTypes`);

    // Enums must have HEX_KIND.SCALAR (not HEX_KIND.STRUCT)
    for (const e of parsed.enums) {
      const tDesc = parsed.types.find((t) => t.tid === e.tid);
      if (tDesc) {
        assert.equal(tDesc.kind, HEX_KIND.SCALAR, `Enum '${tDesc.name}' must have kind HEX_KIND.SCALAR`);
      }
    }

    // Spot check key POSIX symbols
    const view = new Til1View(posixRaw, { tidBase: 0x1000, tidCap: 0x0a00 });
    for (const sym of ['fopen', 'malloc', 'pthread_create', 'socket', 'mmap', 'qsort', 'select']) {
      assert.ok(view.lookupSymbol(sym), `Til1View missing '${sym}' in posix-clib-full.til1`);
    }
  } finally {
    fs.rmSync(tmp1, { recursive: true, force: true });
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. REAL C++ WASM hex_til_mount & hex_til_lookup_symbol end-to-end verification
// ---------------------------------------------------------------------------
await test('REAL WASM hex_til_mount mounts core-til-lite.til1 & posix-clib-full.til1 from tmpdir and resolves POSIX symbols', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-oss-til-wasm-'));
  try {
    await buildTilHub({ outDir: tmpDir, quiet: true });

    const ex = await Promise.resolve(getHexEngineExports());
    assert.ok(ex && typeof ex.hex_til_mount === 'function', 'WASM export hex_til_mount must be available');
    assert.ok(typeof ex.hex_til_lookup_symbol === 'function', 'WASM export hex_til_lookup_symbol must be available');

    const coreBytes = new Uint8Array(fs.readFileSync(path.join(tmpDir, 'core-til-lite.til1')));
    const posixGz = new Uint8Array(fs.readFileSync(path.join(tmpDir, 'posix-clib-full.til1.gz')));
    const posixBytes = fflate.gunzipSync(posixGz);

    const writeBytesToSlot = (slotId, bytes) => {
      const ptr = ex.hex_type_arena_bump_alloc(slotId, bytes.byteLength, 8);
      assert.ok(ptr > 0, `Arena bump alloc failed for slot ${slotId} (${bytes.byteLength}B)`);
      new Uint8Array(ex.memory.buffer, ptr, bytes.byteLength).set(bytes);
      return ptr;
    };

    ex.hex_til_purge_packs();
    ex.hex_type_arena_reset_slot(8);
    const corePtr = writeBytesToSlot(8, coreBytes);
    const posixPtr = writeBytesToSlot(8, posixBytes);

    assert.equal(ex.hex_til_mount(0, corePtr, coreBytes.byteLength, 0x0040, 0x0fc0), HEX_OK);
    assert.equal(ex.hex_til_mount(1, posixPtr, posixBytes.byteLength, 0x1000, 0x0a00), HEX_OK);

    ex.hex_type_arena_reset_slot(5);
    const recPtr = ex.hex_type_arena_bump_alloc(5, 64, 8);
    assert.ok(recPtr > 0);

    const wasmLookup = (symName, slotMask = 0x03) => {
      ex.hex_type_arena_reset_slot(6);
      const symBytes = new TextEncoder().encode(symName);
      const sp = writeBytesToSlot(6, symBytes);
      const st = ex.hex_til_lookup_symbol(sp, symBytes.byteLength, slotMask, HEX_TIL_LOOKUP_DEFAULT, recPtr);
      if (st !== HEX_OK) return { status: st };
      const dv = new DataView(ex.memory.buffer, recPtr, 64);
      const arity = dv.getUint8(5);
      const params = [];
      for (let i = 0; i < arity; i++) {
        params.push(dv.getUint32(16 + i * 4, true));
      }
      return {
        status: st,
        retHexType: dv.getUint32(0, true),
        flags: dv.getUint8(4),
        arity,
        matchedSlot: dv.getUint8(10),
        params,
      };
    };

    const expectedPosix = [
      { name: 'fopen', minArity: 2 },
      { name: 'malloc', minArity: 1 },
      { name: 'pthread_create', minArity: 4 },
      { name: 'socket', minArity: 3 },
      { name: 'mmap', minArity: 6 },
      { name: 'qsort', minArity: 4 },
      { name: 'select', minArity: 5 },
    ];
    for (const exp of expectedPosix) {
      const res = wasmLookup(exp.name, 0x02);
      assert.equal(res.status, HEX_OK, `WASM Slot 1 lookup failed for '${exp.name}' (status=${res.status})`);
      assert.equal(res.matchedSlot, 1);
      assert.ok(res.arity >= exp.minArity, `'${exp.name}' expected arity >= ${exp.minArity}, got ${res.arity}`);
      assert.ok(res.retHexType !== 0);
      for (const pHex of res.params) {
        assert.notEqual(pHex, TIL_PRIM.VOID, `'${exp.name}' must not have non-pointer void param`);
      }
    }

    const resIl2 = wasmLookup('il2cpp_runtime_invoke', 0x01);
    assert.equal(resIl2.status, HEX_OK);
    assert.equal(resIl2.matchedSlot, 0);
    assert.equal(resIl2.arity, 4);

    const resUnderscore = wasmLookup('_pthread_create', 0x02);
    assert.equal(resUnderscore.status, HEX_OK);
    assert.equal(resUnderscore.matchedSlot, 1);
    assert.equal(resUnderscore.arity, 4);

    ex.hex_til_purge_packs();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
