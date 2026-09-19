import test from 'node:test';
import assert from 'node:assert/strict';

import { commitFunctionTopologyRefinement } from '../../../js/analysis/discovery/topology-refinement-transaction.js';

function proposal() {
  return {
    producer: { id: 'noreturn-continuation', version: '1.0.0' },
    binding: {
      binaryId: 'synthetic:atomicity',
      analysisEpoch: 1,
      discoveryKey: 'discovery:atomicity',
      functionTopologyRevision: 0,
      startSetDigest: 'starts',
      programEvidenceDigest: 'evidence',
    },
    status: { completeness: 'complete' },
    candidates: [
      { start: 0x1014n, callSite: 0x1010n },
      { start: 0x1024n, callSite: 0x1020n },
    ],
  };
}

test('mixed valid and invalid candidates fail closed without mutation or wave completion', () => {
  let applied = 0;
  let invalidated = 0;
  const waveKeys = new Set();
  const symbols = {
    functionTopologyRevision: 7,
    applyFunctionTopologyRefinement(candidates) {
      applied += 1;
      return { added: candidates.length, revision: 8 };
    },
  };
  const wave = {
    has(key) { return waveKeys.has(key); },
    mark(key) { waveKeys.add(key); },
  };

  const result = commitFunctionTopologyRefinement({
    proposal: proposal(),
    symbols,
    bindingIsCurrent: () => true,
    wave,
    validateCandidate: (candidate) => candidate.start === 0x1014n,
    invalidate: () => { invalidated += 1; },
  });

  assert.equal(result.status, 'stale');
  assert.equal(result.added, 0);
  assert.equal(applied, 0);
  assert.equal(invalidated, 0);
  assert.equal(symbols.functionTopologyRevision, 7);
  assert.equal(waveKeys.size, 0);
});
