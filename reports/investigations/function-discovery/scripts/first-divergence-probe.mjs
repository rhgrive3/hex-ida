#!/usr/bin/env node
/**
 * function-discovery investigation / Phase 3 focused first-divergence probe.
 *
 * Loads ONE benchmark binary through the repository's own read-only
 * public-benchmark host and reports, for each requested address, which stage of
 *
 *   ELF metadata -> BinaryImage function seeds -> discovery producers ->
 *   discovery artifact -> SymbolIndex function list
 *
 * still contains the address, and which stage first drops it.
 *
 * Read-only: imports product modules, mutates nothing, writes nothing.
 * Usage: node first-divergence-probe.mjs <caseId> <addr> [<addr> ...] [--shapes]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = '/mnt/workspace/hex-agent-e';
const BENCH = path.join(ROOT, 'benchmarks/public/codefuse-arm64');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(BENCH, 'manifest.json'), 'utf8'));
const byId = new Map(MANIFEST.cases.map((c) => [c.id, c]));

const argv = process.argv.slice(2);
const shapesOnly = argv.includes('--shapes');
const rest = argv.filter((a) => a !== '--shapes');
const caseId = rest[0];
const wanted = rest.slice(1).map((a) => BigInt(a));
const meta = byId.get(caseId);
if (!meta) throw new Error(`unknown case: ${caseId}`);

const toBigList = (value) => {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'bigint' ? v : BigInt(typeof v === 'object' ? v.address ?? v : v)));
  if (ArrayBuffer.isView(value)) return Array.from(value, (v) => BigInt(v));
  if (typeof value[Symbol.iterator] === 'function') {
    try {
      return Array.from(value, (v) => BigInt(typeof v === 'object' && v != null ? v.address ?? v : v));
    } catch {
      return [];
    }
  }
  return [];
};
const describe = (v) => {
  if (v == null) return String(v);
  if (Array.isArray(v)) return `array(${v.length})`;
  if (ArrayBuffer.isView(v)) return `${v.constructor.name}(${v.length})`;
  if (typeof v === 'object') return `${v.constructor?.name ?? 'object'}`;
  return typeof v;
};

const hostUrl = pathToFileURL(path.join(ROOT, 'tools/validation/public-benchmark/product-host.mjs')).href;
const { openProduct } = await import(hostUrl);

const product = await openProduct(path.join(BENCH, meta.binary));
if (product.unsupported) {
  console.log(JSON.stringify({ caseId, unsupported: product.reason }, null, 2));
  process.exit(0);
}

const { app, info, sliceIndex } = product;
const slice = info.slices[sliceIndex];
const analysis = await product.app.backend.analyze(sliceIndex);
const image = app.backend?.image ?? analysis?.image ?? analysis;
const symbolIndexInput = await app.backend.analyze(sliceIndex);

if (shapesOnly) {
  console.log(JSON.stringify({
    caseId,
    analysisKeys: Object.keys(analysis ?? {}).map((k) => [k, describe(analysis[k])]),
    imageKeys: Object.keys(image ?? {}).map((k) => [k, describe(image[k])]),
    symbolIndexKeys: Object.keys(app.symbols ?? {}).map((k) => [k, describe(app.symbols[k])]),
    sliceKeys: Object.keys(slice ?? {}).map((k) => [k, describe(slice[k])]),
    symbolIndexInputKeys: Object.keys(symbolIndexInput ?? {}).map((k) => [k, describe(symbolIndexInput[k])]),
  }, null, 2));
  await product.close?.();
  process.exit(0);
}

// Layer 1: loader/base function starts as the worker analysis payload reports
// them, with per-start provenance (source of each start).
const baseStarts = toBigList(analysis?.funcs);
const baseProvenance = Array.isArray(analysis?.functionProvenance) ? analysis.functionProvenance : [];
const baseStartSet = new Set(baseStarts);
const baseEnds = Array.isArray(analysis?.funcEnds) || ArrayBuffer.isView(analysis?.funcEnds) ? analysis.funcEnds : null;
const baseSourceOf = (addr) => {
  const idx = baseStarts.indexOf(addr);
  return idx < 0 ? null : (baseProvenance[idx] ?? null);
};
const baseEndOf = (addr) => {
  const idx = baseStarts.indexOf(addr);
  if (idx < 0 || baseEnds == null || idx >= baseEnds.length) return null;
  const e = baseEnds[idx];
  return e == null ? null : '0x' + BigInt(e).toString(16);
};
const rawSeeds = [];
const symbols = [];
// Layer 3: final SymbolIndex function list after demand discovery.
const finalStarts = toBigList(app.symbols?.funcs);
const finalSet = new Set(finalStarts);
const regions = Array.isArray(slice.regions) ? slice.regions : [];

// Prefer the narrowest *executable, mapped* region; unmapped debug sections can
// share vmAddr 0 and would otherwise shadow real code.
const regionOf = (addr) => {
  const hits = regions.filter((r) => {
    const start = BigInt(r.vmAddr ?? 0);
    return addr >= start && addr < start + BigInt(r.size ?? 0);
  });
  if (!hits.length) return null;
  const exec = hits.filter((r) => r.exec === true);
  const pool = exec.length ? exec : hits;
  return pool.reduce((best, r) => (best == null || BigInt(r.size) < BigInt(best.size) ? r : best), null);
};
const seedOf = (addr) => rawSeeds.filter((s) => s?.address != null && BigInt(s.address) === addr);
const symbolOf = (addr) => symbols.filter((s) => s?.address != null && BigInt(s.address) === addr);
const provenanceOf = (addr) => {
  const idx = finalStarts.indexOf(addr);
  const raw = analysis?.functionProvenance;
  if (idx < 0 || !Array.isArray(raw)) return null;
  return raw[idx] ?? null;
};
const enclosing = (addr) => {
  const before = [...finalSet].filter((a) => a <= addr);
  return before.length ? before.reduce((m, a) => (a > m ? a : m)) : null;
};
const noreturnList = slice.noreturnTargets ? toBigList(slice.noreturnTargets) : null;
const mappingSymbols = image?.metadata?.aarch64MappingSymbols ?? null;
const discovery = app.symbols?.functionDiscovery ?? null;

const rows = wanted.map((addr) => {
  const region = regionOf(addr);
  const seeds = seedOf(addr);
  const syms = symbolOf(addr);
  const enc = enclosing(addr);
  const dic = (region?.dataInCode ?? []).some((e) => addr >= BigInt(e.address) && addr < BigInt(e.address) + BigInt(e.length));
  return {
    address: '0x' + addr.toString(16),
    region: region
      ? { id: region.id, section: region.section ?? null, exec: region.exec === true, vmAddr: '0x' + BigInt(region.vmAddr).toString(16), size: '0x' + BigInt(region.size).toString(16) }
      : null,
    mappingSymbolHere: mappingSymbols ? (mappingSymbols.mappings ?? []).filter((m) => BigInt(m.address) === addr).map((m) => m.name) : null,
    loaderSeed: seeds.map((s) => ({ name: s.name ?? null, source: s.source ?? null, sources: s.sources ?? null, exactFunctionStart: s.exactFunctionStart === true, confidence: s.confidence ?? null })),
    loaderSeedPresent: seeds.length > 0,
    baseLayerStartPresent: baseStartSet.has(addr),
    baseLayerSource: baseSourceOf(addr),
    baseLayerEnd: baseEndOf(addr),
    finalLayerProvenance: provenanceOf(addr),
    imageSymbolAt: syms.map((s) => ({ name: s.name, kind: s.kind, binding: s.binding })),
    isNoreturnTarget: noreturnList ? noreturnList.includes(addr) : null,
    inFinalSymbolIndex: finalSet.has(addr),
    enclosingFinalFunctionStart: enc == null ? null : '0x' + enc.toString(16),
    enclosingFinalFunctionEnd: (() => {
      if (enc == null) return null;
      const fn = app.symbols?.functionAt?.(enc);
      return fn?.end == null ? null : '0x' + BigInt(fn.end).toString(16);
    })(),
    selfFinalFunctionEnd: (() => {
      if (!finalSet.has(addr)) return null;
      const fn = app.symbols?.functionAt?.(addr);
      return fn?.end == null ? null : '0x' + BigInt(fn.end).toString(16);
    })(),
    enclosingIsSelf: enc === addr,
    insideDataInCode: dic,
  };
});

console.log(JSON.stringify({
  caseId,
  binarySha256: meta.binarySha256,
  compiler: meta.compiler,
  optimization: meta.optimization,
  debug: meta.debug,
  stageCounts: {
    analysisBaseFunctionStarts: baseStarts.length,
    finalSymbolIndexFunctions: finalSet.size,
    regions: regions.length,
  },
  analysisLayerFlags: {
    functionStartsExact: analysis?.functionStartsExact ?? null,
    allSeedsExact: analysis?.allSeedsExact ?? null,
    discoveryComplete: analysis?.discoveryComplete ?? null,
    capped: analysis?.capped ?? null,
    symbolCount: analysis?.symbolCount ?? null,
  },
  discoveryCompleteness: {
    functionStartsComplete: app.symbols?.functionStartsComplete ?? null,
    guessed: app.symbols?.guessed ?? null,
    complete: discovery?.complete ?? null,
    reasons: discovery?.reasons ?? null,
    regions: discovery?.regions ?? null,
    capped: discovery?.capped ?? null,
  },
  noreturnTargetCount: noreturnList ? noreturnList.length : null,
  aarch64MappingSymbols: mappingSymbols ? { evidence: mappingSymbols.evidence, count: (mappingSymbols.mappings ?? []).length, list: (mappingSymbols.mappings ?? []).map((m) => `${m.name}@0x${BigInt(m.address).toString(16)}`) } : null,
  executableRegions: regions.filter((r) => r.exec === true).map((r) => `${r.id}:${r.section ?? '-'}@0x${BigInt(r.vmAddr).toString(16)}+0x${BigInt(r.size).toString(16)}`),
  rows,
}, null, 2));

await product.close?.();
