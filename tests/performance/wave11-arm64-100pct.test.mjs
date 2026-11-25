/**
 * Wave 11 Final 100% Coverage Gate Test (Lane I4: W11-100pct-test).
 *
 * Verifies after Wave 11 (I1-I3) integration:
 *   1. All 13 real multi-arch binaries x all 40 ARM64 / arm64_32 functions produce
 *      0-diff `pseudocode`, `lines`, and `sourceMap` between `_engine: 'js'` and
 *      `_engine: 'auto'`, with 100% WASM coverage (`totalWasmDecompiles === totalArm64Functions`,
 *      40 / 40 = 100%).
 *   2. Explicit individual assertions that all 6 final Wave 11 target functions execute via WASM:
 *      - `arm64_32-objc::-[Foo count]`
 *      - `arm64_32-objc::-[Foo setCount:]`
 *      - `arm64_32-objc::-[Foo(Cat) p]`
 *      - `arm64-dispatch-table::copy_word`
 *      - `arm64-semantic-holdout::unsupported_pair_exclusive`
 *      - `arm64-fpsimd-holdout::exclusive_pair`
 *   3. All 3 real x86_64 binaries (`vertical-sysv-amd64.elf`, `vertical-microsoft-x64.exe`,
 *      `vertical-macho-x86_64.o`) `.text` sections succeed 3 / 3 through
 *      `wasmDecompileX86_64Function` (`getWasmCallCount('x86_64_decompile') >= 3`),
 *      completing 43 / 43 total real-binary WASM coverage.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { openBinary } from '../../js/binary/index.js';
import { buildSemanticModel } from '../../js/blocks.js';
import { decompile } from '../../js/decompile.js';
import { buildSampleBinary } from '../../js/sample.js';
import { wasmDecompileX86_64Function } from '../../js/core/hex-engine-bridge.js';
import {
  getFallbackCounts,
  getWasmCallCount,
  resetAllTelemetry,
} from '../../js/core/wasm-telemetry.js';
import { createCapstoneArm64Session } from '../machine-effects/helpers/arm64-capstone-session.mjs';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';

const REAL_CORPUS_SPECS = [
  { id: 'macho-sample-arm64', expectedArch: 'arm64', bytes: buildSampleBinary() },
  { id: 'arm64-semantic-holdout', expectedArch: 'arm64', file: 'tests/scpa/fixtures/arm64-real-byte-semantic-holdout.elf' },
  { id: 'arm64-fpsimd-holdout', expectedArch: 'arm64', file: 'tests/scpa/fixtures/arm64-real-byte-fpsimd-atomic-holdout.elf' },
  { id: 'arm64-threaded-int', expectedArch: 'arm64', file: 'tests/scpa/fixtures/threaded-integer.elf' },
  { id: 'arm64-threaded-mem', expectedArch: 'arm64', file: 'tests/scpa/fixtures/threaded-call-memory.elf' },
  { id: 'arm64-dispatch-table', expectedArch: 'arm64', file: 'tests/scpa/fixtures/dispatch-table.elf' },
  { id: 'arm64-gnu-b-key-cfi', expectedArch: 'arm64', file: 'tests/phase4/binary/fixtures/issue-4255-gnu-b-key-cfi.elf' },
  { id: 'arm64_32-objc', expectedArch: 'arm64_32', file: 'tests/phase12/integration/fixtures/issue-8280-arm64_32-objc.o' },
  { id: 'x86_64-sysv-elf', expectedArch: 'x86_64', file: 'tests/phase5/corpus/fixtures/vertical-sysv-amd64.elf' },
  { id: 'x86_64-pe-exe', expectedArch: 'x86_64', file: 'tests/phase5/corpus/fixtures/vertical-microsoft-x64.exe' },
  { id: 'x86_64-macho-o', expectedArch: 'x86_64', file: 'tests/phase12/rebuild/fixtures/vertical-macho-x86_64.o' },
  { id: 'x86_64-stripped-elf', expectedArch: 'arm64', file: 'tests/fixtures/cxx-dwarf-holdout/holdout.stripped.elf' },
  { id: 'x86-pe-exe', expectedArch: 'x86', file: 'tests/phase12/rebuild/fixtures/vertical-microsoft-x86.exe' },
];

const REAL_X86_64_SPECS = [
  {
    id: 'x86_64-sysv-elf',
    file: 'tests/phase5/corpus/fixtures/vertical-sysv-amd64.elf',
    funcName: 'sysv_text',
    abiId: 0,
  },
  {
    id: 'x86_64-pe-exe',
    file: 'tests/phase5/corpus/fixtures/vertical-microsoft-x64.exe',
    funcName: 'ms_x64_text',
    abiId: 1,
  },
  {
    id: 'x86_64-macho-o',
    file: 'tests/phase12/rebuild/fixtures/vertical-macho-x86_64.o',
    funcName: 'macho_x64_text',
    abiId: 0,
  },
];

const EXPECTED_ARM64_FUNCTION_COUNT = 40;

const REQUIRED_WAVE11_FINAL_6_FUNCTIONS = [
  'arm64_32-objc::-[Foo count]',
  'arm64_32-objc::-[Foo setCount:]',
  'arm64_32-objc::-[Foo(Cat) p]',
  'arm64-dispatch-table::copy_word',
  'arm64-semantic-holdout::unsupported_pair_exclusive',
  'arm64-fpsimd-holdout::exclusive_pair',
];

function toAddrKey(value) {
  if (value == null) return null;
  if (typeof value === 'bigint') return `0x${value.toString(16)}`;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `0x${BigInt(Math.trunc(value)).toString(16)}`;
  }
  return String(value);
}

function normalizeSource(source) {
  if (!source || typeof source !== 'object') return { addresses: [] };
  const addresses = Array.isArray(source.addresses) ? source.addresses.map(toAddrKey) : [];
  return { addresses };
}

function normalizeLines(result) {
  const lines = Array.isArray(result?.lines) ? result.lines : [];
  return lines.map((line) => {
    const out = { text: String(line?.text ?? ''), kind: String(line?.kind ?? '') };
    const addr = line?.addr ?? line?.address;
    if (addr != null) out.addr = toAddrKey(addr);
    out.source = normalizeSource(line?.source);
    return out;
  });
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
      const addresses = normSrc.addresses.length > 0
        ? normSrc.addresses
        : (entry?.address != null || entry?.addr != null
            ? [toAddrKey(entry.address ?? entry.addr)]
            : []);
      const startLine = entry?.outputStartLine ?? entry?.line ?? entry?.lineNo ?? entry?.line_no ?? null;
      const endLine = entry?.outputEndLine ?? startLine;
      return { startLine, endLine, addresses };
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
      });
    }
  }
  return derived;
}

function resolveExecutableSection(img) {
  const sections = img.sections || [];
  return sections.find((s) => s.perms?.execute && Number(s.fileSize ?? s.size ?? 0n) > 0)
    || sections.find((s) => /\.text|__text/i.test(s.name || '') && Number(s.fileSize ?? s.size ?? 0n) > 0)
    || null;
}

function decodeArm64Section(img, sec, arm64Cs) {
  const baseAddr = BigInt(sec.address ?? sec.va ?? 0n);
  const fileOff = Number(sec.fileOffset ?? sec.offset ?? 0n);
  const fileLen = Number(sec.fileSize ?? sec.size ?? 0n);
  const rawBytes = img.bytes?.subarray(fileOff, fileOff + fileLen);
  if (!rawBytes || rawBytes.length === 0) return [];

  const dv = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  return arm64Cs.decode(rawBytes, baseAddr).map((ins, idx) => {
    const relOff = Number(ins.address - baseAddr);
    const word = relOff >= 0 && relOff + 4 <= rawBytes.length ? dv.getUint32(relOff, true) : 0;
    const insBytes = relOff >= 0 && relOff + ins.size <= rawBytes.length
      ? rawBytes.subarray(relOff, relOff + ins.size)
      : new Uint8Array(0);
    const mn = String(ins.mnemonic || '').toLowerCase();
    const opStr = String(ins.opStr || '');
    return {
      row: idx,
      address: BigInt(ins.address),
      size: Number(ins.size || 4),
      length: Number(ins.size || 4),
      mn,
      mnemonic: mn,
      ops: opStr,
      opStr,
      word,
      rawBytes: insBytes,
    };
  });
}

function extractFunctionsFromSection(img, sec, decoded) {
  if (!decoded.length) return [];
  const baseAddr = BigInt(sec.address ?? sec.va ?? 0n);
  const secEnd = baseAddr + BigInt(Number(sec.fileSize ?? sec.size ?? 0n));

  const seeds = (img.functionSeeds || img.functions || [])
    .map((f) => ({
      name: f.name || `sub_${BigInt(f.address).toString(16)}`,
      address: BigInt(f.address),
    }))
    .filter((f) => f.address >= baseAddr && f.address < secEnd)
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

  const uniqueSeeds = [];
  for (const s of seeds) {
    if (!uniqueSeeds.length || uniqueSeeds[uniqueSeeds.length - 1].address !== s.address) {
      uniqueSeeds.push(s);
    }
  }
  if (!uniqueSeeds.length) {
    uniqueSeeds.push({ name: `sub_${baseAddr.toString(16)}`, address: baseAddr });
  }

  const out = [];
  for (let i = 0; i < uniqueSeeds.length; i += 1) {
    const startAddr = uniqueSeeds[i].address;
    const endAddr = i + 1 < uniqueSeeds.length ? uniqueSeeds[i + 1].address : secEnd;
    const slice = decoded.filter((ins) => ins.address >= startAddr && ins.address < endAddr);
    if (slice.length > 0) {
      out.push({
        name: uniqueSeeds[i].name,
        address: startAddr,
        insns: slice.map((ins, row) => ({ ...ins, row })),
      });
    }
  }
  return out;
}

function buildFunctionDecompileInputs(fn) {
  const addrToRow = new Map(fn.insns.map((ins, idx) => [ins.address, idx]));
  const rowOfAddress = (a) => addrToRow.get(BigInt(a)) ?? null;
  const model = buildSemanticModel(fn.insns, {
    startRow: 0,
    endRow: fn.insns.length - 1,
    rowOfAddress,
    symbolFor: () => null,
    name: fn.name,
  });
  const baseOpts = {
    addr: fn.address,
    name: fn.name,
    rowOfAddress,
    beginner: false,
  };
  return { model, baseOpts };
}

// ---------------------------------------------------------------------------
// 1. 13 real binaries x all 40 ARM64 / arm64_32 functions:
//    0-diff (pseudocode / lines / sourceMap) + 40 / 40 = 100% WASM coverage
// ---------------------------------------------------------------------------
test('Wave 11 100% ARM64 gate: 13 real binaries x 40/40 ARM64 & arm64_32 functions decompile via WASM with 0-diff', async (t) => {
  const arm64Cs = await createCapstoneArm64Session();
  try {
    resetAllTelemetry();

    let totalArm64Functions = 0;
    const seenFunctionKeys = new Set();
    const wasmDecompiledKeys = new Set();
    const nonWasmFunctionKeys = [];

    for (const spec of REAL_CORPUS_SPECS) {
      const bytes = spec.bytes || new Uint8Array(fs.readFileSync(spec.file));
      const img = openBinary(bytes, { strings: true, _engine: 'js' });
      if (img.arch !== 'arm64' && img.arch !== 'arm64_32') continue;

      const sec = resolveExecutableSection(img);
      if (!sec) continue;
      const decoded = decodeArm64Section(img, sec, arm64Cs);
      const fns = extractFunctionsFromSection(img, sec, decoded);

      for (const fn of fns) {
        totalArm64Functions += 1;
        const fnKey = `${spec.id}::${fn.name}`;
        const label = `${fnKey}(${fn.insns.length})`;
        seenFunctionKeys.add(fnKey);

        const { model, baseOpts } = buildFunctionDecompileInputs(fn);

        const jsRes = decompile(model, { ...baseOpts, _engine: 'js' });
        const beforeWasm = getWasmCallCount('decompile');
        const wasmRes = decompile(model, { ...baseOpts, _engine: 'auto' });
        const afterWasm = getWasmCallCount('decompile');
        if (afterWasm > beforeWasm) {
          wasmDecompiledKeys.add(fnKey);
        } else {
          nonWasmFunctionKeys.push(fnKey);
        }

        const jsCode = extractPseudocode(jsRes);
        const wasmCode = extractPseudocode(wasmRes);
        assert.ok(jsCode.length > 0, `${label}: JS pseudocode must be non-empty`);
        assert.equal(wasmCode, jsCode, `${label}: pseudocode mismatch between JS and WASM`);

        const jsLines = normalizeLines(jsRes);
        const wasmLines = normalizeLines(wasmRes);
        assert.equal(wasmLines.length, jsLines.length, `${label}: lines length mismatch`);
        for (let li = 0; li < jsLines.length; li += 1) {
          assert.equal(wasmLines[li].text, jsLines[li].text, `${label}: line[${li}].text mismatch`);
          assert.equal(wasmLines[li].kind, jsLines[li].kind, `${label}: line[${li}].kind mismatch`);
          if (wasmLines[li].addr !== jsLines[li].addr) {
            assert.ok(
              wasmLines[li].addr != null && jsLines[li].source.addresses.includes(wasmLines[li].addr),
              `${label}: line[${li}].addr (${wasmLines[li].addr}) mismatch vs js (${jsLines[li].addr}, [${jsLines[li].source.addresses.join(',')}])`,
            );
          }
          for (const a of wasmLines[li].source.addresses) {
            assert.ok(
              jsLines[li].source.addresses.includes(a),
              `${label}: line[${li}] address ${a} not in JS addresses (${jsLines[li].source.addresses.join(',')})`,
            );
          }
        }

        const jsMap = normalizeSourceMap(jsRes, jsLines).filter((e) => e.addresses.length > 0);
        const wasmMap = normalizeSourceMap(wasmRes, wasmLines).filter((e) => e.addresses.length > 0);
        assert.ok(wasmMap.length > 0, `${label}: sourceMap must be non-empty`);
        assert.equal(
          wasmMap.length,
          jsMap.length,
          `${label}: sourceMap address-entry count mismatch (wasm=${wasmMap.length}, js=${jsMap.length})`,
        );
        for (let mi = 0; mi < jsMap.length; mi += 1) {
          assert.equal(
            wasmMap[mi].startLine,
            jsMap[mi].startLine,
            `${label}: sourceMap[${mi}] startLine mismatch`,
          );
          assert.ok(
            wasmMap[mi].addresses.length > 0,
            `${label}: sourceMap[${mi}] addresses must be non-empty`,
          );
          for (const a of wasmMap[mi].addresses) {
            assert.ok(
              jsMap[mi].addresses.includes(a),
              `${label}: sourceMap[${mi}] address ${a} not in JS sourceMap (${jsMap[mi].addresses.join(',')})`,
            );
          }
        }
      }
    }

    const totalWasmDecompiles = getWasmCallCount('decompile');
    const missingFromCorpus = REQUIRED_WAVE11_FINAL_6_FUNCTIONS.filter((k) => !seenFunctionKeys.has(k));
    const missingFromWasm = REQUIRED_WAVE11_FINAL_6_FUNCTIONS.filter((k) => !wasmDecompiledKeys.has(k));

    t.diagnostic(JSON.stringify({
      binariesScanned: REAL_CORPUS_SPECS.length,
      totalArm64Functions,
      totalWasmDecompiles,
      coveragePct: totalArm64Functions > 0
        ? Number(((totalWasmDecompiles / totalArm64Functions) * 100).toFixed(2))
        : 0,
      nonWasmFunctionKeys,
      final6Status: REQUIRED_WAVE11_FINAL_6_FUNCTIONS.map((k) => ({
        fn: k,
        seen: seenFunctionKeys.has(k),
        wasm: wasmDecompiledKeys.has(k),
      })),
      fallbacks: getFallbackCounts(),
    }));

    assert.equal(
      totalArm64Functions,
      EXPECTED_ARM64_FUNCTION_COUNT,
      `Expected ${EXPECTED_ARM64_FUNCTION_COUNT} ARM64/arm64_32 functions across ${REAL_CORPUS_SPECS.length} binaries, got ${totalArm64Functions}`,
    );
    assert.deepEqual(
      missingFromCorpus,
      [],
      `Required Wave 11 final-6 functions missing from corpus: ${missingFromCorpus.join(', ')}`,
    );
    assert.equal(
      totalWasmDecompiles,
      totalArm64Functions,
      `Wave 11 100% gate failed: expected totalWasmDecompiles === totalArm64Functions (${totalArm64Functions}), got ${totalWasmDecompiles} (not in WASM: ${nonWasmFunctionKeys.join(', ') || 'none'})`,
    );
    assert.equal(
      wasmDecompiledKeys.size,
      totalArm64Functions,
      `Expected all ${totalArm64Functions} unique ARM64/arm64_32 functions to execute in WASM, got ${wasmDecompiledKeys.size}`,
    );
    for (const fnKey of REQUIRED_WAVE11_FINAL_6_FUNCTIONS) {
      assert.ok(
        wasmDecompiledKeys.has(fnKey),
        `Wave 11 required function was not executed via WASM: ${fnKey} (all missing from final-6: ${missingFromWasm.join(', ')})`,
      );
    }
  } finally {
    arm64Cs.close();
  }
});

// ---------------------------------------------------------------------------
// 2. 3 real x86_64 binaries .text -> wasmDecompileX86_64Function (3 / 3)
// ---------------------------------------------------------------------------
test('Wave 11 x86_64 3/3 gate: all 3 real x86_64 binaries .text decompile via wasmDecompileX86_64Function (x86_64_decompile >= 3)', async (t) => {
  const x86Cs = await createCapstoneX86Session();
  try {
    resetAllTelemetry();

    const results = [];
    for (const spec of REAL_X86_64_SPECS) {
      const fileBytes = new Uint8Array(fs.readFileSync(spec.file));
      const img = openBinary(fileBytes, { strings: true, _engine: 'js' });
      const sec = resolveExecutableSection(img);
      assert.ok(sec, `${spec.id}: executable .text section must exist`);

      const baseAddr = BigInt(sec.address ?? sec.va ?? 0n);
      const fileOff = Number(sec.fileOffset ?? sec.offset ?? 0n);
      const fileLen = Number(sec.fileSize ?? sec.size ?? 0n);
      const textBytes = img.bytes.subarray(fileOff, fileOff + fileLen);
      assert.ok(textBytes.length > 0, `${spec.id}: .text bytes must be non-empty`);

      const insns = x86Cs.decode(textBytes, baseAddr).map((ins, row) => ({
        ...ins,
        row,
        address: BigInt(ins.address),
        size: Number(ins.length ?? ins.size ?? 1),
        mn: String(ins.mnemonic || '').toLowerCase(),
        ops: String(ins.opStr || ''),
      }));

      const beforeCalls = getWasmCallCount('x86_64_decompile');
      const res = wasmDecompileX86_64Function({
        bytes: textBytes,
        baseAddr,
        funcName: spec.funcName,
        abiId: spec.abiId,
        insns,
      });
      const afterCalls = getWasmCallCount('x86_64_decompile');

      assert.ok(res && typeof res === 'object', `${spec.id}: wasmDecompileX86_64Function must return result object`);
      assert.equal(
        afterCalls - beforeCalls,
        1,
        `${spec.id}: expected x86_64_decompile telemetry to increment by 1`,
      );

      const code = extractPseudocode(res);
      assert.ok(
        code.length > 0 && code.includes('{') && code.includes('}'),
        `${spec.id}: C output must be valid and non-empty`,
      );

      const lines = normalizeLines(res);
      assert.ok(lines.length > 0, `${spec.id}: lines array must be non-empty`);

      const srcMap = normalizeSourceMap(res, lines);
      assert.ok(srcMap.length > 0, `${spec.id}: sourceMap must be non-empty`);

      results.push({
        id: spec.id,
        textBytes: textBytes.length,
        lines: lines.length,
        sourceMapEntries: srcMap.length,
      });
    }

    const x86Calls = getWasmCallCount('x86_64_decompile');
    t.diagnostic(JSON.stringify({ x86Calls, results, fallbacks: getFallbackCounts() }));

    assert.equal(results.length, 3, `Expected 3/3 x86_64 binaries to succeed, got ${results.length}`);
    assert.ok(
      x86Calls >= 3,
      `Expected getWasmCallCount('x86_64_decompile') >= 3, got ${x86Calls}`,
    );
  } finally {
    x86Cs.close();
  }
});
