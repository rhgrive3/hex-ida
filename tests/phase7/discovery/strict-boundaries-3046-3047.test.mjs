import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDiscoveryEvidence,
  createFunctionCandidate,
  createRegion,
} from '../../../js/analysis/discovery/candidates.js';

test('discovery canonical addresses reject structured ToPrimitive coercion', () => {
  for (const bad of [
    ['16'],
    { valueOf: () => 16 },
    true,
    false,
    new Number(16),
  ]) {
    assert.throws(() => createFunctionCandidate({ start: bad }), /discovery-candidate-invalid-start/);
    assert.throws(() => createDiscoveryEvidence({ kind: 'export', start: bad }), /discovery-evidence-invalid-start/);
    assert.throws(() => createRegion({ start: bad, end: 32n }), /discovery-region-invalid-start/);
    assert.throws(() => createRegion({ start: 16n, end: bad }), /discovery-region-invalid-end/);
  }

  assert.equal(createFunctionCandidate({ start: 16n }).start, '16');
  assert.equal(createFunctionCandidate({ start: 16 }).start, '16');
  assert.equal(createFunctionCandidate({ start: '0x10' }).start, '16');
});

test('proof-bearing discovery tokens are string-only while nullish defaults remain intact', () => {
  assert.throws(
    () => createDiscoveryEvidence({ kind: ['loader-function-start'], start: 16n }),
    /discovery-evidence-unknown-kind/,
  );
  assert.throws(
    () => createDiscoveryEvidence({ kind: 'export', start: 16n, extentRole: ['complete'] }),
    /discovery-evidence-invalid-extent-role/,
  );
  assert.throws(
    () => createRegion({ start: 16n, end: 32n, ownership: ['exclusive'] }),
    /discovery-region-invalid-ownership/,
  );
  assert.throws(
    () => createFunctionCandidate({ start: 16n, startState: ['exact'] }),
    /discovery-candidate-invalid-start-state/,
  );
  assert.throws(
    () => createFunctionCandidate({ start: 16n, extentState: ['exact'] }),
    /discovery-candidate-invalid-extent-state/,
  );

  assert.equal(createDiscoveryEvidence({ kind: 'export', start: 16n }).extentRole, 'complete');
  assert.equal(createRegion({ start: 16n, end: 32n }).ownership, 'exclusive');
  const candidate = createFunctionCandidate({ start: 16n });
  assert.equal(candidate.startState, 'heuristic');
  assert.equal(candidate.extentState, 'unknown');
});
