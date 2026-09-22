/* Plan-A report contract: validate structure and arithmetic, not fixed corpus scores. */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { decide } from '../js/evidence.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'reports/investigations/pinpoint-confidence-plan-a/current-main-p4');
const rows = fs.readFileSync(path.join(DIR, 'rows.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const field = rows.filter((row) => row.kind === 'field');
const dsda = rows.filter((row) => row.kind === 'location');
const summary = JSON.parse(fs.readFileSync(path.join(DIR, 'summary.json'), 'utf8'));
const policies = JSON.parse(fs.readFileSync(path.join(DIR, 'policy-comparison.json'), 'utf8'));
const oldVsCurrent = JSON.parse(fs.readFileSync(path.join(DIR, 'old-vs-current.json'), 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync(path.join(DIR, 'failure-taxonomy.json'), 'utf8'));
const oracle = JSON.parse(fs.readFileSync(path.join(DIR, 'oracle-ceiling.json'), 'utf8'));
const jev = JSON.parse(fs.readFileSync(path.join(DIR, 'jev-eligibility-analysis.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'measurement.json'), 'utf8'));
const queries = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/pinpoint-confidence-queries.json'), 'utf8'));

function fusion(candidate) {
  return {
    ...candidate.fusion,
    items: candidate.evidence.map((item) => ({ ...item, id: item.identifying === true })),
  };
}
function sumVerdicts(metric) {
  return Object.values(metric.verdicts).reduce((sum, verdict) => sum + verdict.correct + verdict.incorrect, 0);
}

test('Plan-A rows bind the full denominator, current-main provenance, candidate snapshots, and P4 replay', () => {
  assert.equal(field.length, queries.length);
  assert.equal(dsda.length, 1);
  assert.equal(summary.denominatorContract.fieldRows, queries.length);
  assert.equal(summary.denominatorContract.totalRows, rows.length);
  assert.equal(manifest.complete, true);
  assert.match(manifest.productCommit, /^[0-9a-f]{40}$/);
  for (const row of field) {
    assert.equal(row.error, undefined);
    assert.equal(row.replayFidelity, 'match');
    assert.equal(row.policyAVerdict, row.newVerdict, 'A remains the P1 global-gate counterfactual');
    assert.equal(row.policyDPlanAVerdict, row.p4Verdict, 'D shares the current P4 production core');
    assert.equal(row.currentVerdict, row.policyDPlanAVerdict, 'recorded production field verdict is P4');
    assert.ok(row.candidatePresent === (row.truthRank > 0));
    assert.ok(Array.isArray(row.candidates) && row.candidates.length === row.candidateCount);
    assert.ok(row.candidates.some((candidate) => candidate.rank === 1));
    assert.ok(row.candidatePresent ? row.candidates.some((candidate) => candidate.truth) : true);
  }
});

test('Plan-A policy comparison preserves every requested subset denominator and verdict arithmetic', () => {
  const expected = {
    all: field.length,
    exact: field.filter((row) => row.mode === 'exact').length,
    partial: field.filter((row) => row.mode === 'partial').length,
    candidatePresent: field.filter((row) => row.candidatePresent).length,
    candidateNotFound: field.filter((row) => !row.candidatePresent).length,
    independentGroups2: field.filter((row) => row.independentGroups === 2).length,
    independentGroupsGte3: field.filter((row) => row.independentGroups >= 3).length,
  };
  for (const policy of Object.values(policies.policies)) {
    for (const [subset, denominator] of Object.entries(expected)) {
      const metric = policy.subsets[subset];
      assert.equal(metric.denominator, denominator, `${policy.column}/${subset}`);
      assert.equal(sumVerdicts(metric), denominator, `${policy.column}/${subset} verdict sum`);
      assert.equal(metric.falseStrong, metric.falseConfirmed + metric.falseLikely);
      assert.equal(metric.correctStrong, metric.correctConfirmed + metric.correctLikely);
      assert.equal(metric.strong, metric.correctStrong + metric.falseStrong);
      assert.equal(metric.candidatePresent + metric.candidateNotFound, denominator);
    }
  }
  assert.equal(summary.selectedPolicy.id, 'D');
  assert.equal(summary.selectedPolicyDeltaFromA.falseStrong, 0, 'selected exemption must not introduce a false strong in the measured replay');
});

test('Plan-A selected production field verdict replays exactly from recorded candidate evidence without re-ranking', () => {
  for (const row of field) {
    const top = row.candidates.find((candidate) => candidate.rank === 1);
    const runner = row.candidates.find((candidate) => candidate.rank === 2);
    const result = decide([
      { key: top.key, fusion: fusion(top) },
      ...(runner ? [{ key: runner.key, fusion: fusion(runner) }] : []),
    ], { allowTrustedTwoGroup: true });
    assert.equal(result.verdict, row.policyDPlanAVerdict, `${row.binary}|${row.mode}|${row.label}`);
    assert.equal(result.top.key, top.key, 'decision must not change ranking');
  }
});

test('Plan-A historical comparison and failure taxonomy remain denominator-complete', () => {
  const comparison = oldVsCurrent.comparison;
  assert.equal(comparison.historicRows, field.length);
  assert.equal(comparison.currentRows, field.length);
  assert.equal(comparison.recoveredPartialRows.length, comparison.subsets.partial.change.candidatePresent);
  assert.equal(comparison.subsets.all.change.candidatePresent,
    comparison.subsets.exact.change.candidatePresent + comparison.subsets.partial.change.candidatePresent);
  for (const view of [taxonomy.currentPolicyA, taxonomy.selectedPolicyD]) {
    assert.equal(Object.values(view.counts).reduce((sum, value) => sum + value, 0), field.length);
    assert.equal(view.rows.length, field.length);
  }
  assert.equal(taxonomy.selectedPolicyD.counts['5-independence-policy-too-broad'], 0,
    'the selected policy must resolve exactly the measured global-gate failure class');
});

test('Plan-A oracle decomposition and Jev boundary are machine-checkable and fail closed', () => {
  assert.equal(oracle.candidateOracle.correctTop1, field.filter((row) => row.candidatePresent).length);
  assert.equal(oracle.rankingOracle.observedTop1Correct, policies.policies.A.subsets.all.top1Correct);
  assert.equal(oracle.confidenceOracle.correctStrongCeiling, policies.policies.D.subsets.all.top1Correct);
  assert.equal(
    oracle.lossDecomposition.candidateRecallLoss + oracle.lossDecomposition.rankingLossAfterCandidateRecall + oracle.lossDecomposition.confidenceCalibrationLossAfterCorrectTop1,
    field.length - policies.policies.D.subsets.all.correctStrong,
  );
  assert.equal(Object.values(jev.reasonCounts).reduce((sum, value) => sum + value, 0), field.length);
  assert.equal(jev.eligibleCount, jev.rows.filter((row) => row.eligible).length);
  for (const row of jev.rows.filter((row) => row.eligible)) {
    assert.equal(row.mode, 'partial');
    assert.equal(row.localVerdict, 'ambiguous');
    assert.ok(row.candidateCount >= 2);
    assert.equal(row.deterministicEvidence, 'unresolved');
  }
  assert.equal(jev.notImprovedByThisJevBoundary,
    taxonomy.selectedPolicyD.rows.filter((row) => row.category !== 'resolved' && !jev.rows.find((candidate) => candidate.key === row.key)?.eligible).length);
});
