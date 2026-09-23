import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assessJevEligibility } from '../js/pinpoint-jev-eligibility.js';
import {
  BUDGET, assertBaselineParity, compareObjective, evaluateSequence,
  productionReplay, runHeuristic, strong, withinBudget,
} from '../scripts/pinpoint-probe-scheduler.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'reports/investigations/pinpoint-jev-probe-audit-20260923');
const json = (name) => JSON.parse(fs.readFileSync(path.join(OUT, name), 'utf8'));
const jsonl = (name) => fs.readFileSync(path.join(OUT, name), 'utf8').trim().split('\n').map(JSON.parse);
const corpus = jsonl('focused-eligible-corpus.jsonl');
const probes = jsonl('probe-transitions.jsonl');
const heuristic = json('heuristic-results.json');
const b = json('oracle-budget-results.json').rows;
const a = json('oracle-unbounded-results.json').rows;
test('audit manifest binds the exact source and artifact bytes', () => {
  const manifest = json('audit-manifest.json');
  const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  for (const [relative, expected] of Object.entries(manifest.sourceSha256)) {
    assert.equal(hash(path.join(ROOT, relative)), expected, relative);
  }
  for (const [relative, expected] of Object.entries(manifest.artifactSha256)) {
    assert.equal(hash(path.join(OUT, relative)), expected, relative);
  }
});

test('focused denominator and production empty replay parity', () => {
  assert.equal(corpus.length, 61);
  for (const row of corpus) {
    assertBaselineParity(row);
    const empty = evaluateSequence(row, []);
    assert.equal(empty.top, row.topCandidate);
    assert.equal(empty.verdict, row.localVerdict);
  }
});
test('zero budget preserves production result', () => {
  const zero = { maxProbeCount: 0, maxAnalyzeCalls: 0, maxElapsedMs: 0 };
  for (const row of corpus) {
    const run = runHeuristic(row, probes.filter((p) => p.queryId === row.queryId), 'H1', {}, zero);
    assert.equal(run.top, row.topCandidate);
    assert.equal(run.verdict, row.localVerdict);
    assert.equal(run.cost.probes, 0);
  }
});
test('failure, timeout, malformed result, and duplicate code fail closed', () => {
  const row = corpus[0];
  const before = productionReplay(row);
  const candidateId = row.topCandidate;
  const obs = { candidateId, code: 'getter-verified', strength: 1,
    sourceIdentity: 'test:function:1:site:2', evidenceProvenance: 'verifyAccessor' };
  for (const mutation of [
    { failed: true, observations: [obs] },
    { timedOut: true, observations: [obs] },
    { observations: [{ ...obs, sourceIdentity: '' }] },
    { observations: [{ ...obs, evidenceProvenance: '' }] },
  ]) {
    const after = productionReplay(row, [mutation]);
    assert.equal(after.topFusion.logOdds, before.topFusion.logOdds);
    assert.equal(after.verdict, before.verdict);
  }
  const existingCode = row.candidates[0].evidence[0].code;
  const duplicate = { observations: [{ ...obs, code: existingCode }] };
  assert.equal(productionReplay(row, [duplicate]).topFusion.logOdds, before.topFusion.logOdds);
  assert.equal(productionReplay(row, [duplicate, duplicate]).topFusion.logOdds, before.topFusion.logOdds);
});
test('recall lane and P4 policy are preserved by replay', () => {
  for (const row of corpus) {
    const state = productionReplay(row);
    let seenRecall = false;
    for (const candidate of state.candidates) {
      if (candidate.recallLane) seenRecall = true;
      else assert.equal(seenRecall, false, 'non-recall candidate after recall lane');
    }
    assert.equal(state.verdict, row.localVerdict);
    assert.equal(state.topFusion.independentGroups, row.topFusion.independentGroups);
  }
});
test('budget, oracle dominance, and exact eligibility boundaries', () => {
  assert.equal(a.length, 61);
  assert.equal(b.length, 61);
  const aById = new Map(a.map((r) => [r.queryId, r]));
  const bById = new Map(b.map((r) => [r.queryId, r]));
  const hById = new Map(heuristic.selectedRows.map((r) => [r.queryId, r]));
  for (const row of corpus) {
    const br = bById.get(row.queryId), ar = aById.get(row.queryId), hr = hById.get(row.queryId);
    assert.ok(compareObjective(ar.objective, br.objective) >= 0);
    assert.ok(compareObjective(br.objective, hr.objective) >= 0);
    assert.ok(withinBudget(probes.filter((p) => br.probeIds.includes(p.probeId)), BUDGET));
    assert.ok(withinBudget(probes.filter((p) => hr.probeIds.includes(p.probeId)), BUDGET));
    assert.equal(assessJevEligibility({
      queryMode: row.mode, candidateLattice: 'complete', candidateCount: row.candidateCount,
      localVerdict: row.localVerdict, deterministicEvidence: 'unresolved', highImpact: true,
    }).eligible, true);
  }
  assert.equal(assessJevEligibility({
    queryMode: 'exact', candidateLattice: 'complete', candidateCount: 2,
    localVerdict: 'ambiguous', deterministicEvidence: 'unresolved', highImpact: true,
  }).eligible, false);
  assert.equal(assessJevEligibility({
    queryMode: 'partial', candidateLattice: 'complete', candidateCount: 2,
    localVerdict: 'likely', deterministicEvidence: 'unresolved', highImpact: true,
  }).eligible, false);
  assert.ok(heuristic.selectedRows.every((r) => !strong(r.verdict) || r.stopReason === 'STOP_RESOLVED'
    || r.stopReason === 'STOP_BUDGET'));
});
