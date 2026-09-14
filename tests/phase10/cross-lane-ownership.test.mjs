import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  phase10CrossLaneIntegration,
  phase10OwnershipViolation,
} from '../../tools/validation/phase10/ownership-check.mjs';

const manifest = {
  allowedExact: ['exact.js'],
  allowedPrefixes: ['owned/'],
  forbiddenPrefixes: ['forbidden/'],
};

assert.equal(phase10CrossLaneIntegration(null), false);
assert.equal(phase10CrossLaneIntegration({ pull_request: { labels: [] } }), false);
assert.equal(phase10CrossLaneIntegration({
  pull_request: { labels: [{ name: 'cross-lane-integration' }] },
}), true);
assert.equal(phase10CrossLaneIntegration({
  pull_request: { labels: [{ name: 'integration' }] },
}), false);

assert.equal(phase10OwnershipViolation('owned/file.js', manifest), null);
assert.equal(phase10OwnershipViolation('exact.js', manifest), null);
assert.equal(phase10OwnershipViolation('other/file.js', manifest), 'unowned:other/file.js');
assert.equal(phase10OwnershipViolation('other/file.js', manifest, { allowUnowned: true }), null);
assert.equal(
  phase10OwnershipViolation('forbidden/file.js', manifest, { allowUnowned: true }),
  'forbidden:forbidden/file.js',
);

const repositoryManifest = JSON.parse(fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/validation/phase10/ownership.json'),
  'utf8',
));
assert.equal(phase10OwnershipViolation('js/patch.js', repositoryManifest), null, 'the patch assembler must use an exact Phase 10 foreign-path route');
assert.equal(phase10OwnershipViolation('tests/phase10/issue-5724-dynamic-machine-integer-boundary.mjs', repositoryManifest), null, 'moved regressions must remain Phase 10-owned');
assert.equal(phase10OwnershipViolation('tests/issue-5724-dynamic-machine-integer-boundary.mjs', repositoryManifest), 'unowned:tests/issue-5724-dynamic-machine-integer-boundary.mjs', 'the old root test location must not widen ownership');

console.log('phase10 cross-lane ownership opt-in: PASS');
