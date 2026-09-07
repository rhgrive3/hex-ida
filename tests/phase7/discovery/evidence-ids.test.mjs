import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryEvidence } from '../../../js/analysis/discovery/candidates.js';

function evidence(evidenceIds) {
  return createDiscoveryEvidence({
    kind: 'export',
    start: 0x1000,
    producerId: 'test',
    evidenceIds,
  });
}

test('discovery evidence IDs preserve canonical string dedupe and ordering', () => {
  assert.deepEqual(evidence(['z', 'a', 'z']).evidenceIds, ['a', 'z']);
});

test('discovery evidence IDs reject non-canonical values', () => {
  for (const invalid of [
    [{ source: 'A' }],
    [0],
    [false],
    [null],
    [''],
  ]) {
    assert.throws(
      () => evidence(invalid),
      /discovery-evidence-invalid-evidence-id/,
      `expected rejection for ${JSON.stringify(invalid)}`,
    );
  }
  assert.throws(
    () => createDiscoveryEvidence({ kind: 'export', start: 0x1000, producerId: 'test', evidenceIds: 'id' }),
    /discovery-evidence-invalid-evidence-id/,
  );
});
