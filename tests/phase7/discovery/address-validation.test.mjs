import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDiscoveryEvidence,
  createFunctionCandidate,
  createRegion,
} from '../../../js/analysis/discovery/candidates.js';

test('canonical discovery addresses reject negative values', () => {
  assert.throws(() => createFunctionCandidate({ start: -1n }), /discovery-candidate-invalid-start/);
  assert.throws(() => createFunctionCandidate({ start: '-1' }), /discovery-candidate-invalid-start/);
  assert.throws(() => createDiscoveryEvidence({ kind: 'export', start: -1n }), /discovery-evidence-invalid-start/);
  assert.throws(() => createRegion({ start: -2n, end: -1n }), /discovery-region-invalid-start/);
  assert.throws(() => createRegion({ start: 0n, end: -1n }), /discovery-region-invalid-end/);

  assert.equal(createFunctionCandidate({ start: 0n }).start, '0');
  assert.equal(createFunctionCandidate({ start: '0x10' }).start, '16');
  assert.deepEqual(createRegion({ start: '0x10', end: '32' }), {
    start: '16', end: '32', ownership: 'exclusive',
  });
  assert.throws(() => createRegion({ start: 1n, end: 1n }), /discovery-region-empty/);
});
