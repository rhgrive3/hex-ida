#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  BUDGET, assertBaselineParity, compareObjective, evaluateSequence,
  productionReplay, runHeuristic, runOracle, strong, withinBudget,
} from './pinpoint-probe-scheduler.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'reports/investigations/pinpoint-jev-probe-audit-20260923');
const readJsonl = (name) => fs.readFileSync(path.join(OUT, name), 'utf8').trim().split('\n').map(JSON.parse);
const corpus = readJsonl('focused-eligible-corpus.jsonl');
const transitions = readJsonl('probe-transitions.jsonl');
if (corpus.length !== 61) throw new Error(`expected 61 focused rows, got ${corpus.length}`);
const byQuery = new Map(corpus.map((row) => [row.queryId, transitions.filter((p) => p.queryId === row.queryId)]));
const kinds = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'];
const baseline = corpus.map((row) => {
  assertBaselineParity(row);
  return evaluateSequence(row, []);
});
const baseById = new Map(baseline.map((r) => [r.queryId, r]));
const probeRates = new Map();
for (const row of corpus) {
  const other = transitions.filter((p) => p.queryId !== row.queryId);
  const rates = {};
  for (const family of new Set(other.map((p) => p.family))) {
    const subset = other.filter((p) => p.family === family && !p.baselineCovered && !p.failed && !p.timedOut);
    rates[family] = subset.length ? subset.filter((p) => p.useful).length / subset.length : 0;
  }
  probeRates.set(row.queryId, rates);
}
const heuristicVariants = Object.fromEntries(kinds.map((kind) => [kind, corpus.map((row) =>
  runHeuristic(row, byQuery.get(row.queryId), kind, probeRates.get(row.queryId), BUDGET))]));
function aggregateObjective(rows) {
  const falseStrong = rows.filter((r) => strong(r.verdict) && !r.topCorrect).length;
  const topCorrect = rows.filter((r) => r.topCorrect).length;
  const correctStrong = rows.filter((r) => r.topCorrect && strong(r.verdict)).length;
  const ambiguous = rows.filter((r) => r.verdict === 'ambiguous').length;
  const calls = rows.reduce((n, r) => n + r.cost.calls, 0);
  const probes = rows.reduce((n, r) => n + r.cost.probes, 0);
  const elapsed = rows.reduce((n, r) => n + r.cost.elapsedMs, 0);
  return [-falseStrong, topCorrect, correctStrong, -ambiguous, -calls, -probes, -elapsed];
}
const bestKind = kinds.slice().sort((a, b) => compareObjective(
  aggregateObjective(heuristicVariants[b]), aggregateObjective(heuristicVariants[a])))[0];
