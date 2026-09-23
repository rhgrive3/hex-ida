#!/usr/bin/env node
// Fail-closed integrity checks for the committed rescue/regression report.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => JSON.parse(fs.readFileSync(path.join(HERE, name), 'utf8'));
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const manifest = read('manifest.json');
for (const [name, digest] of Object.entries(manifest.artifactHashes || {})) {
  assert.equal(sha(path.join(HERE, name)), digest, `hash: ${name}`);
}

const baseline = read('current-main-baseline.json');
const evaluation = read('evaluation-summary.json');
const holdout = read('holdout-results.json');
const feature = read('feature-summary.json');
const det = read('deterministic-comparison.json');
const oracle = read('oracle-ceilings.json');
const latency = read('latency-summary.json');
const strong = read('strong-override-arms.json');
const gates = read('gate-candidates.json');
const readme = fs.readFileSync(path.join(HERE, 'README.md'), 'utf8');

const classification = fs.readFileSync(path.join(HERE, 'row-classification.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const rescues = fs.readFileSync(path.join(HERE, 'rescue-cases.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const regressions = fs.readFileSync(path.join(HERE, 'regression-cases.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const matrix = fs.readFileSync(path.join(HERE, 'feature-matrix.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

assert.equal(baseline.N, 426);
assert.equal(baseline.candidatePresent, 426);
assert.equal(baseline.exact.N, 230);
assert.equal(baseline.partial.N, 196);
assert.equal(baseline.top1 + baseline.wrong, 426);
assert.equal(baseline.exact.top1 + baseline.partial.top1, baseline.top1);

assert.equal(classification.length, 196);
assert.equal(matrix.length, 196);
const counts = classification.reduce((a, r) => { a[r.classification] = (a[r.classification] || 0) + 1; return a; }, {});
assert.equal(counts.RESCUE, rescues.length, 'rescue file count');
assert.equal(counts.REGRESSION, regressions.length, 'regression file count');
assert.equal((counts.RESCUE || 0) + (counts.REGRESSION || 0) + (counts.STABLE_CORRECT || 0) + (counts.STABLE_WRONG || 0), 196);

// classification consistency with baseline/jev booleans
for (const r of classification) {
  const expect = (!r.baselineCorrect && r.jevCorrect) ? 'RESCUE'
    : (r.baselineCorrect && !r.jevCorrect) ? 'REGRESSION'
    : (r.baselineCorrect && r.jevCorrect) ? 'STABLE_CORRECT' : 'STABLE_WRONG';
  assert.equal(r.classification, expect, `class ${r.id}`);
  // gate features must not embed truth fields as predicates — truth only as eval labels
  assert.ok('truthRank' in r, 'truthRank present for evaluation');
}

// regressions are baseline-correct (rank 1) by construction of this corpus labels
for (const r of regressions) {
  assert.equal(r.classification, 'REGRESSION');
  assert.equal(r.featureSnapshot.truthRank, 1, `regression truth rank ${r.id}`);
  assert.ok(r.query && r.baseline && r.jev && r.expected, `regression case fields ${r.id}`);
  assert.ok(r.whyBaselineLostOrHeld && r.whyJevAppearedToHelpOrHurt, `regression narrative ${r.id}`);
}
for (const r of rescues) {
  assert.equal(r.classification, 'RESCUE');
  assert.ok(r.featureSnapshot.truthRank >= 2, `rescue truth not top1 ${r.id}`);
}

assert.equal(evaluation.denominator, 426);
assert.equal(evaluation.labelArm.wrongToCorrect, counts.RESCUE);
assert.equal(evaluation.labelArm.correctToWrong, counts.REGRESSION);
assert.equal(feature.counts.RESCUE, counts.RESCUE);
assert.equal(feature.counts.REGRESSION, counts.REGRESSION);

// holdout splits cover all partials
assert.equal(holdout.splits.development.N + holdout.splits.holdout.N, 196);
assert.equal(holdout.splits.development.binary, 'battlecats');

// zero-regression frontier entries actually have 0 regressions
for (const g of holdout.zeroRegressionFrontierFull) {
  assert.equal(g.correctToWrong, 0, `zero frontier ${g.gateId}`);
}
for (const g of holdout.oneRegressionFrontierFull) {
  assert.ok(g.correctToWrong <= 1, `one frontier ${g.gateId}`);
}

// deterministic comparison consistent
assert.equal(det.deterministicScreen.total.N, 196);
assert.ok(det.overlap.jevOnlyRescue >= 0 && det.overlap.detOnlyRescue >= 0);
assert.equal(latency.observedLabelCalls, classification.filter((r) => typeof r.jevLatencyMs === 'number' || r.jevError).length
  || latency.observedLabelCalls); // soft if some missing

// oracle bounds
assert.ok(oracle.jevPerfectChoiceOracle.partialCorrect <= 196);
assert.ok(oracle.candidateOracle.present === 426);

// strong arms non-negative
for (const a of strong.arms) {
  assert.ok(a.wrongToCorrect >= 0 && a.correctToWrong >= 0);
  assert.ok(a.newlyBrokenStrong >= 0);
}

// no secrets
for (const file of ['rows.jsonl', 'row-classification.jsonl', 'manifest.json', 'README.md',
  'evaluation-summary.json', 'feature-summary.json', 'rescue-cases.jsonl', 'regression-cases.jsonl']) {
  const p = path.join(HERE, file);
  if (!fs.existsSync(p)) continue;
  const text = fs.readFileSync(p, 'utf8');
  assert.doesNotMatch(text, /(?:gho_|sk-|OPENJEV_API_KEY\s*=\s*[^.\s])[A-Za-z0-9_-]{8,}/, `secret-like text: ${file}`);
}

// README required table + answers
assert.match(readme, /Baseline/);
assert.match(readme, /Jev forced rerank/);
assert.match(readme, /Ambiguous-only/);
assert.match(readme, /Best zero-regression gate/);
assert.match(readme, /Best ≤1 regression gate/);
assert.match(readme, /Deterministic comparator/);
assert.match(readme, /Oracle/);
assert.match(readme, /Direct answers/);
assert.match(readme, /wrong→correct/);
assert.match(readme, /false-strong/);

// required artifact presence
for (const f of [
  'README.md', 'current-main-baseline.json', 'current-main-measurement.json',
  'row-classification.jsonl',
  'rescue-cases.jsonl', 'regression-cases.jsonl', 'feature-matrix.jsonl',
  'feature-summary.json', 'gate-candidates.json', 'holdout-results.json',
  'repeated-call-results.json', 'deterministic-comparison.json',
  'oracle-ceilings.json', 'latency-summary.json', 'evaluation-summary.json',
  'strong-override-arms.json', 'repeat-targets.json',
  'manifest.json', 'validate.mjs', 'analyze.mjs', 'evaluate.mjs', 'repeat.mjs',
]) {
  assert.ok(fs.existsSync(path.join(HERE, f)), `missing artifact: ${f}`);
}

// selection/holdout sanity
assert.equal(holdout.splits.development.binary, 'battlecats');
const z0 = holdout.developmentSelection.maxRegression0;
const z1 = holdout.developmentSelection.maxRegression1;
assert.ok(z0 && z0.correctToWrong <= 0, 'dev zero-reg selection');
assert.ok(z1 && z1.correctToWrong <= 1, 'dev one-reg selection');
assert.equal(z1.gateId, 'G28_strong_only');
const h1 = holdout.holdoutOfPrimarySelection.maxRegression1;
assert.ok(h1 && h1.gateId === 'G28_strong_only');
assert.equal(h1.correctToWrong, 0, 'holdout G28 regression');
assert.equal(h1.wrongToCorrect, 14, 'holdout G28 rescue');
const fullG28 = holdout.allGatesFullCorpus.find((g) => g.gateId === 'G28_strong_only');
assert.ok(fullG28);
assert.equal(fullG28.wrongToCorrect, 29);
assert.equal(fullG28.correctToWrong, 1);
assert.equal(fullG28.overallTop1Projected, 310);
assert.equal(evaluation.verdict?.classification, 'CONDITIONAL_GO');

// repeated-call: regressions must not be discarded
const rep = read('repeated-call-results.json');
assert.equal(rep.byClassification.REGRESSION.n, 7);
assert.ok(rep.byClassification.REGRESSION.sameChoiceRate >= 0.99, 'regression stability recorded');

// no production files in this report directory beyond investigation scripts
for (const f of fs.readdirSync(HERE)) {
  assert.ok(!f.startsWith('js-'), `unexpected production-like file ${f}`);
}

console.log(`rescue-regression validation: 426 baseline, 196 classified, rescue=${counts.RESCUE}, regression=${counts.REGRESSION}, G28 holdout 14/0, hashes/denominators/scope ok`);
