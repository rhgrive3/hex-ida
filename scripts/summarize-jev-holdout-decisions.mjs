#!/usr/bin/env node
/**
 * Read-only reporter for the Jev advisory-versus-canonical decision.
 *
 * It reads only the committed prospective-evaluation outputs of each holdout run
 * (prospective-raw-results.jsonl + prospective-summary.json) and prints:
 *   - per-run counts,
 *   - a conservative distinct-case pool across runs,
 *   - the frozen 2026-09-24 canonical decision criteria applied to each view.
 *
 * The criteria below are the ones recorded in
 * reports/investigations/jev-final-decision-20260924/README.md. They are
 * constants, never inputs: this script must not be able to move a bar to make a
 * ranking problem disappear. Raw counts are always printed next to the verdict.
 *
 * Usage:
 *   node scripts/summarize-jev-holdout-decisions.mjs [runDir ...] [--json <out>]
 * Defaults to the three runs recorded on 2026-09-25 at f24fdca40.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Frozen 2026-09-24 decision criteria. Do not tune these to fit a result.
const FROZEN_CRITERIA = Object.freeze({
  minRescues: 1,
  maxRegressions: 1,
  maxRegressionRescueRatio: 0.1,
  maxNewFalseStrong: 0,
  requiresFailClosed: true,
});

const DEFAULT_RUNS = [
  { name: 'xadmaster-run1', holdout: 'xadmaster', dir: 'reports/investigations/jev-disjoint-holdout-20260925/xadmaster' },
  { name: 'xadmaster-run2', holdout: 'xadmaster', dir: 'reports/investigations/jev-disjoint-holdout-20260925/xadmaster-repeat' },
  { name: 'sparkle-rerun', holdout: 'sparkle', dir: 'reports/investigations/jev-disjoint-holdout-20260925/sparkle-rerun' },
];

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function summarizeRun(run) {
  const dir = path.join(ROOT, run.dir);
  const rows = readJsonl(path.join(dir, 'prospective-raw-results.jsonl'));
  const summary = readJson(path.join(dir, 'prospective-summary.json'));
  const answerable = rows.filter((r) => r.gold);
  const rescues = answerable.filter((r) => !r.armA.correct && r.armB.correct);
  const regressions = answerable.filter((r) => r.armA.correct && !r.armB.correct);
  const routed = rows.filter((r) => r.armB.source === 'jev');
  return {
    name: run.name,
    holdout: run.holdout,
    dir: run.dir,
    productHeadAtRun: summary.productHeadAtRun,
    routerSha256: summary.routerSha256,
    caseSha256: summary.caseSha256,
    binarySha256: summary.binarySha256,
    model: summary.model,
    totalCases: rows.length,
    answerableCases: answerable.length,
    abstainCases: rows.length - answerable.length,
    armA_top1: answerable.filter((r) => r.armA.correct).length,
    armB_top1: answerable.filter((r) => r.armB.correct).length,
    armA_falseStrong: rows.filter((r) => r.armA.falseStrong).length,
    armB_falseStrong: rows.filter((r) => r.armB.falseStrong).length,
    armA_unsafeConfident: rows.filter((r) => r.armA.unsafeConfident).length,
    armB_unsafeConfident: rows.filter((r) => r.armB.unsafeConfident).length,
    routedCases: routed.length,
    rescues: rescues.length,
    regressions: regressions.length,
    regressionRescueRatio: rescues.length ? regressions.length / rescues.length : null,
    rescueCaseIds: rescues.map((r) => r.id),
    regressionCaseIds: regressions.map((r) => r.id),
    apiClientStats: summary.apiClientStats,
    failedCallsObserved: summary.metrics?.differential?.failedCallsObserved ?? null,
    failClosedObserved: summary.metrics?.differential?.failClosedObserved ?? null,
    _rows: rows,
  };
}

/**
 * Conservative distinct-case pool: repeated runs of the same holdout are
 * counted once per case. A case that regressed in any run is a pooled
 * regression; a case that was rescued in any run and never regressed is a
 * pooled rescue. This never makes a repeated run look safer than its worst run.
 */
