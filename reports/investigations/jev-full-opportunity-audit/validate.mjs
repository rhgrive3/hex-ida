#!/usr/bin/env node
// Fail-closed integrity and denominator checks for the committed audit.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => JSON.parse(fs.readFileSync(path.join(HERE, name), 'utf8'));
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest = read('manifest.json');
for (const [name, digest] of Object.entries(manifest.artifactHashes)) {
  assert.equal(sha(path.join(HERE, name)), digest, `hash: ${name}`);
}
const rows = fs.readFileSync(path.join(HERE, 'rows.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const taxonomy = read('failure-taxonomy.json');
const evaluation = read('evaluation-summary.json');
const latency = read('latency-summary.json');
const matrix = read('use-case-matrix.json');
const oracle = read('oracle-ceilings.json');
const broader = read('broader-scheduler-summary.json');
assert.equal(rows.length, 426);
assert.equal(new Set(rows.map((r) => r.id)).size, 426);
assert.equal(rows.filter((r) => r.candidatePresent).length, 426);
assert.equal(rows.filter((r) => r.mode === 'exact').length, 230);
assert.equal(rows.filter((r) => r.mode === 'partial').length, 196);
assert.equal(rows.filter((r) => r.baselineCorrect).length, 282);
assert.equal(rows.filter((r) => !r.baselineCorrect).length, 144);
for (const row of rows) {
  assert.equal(row.candidates.filter((c) => c.truth).length, 1, `truth unique: ${row.id}`);
  assert.equal(row.candidates[row.truthRank - 1]?.truth, true, `truth rank: ${row.id}`);
  assert.equal(row.baselineCorrect, row.truthRank === 1, `baseline rank: ${row.id}`);
  if (row.mode === 'exact') assert.equal(Object.values(row.jev).filter(Boolean).length, 0, `exact untouched: ${row.id}`);
  else for (const arm of ['label', 'class', 'evidence']) {
    const x = row.jev[arm];
    assert.ok(x && !x.error, `live result: ${row.id}/${arm}`);
    assert.ok(Number.isInteger(x.choiceIndex) && x.choiceIndex >= 0 && x.choiceIndex < row.candidates.length);
    assert.equal(x.correct, !!row.candidates[x.choiceIndex].truth);
  }
}
assert.equal(taxonomy.rows.length, 426);
assert.equal(Object.values(taxonomy.primaryCounts).reduce((a, b) => a + b, 0), 426);
assert.equal(evaluation.jevForcedPreference.label.allPartial.wrongToCorrect, 46);
assert.equal(evaluation.jevForcedPreference.label.allPartial.correctToWrong, 7);
assert.equal(evaluation.deterministic.partial.wrongToCorrect, 103);
assert.equal(evaluation.deterministic.partial.correctToWrong, 4);
assert.equal(evaluation.failClosedGate.label.triggered, 0);
assert.equal(latency.observedCalls, 588);
assert.equal(oracle.currentProbeCatalog.deterministicVsBudgetOracleResolvedGap, 0);
assert.equal(broader.focusedCount, 105);
assert.equal(broader.eligibleWrongBaseline, 76);
assert.equal(broader.heuristic.resolved, 2);
assert.equal(broader.budgetOracle.resolved, 2);
assert.equal(broader.unboundedOracle.resolved, 2);
assert.equal(broader.gap.budgetOracleResolvedMinusHeuristicResolved, 0);
assert.equal(broader.gap.unboundedOracleResolvedMinusHeuristicResolved, 0);
assert.equal(matrix.uses.length, 10);
assert.ok(matrix.uses.every((u) => ['GO', 'CONDITIONAL_GO', 'RESEARCH_ONLY', 'NO_GO'].includes(u.classification)));
for (const file of ['rows.jsonl', 'failure-taxonomy.json', 'use-case-matrix.json',
  'evaluation-summary.json', 'oracle-ceilings.json', 'latency-summary.json', 'manifest.json']) {
  const text = fs.readFileSync(path.join(HERE, file), 'utf8');
  assert.doesNotMatch(text, /(?:gho_|sk-|OPENJEV_API_KEY\s*=)[A-Za-z0-9_-]{8,}/, `secret-like text: ${file}`);
}
console.log('audit validation: 426 rows, 588 live calls, denominators/hashes/scope consistent');
