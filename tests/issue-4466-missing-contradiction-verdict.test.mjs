import assert from 'node:assert/strict';
import test from 'node:test';
import { createClaimNode, EvidenceGraph } from '../js/core/evidence/index.js';

function claim(overrides = {}) {
  return createClaimNode({
    id: 'claim-4466',
    targetEntityIds: ['entity-4466'],
    semanticKind: 'identity',
    completeness: 'complete',
    verdict: 'unknown',
    ...overrides,
  });
}

function contradiction(id = 'known-counterexample') {
  return {
    id,
    family: 'DataflowEvidence',
    targetEntityIds: ['entity-4466'],
    semanticKind: 'counterexample',
    completeness: 'complete',
    deterministic: false,
  };
}

test('#4466 missing contradiction references do not prove a negative verdict', () => {
  const graph = new EvidenceGraph({
    nodes: [claim({ contradictingEvidenceIds: ['missing-counterexample'] })],
  });
  const result = graph.evaluateClaim('claim-4466');
  assert.notEqual(result.verdict, 'contradicted');
  assert.deepEqual(result.missingEvidenceIds, ['missing-counterexample']);
});

test('#4466 a known applicable contradiction still wins', () => {
  const graph = new EvidenceGraph({
    nodes: [contradiction(), claim({ contradictingEvidenceIds: ['known-counterexample'] })],
  });
  assert.equal(graph.evaluateClaim('claim-4466').verdict, 'contradicted');
});

test('#4466 mixed known and missing contradictions retain both authorities', () => {
  const graph = new EvidenceGraph({
    nodes: [
      contradiction(),
      claim({ contradictingEvidenceIds: ['known-counterexample', 'missing-counterexample'] }),
    ],
  });
  const result = graph.evaluateClaim('claim-4466');
  assert.equal(result.verdict, 'contradicted');
  assert.deepEqual(result.missingEvidenceIds, ['missing-counterexample']);
});

test('#4466 stale manual contradicted status is not restored without evidence', () => {
  const graph = new EvidenceGraph({
    nodes: [claim({ verdict: 'contradicted' })],
  });
  assert.notEqual(graph.evaluateClaim('claim-4466').verdict, 'contradicted');
});

console.log('issue #4466 missing contradiction verdict: PASS');
