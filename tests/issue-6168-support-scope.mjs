/**
 * #6168 regression: supporting/contradicting evidence must be applicable to
 * the claim's scope. Previously existence alone promoted unrelated evidence
 * to supported/contradicted verdicts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceGraph } from '../js/core/evidence/index.js';

test('#6168 unrelated support does not promote', () => {
  const graph = new EvidenceGraph({
    nodes: [
      {
        id: 'evidence-for-A',
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
        supportingEvidenceIds: ['evidence-for-A'],
        completeness: 'complete',
        verdict: 'unknown',
      },
    ],
  });
  assert.notEqual(graph.evaluateClaim('claim-for-B').verdict, 'supported');
});

test('#6168 unrelated contradiction does not demote', () => {
  const graph = new EvidenceGraph({
    nodes: [
      {
        id: 'evidence-for-A',
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
        contradictingEvidenceIds: ['evidence-for-A'],
        completeness: 'complete',
        verdict: 'unknown',
      },
    ],
  });
  assert.notEqual(graph.evaluateClaim('claim-for-B').verdict, 'contradicted');
});

test('#6168 same-target support still applies', () => {
  const graph = new EvidenceGraph({
    nodes: [
      {
        id: 'ev',
        family: 'SemanticEvidence',
        targetEntityIds: ['entity-B'],
        semanticKind: 'identity-proof',
        completeness: 'complete',
        deterministic: false,
      },
      {
        id: 'claim',
        family: 'Claim',
        targetEntityIds: ['entity-B'],
        semanticKind: 'identity',
        supportingEvidenceIds: ['ev'],
        completeness: 'complete',
        verdict: 'unknown',
      },
    ],
  });
  assert.equal(graph.evaluateClaim('claim').verdict, 'supported');
});

test('#6168 same-target contradiction still applies', () => {
  const graph = new EvidenceGraph({
    nodes: [
      {
        id: 'ev',
        family: 'SemanticEvidence',
        targetEntityIds: ['entity-B'],
        semanticKind: 'counter',
        completeness: 'complete',
        deterministic: false,
      },
      {
        id: 'claim',
        family: 'Claim',
        targetEntityIds: ['entity-B'],
        semanticKind: 'identity',
        contradictingEvidenceIds: ['ev'],
        completeness: 'complete',
        verdict: 'unknown',
      },
    ],
  });
  assert.equal(graph.evaluateClaim('claim').verdict, 'contradicted');
});

test('#6168 binary mismatch is rejected for support', () => {
  const graph = new EvidenceGraph({
    nodes: [
      {
        id: 'ev',
        family: 'SemanticEvidence',
        binaryId: 'bin-A',
        targetEntityIds: ['entity-X'],
        semanticKind: 'identity-proof',
        completeness: 'complete',
        deterministic: true,
      },
      {
        id: 'claim',
        family: 'Claim',
        binaryId: 'bin-B',
        targetEntityIds: ['entity-X'],
        semanticKind: 'identity',
        supportingEvidenceIds: ['ev'],
        completeness: 'complete',
        verdict: 'unknown',
      },
    ],
  });
  assert.notEqual(graph.evaluateClaim('claim').verdict, 'supported');
});

test('#6168 supports edge uses the same policy', () => {
  const graph = new EvidenceGraph({
    nodes: [
      {
        id: 'evidence-for-A',
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
    edges: [{ type: 'supports', from: 'claim-for-B', to: 'evidence-for-A' }],
  });
  assert.notEqual(graph.evaluateClaim('claim-for-B').verdict, 'supported');
});

test('#6168 contradicts edge uses the same policy', () => {
  const graph = new EvidenceGraph({
    nodes: [
      {
        id: 'evidence-for-A',
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
    edges: [{ type: 'contradicts', from: 'claim-for-B', to: 'evidence-for-A' }],
  });
  assert.notEqual(graph.evaluateClaim('claim-for-B').verdict, 'contradicted');
});

test('#6168 unrelated contradiction does not override valid confirmation', () => {
  const graph = new EvidenceGraph({
    nodes: [
      {
        id: 'proof-for-B',
        family: 'SemanticEvidence',
        targetEntityIds: ['entity-B'],
        semanticKind: 'identity-proof',
        completeness: 'complete',
        deterministic: true,
      },
      {
        id: 'noise-for-A',
        family: 'SemanticEvidence',
        targetEntityIds: ['entity-A'],
        semanticKind: 'noise',
        completeness: 'complete',
        deterministic: false,
      },
      {
        id: 'claim',
        family: 'Claim',
        targetEntityIds: ['entity-B'],
        semanticKind: 'identity',
        confirmedByEvidenceIds: ['proof-for-B'],
        contradictingEvidenceIds: ['noise-for-A'],
        completeness: 'complete',
        verdict: 'unknown',
      },
    ],
  });
  assert.equal(graph.evaluateClaim('claim').verdict, 'confirmed');
});

test('#6168 missing references stay unresolved', () => {
  const graph = new EvidenceGraph({
    nodes: [
      {
        id: 'claim',
        family: 'Claim',
        targetEntityIds: ['entity-C'],
        semanticKind: 'identity',
        supportingEvidenceIds: ['missing-support'],
        completeness: 'partial',
        verdict: 'supported',
      },
    ],
  });
  const result = graph.evaluateClaim('claim');
  assert.equal(result.verdict, 'unverified');
  assert.deepEqual(result.missingEvidenceIds, ['missing-support']);
});
