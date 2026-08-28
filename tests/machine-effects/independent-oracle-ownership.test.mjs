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
  'js/semantics/effects/index.js',
  'tests/machine-effects/a2-denominator-inventory.json',
  'specs/001-loaded-pointer-recovery/',
  '.github/workflows/',
  'reports/',
];

assert.equal(changedFilesWithinAllowlist(owned).valid, true);
assert.equal(changedFilesWithinAllowlist([...owned, forbidden[0]]).valid, false);
assert.ok(owned.every((file) => file.startsWith('tools/validation/machine-effects/') || file.startsWith('tests/machine-effects/')));
assert.ok(forbidden.every((file) => !owned.includes(file)));
assert.notEqual(INDEPENDENT_ORACLE_IDENTITY, PRODUCTION_SUBJECT_IDENTITY);

const runnerSource = fs.readFileSync(path.join(root, 'tools/validation/machine-effects/oracle-runner.mjs'), 'utf8');
const policySource = fs.readFileSync(path.join(root, 'tools/validation/machine-effects/oracle-policy.mjs'), 'utf8');
assert.doesNotMatch(runnerSource, /from ['"](?:\.\.\/)+js\/semantics\/effects/);
assert.doesNotMatch(policySource, /from ['"](?:\.\.\/)+js\/semantics\/effects/);

console.log('machine-effects independent oracle ownership: PASS');