export function poolRuns(summaries) {
  const perCase = new Map();
  for (const run of summaries) {
    for (const row of run._rows) {
      const key = `${run.holdout}::${row.id}`;
      const entry = perCase.get(key) ?? {
        key, holdout: run.holdout, id: row.id, answerable: !!row.gold,
        armA_correct: row.armA.correct, armB_correct_any: false, regressed: false,
      };
      entry.armB_correct_any = entry.armB_correct_any || !!row.armB.correct;
      entry.regressed = entry.regressed || (!!row.armA.correct && !row.armB.correct);
      perCase.set(key, entry);
    }
  }
  const cases = [...perCase.values()];
  const answerable = cases.filter((c) => c.answerable);
  const rescues = answerable.filter((c) => !c.armA_correct && c.armB_correct_any && !c.regressed);
  const regressions = answerable.filter((c) => c.regressed);
  return {
    distinctAnswerableCases: answerable.length,
    rescues: rescues.length,
    regressions: regressions.length,
    regressionRescueRatio: rescues.length ? regressions.length / rescues.length : null,
    rescueCaseIds: rescues.map((c) => c.key),
    regressionCaseIds: regressions.map((c) => c.key),
  };
}

export function applyFrozenCriteria(metrics) {
  const criteria = [
    { id: 'rescues>0', pass: metrics.rescues > FROZEN_CRITERIA.minRescues - 1, observed: metrics.rescues },
    { id: 'regressions<=1', pass: metrics.regressions <= FROZEN_CRITERIA.maxRegressions, observed: metrics.regressions },
    {
      id: 'regressions/rescues<=0.1',
      pass: metrics.regressionRescueRatio !== null && metrics.regressionRescueRatio <= FROZEN_CRITERIA.maxRegressionRescueRatio,
      observed: metrics.regressionRescueRatio,
    },
    { id: 'newFalseStrong==0', pass: (metrics.newFalseStrong ?? 0) <= FROZEN_CRITERIA.maxNewFalseStrong, observed: metrics.newFalseStrong ?? null },
  ];
  return { criteria, canonicalBarMet: criteria.every((c) => c.pass) };
}

function main() {
  const args = process.argv.slice(2);
  const jsonIndex = args.indexOf('--json');
  const jsonOut = jsonIndex >= 0 ? args[jsonIndex + 1] : null;
  const runArgs = args.filter((a, i) => i !== jsonIndex && i !== jsonIndex + 1);
  const runs = runArgs.length
    ? runArgs.map((dir) => ({ name: path.basename(dir), holdout: path.basename(dir), dir }))
    : DEFAULT_RUNS;

  const summaries = runs.map(summarizeRun);
  const pooled = poolRuns(summaries);
  const perRun = summaries.map((s) => {
    const { _rows, ...metrics } = s;
    return { ...metrics, ...applyFrozenCriteria({ ...metrics, newFalseStrong: metrics.armB_falseStrong - metrics.armA_falseStrong }) };
  });

  const report = {
    schema: 'hex-jev-holdout-decision-summary/v1',
    generatedAtUtc: new Date().toISOString(),
    frozenCriteria: FROZEN_CRITERIA,
    runs: perRun,
    pooled: { ...pooled, ...applyFrozenCriteria({ ...pooled, newFalseStrong: null }) },
  };

  for (const run of report.runs) {
    console.log(`${run.name}: answerable=${run.answerableCases} A_top1=${run.armA_top1} B_top1=${run.armB_top1} rescues=${run.rescues} regressions=${run.regressions} ratio=${run.regressionRescueRatio} newFalseStrong=${run.armB_falseStrong - run.armA_falseStrong} canonicalBarMet=${run.canonicalBarMet}`);
    if (run.regressionCaseIds.length) console.log(`  regressions: ${run.regressionCaseIds.join(', ')}`);
  }
  console.log(`pooled(distinct cases, worst-run-wins): answerable=${report.pooled.distinctAnswerableCases} rescues=${report.pooled.rescues} regressions=${report.pooled.regressions} ratio=${report.pooled.regressionRescueRatio} canonicalBarMet=${report.pooled.canonicalBarMet}`);
  if (jsonOut) fs.writeFileSync(path.resolve(jsonOut), JSON.stringify(report, null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
