#!/usr/bin/env node
/*
 * Assemble reports/investigations/output-recompilation-20260924/after.json
 * from a completed harness run (measure-functions) plus its replay outputs
 * (recompile-replay, tu-replay), using the exact schema and derivation rules
 * of before.json. Measurement bookkeeping only; no product code is read.
 *
 * Usage:
 *   node reports/investigations/output-recompilation-20260924/build-after.mjs \
 *     --run <evidence>/current-output-after \
 *     --out reports/investigations/output-recompilation-20260924/after.json
 */
import fs from 'node:fs';
import path from 'node:path';

function optionValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] != null ? args[index + 1] : fallback;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const SELECTION = Object.freeze({
  caseIds: [
    '1/1_gcc_O1_g', '2/2_gcc_O1_g', '3/3_gcc_O1_g', '4/4_gcc_O1_g',
    '5-1/5-1_gcc_O1_g', '5-23/5-23_gcc_O1_g', '6/6_gcc_O1_g', '7/7_gcc_O1_g',
  ],
  group: 'one case per group',
  configuration: 'gcc_O1_g',
  structure: 'none',
});

const args = process.argv.slice(2);
const runDir = path.resolve(optionValue(args, '--run', '.'));
const outFile = path.resolve(optionValue(args, '--out', 'after.json'));

const run = readJson(path.join(runDir, 'run.json'));
const summary = readJson(path.join(runDir, 'summary.json'));
const replay = readJson(path.join(runDir, 'recompilability', 'replay-summary.json'));
const tu = readJson(path.join(runDir, 'tu-replay', 'tu-replay-summary.json'));

const caseFiles = fs.readdirSync(path.join(runDir, 'cases')).filter((name) => name.endsWith('.json')).sort();
const cases = caseFiles.map((name) => readJson(path.join(runDir, 'cases', name)));

let total = 0;
let completed = 0;
let functionsWithGoto = 0;
let totalObservedGotos = 0;
const structureModes = { structured: 0, linear: 0, unknown: 0 };
let unknownInstructionFunctions = 0;
let unknownInstructionInstances = 0;
let observed = 0;
let missing = 0;
const timeouts = [];
for (const record of cases) {
  for (const fn of record.functions ?? []) {
    total += 1;
    const pass = fn.state === 'PASS';
    if (pass) {
      completed += 1;
      const gotos = fn.gotos ?? 0;
      if (gotos > 0) { functionsWithGoto += 1; totalObservedGotos += gotos; }
      const mode = fn.coverageMode ?? 'unknown';
      if (mode === 'structured' || mode === 'linear') structureModes[mode] += 1;
      else structureModes.unknown += 1;
      const unknown = fn.unknownInstructions ?? 0;
      if (unknown > 0) { unknownInstructionFunctions += 1; unknownInstructionInstances += unknown; }
    } else {
      structureModes.unknown += 1;
      timeouts.push({
        caseId: record.caseId,
        address: String(fn.address),
        name: fn.name ?? null,
        reason: String(fn.reason ?? 'function-watchdog-timeout'),
      });
    }
    if (fn.unknownInstructions == null) missing += 1;
    else observed += 1;
  }
}

const firstFailureSamples = (replay.firstFailureSamples ?? []).map((row) => ({
  caseId: row.caseId,
  family: row.firstFamily,
  message: typeof row.firstDiagnostic === 'object'
    ? (row.firstDiagnostic?.message ?? null)
    : (row.firstDiagnostic ?? null),
  errors: row.errors,
}));

const tuCases = (tu.cases ?? []).map((row) => ({
  caseId: row.caseId,
  unresolved: row.unresolved ?? {},
  prototypes: row.prototypes ?? null,
  globals: row.globals ?? null,
  rawFirstFamily: row.raw?.ok ? 'none' : (row.raw?.firstFamily ?? 'n/a'),
  tuFirstFamily: row.tu?.ok ? 'none' : (row.tu?.firstFamily ?? 'n/a'),
}));

const after = {
  schema: 'hex-output-recompilation-measurement/v1',
  stage: 'after',
  baseline: {
    headSha: run.headSha,
    sourceIdentity: run.sourceIdentity,
    configHash: run.configHash,
    measurementHarnessHash: summary.config?.harnessHash ?? null,
    createdAt: run.createdAt,
  },
  selection: SELECTION,
  denominator: {
    cases: cases.length,
    functions: total,
    measuredCases: Object.values(summary.states ?? {}).reduce((a, b) => a + b, 0),
    timedOutFunctions: timeouts.length,
    completedFunctions: completed,
  },
  functions: {
    functionsWithGoto,
    totalObservedGotos,
    gotoObservationDenominator: completed,
    structureModes,
    unknownInstructionFunctions,
    unknownInstructionInstances,
    unknownInstructionObservation: { observed, missing },
  },
  perFunctionSyntax: {
    sampledFunctions: replay.denominator?.sampledFunctions ?? 0,
    caseStates: replay.caseStates ?? {},
    caseFirstFamilies: replay.caseFirstFamilies ?? {},
    functionFirstFamilies: replay.functionFirstFamilies ?? {},
    firstFailureSamples,
  },
  tuPackaging: {
    denominatorFunctions: tu.denominator?.functions ?? 0,
    caseStates: tu.caseStates ?? {},
    rawCaseFamilies: tu.rawCaseFamilies ?? {},
    tuCaseFamilies: tu.tuCaseFamilies ?? {},
    rescuedByPackager: tu.comparison?.rescuedByPackager ?? 0,
    unresolvedTotals: tu.unresolvedTotals ?? {},
    cases: tuCases,
  },
  timeouts,
  notes: [
    'Same eight case IDs, watchdog configuration, and replay derivation rules as before.json.',
    'All watchdog timeouts are retained in the denominator; case and address identify each timeout.',
    'Unknown-instruction counts and structure modes cover completed functions only; timeout functions have no completed output.',
  ],
};

fs.writeFileSync(outFile, `${JSON.stringify(after, null, 2)}\n`);
console.log(`wrote ${outFile}`);
