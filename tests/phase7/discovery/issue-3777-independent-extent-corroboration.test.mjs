import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryEvidence } from '../../../js/analysis/discovery/candidates.js';
import { fuseFunctionCandidates } from '../../../js/analysis/discovery/fusion.js';

function extentEvidence(producerId, { kind = 'symbol-table', end = 0x1010 } = {}) {
  return createDiscoveryEvidence({
    kind,
    producerId,
    start: 0x1000,
    extentRole: 'complete',
    regions: [{ start: 0x1000, end, ownership: 'exclusive' }],
  });
}

function fuse(evidence) {
  const result = fuseFunctionCandidates(evidence, {
    architectureId: 'arm64',
    snapshotId: 'snapshot-3777',
  });
  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.candidates.length, 1);
  return result.candidates[0];
}

test('same producer duplicate extent evidence cannot self-corroborate to probable', () => {
  for (const count of [2, 3, 8]) {
    const candidate = fuse(Array.from({ length: count }, () => extentEvidence('p1')));
    assert.equal(candidate.startState, 'heuristic');
    assert.equal(candidate.extentState, 'heuristic');
    assert.deepEqual(candidate.regions, [{ start: '4096', end: '4112', ownership: 'exclusive' }]);
  }
});

test('two independent producers agreeing on one complete extent remain probable', () => {
  const candidate = fuse([
    extentEvidence('p1'),
    extentEvidence('p2'),
  ]);

  assert.equal(candidate.startState, 'probable');
  assert.equal(candidate.extentState, 'probable');
});

test('one authoritative complete extent remains exact', () => {
  const candidate = fuse([
    extentEvidence('loader', { kind: 'loader-function-start' }),
  ]);

  assert.equal(candidate.startState, 'exact');
  assert.equal(candidate.extentState, 'exact');
});

test('independent conflicting complete extents remain unknown instead of voting', () => {
  const candidate = fuse([
    extentEvidence('p1', { end: 0x1010 }),
    extentEvidence('p2', { end: 0x1020 }),
  ]);

  assert.equal(candidate.startState, 'probable');
  assert.equal(candidate.extentState, 'unknown');
  assert.deepEqual(candidate.regions, []);
  assert.ok(candidate.conflicts.some((conflict) => conflict.kind === 'extent'));
});