const heuristic = heuristicVariants[bestKind];
const hById = new Map(heuristic.map((r) => [r.queryId, r]));
const oracleB = [], oracleA = [];
for (const row of corpus) {
  const probes = byQuery.get(row.queryId);
  const h = hById.get(row.queryId);
  const b = runOracle(row, probes, BUDGET, h);
  const a = runOracle(row, probes, null, b);
  b.stopReason = b.topCorrect && strong(b.verdict) ? 'STOP_RESOLVED'
    : b.cost.probes >= BUDGET.maxProbeCount || b.cost.calls >= BUDGET.maxAnalyzeCalls
      || b.cost.elapsedMs >= BUDGET.maxElapsedMs ? 'STOP_BUDGET' : 'STOP_NO_USEFUL_PROBE';
  a.stopReason = a.topCorrect && strong(a.verdict) ? 'STOP_RESOLVED' : 'STOP_NO_USEFUL_PROBE';
  if (!withinBudget(probes.filter((p) => b.probeIds.includes(p.probeId)), BUDGET)
    || !withinBudget(probes.filter((p) => h.probeIds.includes(p.probeId)), BUDGET)) throw new Error('budget overflow');
  if (compareObjective(a.objective, b.objective) < 0) throw new Error('Oracle A < B');
  for (const kind of kinds) {
    const variant = heuristicVariants[kind].find((r) => r.queryId === row.queryId);
    if (compareObjective(b.objective, variant.objective) < 0) {
      throw new Error(`Oracle B < ${kind}: ${row.queryId}`);
    }
  }
  oracleB.push(b); oracleA.push(a);
  process.stdout.write(`oracle ${oracleB.length}/${corpus.length}: ${row.queryId} states=${b.states}/${a.states}\n`);
}
const bById = new Map(oracleB.map((r) => [r.queryId, r]));
const aById = new Map(oracleA.map((r) => [r.queryId, r]));
const quantile = (values, p) => {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
};
function stats(rows) {
  const counts = { total: rows.length, top1Correct: 0, correctStrong: 0, falseStrong: 0, ambiguous: 0,
    resolved: 0, wrongToCorrect: 0, correctToWrong: 0, falseStrongPrevented: 0, newFalseStrong: 0,
    budgetExhaustion: 0, stopReasons: {} };
  const probes = [], calls = [], elapsed = [];
  for (const r of rows) {
    const old = baseById.get(r.queryId);
    counts.top1Correct += Number(r.topCorrect);
    counts.correctStrong += Number(r.topCorrect && strong(r.verdict));
    counts.falseStrong += Number(!r.topCorrect && strong(r.verdict));
    counts.ambiguous += Number(r.verdict === 'ambiguous');
    counts.resolved += Number(r.topCorrect && strong(r.verdict));
    counts.wrongToCorrect += Number(!old.topCorrect && r.topCorrect);
    counts.correctToWrong += Number(old.topCorrect && !r.topCorrect);
    counts.falseStrongPrevented += Number(!old.topCorrect && strong(old.verdict) && !strong(r.verdict));
    counts.newFalseStrong += Number(!r.topCorrect && strong(r.verdict) && !strong(old.verdict));
    counts.budgetExhaustion += Number(r.stopReason === 'STOP_BUDGET');
    if (r.stopReason) counts.stopReasons[r.stopReason] = (counts.stopReasons[r.stopReason] || 0) + 1;
    probes.push(r.cost.probes); calls.push(r.cost.calls); elapsed.push(r.cost.elapsedMs);
  }
  return {
    ...counts, averageProbes: probes.reduce((a, b) => a + b, 0) / rows.length,
    p50Probes: quantile(probes, 0.5), p95Probes: quantile(probes, 0.95),
    totalAnalyzeCalls: calls.reduce((a, b) => a + b, 0),
    p50AnalyzeCalls: quantile(calls, 0.5), p95AnalyzeCalls: quantile(calls, 0.95),
    p50ElapsedMs: quantile(elapsed, 0.5), p95ElapsedMs: quantile(elapsed, 0.95),
  };
}
const classification = corpus.map((row) => {
  const h = hById.get(row.queryId), b = bById.get(row.queryId), a = aById.get(row.queryId);
  const ownProbes = byQuery.get(row.queryId);
  const baselineCorrect = row.truthRank === 1;
  let category = 'OTHER', reason = 'Available scored probes did not prove the requested field; intent and missing primitives require case review.';
  let secondaryStatus = null;
  if (baselineCorrect) {
    category = 'ALREADY_CORRECT';
    secondaryStatus = h.topCorrect && strong(h.verdict) ? null : 'CONFIDENCE_ONLY';
    reason = h.topCorrect && strong(h.verdict)
      ? 'Baseline top1 was already correct; heuristic raised confidence.'
      : 'Baseline top1 was correct but remains below a safe strong verdict.';
  } else if (h.topCorrect && strong(h.verdict)) {
    category = 'HEURISTIC_RESOLVED'; reason = 'Fixed deterministic heuristic reached correct strong within budget.';
  } else if (b.topCorrect && strong(b.verdict)) {
    category = 'ORACLE_ONLY_RESOLVED'; reason = 'Exact budget oracle reached correct strong but heuristic did not.';
  } else if (a.topCorrect && strong(a.verdict)) {
    category = 'ONLY_UNBOUNDED_RESOLVED'; reason = 'Same probe catalog required more than the production budget.';
  } else if (!ownProbes.some((p) => p.observations?.length && !p.failed && !p.timedOut)) {
    const truth = row.candidates.find((c) => c.className === row.expectedClass
      && c.fieldName === row.expectedField);
    const indexedSites = ownProbes.find((p) => p.family === 'scan-access'
      && p.candidateId === truth?.key)?.siteCount || 0;
    category = indexedSites ? 'ANALYSIS_PRIMITIVE_MISSING' : 'BINARY_EVIDENCE_INSUFFICIENT';
    reason = indexedSites
      ? 'scanAccess found access sites, but no current receiver-safe field primitive converted them into novel scored evidence.'
      : 'No novel scored observation or access site in the bounded production primitive catalog; this is catalog-relative.';
  }
  return {
    queryId: row.queryId, binary: row.binary, label: row.label,
    expectedClass: row.expectedClass, expectedField: row.expectedField,
    baselineTop: row.topCandidate, baselineTruthRank: row.truthRank,
    heuristic: h, oracleB: b, oracleA: a, category, secondaryStatus, reason,
    intentUnderspecified: false,
  };
});
const bs = stats(baseline), hs = stats(heuristic), bstats = stats(oracleB), astats = stats(oracleA);
const selectedTransitions = heuristic.flatMap((r) => r.probeIds.map((id) =>
  byQuery.get(r.queryId).find((p) => p.probeId === id)));
