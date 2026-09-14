import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryEvidence } from '../../../js/analysis/discovery/candidates.js';
import { fuseFunctionCandidates } from '../../../js/analysis/discovery/fusion.js';

test('fusion rejects non-Array evidence containers instead of laundering them to complete-empty', () => {
  const malformed = [
    'not-an-array',
    new Set(),
    {},
    new Uint8Array([1, 2, 3]),
  ];
  for (const evidence of malformed) {
    assert.throws(
      () => fuseFunctionCandidates(evidence, {}),
      /discovery-fusion-evidence-invalid/,
    );
  }
});

test('fusion preserves empty and normal Array evidence semantics', () => {
  const empty = fuseFunctionCandidates([], {});
  assert.deepEqual(empty.candidates, []);
  assert.equal(empty.status.completeness, 'complete');
  assert.equal(empty.status.stopReason, null);

  const evidence = [createDiscoveryEvidence({
    kind: 'loader-function-start',
    start: 0x1000,
    producerId: 'loader',
  })];
  const normal = fuseFunctionCandidates(evidence, {});
  assert.equal(normal.status.completeness, 'complete');
  assert.equal(normal.candidates.length, 1);
  assert.equal(normal.candidates[0].start, '4096');
  assert.equal(normal.candidates[0].startState, 'exact');
});
