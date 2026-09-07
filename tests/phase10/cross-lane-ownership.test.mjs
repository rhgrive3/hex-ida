import assert from 'node:assert/strict';
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

console.log('phase10 cross-lane ownership opt-in: PASS');
