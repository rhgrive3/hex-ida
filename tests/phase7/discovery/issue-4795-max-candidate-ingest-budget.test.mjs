import assert from 'node:assert/strict';
import test from 'node:test';

import { fuseFunctionCandidates } from '../../../js/analysis/discovery/fusion.js';

function evidence(start, producerId = 'p', overrides = {}) {
  return {
    kind: 'direct-call-target',
    authority: 'corroborating',
    producerId,
    extentRole: 'complete',
    start,
    regions: [],
    ...overrides,
  };
}

test('#4795 maxCandidates stops ingestion once overflow is irreversible', () => {
  const bomb = {};
  Object.defineProperty(bomb, 'kind', {
    enumerable: true,
    get() {
      throw new Error('evidence beyond maxCandidates was consumed');
    },
  });

  const result = fuseFunctionCandidates([
    evidence('4096', 'a'),
    evidence('8192', 'b'),
    bomb,
  ], {
    snapshotId: 'issue-4795',
    budget: { maxCandidates: 1, maxEvidencePerCandidate: 1 },
  });

  assert.deepEqual(result.candidates, []);
  assert.equal(result.status.completeness, 'truncated');
  assert.equal(result.status.stopReason, 'budget-exhausted');
});

test('#4795 duplicate starts do not consume the candidate budget', () => {
  const result = fuseFunctionCandidates([
    evidence('4096', 'b'),
    evidence('4096', 'a'),
    evidence('4096', 'c'),
  ], {
    snapshotId: 'issue-4795-duplicates',
    budget: { maxCandidates: 1, maxEvidencePerCandidate: 4 },
  });

  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].startEvidence.map((item) => item.producerId), ['a', 'b', 'c']);
});

test('#4795 exactly maxCandidates distinct starts remains complete', () => {
  const result = fuseFunctionCandidates([
    evidence('8192', 'b'),
    evidence('4096', 'a'),
  ], {
    snapshotId: 'issue-4795-exact-limit',
    budget: { maxCandidates: 2, maxEvidencePerCandidate: 2 },
  });

  assert.equal(result.status.completeness, 'complete');
  assert.deepEqual(result.candidates.map((candidate) => candidate.start), ['4096', '8192']);
});

test('#4795 maxEvidencePerCandidate keeps deterministic highest-ranked evidence', () => {
  const rows = [
    evidence('4096', 'z', { kind: 'prologue-candidate', authority: 'heuristic', evidenceIds: ['ev-z'] }),
    evidence('4096', 'b', { kind: 'debug-symbol', authority: 'corroborating', evidenceIds: ['ev-b'] }),
    evidence('4096', 'a', { kind: 'loader-function-start', authority: 'authoritative', evidenceIds: ['ev-a'] }),
  ];
  const options = {
    snapshotId: 'issue-4795-top-k',
    budget: { maxCandidates: 1, maxEvidencePerCandidate: 2 },
  };

  const forward = fuseFunctionCandidates(rows, options);
  const reverse = fuseFunctionCandidates([...rows].reverse(), options);
  assert.deepEqual(forward, reverse);
  assert.equal(forward.status.completeness, 'truncated');
  assert.deepEqual(
    forward.candidates[0].startEvidence.map((item) => item.evidenceIds[0]),
    ['ev-a', 'ev-b'],
  );
});
