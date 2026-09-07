// Regression for #6154: EvidenceGraph.canConfirmClaim() ignored the claim
// argument entirely, so a complete deterministic proof bound to entity-A
// could confirm a claim bound to entity-B (or another binary) just by being
// listed in its confirmedByEvidenceIds. Confirmation is now target-scoped:
// a proof with explicit entity targets must intersect the claim's targets,
// and a binary-bound proof cannot confirm a claim from another binary.
import assert from 'node:assert/strict';
import { EvidenceGraph } from '../js/core/evidence/index.js';

function graph(nodes) {
  return new EvidenceGraph(nodes);
}

{
  // The issue's example: entity-A proof listed on an entity-B claim.
  const g = graph({
    nodes: [
      { id: 'proof-for-A', family: 'SemanticEvidence', targetEntityIds: ['entity-A'], semanticKind: 'identity-proof', completeness: 'complete', deterministic: true },
      { id: 'claim-for-B', family: 'Claim', targetEntityIds: ['entity-B'], semanticKind: 'identity', confirmedByEvidenceIds: ['proof-for-A'], completeness: 'complete', verdict: 'unknown' },
    ],
  });
  const result = g.evaluateClaim('claim-for-B');
  assert.notEqual(result.verdict, 'confirmed', 'a foreign-entity proof must not confirm the claim');
  assert.equal(result.verdict, 'unverified');
}

{
  // Binary mismatch also refuses confirmation.
  const g = graph({
    nodes: [
      { id: 'proof-bin-A', family: 'SemanticEvidence', binaryId: 'bin-A', targetEntityIds: ['entity-B'], semanticKind: 'identity-proof', completeness: 'complete', deterministic: true },
      { id: 'claim-bin-B', family: 'Claim', binaryId: 'bin-B', targetEntityIds: ['entity-B'], semanticKind: 'identity', confirmedByEvidenceIds: ['proof-bin-A'], completeness: 'complete', verdict: 'unknown' },
    ],
  });
  assert.notEqual(g.evaluateClaim('claim-bin-B').verdict, 'confirmed', 'a cross-binary proof must not confirm');
}

{
  // Matching entity targets and matching binaries still confirm.
  const g = graph({
    nodes: [
      { id: 'proof-for-B', family: 'SemanticEvidence', binaryId: 'bin-B', targetEntityIds: ['entity-B', 'entity-C'], semanticKind: 'identity-proof', completeness: 'complete', deterministic: true },
      { id: 'claim-for-B', family: 'Claim', binaryId: 'bin-B', targetEntityIds: ['entity-B'], semanticKind: 'identity', confirmedByEvidenceIds: ['proof-for-B'], completeness: 'complete', verdict: 'unknown' },
    ],
  });
  assert.equal(g.evaluateClaim('claim-for-B').verdict, 'confirmed', 'a target- and binary-matched proof confirms');
}

{
  // An untargeted deterministic proof keeps its historical contract
  // (core evidence lattice, #1178).
  const g = graph({
    nodes: [
      { id: 'proof', family: 'SemanticEvidence', semanticKind: 'deterministic-proof', completeness: 'complete', deterministic: true },
      { id: 'claim', family: 'Claim', targetEntityIds: ['entity-b'], semanticKind: 'identity', confirmedByEvidenceIds: ['proof'], completeness: 'complete', verdict: 'unknown' },
    ],
  });
  assert.equal(g.evaluateClaim('claim').verdict, 'confirmed');
}
