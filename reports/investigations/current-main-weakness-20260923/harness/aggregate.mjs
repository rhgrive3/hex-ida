#!/usr/bin/env node
/*
 * Aggregate the current-main measurement receipts into the report's taxonomy
 * and latency tables. Measurement-only; reads `<run>/cases/*.json` and writes
 * `<run>/analysis.json` plus a compact text summary.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CASE_SCHEMA,
  distribution,
  optionValue,
  percentile,
  readJson,
  round,
} from './lib.mjs';

const SIZE_BUCKETS = [
  [0, 32], [33, 64], [65, 128], [129, 256], [257, 512], [513, 1024], [1025, Infinity],
];

function sizeBucket(size) {
  if (!Number.isFinite(size)) return 'unknown';
  for (const [low, high] of SIZE_BUCKETS) {
    if (size >= low && size <= high) return high === Infinity ? `${low}+` : `${low}-${high}`;
  }
  return 'unknown';
}

function gotoBucket(gotos) {
  if (!Number.isFinite(gotos)) return 'unknown';
  if (gotos === 0) return '0';
  if (gotos === 1) return '1';
  if (gotos <= 3) return '2-3';
  if (gotos <= 10) return '4-10';
  return '11+';
}

function reasonFamily(reason) {
  if (reason == null) return null;
  const text = String(reason);
  if (/^function-watchdog-timeout$/.test(text)) return 'function-watchdog-timeout';
  if (/^analysis-budget$/.test(text)) return 'analysis-budget';
  if (/^decompile-projection-withheld$/.test(text)) return 'decompile-projection-withheld';
  if (/^decompile-projection-schema-drift$/.test(text)) return 'decompile-projection-schema-drift';
  if (/^function-end-unproven/.test(text)) return 'function-end-unproven';
  if (/^function-discovery-incomplete$/.test(text)) return 'function-discovery-incomplete';
  if (/^function-scan-budget$/.test(text)) return 'function-scan-budget';
  if (/^arm64-/.test(text)) return text;
  if (/^riscv-/.test(text)) return text;
  if (/^x86-64-/.test(text)) return text;
  if (/^semantic-function-unsupported-architecture/.test(text)) return 'semantic-function-unsupported-architecture';
  return text.split(':')[0].slice(0, 80);
}

function groupDistribution(rows, keyOf, valueOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (key == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(valueOf(row));
  }
  return Object.fromEntries([...groups.entries()]
    .map(([key, values]) => [key, distribution(values)])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
}

function averageRank(values) {
  const order = values.map((value, index) => [value, index]).sort((left, right) => left[0] - right[0]);
  const ranks = new Array(values.length);
  let index = 0;
  while (index < order.length) {
    let end = index;
    while (end + 1 < order.length && order[end + 1][0] === order[index][0]) end++;
    const rank = (index + end) / 2 + 1;
    for (let cursor = index; cursor <= end; cursor++) ranks[order[cursor][1]] = rank;
    index = end + 1;
  }
  return ranks;
}

function spearman(pairs) {
  const filtered = pairs.filter(([left, right]) => Number.isFinite(left) && Number.isFinite(right));
  if (filtered.length < 8) return { n: filtered.length, rho: null };
  const leftRanks = averageRank(filtered.map(pair => pair[0]));
  const rightRanks = averageRank(filtered.map(pair => pair[1]));
  const n = filtered.length;
  const meanLeft = leftRanks.reduce((total, value) => total + value, 0) / n;
  const meanRight = rightRanks.reduce((total, value) => total + value, 0) / n;
  let covariance = 0; let varianceLeft = 0; let varianceRight = 0;
  for (let index = 0; index < n; index++) {
    const left = leftRanks[index] - meanLeft;
    const right = rightRanks[index] - meanRight;
    covariance += left * right; varianceLeft += left * left; varianceRight += right * right;
  }
  const rho = covariance / Math.sqrt(varianceLeft * varianceRight || 1);
  return { n, rho: round(rho, 4) };
}

function loadRunRecords(runDir) {
  const casesDir = path.join(runDir, 'cases');
  const records = [];
  for (const file of fs.readdirSync(casesDir).sort()) {
    if (!file.endsWith('.json')) continue;
    const record = readJson(path.join(casesDir, file));
    if (record?.schema === CASE_SCHEMA) records.push(record);
  }
  return records;
}

function countStates(records) {
  const counts = {};
  for (const record of records) counts[record.state] = (counts[record.state] ?? 0) + 1;
  return counts;
}

function buildAnalysis(records) {
  const functions = [];
  for (const record of records) {
    for (const row of record.functions ?? []) functions.push({ ...row, caseId: record.caseId });
  }
  const functionStates = {};
  for (const row of functions) functionStates[row.state] = (functionStates[row.state] ?? 0) + 1;
  const stateShare = Object.fromEntries(Object.entries(functionStates)
    .map(([state, count]) => [state, round(count / (functions.length || 1), 4)]));

  const reasonFamilies = {};
  for (const row of functions) {
    if (row.reason == null) continue;
    const family = reasonFamily(row.reason);
    reasonFamilies[family] = reasonFamilies[family] ?? { count: 0, states: {}, exampleCase: row.caseId, exampleAddress: row.address };
    reasonFamilies[family].count += 1;
    reasonFamilies[family].states[row.state] = (reasonFamilies[family].states[row.state] ?? 0) + 1;
  }
  const reasonFamiliesByState = {};
  for (const [family, info] of Object.entries(reasonFamilies)) {
    for (const state of Object.keys(info.states)) {
      reasonFamiliesByState[state] = reasonFamiliesByState[state] ?? {};
      reasonFamiliesByState[state][family] = (reasonFamiliesByState[state][family] ?? 0) + info.states[state];
    }
  }

  const latencyByState = groupDistribution(functions, row => row.state, row => row.elapsedMs);
  const latencyBySize = groupDistribution(functions, row => sizeBucket(row.sizeBytes), row => row.elapsedMs);
  const latencyByGoto = groupDistribution(functions, row => gotoBucket(row.gotos), row => row.elapsedMs);
  const withGoto = functions.filter(row => Number.isFinite(row.gotos) && row.gotos > 0);
  const structureMeasured = functions.filter(row => row.structure != null);

  const correlations = {
    elapsedVsSize: spearman(functions.map(row => [Math.log1p(row.elapsedMs ?? 0), Math.log1p(row.sizeBytes ?? 0)])),
    elapsedVsGotos: spearman(functions.map(row => [Math.log1p(row.elapsedMs ?? 0), row.gotos ?? 0])),
    elapsedVsCfgBlocks: spearman(structureMeasured.map(row => [Math.log1p(row.elapsedMs ?? 0), row.structure?.cfgBlocks ?? null])),
    elapsedVsIrValues: spearman(structureMeasured.map(row => [Math.log1p(row.elapsedMs ?? 0), row.structure?.irValues ?? null])),
  };

  const slowest = functions
    .filter(row => Number.isFinite(row.elapsedMs))
    .slice()
    .sort((left, right) => right.elapsedMs - left.elapsedMs)
    .slice(0, 40)
    .map(row => ({
      caseId: row.caseId, address: row.address, name: row.name, sizeBytes: row.sizeBytes,
      state: row.state, completeness: row.completeness, reason: row.reason,
      elapsedMs: round(row.elapsedMs, 2), gotos: row.gotos, pseudocodeChars: row.pseudocodeChars,
      nonEmptyLines: row.nonEmptyLines, unknownInstructions: row.unknownInstructions,
      structured: row.structured, coverageMode: row.coverageMode,
      structure: row.structure ? {
        cfgBlocks: row.structure.cfgBlocks, cfgEdges: row.structure.cfgEdges,
        irValues: row.structure.irValues, irInstructions: row.structure.irInstructions,
        irBlocks: row.structure.irBlocks, structuralMs: round(row.structure.structuralMs, 2),
        structuralReason: row.structure.structuralReason,
      } : null,
    }));

  const caseLatency = groupDistribution(
    records.flatMap(record => (record.functions ?? []).map(row => ({ caseId: record.caseId, elapsedMs: row.elapsedMs }))),
    row => row.caseId, row => row.elapsedMs,
  );

  return {
    denominator: { cases: records.length, functions: functions.length },
    caseStates: countStates(records),
    functionStates, stateShare,
    coverage: {
      unknownInstructions: distribution(functions.map(row => row.unknownInstructions)),
      functionsWithUnknownInstructions: functions.filter(row => (row.unknownInstructions ?? 0) > 0).length,
      warnings: distribution(functions.map(row => row.warnings)),
      functionsWithWarnings: functions.filter(row => (row.warnings ?? 0) > 0).length,
      structured: functions.filter(row => row.structured === true).length,
      semanticModel: functions.filter(row => row.semantic === true).length,
      projectionWithheld: functions.filter(row => row.projection != null).length,
    },
    latency: {
      all: distribution(functions.map(row => row.elapsedMs)),
      byState: latencyByState,
      bySizeBucket: latencyBySize,
      byGotoBucket: latencyByGoto,
      byCase: caseLatency,
      totalFunctions: functions.length,
    },
    goto: {
      functionsWithGoto: withGoto.length,
      share: round(withGoto.length / (functions.length || 1), 4),
      distribution: distribution(functions.map(row => row.gotos)),
      byState: groupDistribution(functions.filter(row => Number.isFinite(row.gotos)), row => row.state, row => row.gotos),
    },
    structure: {
      measured: structureMeasured.length,
      cfgBlocks: distribution(structureMeasured.map(row => row.structure?.cfgBlocks)),
      irValues: distribution(structureMeasured.map(row => row.structure?.irValues)),
      irInstructions: distribution(structureMeasured.map(row => row.structure?.irInstructions)),
      correlations,
      structuralMs: distribution(structureMeasured.map(row => row.structure?.structuralMs)),
    },
    reasons: { families: reasonFamilies, byState: reasonFamiliesByState },
    slowest,
    discovery: records.map(record => ({
      caseId: record.caseId, functionCount: record.functionCount,
      complete: record.functionDiscoveryComplete === true, states: record.functionStates ?? {},
      setup: record.setup ?? null, elapsedMs: round(record.elapsedMs ?? null, 1),
    })),
  };
}

function loadFrozenReference(frozenPath) {
  const summary = readJson(frozenPath);
  if (!summary?.comparison?.cases) return null;
  const rows = [];
  for (const entry of summary.comparison.cases) {
    for (const row of entry.rows ?? []) {
      rows.push({
        caseId: entry.caseId, address: row.address, hexPresent: row.hexPresent === true,
        hexState: row.hexState ?? null, gotos: row.hexMetrics?.gotoCount ?? null,
        nonEmptyLines: row.hexMetrics?.nonEmptyLines ?? null,
      });
    }
  }
  return {
    provenance: summary.provenance ?? null,
    states: countStates(rows.filter(row => row.hexPresent).map(row => ({ state: row.hexState ?? 'UNKNOWN' }))),
    goto: distribution(rows.filter(row => Number.isFinite(row.gotos)).map(row => row.gotos)),
    rows,
  };
}

function compareWithFrozen(records, frozen) {
  if (!frozen) return null;
  const frozenByKey = new Map();
  for (const row of frozen.rows) frozenByKey.set(`${row.caseId}|${BigInt(row.address)}`, row);
  let joined = 0; let stateEqual = 0; let stateMismatch = 0; let gotoEqual = 0; let gotoDelta = 0;
  let nowOnly = 0; let frozenOnly = 0;
  const mismatches = [];
  for (const record of records) {
    const seen = new Set();
    for (const row of record.functions ?? []) {
      const key = `${record.caseId}|${BigInt(row.address)}`;
      seen.add(key);
      const reference = frozenByKey.get(key);
      if (!reference) { nowOnly += 1; continue; }
      joined += 1;
      const frozenState = reference.hexPresent ? reference.hexState : 'MISSING';
      if (frozenState === row.state) stateEqual += 1;
      else {
        stateMismatch += 1;
        if (mismatches.length < 50) mismatches.push({ caseId: record.caseId, address: row.address, frozenState, nowState: row.state, nowReason: row.reason });
      }
      if (Number.isFinite(reference.gotos) && Number.isFinite(row.gotos)) {
        if (reference.gotos === row.gotos) gotoEqual += 1;
        else gotoDelta += 1;
      }
    }
    for (const [key] of frozenByKey) {
      if (key.startsWith(`${record.caseId}|`) && !seen.has(key)) frozenOnly += 1;
    }
  }
  return {
    frozenProvenance: frozen.provenance,
    frozenStates: frozen.states,
    frozenGoto: frozen.goto,
    joined, stateEqual, stateMismatch, gotoEqual, gotoDelta, nowOnly, frozenOnly,
    mismatches,
  };
}

export function aggregateRun({ runDir, frozenPath = null, log = console.log } = {}) {
  const run = readJson(path.join(runDir, 'run.json'));
  const records = loadRunRecords(runDir);
  if (!records.length) throw new Error(`aggregate-no-case-records:${runDir}`);
  const analysis = {
    schema: 'hex-current-main-analysis/v1',
    run,
    ...buildAnalysis(records),
  };
  if (frozenPath) analysis.frozenComparison = compareWithFrozen(records, loadFrozenReference(frozenPath));
  const outPath = path.join(runDir, 'analysis.json');
  fs.writeFileSync(outPath, `${JSON.stringify(analysis, null, 2)}\n`);
  log(`analysis -> ${outPath}`);
  log(`functions: ${analysis.denominator.functions} cases: ${analysis.denominator.cases}`);
  log(`function states: ${JSON.stringify(analysis.functionStates)}`);
  log(`latency ms: ${JSON.stringify(analysis.latency.all)}`);
  log(`reasons: ${JSON.stringify(Object.fromEntries(Object.entries(analysis.reasons.families).map(([key, info]) => [key, info.count])))}`);
  log(`goto: ${analysis.goto.functionsWithGoto} / ${analysis.denominator.functions} (${analysis.goto.share})`);
  if (analysis.frozenComparison) {
    log(`frozen join: joined=${analysis.frozenComparison.joined} stateEqual=${analysis.frozenComparison.stateEqual} stateMismatch=${analysis.frozenComparison.stateMismatch} gotoEqual=${analysis.frozenComparison.gotoEqual} gotoDelta=${analysis.frozenComparison.gotoDelta} nowOnly=${analysis.frozenComparison.nowOnly} frozenOnly=${analysis.frozenComparison.frozenOnly}`);
  }
  return { analysis, outPath };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const runDir = path.resolve(optionValue(args, '--run', '.'));
  const frozenPath = optionValue(args, '--frozen', null);
  try {
    aggregateRun({ runDir, frozenPath: frozenPath ? path.resolve(frozenPath) : null });
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}
