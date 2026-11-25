#!/usr/bin/env node
/**
 * Final E2E Benchmark for Wave 6 (W6-bench-rollback).
 *
 * Benchmarks all 13 real multi-arch binaries (ARM64, ARM64_32, x86_64, x86;
 * Mach-O, ELF, PE) x all extracted functions across 3 engine modes:
 *   - js   (_engine: 'js')
 *   - wasm (_engine: 'wasm')
 *   - auto (_engine: 'auto', mixed WASM + JS fallback)
 *
 * Reports:
 *   1. Full-corpus decompilation wall time (median ms across rounds) and peak
 *      memory (RSS MB / heapUsed MB) per mode.
 *   2. WASM-eligible N-function subset decompilation wall time (median ms) and
 *      peak memory per mode.
 *   3. Telemetry verification (wasmCalls & fallbackCounts) per mode.
 *   4. Wave 13 microbenchmarks (256 KiB scanStrings & 1 MiB compileBytePattern).
 *   5. Both human-readable Markdown tables and machine-readable JSON output.
 *
 * Usage:
 *   node scripts/benchmark-final-e2e.mjs [--rounds=3] [--wasm7-iters=20]
 */
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

import { openBinary, scanStrings } from '../js/binary/index.js';
import { compileBytePattern } from '../js/platform/byte-search.js';
import { buildSampleBinary } from '../js/sample.js';
import { buildSemanticModel } from '../js/blocks.js';
import { buildCfg } from '../js/cfg.js';
import { analyzeGraph } from '../js/controlflow.js';
import { decompile } from '../js/decompile.js';
import { analyzeSemanticFunction } from '../js/analysis/semantic-function.js';
import {
  getFallbackCounts,
  getWasmCallCount,
  getWasmCallCounts,
  resetAllTelemetry,
} from '../js/core/wasm-telemetry.js';
import { createCapstoneArm64Session } from '../tests/machine-effects/helpers/arm64-capstone-session.mjs';
import { createCapstoneX86Session } from '../tests/phase5/helpers/capstone-session.mjs';

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