const firstDecisive = [];
for (const result of heuristic) {
  const row = corpus.find((x) => x.queryId === result.queryId);
  const selected = result.probeIds.map((id) => byQuery.get(row.queryId).find((p) => p.probeId === id));
  for (let i = 1; i <= selected.length; i++) {
    const state = productionReplay(row, selected.slice(0, i));
    if (state.topCorrect && strong(state.verdict)) {
      firstDecisive.push({
        elapsedMs: selected.slice(0, i).reduce((n, p) => n + p.elapsedMs, 0),
        analyzeCalls: selected.slice(0, i).reduce((n, p) => n + p.analysisCalls, 0),
        probes: i,
      });
      break;
    }
  }
}
const probed = transitions.filter((p) => !p.baselineCovered && !p.unsupported);
const rate = (n, d) => d ? n / d : 0;
const comparison = {
  schema: 'hex-pinpoint-jev-scheduler-comparison/v2',
  denominator: 426, focusedCount: corpus.length, eligibleWrongBaseline: corpus.filter((r) => r.truthRank !== 1).length,
  budget: BUDGET, oracleObjective: ['min false-strong', 'max correct top1', 'max correct-strong',
    'min unresolved ambiguity', 'min analyze calls', 'min probes', 'min elapsed'],
  selectedHeuristic: bestKind, heuristicVariants: Object.fromEntries(kinds.map((k) => [k, stats(heuristicVariants[k])])),
  baseline: bs, heuristic: hs, oracleB: bstats, oracleA: astats,
  all426Impact: Object.fromEntries([
    ['heuristic', hs], ['oracleB', bstats], ['oracleA', astats],
  ].map(([name, s]) => [name, {
    netTop1Gain: s.top1Correct - bs.top1Correct,
    netTop1PercentagePoints: 100 * (s.top1Correct - bs.top1Correct) / 426,
    correctStrongGain: s.correctStrong - bs.correctStrong,
    correctStrongPercentagePoints: 100 * (s.correctStrong - bs.correctStrong) / 426,
  }])),
  gap: {
    oracleBResolvedMinusHeuristicResolved: bstats.resolved - hs.resolved,
    all426PercentagePoints: 100 * (bstats.resolved - hs.resolved) / 426,
    oracleBWrongToCorrectMinusHeuristic: bstats.wrongToCorrect - hs.wrongToCorrect,
  },
  probeStatistics: {
    catalogProbes: transitions.length, independentlyExecuted: probed.length,
    usefulRate: rate(probed.filter((p) => p.useful).length, probed.length),
    uselessRate: rate(probed.filter((p) => !p.useful).length, probed.length),
    decisiveRate: rate(probed.filter((p) => p.decisive).length, probed.length),
    selectedUsefulRate: rate(selectedTransitions.filter((p) => p.useful).length, selectedTransitions.length),
    timeToFirstDecisiveP50Ms: quantile(firstDecisive.map((x) => x.elapsedMs), 0.5),
    timeToFirstDecisiveP95Ms: quantile(firstDecisive.map((x) => x.elapsedMs), 0.95),
    callsToFirstDecisiveP50: quantile(firstDecisive.map((x) => x.analyzeCalls), 0.5),
    probesToFirstDecisiveP50: quantile(firstDecisive.map((x) => x.probes), 0.5),
  },
  invariants: { emptySequenceParity: true, budgetZeroParity: true,
    oracleAAtLeastB: true, oracleBAtLeastEachHeuristic: true, budgetsHonored: true },
  classificationCounts: Object.fromEntries([
    'ALREADY_CORRECT', 'HEURISTIC_RESOLVED', 'ORACLE_ONLY_RESOLVED',
    'ONLY_UNBOUNDED_RESOLVED', 'BINARY_EVIDENCE_INSUFFICIENT',
    'ANALYSIS_PRIMITIVE_MISSING', 'INTENT_UNDERSPECIFIED',
    'CONFIDENCE_ONLY', 'OTHER',
  ].map((category) => [category, classification.filter((r) => r.category === category).length])),
};
const write = (name, value) => {
  const target = path.join(OUT, name), pending = target + '.partial';
  fs.writeFileSync(pending, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(pending, target);
};
write('heuristic-results.json', { selected: bestKind, variants: heuristicVariants, selectedRows: heuristic });
write('oracle-budget-results.json', { rows: oracleB, budget: BUDGET });
write('oracle-unbounded-results.json', { rows: oracleA });
write('scheduler-comparison.json', comparison);
write('failure-classification.json', classification);
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sources = [
  'js/evidence.js', 'js/pinpoint.js', 'js/pinpoint-legacy.js',
  'js/pinpoint-jev-eligibility.js',
  'scripts/measure-pinpoint-confidence.mjs',
  'scripts/measure-pinpoint-jev-probes.mjs',
  'scripts/pinpoint-probe-scheduler.mjs',
  'scripts/compare-pinpoint-jev-schedulers.mjs',
  'tests/pinpoint-jev-probe-audit.mjs',
  'tests/fixtures/pinpoint-confidence-queries.json',
];
const artifacts = [
  'baseline/measurement.json', 'baseline/rows.jsonl',
  'focused-eligible-corpus.jsonl', 'probe-catalog-v2.json',
  'probe-transitions.jsonl', 'heuristic-results.json',
  'oracle-budget-results.json', 'oracle-unbounded-results.json',
  'scheduler-comparison.json', 'failure-classification.json',
];
write('audit-manifest.json', {
  schema: 'hex-pinpoint-jev-probe-audit-manifest/v1',
  baselineProductCommit: jsonBaselineCommit(),
  sourceSha256: Object.fromEntries(sources.map((file) => [file, hash(path.join(ROOT, file))])),
  artifactSha256: Object.fromEntries(artifacts.map((file) => [file, hash(path.join(OUT, file))])),
});
process.stdout.write(JSON.stringify({
  baseline: bs, heuristic: hs, oracleB: bstats, oracleA: astats, gap: comparison.gap,
  classificationCounts: comparison.classificationCounts,
}, null, 2) + '\n');

function jsonBaselineCommit() {
  return JSON.parse(fs.readFileSync(path.join(OUT, 'baseline/measurement.json'), 'utf8')).productCommit;
}
