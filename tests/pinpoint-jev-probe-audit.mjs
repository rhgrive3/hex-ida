import { execFileSync } from 'node:child_process';
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

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const CURRENT_ROUTER_SHA = '9f80701fb298e2bac1028fd8e7182b3a525cfde41b179957c8676e7870ec7f2f';
const PUBLICATION_ROUTER_SHA = 'c94629ce03c6da9190c944928fa26ad8d467f812f4bbb545224b8a6423207d4e';
const FROZEN_ROUTER_SHA = '62f3c7eb561218527db146b658f3394a1a6e12469b465b88b848e3f8cddb2173';
// The historical study remains bound to its immutable source and artifacts.
// Preserve the exact pre-Jev publication product separately from the V2 router.
// The new router is bound to its prospectively frozen evaluation manifest;
// neither version is relabelled as the other's measured product.
const CXX_ROUTER_DELTAS = [
  {
    current: [
      'export function byRecallLane(a, b) {',
      '  return ((a.recallLane ? 1 : 0) - (b.recallLane ? 1 : 0))',
      '    || (b.fusion.logOdds - a.fusion.logOdds)',
      "    || (a.source === 'cxx' || b.source === 'cxx'",
      "      ? Number(a.source === 'cxx') - Number(b.source === 'cxx') || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)",
      '      : 0);',
      '}',
    ].join('\n'),
    frozen: [
      'export function byRecallLane(a, b) {',
      '  return ((a.recallLane ? 1 : 0) - (b.recallLane ? 1 : 0))',
      '    || (b.fusion.logOdds - a.fusion.logOdds);',
      '}',
    ].join('\n'),
  },
  {
    current: "function hydrateShapeChangeSites(pin, opts) {\n  if (pin?.top?.source === 'cxx') return pin;\n",
    frozen: 'function hydrateShapeChangeSites(pin, opts) {\n',
  },
];

function assertRouterContinuity(source, currentSha = CURRENT_ROUTER_SHA) {
  assert.equal(sha256(source), currentSha, 'current exact router bytes');
  const policyBytes = fs.readFileSync(path.join(ROOT, 'reports/investigations/jev-realgame-final/stability-v2/policy-freeze.json'));
  assert.equal(sha256(policyBytes), 'a43b48fde7d15f6863c7c7483757a1223313cea5796352706a9183a6670d4d59', 'prospective V2 policy bytes');
  assert.equal(currentSha, JSON.parse(policyBytes).routerSourceSha256, 'current router must match the independently evaluated V2 source');
  let frozen = execFileSync('git', ['show', '827e74798f036f4f95c0b2d7a06c75a977ac8086:js/pinpoint.js'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(sha256(frozen), PUBLICATION_ROUTER_SHA, 'exact historical C++ publication router');
  for (const delta of CXX_ROUTER_DELTAS) {
    assert.equal(frozen.split(delta.current).length, 2, 'exactly one approved C++ router delta');
    frozen = frozen.replace(delta.current, delta.frozen);
  }
  assert.equal(sha256(frozen), FROZEN_ROUTER_SHA, 'unchanged frozen router body outside approved C++ deltas');
}

test('audit manifest binds the exact source and artifact bytes', () => {
  const manifest = json('audit-manifest.json');
  const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const historicalCommit = '64096f5cb04c300a6bc7f412d7030896bc48d067';

  for (const [relative, expected] of Object.entries(manifest.sourceSha256)) {
    // Validate historical exact source via immutable git blob at the commit where the audit was conducted
    const historicalBlob = execFileSync('git', ['cat-file', '-p', `${historicalCommit}:${relative}`], {
      cwd: ROOT,
    });
    assert.equal(hashBytes(historicalBlob), expected, `${relative} (historical commit ${historicalCommit})`);

    // Verify both the exact current product and unchanged historical router
    // body around the two approved C++ publication deltas. Never relabel the
    // historical study as an evaluation of the new candidate universe.
    if (relative === 'js/pinpoint.js') {
      assertRouterContinuity(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
    }
  }

  // Preserve artifact byte hashes
  for (const [relative, expected] of Object.entries(manifest.artifactSha256)) {
    assert.equal(hash(path.join(OUT, relative)), expected, relative);
  }
});

test('router freeze rejects policy drift and unapproved C++ edits even after refreshing the product hash', () => {
  const source = fs.readFileSync(path.join(ROOT, 'js/pinpoint.js'), 'utf8');
  assertRouterContinuity(source);
  const policyDrift = source.replace('max: opts?.maxChoices ?? 255', 'max: opts?.maxChoices ?? 254');
  assert.notEqual(policyDrift, source);
  assert.throws(() => assertRouterContinuity(policyDrift, sha256(policyDrift)), /current router must match the independently evaluated V2 source/);
  const cxxDrift = source.replace("if (pin?.top?.source === 'cxx') return pin;", "if (pin?.top?.source === 'objc') return pin;");
  assert.notEqual(cxxDrift, source);
  assert.throws(() => assertRouterContinuity(cxxDrift, sha256(cxxDrift)), /current router must match the independently evaluated V2 source/);
  const duplicatedGuard = source.replace(CXX_ROUTER_DELTAS[1].current, CXX_ROUTER_DELTAS[1].current + "  if (pin?.top?.source === 'cxx') return pin;\n");
  assert.notEqual(duplicatedGuard, source);
  assert.throws(() => assertRouterContinuity(duplicatedGuard, sha256(duplicatedGuard)), /current router must match the independently evaluated V2 source/);
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
    assert.ok(row.candidates.length > 0);
    assert.equal(row.localVerdict, assessJevEligibility(row).eligible ? 'ambiguous' : row.localVerdict);
  }
});

test('budget, oracle dominance, and exact eligibility boundaries', () => {
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
