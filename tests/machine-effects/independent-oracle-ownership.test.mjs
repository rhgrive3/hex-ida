import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { changedFilesWithinAllowlist } from '../../tools/validation/machine-effects/oracle-release-verify.mjs';
import { INDEPENDENT_ORACLE_IDENTITY, PRODUCTION_SUBJECT_IDENTITY } from '../../tools/validation/machine-effects/oracle-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const owned = [
  'tools/validation/machine-effects/oracle-policy.mjs',
  'tools/validation/machine-effects/oracle-schema.mjs',
  'tools/validation/machine-effects/oracle-corpus.mjs',
  'tools/validation/machine-effects/oracle-runner.mjs',
  'tools/validation/machine-effects/oracle-report.mjs',
  'tools/validation/machine-effects/oracle-release-verify.mjs',
  'tests/machine-effects/independent-oracle-counterexample.test.mjs',
  'tests/machine-effects/independent-oracle-negative.test.mjs',
  'tests/machine-effects/independent-oracle-determinism.test.mjs',
  'tests/machine-effects/independent-oracle-report.test.mjs',
  'tests/machine-effects/independent-oracle-denominator-preservation.test.mjs',
];
const forbidden = [
  'tests/machine-effects/a2-denominator-inventory.json',
  'tools/validation/machine-effects/generated/formal-evidence-artifacts.json',
  'specs/001-loaded-pointer-recovery/',
  '.github/workflows/',
  'js/decompiler/phase8/sccp.js',
  'js/symbolic/executor.js',
  'userscript/hex.user.template.js',
  'userscript/release-version.json',
  'reports/',
];
const phase1AllowedPrefixes = [
  'tools/validation/machine-effects/',
  'tests/machine-effects/',
];

assert.equal(changedFilesWithinAllowlist(owned, phase1AllowedPrefixes).valid, true);
assert.equal(changedFilesWithinAllowlist([...owned, forbidden[0]], phase1AllowedPrefixes).valid, false);
assert.equal(changedFilesWithinAllowlist([...owned, forbidden[1]], phase1AllowedPrefixes).valid, false,
  'component ownership rejects the integration-owned generated evidence artifact');
assert.equal(changedFilesWithinAllowlist([...owned, 'tools/validation/machine-effects/generated/other.json'], phase1AllowedPrefixes).valid, false,
  'component ownership rejects every generated evidence artifact, not only one filename');
const alternatePaths = [
  'tools/validation/machine-effects/../../outside.mjs',
  'tests/machine-effects/../outside.mjs',
  '/tools/validation/machine-effects/oracle-policy.mjs',
  'C:/tools/validation/machine-effects/oracle-policy.mjs',
  'tools\\validation\\machine-effects\\oracle-policy.mjs',
  'tools/validation//machine-effects/oracle-policy.mjs',
  'tools/validation/./machine-effects/oracle-policy.mjs',
  'tools/validation/machine-effects/',
  '',
  'tools/validation/machine-effects/oracle-policy.mjs\0suffix',
];
for (const alternatePath of alternatePaths) {
  const result = changedFilesWithinAllowlist([alternatePath], phase1AllowedPrefixes);
  assert.equal(result.valid, false, JSON.stringify(alternatePath));
  assert.deepEqual(result.violations, [alternatePath], JSON.stringify(alternatePath));
}
let coercions = 0;
const nonStringPath = { toString() { coercions += 1; return owned[0]; } };
assert.equal(changedFilesWithinAllowlist([nonStringPath], phase1AllowedPrefixes).valid, false);
assert.equal(coercions, 0, 'path validation must not coerce untrusted entries');
assert.equal(changedFilesWithinAllowlist([...owned, 'js/semantics/effects/index.js']).valid, false,
  'oracle-only ownership rejects the canonical production semantics contract');
assert.equal(changedFilesWithinAllowlist([...owned, ...forbidden]).valid, false,
  'ME-01 release scope must reject governance, decompiler, symbolic, userscript, denominator, and report output');
assert.ok(owned.every((file) => file.startsWith('tools/validation/machine-effects/') || file.startsWith('tests/machine-effects/')));
assert.ok(forbidden.every((file) => !owned.includes(file)));
assert.notEqual(INDEPENDENT_ORACLE_IDENTITY, PRODUCTION_SUBJECT_IDENTITY);

const runnerSource = fs.readFileSync(path.join(root, 'tools/validation/machine-effects/oracle-runner.mjs'), 'utf8');
const policySource = fs.readFileSync(path.join(root, 'tools/validation/machine-effects/oracle-policy.mjs'), 'utf8');
const evidenceSource = fs.readFileSync(path.join(root, 'tools/validation/machine-effects/oracle-evidence-v2.mjs'), 'utf8');
assert.doesNotMatch(runnerSource, /from ['"](?:\.\.\/)+js\/semantics\/effects/);
assert.doesNotMatch(runnerSource, /Array\.from\(\{\s*length|new Array\(length/,
  'untrusted array length must not drive allocation');
assert.doesNotMatch(policySource, /from ['"](?:\.\.\/)+js\/semantics\/effects/);
assert.doesNotMatch(evidenceSource, /from ['"](?:\.\.\/)+js\/semantics\/effects/);

console.log('machine-effects independent oracle ownership: PASS');
