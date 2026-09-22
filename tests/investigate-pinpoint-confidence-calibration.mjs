/*
 * Artifact + consistency checks for the confidence calibration measurement.
 *
 * Validates the committed report (rows.jsonl / summary.json) without any
 * binary analysis: schema, query counts, offline replay audit (stored verdicts
 * recomputed from stored fusion equal stored verdicts), aggregate arithmetic,
 * and a production canary (current decide() must still be the measured NEW
 * policy — if productionendpoints move, this report is stale and must be
 * re-measured, never silently reused).
 *
 *   node tests/investigate-pinpoint-confidence-calibration.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  oldVerdictForFusion, newVerdictForFusion, p4VerdictForFusion,
  policyBVerdictForFusion, policyCVerdictForFusion,
} from '../scripts/pinpoint-confidence-policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIR = path.join(ROOT, 'reports/investigations/pinpoint-confidence-calibration');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write('  ok  ' + name + '\n'); }
  catch (err) {
    failures.push({ name, err });
    process.stdout.write('FAIL  ' + name + '\n      ' + (err && err.message) + '\n');
  }
}
function ok(c, m) { if (!c) throw new Error(m || 'expected truthy'); }
function eq(a, b, m) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || 'not equal') + ': got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b));
}

const queries = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/pinpoint-confidence-queries.json'), 'utf8'));
const rows = fs.readFileSync(path.join(DIR, 'rows.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const summary = JSON.parse(fs.readFileSync(path.join(DIR, 'summary.json'), 'utf8'));
const field = rows.filter((r) => r.kind === 'field');
const dsda = rows.filter((r) => r.kind === 'location');

const REQUIRED = ['binary', 'mode', 'label', 'expectedClass', 'expectedField', 'topClass', 'topField',
  'topCorrect', 'truthRank', 'candidateCount', 'probability', 'logOdds', 'margin', 'verified',
  'identifying', 'independentGroups', 'groups', 'evidence', 'oldVerdict', 'newVerdict', 'p4Verdict',
  'policyBVerdict', 'policyCVerdict', 'missing', 'replayFidelity', 'analyzeCalls'];

test('query fixture: 426 queries with #9413 per-binary/mode counts', () => {
  eq(queries.length, 426, 'fixture size');
  const count = (b, m) => queries.filter((q) => q.binary === b && q.mode === m).length;
  eq([count('battlecats', 'exact'), count('battlecats', 'partial')], [120, 86], 'battlecats');
  eq([count('TsumTsum', 'exact'), count('TsumTsum', 'partial')], [60, 60], 'TsumTsum');
  eq([count('YWP', 'exact'), count('YWP', 'partial')], [50, 50], 'YWP');
});

test('rows: 426 field rows, zero errors, zero fidelity mismatches', () => {
  eq(field.length, 426, 'field rows');
  eq(field.filter((r) => r.error).length, 0, 'error rows');
  eq(field.filter((r) => (r.replayFidelity || 'match') !== 'match').length, 0, 'fidelity mismatches');
  for (const r of field) for (const k of REQUIRED) ok(r[k] !== undefined, `row missing ${k}: ${r.binary}|${r.mode}|${r.label}`);
});

test('offline replay audit: stored verdicts recompute exactly', () => {
  const topFusionOf = (r) => ({
    logOdds: r.logOdds, probability: r.probability, verified: r.verified,
    identifying: r.identifying, independentGroups: r.independentGroups, groups: r.groups,
  });
  // Verdicts depend on the runner-up only through the margin, so rebuild an
  // equivalent runner from the stored margin. Where the collection schema
  // already stores runnerLogOdds, cross-check it against the stored margin.
  // (Early collection rows predate the runnerLogOdds field; re-running 288
  // queries to backfill identical numbers would double analysis work for
  // zero new information.)
  const runnerOf = (r) => {
    if ((r.candidateCount ?? 0) <= 1) return null;
    if (r.marginInfinite) return null;
    if (typeof r.margin !== 'number' || typeof r.logOdds !== 'number') return null;
    if ('runnerLogOdds' in r && r.runnerLogOdds != null) {
      if (Math.abs((r.logOdds - r.margin) - r.runnerLogOdds) > 1e-6) {
        throw new Error(`margin/runnerLogOdds inconsistent: ${r.binary}|${r.mode}|${r.label}`);
      }
    }
    return { logOdds: r.logOdds - r.margin };
  };
  for (const r of field) {
    const t = topFusionOf(r);
    const u = runnerOf(r);
    const codes = (r.evidence || []).map((e) => e.code);
    eq(oldVerdictForFusion(t, u).verdict, r.oldVerdict, `OLD ${r.binary}|${r.mode}|${r.label}`);
    eq(newVerdictForFusion(t, u).verdict, r.newVerdict, `NEW ${r.binary}|${r.mode}|${r.label}`);
    eq(p4VerdictForFusion(t, u).verdict, r.p4Verdict, `P4 ${r.binary}|${r.mode}|${r.label}`);
    eq(policyBVerdictForFusion(t, u, codes).verdict, r.policyBVerdict, `B ${r.binary}|${r.mode}|${r.label}`);
    eq(policyCVerdictForFusion(t, u, codes).verdict, r.policyCVerdict, `C ${r.binary}|${r.mode}|${r.label}`);
  }
});

test('denominator contract: fieldRows=426, dsdaHoldoutRows=1, totalRows=427 (fail-closed, same as focused validator)', () => {
  eq(field.length, 426, 'field rows');
  eq(dsda.length, 1, 'DSDA holdout rows');
  eq(rows.length, 427, 'total rows');
  eq(summary.dataset.fieldRows, 426, 'summary.dataset.fieldRows');
  eq(summary.dataset.dsdaHoldoutRows, 1, 'summary.dataset.dsdaHoldoutRows');
  eq(summary.dataset.totalRows, 427, 'summary.dataset.totalRows');
  eq(summary.dataset.fieldQueries, 426, 'summary.dataset.fieldQueries');
  eq(summary.dataset.dsdaHoldout, 'included-separately', 'summary.dataset.dsdaHoldout');
});

test('summary arithmetic is internally consistent', () => {
  const c = summary.contingency;
  eq(c.OLD.falseStrong, c.OLD.wrongConfirmed + c.OLD.wrongLikely, 'OLD falseStrong');
  eq(c.NEW.falseStrong, c.NEW.wrongConfirmed + c.NEW.wrongLikely, 'NEW falseStrong');
  eq(summary.abstentionCost.preventedFalseStrong, c.OLD.falseStrong - c.NEW.falseStrong, 'prevented');
  const gSum = Object.values(summary.groups).reduce((a, b) => a + b.queries, 0);
  eq(gSum, 426, 'groups cover all field queries');
  eq(summary.pCorrectGivenOldLikelyG2.n, 57, 'g2 likely n');
  eq(summary.exact.queries + summary.partialOverall.queries, 426, 'regime split');
  eq(summary.presentVsNotFound.present + summary.presentVsNotFound.notFound, 426, 'present/notfound split');
  eq(summary.partialNotFound, 0, 'not-found kept in denominators (0 missing after #9437 recall fix)');
  eq(summary.preventedDetail.length, 2, 'prevented detail');
  eq(summary.newLikelyPool.n, 24, 'NEW likely pool');
});

test('DSDA holdout row: OLD likely -> NEW ambiguous, ranking intact', () => {
  ok(dsda.length <= 1, 'at most one DSDA row');
  if (!dsda.length) { process.stdout.write('    (skipped: artifact absent in this checkout)\n'); return; }
  const d = dsda[0];
  eq(d.topOffset, '148', 'top stays 148');
  eq(d.truthRank, 4, 'truth rank 4');
  eq(d.oldVerdict, 'likely', 'OLD false-likely');
  eq(d.newVerdict, 'ambiguous', 'NEW honest');
  eq(d.independentGroups, 2, 'groups 2');
  eq(d.p4Verdict, 'ambiguous', 'P4 (location path, flag off) keeps DSDA ambiguous');
  eq(d.replayFidelity, 'match', 'fidelity');
});

test('P4 production validation gates: no new/downgraded false-strong deltas, DSDA stays ambiguous', () => {
  const safety = summary.p4Validation && summary.p4Validation.safety;
  ok(safety, 'summary.p4Validation.safety present');
  eq(safety.newlyIntroducedFalseStrong.length, 0, 'P4 must not introduce any false-strong vs P1');
  eq(safety.downgradedCorrectStrong.length, 0, 'P4 must not downgrade any correct-strong vs P1');
  eq(safety.dsdaVerdict, 'ambiguous', 'DSDA holdout stays ambiguous under P4');
  ok(summary.contingency.P4.falseStrong <= summary.contingency.NEW.falseStrong, 'P4 false-strong must not increase');
  const p4cs = summary.contingency.P4.correctConfirmed + summary.contingency.P4.correctLikely;
  const p1cs = summary.contingency.NEW.correctConfirmed + summary.contingency.NEW.correctLikely;
  ok(p4cs >= p1cs, `P4 correct-strong must not decrease (p4=${p4cs}, p1=${p1cs})`);
});

test('production canary: decide() is still the measured P4 policy endpoints', () => {
  const root = path.resolve(HERE, '..');
  const src = fs.readFileSync(path.join(root, 'js/evidence.js'), 'utf8');
  ok(/likelyGroupsGate\(topFusion, independent, opts\)/.test(src),
    'P4 groups gate must still be the production likely rule; if it moved, re-measure instead of reusing this report');
  ok(/TRUSTED_LIKELY_GROUPS = Object\.freeze\(\[GROUP\.METADATA, GROUP\.STRUCTURAL\]\)/.test(src),
    'trusted pair must stay exactly metadata+structural');
  const legacy = fs.readFileSync(path.join(root, 'js/pinpoint-legacy.js'), 'utf8');
  eq((legacy.match(/allowTrustedTwoGroup: true/g) || []).length, 1,
    'legacy must wire the field-only P4 flag exactly once (FIELD_LIKELY_OPTS)');
  ok(/decide\(list, \{ maxVerdict: VERDICT\.LIKELY \}\)/.test(legacy),
    'location path must not enable the P4 exception');
  const facade = fs.readFileSync(path.join(root, 'js/pinpoint.js'), 'utf8');
  eq((facade.match(/allowTrustedTwoGroup: true/g) || []).length, 1,
    'facade field decide must pass the P4 flag exactly once');
});

process.stdout.write('\n' + passed + ' passed, ' + failures.length + ' failed\n');
if (failures.length) process.exit(1);