function parseCliArgs(argv) {
  let rounds = 3;
  let wasm7Iters = 20;
  for (const arg of argv) {
    if (arg.startsWith('--rounds=')) {
      const n = Number.parseInt(arg.slice('--rounds='.length), 10);
      if (Number.isInteger(n) && n >= 1) rounds = n;
    } else if (arg.startsWith('--wasm7-iters=')) {
      const n = Number.parseInt(arg.slice('--wasm7-iters='.length), 10);
      if (Number.isInteger(n) && n >= 1) wasm7Iters = n;
    }
  }
  return { rounds, wasm7Iters };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const ALL_WASM_DOMAINS = Object.freeze([
  'decompile',
  'x86_64_decompile',
  'cfg',
  'loops',
  'identity',
  'binary',
  'arm64_decode',
  'x86_64_decode',
  'strings',
  'byte_search',
]);

function summarizeWasmCalls(counts = {}) {
  const byDomain = {};
  let total = 0;
  for (const domain of ALL_WASM_DOMAINS) {
    const value = Number(counts[domain] || 0);
    byDomain[domain] = value;
    total += value;
  }
  for (const [domain, rawVal] of Object.entries(counts)) {
    if (!Object.hasOwn(byDomain, domain)) {
      const value = Number(rawVal || 0);
      byDomain[domain] = value;
      total += value;
    }
  }
  return { byDomain, total };
}

function withModeEnv(mode, fn) {
  const prevGlobal = globalThis.HEX_ENGINE;
  const prevGlobalMode = globalThis.__HEX_ENGINE_MODE__;
  const prevEnv = process.env.HEX_ENGINE;
  try {
    if (mode === 'js') {
      globalThis.HEX_ENGINE = 'js';
      globalThis.__HEX_ENGINE_MODE__ = 'js';
      process.env.HEX_ENGINE = 'js';
    } else {
      delete globalThis.HEX_ENGINE;
      delete globalThis.__HEX_ENGINE_MODE__;
      delete process.env.HEX_ENGINE;
    }
    return fn();
  } finally {
    if (prevGlobal === undefined) delete globalThis.HEX_ENGINE;
    else globalThis.HEX_ENGINE = prevGlobal;
    if (prevGlobalMode === undefined) delete globalThis.__HEX_ENGINE_MODE__;
    else globalThis.__HEX_ENGINE_MODE__ = prevGlobalMode;
    if (prevEnv === undefined) delete process.env.HEX_ENGINE;
    else process.env.HEX_ENGINE = prevEnv;
  }
}

function toMB(bytes) {
  return +(bytes / (1024 * 1024)).toFixed(2);
}

function resolveExecutableSection(img) {
  const sections = img.sections || [];
  return sections.find((s) => s.perms?.execute && Number(s.fileSize ?? s.size ?? 0n) > 0)
    || sections.find((s) => /\.text|__text/i.test(s.name || '') && Number(s.fileSize ?? s.size ?? 0n) > 0)
    || null;
}

function decodeSectionWithCapstone(img, sec, sessions) {
  const baseAddr = BigInt(sec.address ?? sec.va ?? 0n);
  const fileOff = Number(sec.fileOffset ?? sec.offset ?? 0n);
  const fileLen = Number(sec.fileSize ?? sec.size ?? 0n);
  const rawBytes = img.bytes?.subarray(fileOff, fileOff + fileLen);
  if (!rawBytes || rawBytes.length === 0) return [];

  if (img.arch === 'arm64' || img.arch === 'arm64_32') {
    const dv = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
    return sessions.arm64.decode(rawBytes, baseAddr).map((ins, idx) => {
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

  if (img.arch === 'x86_64') {
    return sessions.x86.decode(rawBytes, baseAddr).map((ins, idx) => {
      const addr = BigInt(ins.address);
      const size = Number(ins.length ?? ins.size ?? 1);
      const relOff = Number(addr - baseAddr);
      const insBytes = relOff >= 0 && relOff + size <= rawBytes.length
        ? rawBytes.subarray(relOff, relOff + size)
        : new Uint8Array(0);
      const mn = String(ins.mnemonic || '').toLowerCase();
      const opStr = String(ins.opStr || '');
      return {
        ...ins,
        row: idx,
        address: addr,
        size,
        length: size,
        mn,
        mnemonic: mn,
        ops: opStr,
        opStr,
        rawBytes: insBytes,
      };
    });
  }

  return [];
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

function prepareCorpus(sessions) {
  const preparedBinaries = [];
  const wasmEligibleFunctions = [];
  let totalFunctions = 0;

  for (const spec of REAL_CORPUS_SPECS) {
    const bytes = spec.bytes || new Uint8Array(fs.readFileSync(spec.file));
    const img = openBinary(bytes, { strings: true, _engine: 'js' });
    const sec = resolveExecutableSection(img);
    const decoded = sec ? decodeSectionWithCapstone(img, sec, sessions) : [];
    const fns = sec ? extractFunctionsFromSection(img, sec, decoded) : [];
    const isArm64 = img.arch === 'arm64' || img.arch === 'arm64_32';
    const isX86_64 = img.arch === 'x86_64';

    const preparedFns = fns.map((fn) => {
      const addrToRow = new Map(fn.insns.map((ins, idx) => [ins.address, idx]));
      const rowOfAddress = (a) => addrToRow.get(BigInt(a)) ?? null;
      let model = null;
      let cfgSuccs = null;
      let cfgEntry = 0;
      let wasmEligible = false;

      if (isArm64) {
        model = buildSemanticModel(fn.insns, {
          startRow: 0,
          endRow: fn.insns.length - 1,
          rowOfAddress,
          symbolFor: () => null,
          name: fn.name,
        });
        const builtCfg = buildCfg(model, { rowOfAddress });
        cfgSuccs = (builtCfg?.nodes || []).map((node) => (node.succ || []).map((e) => e.to));
        cfgEntry = builtCfg?.entry ?? 0;
        resetAllTelemetry();
        const beforeDecomp = getWasmCallCount('decompile');
        decompile(model, {
          addr: fn.address,
          name: fn.name,
          rowOfAddress,
          beginner: false,
          _engine: 'auto',
        });
        wasmEligible = getWasmCallCount('decompile') > beforeDecomp;
      }

      const x86SemanticInput = isX86_64
        ? {
            binaryId: spec.id,
            sliceId: `slice-${img.arch}`,
            snapshotId: 'snap',
            architecture: 'x86_64',
            platform: (img.format === 'pe' || String(img.platform || '').toLowerCase() === 'windows') ? 'windows' : 'linux',
            abiId: (img.format === 'pe' || String(img.platform || '').toLowerCase() === 'windows') ? 'microsoft-x64' : 'sysv-amd64',
            decoderSemanticVersion: fn.insns[0]?.decoderSemanticVersion || 'capstone-x86_64-v1',
            instructions: fn.insns.map((ins, row) => ({
              ...ins,
              row,
              origin: {
                byteRanges: [{ binaryId: spec.id, start: BigInt(row * ins.size), length: ins.size }],
                virtualRanges: [{ sliceId: `slice-${img.arch}`, start: ins.address, length: ins.size }],
              },
            })),
            dataEndianness: img.endian || 'little',
            instructionEndianness: img.endian || 'little',
          }
        : null;

      const entry = {
        binaryId: spec.id,
        arch: img.arch,
        format: img.format,
        name: fn.name,
        address: fn.address,
        insnCount: fn.insns.length,
        isArm64,
        isX86_64,
        model,
        rowOfAddress,
        cfgSuccs,
        cfgEntry,
        x86SemanticInput,
        wasmEligible,
      };
      if (wasmEligible) wasmEligibleFunctions.push(entry);
      return entry;
    });

    totalFunctions += preparedFns.length;
    preparedBinaries.push({
      id: spec.id,
      arch: img.arch,
      format: img.format,
      bytes,
      functions: preparedFns,
    });
  }

  return { preparedBinaries, wasmEligibleFunctions, totalFunctions };
}

function runFullCorpusOnce(preparedBinaries, mode) {
  let peakRss = process.memoryUsage().rss;
  let peakHeap = process.memoryUsage().heapUsed;
  let sink = 0;

  const sampleMem = () => {
    const m = process.memoryUsage();
    if (m.rss > peakRss) peakRss = m.rss;
    if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
  };

  const t0 = performance.now();
  for (const bin of preparedBinaries) {
    const opened = openBinary(bin.bytes, { strings: true, _engine: mode });
    sink += (opened.sections || []).length;

    for (const fn of bin.functions) {
      if (fn.isArm64) {
        if (fn.cfgSuccs && fn.cfgSuccs.length > 0) {
          const cfgOpts = mode === 'js'
            ? { _forceJs: true, _engine: 'js' }
            : mode === 'wasm'
              ? { _forceWasm: true, _engine: 'wasm' }
              : { _engine: 'auto' };
          const cfgRes = analyzeGraph(fn.cfgSuccs, fn.cfgEntry, null, cfgOpts);
          sink += cfgRes?.reachable?.size ?? cfgRes?.reachable?.length ?? 0;
        }
        const dec = decompile(fn.model, {
          addr: fn.address,
          name: fn.name,
          rowOfAddress: fn.rowOfAddress,
          beginner: false,
          _engine: mode,
        });
        sink += (dec?.pseudocode || '').length;
      } else if (fn.isX86_64 && fn.x86SemanticInput) {
        const sem = analyzeSemanticFunction(fn.x86SemanticInput, { _engine: mode });
        const semanticCfg = sem?.pipeline?.cfg || sem?.cfg;
        if (semanticCfg?.blocks?.length > 0) {
          const blocks = semanticCfg.blocks;
          const idToIdx = new Map(blocks.map((b, idx) => [b.id, idx]));
          const succs = blocks.map((b) =>
            (b.successors || [])
              .map((e) => idToIdx.get(e.to))
              .filter((idx) => idx !== undefined),
          );
          const entryIdx = idToIdx.get(semanticCfg.entryBlockId) ?? 0;
          const cfgOpts = mode === 'js'
            ? { _forceJs: true, _engine: 'js' }
            : mode === 'wasm'
              ? { _forceWasm: true, _engine: 'wasm' }
              : { _engine: 'auto' };
          const cfgRes = analyzeGraph(succs, entryIdx, null, cfgOpts);
          sink += cfgRes?.reachable?.size ?? cfgRes?.reachable?.length ?? 0;
        }
        sink += (sem?.decompiler?.pseudocode || '').length;
      }
    }
    sampleMem();
  }
  const elapsedMs = performance.now() - t0;
  sampleMem();
  return { elapsedMs, peakRss, peakHeap, sink };
}

function runWasm7SubsetOnce(wasmEligibleFunctions, mode, iters) {
  let peakRss = process.memoryUsage().rss;
  let peakHeap = process.memoryUsage().heapUsed;
  let sink = 0;

  const t0 = performance.now();
  for (let i = 0; i < iters; i += 1) {
    for (const fn of wasmEligibleFunctions) {
      const dec = decompile(fn.model, {
        addr: fn.address,
        name: fn.name,
        rowOfAddress: fn.rowOfAddress,
        beginner: false,
        _engine: mode,
      });
      sink += (dec?.pseudocode || '').length;
    }
    const m = process.memoryUsage();
    if (m.rss > peakRss) peakRss = m.rss;
    if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
  }
  const elapsedMs = performance.now() - t0;
  return { elapsedMs, peakRss, peakHeap, sink };
}

function buildSyntheticStringsImage(byteSize = 256 * 1024) {
  const bytes = new Uint8Array(byteSize);
  for (let i = 0; i < byteSize; i += 1) {
    const v = i & 0x0f;
    bytes[i] = v === 9 ? 1 : v;
  }
  const encoder = new TextEncoder();
  const stride = 1024;
  for (let off = 64, idx = 0; off + 40 < byteSize; off += stride, idx += 1) {
    const token = encoder.encode(`hex_wave13_string_token_${String(idx).padStart(4, '0')}`);
    bytes.set(token, off);
    bytes[off + token.length] = 0;
  }
  return {
    bytes,
    sections: [],
    segments: [],
    endian: 'little',
    offsetToAddress: (off) => BigInt(off),
  };
}

function buildSyntheticByteSearchFixture(byteSize = 1024 * 1024) {
  const buffer = new Uint8Array(byteSize);
  for (let i = 0; i < byteSize; i += 1) {
    buffer[i] = (i * 31 + 7) & 0xff;
  }
  const pattern = new Uint8Array([
    0xde, 0xad, 0xbe, 0xef, 0x13, 0x37, 0x48, 0x45,
    0x58, 0x57, 0x31, 0x33, 0xca, 0xfe, 0xba, 0xbe,
  ]);
  const mask = new Uint8Array(pattern.length).fill(0xff);
  const stride = 128 * 1024;
  for (let off = 64 * 1024; off + pattern.length < byteSize; off += stride) {
    buffer.set(pattern, off);
  }
  return { buffer, pattern, mask };
}

function runWave13Microbench(rounds) {
  const stringsImage = buildSyntheticStringsImage(256 * 1024);
  const { buffer: searchBuf, pattern, mask } = buildSyntheticByteSearchFixture(1024 * 1024);

  // Brief warmup for both modes
  for (const mode of ['js', 'wasm']) {
    withModeEnv(mode, () => {
      scanStrings(stringsImage, { _engine: mode });
      const matcher = compileBytePattern(pattern, mask, false);
      if (matcher) matcher.find(searchBuf, 0);
    });
  }

  const scanStringsResult = { bufferBytes: stringsImage.bytes.length };
  const byteSearchResult = { bufferBytes: searchBuf.length, patternBytes: pattern.length };

  for (const mode of ['js', 'wasm']) {
    const strTimes = [];
    let strCount = 0;
    let strWasmCalls = 0;
    for (let r = 0; r < rounds; r += 1) {
      resetAllTelemetry();
      const t0 = performance.now();
      const found = withModeEnv(mode, () => scanStrings(stringsImage, { _engine: mode }));
      strTimes.push(performance.now() - t0);
      strCount = found.length;
      strWasmCalls = getWasmCallCount('strings');
    }
    scanStringsResult[mode] = {
      roundsMs: strTimes.map((t) => +t.toFixed(3)),
      medianMs: +median(strTimes).toFixed(3),
      count: strCount,
      wasmCalls: strWasmCalls,
    };

    const searchTimes = [];
    let matchCount = 0;
    let searchWasmCalls = 0;
    for (let r = 0; r < rounds; r += 1) {
      resetAllTelemetry();
      const t0 = performance.now();
      const hits = withModeEnv(mode, () => {
        const matcher = compileBytePattern(pattern, mask, false);
        let pos = 0;
        let count = 0;
        while (matcher && (pos = matcher.find(searchBuf, pos)) !== -1) {
          count += 1;
          pos += 1;
        }
        return count;
      });
      searchTimes.push(performance.now() - t0);
      matchCount = hits;
      searchWasmCalls = getWasmCallCount('byte_search');
    }
    byteSearchResult[mode] = {
      roundsMs: searchTimes.map((t) => +t.toFixed(3)),
      medianMs: +median(searchTimes).toFixed(3),
      matches: matchCount,
      wasmCalls: searchWasmCalls,
    };
  }

  scanStringsResult.speedupVsJs = scanStringsResult.wasm.medianMs > 0
    ? +(scanStringsResult.js.medianMs / scanStringsResult.wasm.medianMs).toFixed(2)
    : 0;
  byteSearchResult.speedupVsJs = byteSearchResult.wasm.medianMs > 0
    ? +(byteSearchResult.js.medianMs / byteSearchResult.wasm.medianMs).toFixed(2)
    : 0;

  return {
    scanStrings256KiB: scanStringsResult,
    byteSearch1MiB: byteSearchResult,
  };
}

function formatTable(report) {
  const lines = [];
  const eligibleCount = report.corpus.wasmEligibleFunctions;
  lines.push('=== Final E2E Benchmark (13 Real Binaries x All Functions) ===');
  lines.push('| Mode | Median Total (ms) | Peak RSS (MB) | Peak heapUsed (MB) | Speedup vs JS | WASM Engine Calls | FLAG_JS Fallbacks |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  const jsFullMed = report.fullCorpus.js.medianMs;
  for (const mode of ['js', 'wasm', 'auto']) {
    const r = report.fullCorpus[mode];
    const speedup = r.medianMs > 0 ? (jsFullMed / r.medianMs).toFixed(2) : '0.00';
    const flagJsFallbacks = r.fallbackCounts['decompile:wasm_disabled'] || 0;
    lines.push(
      `| ${mode} | ${r.medianMs.toFixed(2)} | ${r.peakRssMB.toFixed(2)} | ${r.peakHeapMB.toFixed(2)} | ${speedup}x | ${r.wasmCalls.decompile || 0} | ${flagJsFallbacks} |`,
    );
  }
  lines.push('');
  lines.push(`=== WASM-Eligible ${eligibleCount} Functions Subset (per-pass = ${eligibleCount} functions, ${report.config.wasm7Iters}x batch median) ===`);
  lines.push(`| Mode | Median Batch (ms) | Median Per-Pass ${eligibleCount} Fns (ms) | Peak RSS (MB) | Peak heapUsed (MB) | Speedup vs JS |`);
  lines.push('|---|---:|---:|---:|---:|---:|');
  const js7Med = report.wasm7Subset.js.medianBatchMs;
  for (const mode of ['js', 'wasm', 'auto']) {
    const r = report.wasm7Subset[mode];
    const speedup = r.medianBatchMs > 0 ? (js7Med / r.medianBatchMs).toFixed(2) : '0.00';
    lines.push(
      `| ${mode} | ${r.medianBatchMs.toFixed(2)} | ${r.medianPerPassMs.toFixed(3)} | ${r.peakRssMB.toFixed(2)} | ${r.peakHeapMB.toFixed(2)} | ${speedup}x |`,
    );
  }
  lines.push('');
  lines.push('=== WASM Call Summary (All Domains) ===');
  const domainHeaders = ALL_WASM_DOMAINS.join(' | ');
  const domainSep = ALL_WASM_DOMAINS.map(() => '---:').join('|');
  lines.push(`| Suite | Mode | ${domainHeaders} | Total |`);
  lines.push(`|---|---|${domainSep}|---:|`);
  for (const [suiteLabel, suiteData] of [
    ['Full Corpus', report.fullCorpus],
    [`Subset (${eligibleCount} Fns)`, report.wasm7Subset],
  ]) {
    for (const mode of ['js', 'wasm', 'auto']) {
      const summary = suiteData[mode].wasmCallSummary;
      const cols = ALL_WASM_DOMAINS.map((d) => summary.byDomain[d] || 0).join(' | ');
      lines.push(`| ${suiteLabel} | ${mode} | ${cols} | ${summary.total} |`);
    }
  }
  if (report.wave13Microbench) {
    const { scanStrings256KiB: s, byteSearch1MiB: b } = report.wave13Microbench;
    lines.push('');
    lines.push('=== Wave 13 Microbench (strings 256 KiB / byte_search 1 MiB) ===');
    lines.push('| Benchmark | JS Median (ms) | WASM Median (ms) | Speedup vs JS | Hits/Count | WASM Calls |');
    lines.push('|---|---:|---:|---:|---:|---:|');
    lines.push(
      `| scanStrings (256 KiB) | ${s.js.medianMs.toFixed(3)} | ${s.wasm.medianMs.toFixed(3)} | ${s.speedupVsJs.toFixed(2)}x | ${s.wasm.count} | ${s.wasm.wasmCalls} |`,
    );
    lines.push(
      `| byteSearch (1 MiB) | ${b.js.medianMs.toFixed(3)} | ${b.wasm.medianMs.toFixed(3)} | ${b.speedupVsJs.toFixed(2)}x | ${b.wasm.matches} | ${b.wasm.wasmCalls} |`,
    );
  }
  const v = report.verification;
  lines.push('');
  lines.push(
    `JS Mode Zero-WASM Verification: ${v.jsModeZeroWasmVerified ? 'PASS' : 'FAIL'} `
    + `(fullCorpus total=${v.jsFullCorpusTotalWasmCalls}, subset total=${v.jsSubsetTotalWasmCalls})`,
  );
  return lines.join('\n');
}

async function main() {
  const { rounds, wasm7Iters } = parseCliArgs(process.argv.slice(2));
  const arm64Cs = await createCapstoneArm64Session();
  const x86Cs = await createCapstoneX86Session();
  const sessions = { arm64: arm64Cs, x86: x86Cs };

  try {
    const { preparedBinaries, wasmEligibleFunctions, totalFunctions } = prepareCorpus(sessions);

    // Warmup both engines briefly
    withModeEnv('js', () => runWasm7SubsetOnce(wasmEligibleFunctions, 'js', 2));
    withModeEnv('wasm', () => runWasm7SubsetOnce(wasmEligibleFunctions, 'wasm', 2));

    const modes = ['js', 'wasm', 'auto'];
    const fullCorpus = {};
    const wasm7Subset = {};

    for (const mode of modes) {
      const roundTimes = [];
      let peakRss = 0;
      let peakHeap = 0;
      let lastSink = 0;
      let lastWasmCalls = {};
      let lastFallbackCounts = {};

      for (let r = 0; r < rounds; r += 1) {
        if (typeof global.gc === 'function') global.gc();
        resetAllTelemetry();
        const res = withModeEnv(mode, () => runFullCorpusOnce(preparedBinaries, mode));
        roundTimes.push(res.elapsedMs);
        if (res.peakRss > peakRss) peakRss = res.peakRss;
        if (res.peakHeap > peakHeap) peakHeap = res.peakHeap;
        lastSink = res.sink;
        lastWasmCalls = getWasmCallCounts();
        lastFallbackCounts = getFallbackCounts();
      }

      const wasmCallSummary = summarizeWasmCalls(lastWasmCalls);
      if (mode === 'js' && wasmCallSummary.total !== 0) {
        throw new Error(`JS mode full-corpus expected 0 WASM calls across all domains, got ${JSON.stringify(wasmCallSummary)}`);
      }

      fullCorpus[mode] = {
        roundsMs: roundTimes.map((t) => +t.toFixed(2)),
        medianMs: +median(roundTimes).toFixed(2),
        peakRssMB: toMB(peakRss),
        peakHeapMB: toMB(peakHeap),
        sink: lastSink,
        wasmCalls: lastWasmCalls,
        wasmCallSummary,
        fallbackCounts: lastFallbackCounts,
      };
    }

    for (const mode of modes) {
      const batchTimes = [];
      let peakRss = 0;
      let peakHeap = 0;
      let lastSink = 0;
      let lastWasmCalls = {};
      let lastFallbackCounts = {};

      for (let r = 0; r < rounds; r += 1) {
        if (typeof global.gc === 'function') global.gc();
        resetAllTelemetry();
        const res = withModeEnv(mode, () => runWasm7SubsetOnce(wasmEligibleFunctions, mode, wasm7Iters));
        batchTimes.push(res.elapsedMs);
        if (res.peakRss > peakRss) peakRss = res.peakRss;
        if (res.peakHeap > peakHeap) peakHeap = res.peakHeap;
        lastSink = res.sink;
        lastWasmCalls = getWasmCallCounts();
        lastFallbackCounts = getFallbackCounts();
      }

      const wasmCallSummary = summarizeWasmCalls(lastWasmCalls);
      if (mode === 'js' && wasmCallSummary.total !== 0) {
        throw new Error(`JS mode subset expected 0 WASM calls across all domains, got ${JSON.stringify(wasmCallSummary)}`);
      }

      const medBatch = median(batchTimes);
      wasm7Subset[mode] = {
        batchRoundsMs: batchTimes.map((t) => +t.toFixed(2)),
        medianBatchMs: +medBatch.toFixed(2),
        medianPerPassMs: +(medBatch / wasm7Iters).toFixed(3),
        peakRssMB: toMB(peakRss),
        peakHeapMB: toMB(peakHeap),
        sink: lastSink,
        wasmCalls: lastWasmCalls,
        wasmCallSummary,
        fallbackCounts: lastFallbackCounts,
      };
    }

    const wave13Microbench = runWave13Microbench(rounds);

    const jsFullTotal = fullCorpus.js.wasmCallSummary.total;
    const jsSubsetTotal = wasm7Subset.js.wasmCallSummary.total;
    const report = {
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      config: { rounds, wasm7Iters },
      corpus: {
        binaries: preparedBinaries.length,
        totalFunctions,
        wasmEligibleFunctions: wasmEligibleFunctions.length,
        wasmEligibleNames: wasmEligibleFunctions.map((f) => `${f.binaryId}::${f.name}(${f.insnCount})`),
      },
      verification: {
        jsModeZeroWasmVerified: jsFullTotal === 0 && jsSubsetTotal === 0,
        jsFullCorpusTotalWasmCalls: jsFullTotal,
        jsSubsetTotalWasmCalls: jsSubsetTotal,
      },
      fullCorpus,
      wasm7Subset,
      wave13Microbench,
    };

    console.log(formatTable(report));
    console.log('\n=== JSON ===');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    arm64Cs.close();
    x86Cs.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
