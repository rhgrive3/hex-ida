/**
 * #6154 regression: deterministic evidence for another entity must not
 * confirm an unrelated Claim. canConfirmClaim() previously ignored the claim
 * scope entirely.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceGraph, canConfirmClaim } from '../js/core/evidence/index.js';

test('#6154 unrelated entity evidence does not confirm', () => {
  const graph = new EvidenceGraph({
    nodes: [
      {
        id: 'proof-for-A',
        family: 'SemanticEvidence',
        targetEntityIds: ['entity-A'],
        semanticKind: 'identity-proof',
        completeness: 'complete',
        deterministic: true,
      },
      {
        id: 'claim-for-B',
        family: 'Claim',
        targetEntityIds: ['entity-B'],
        semanticKind: 'identity',
        confirmedByEvidenceIds: ['proof-for-A'],
        completeness: 'complete',
        verdict: 'unknown',
      },
    ],
  });
  assert.notEqual(graph.evaluateClaim('claim-for-B').verdict, 'confirmed');
});

test('#6154 mismatched binaryId does not confirm', () => {
  const graph = new EvidenceGraph({
    nodes: [
      {
        id: 'proof-a',
        family: 'SemanticEvidence',
        binaryId: 'bin-A',
        targetEntityIds: ['entity-X'],
        semanticKind: 'identity-proof',
        completeness: 'complete',
        deterministic: true,
      },
      {
        id: 'claim-b',
        family: 'Claim',
        binaryId: 'bin-B',
        targetEntityIds: ['entity-X'],
        semanticKind: 'identity',
        confirmedByEvidenceIds: ['proof-a'],
        completeness: 'complete',
        verdict: 'unknown',
      },
    ],
  });
  assert.notEqual(graph.evaluateClaim('claim-b').verdict, 'confirmed');
});

test('#6154 same target still confirms', () => {
  const graph = new EvidenceGraph({
    nodes: [
      {
        id: 'proof',
        family: 'SemanticEvidence',
        targetEntityIds: ['entity-A'],
        semanticKind: 'identity-proof',
        completeness: 'complete',
        deterministic: true,
      },
      {
        id: 'claim',
        family: 'Claim',
        targetEntityIds: ['entity-A'],
        semanticKind: 'identity',
        confirmedByEvidenceIds: ['proof'],
        completeness: 'complete',
        verdict: 'unknown',
      },
    ],
  });
  assert.equal(graph.evaluateClaim('claim').verdict, 'confirmed');
});

test('#6154 generic evidence without targets still confirms (existing contract)', () => {
  const graph = new EvidenceGraph({
    nodes: [
      {
        id: 'ev-complete',
        family: 'SemanticEvidence',
        semanticKind: 'test',
        completeness: 'complete',
        deterministic: true,
      },
      {
        id: 'claim-comp',
        family: 'Claim',
        targetEntityIds: ['f'],
        semanticKind: 'p',
        confirmedByEvidenceIds: ['ev-complete'],
        completeness: 'complete',
        verdict: 'unknown',
      },
    ],
  });
  assert.equal(graph.evaluateClaim('claim-comp').verdict, 'confirmed');
});

test('#6154 #1178 completeness gates preserved', () => {
  for (const completeness of ['unsupported', 'truncated', 'partial']) {
    const graph = new EvidenceGraph({
      nodes: [
        {
          id: 'ev',
          family: 'SemanticEvidence',
          targetEntityIds: ['f'],
          semanticKind: 'test',
          completeness,
          deterministic: true,
        },
        {
          id: 'claim',
          family: 'Claim',
          targetEntityIds: ['f'],
          semanticKind: 'p',
          confirmedByEvidenceIds: ['ev'],
          completeness: 'complete',
          verdict: 'unknown',
        },
      ],
    });
    assert.equal(graph.evaluateClaim('claim').verdict, 'unverified');
  }
});

test('#6154 verified-by edge uses the same scope policy', () => {
  const graph = new EvidenceGraph({
    nodes: [
      {
        id: 'proof-for-A',
        family: 'SemanticEvidence',
        targetEntityIds: ['entity-A'],
        semanticKind: 'identity-proof',
        completeness: 'complete',
        deterministic: true,
      },
      {
        id: 'claim-for-B',
        family: 'Claim',
        targetEntityIds: ['entity-B'],
        semanticKind: 'identity',
        completeness: 'complete',
        verdict: 'unknown',
      },
    ],
    edges: [{ type: 'verified-by', from: 'claim-for-B', to: 'proof-for-A' }],
  });
  assert.notEqual(graph.evaluateClaim('claim-for-B').verdict, 'confirmed');
});

test('#6154 canConfirmClaim directly enforces scope', () => {
  const evidence = {
    deterministic: true,
    completeness: 'complete',
    targetEntityIds: ['entity-A'],
    binaryId: null,
  };
  const claim = { targetEntityIds: ['entity-B'], binaryId: null };
  assert.equal(canConfirmClaim(evidence, claim), false);
  assert.equal(
    canConfirmClaim({ ...evidence, targetEntityIds: ['entity-B'] }, claim),
    true,
  );
});
