// Regression for #6168: EvidenceGraph.evaluateClaim() granted supported /
// contradicted verdict authority on mere node existence. Evidence referenced
// by a claim (via supportingEvidenceIds / contradictingEvidenceIds arrays or
// supports / contradicts edges) must pass the same target-scope applicability
// policy as confirmations (#6154's shared lattice): explicit target binding
// must intersect the claim's targets, and disagreeing binaryId never applies.
import assert from 'node:assert/strict';
import { EvidenceGraph } from '../js/core/evidence/index.js';

const evidence = (overrides = {}) => ({
  id: 'evidence-A',
  family: 'SemanticEvidence',
  targetEntityIds: ['entity-A'],
  binaryId: 'bin-A',
  semanticKind: 'identity-proof',
  completeness: 'complete',
  deterministic: true,
  ...overrides,
});
const claim = (overrides = {}) => ({
  id: 'claim-B',
  family: 'Claim',
  targetEntityIds: ['entity-B'],
  binaryId: 'bin-A',
  semanticKind: 'identity',
  completeness: 'complete',
  verdict: 'unknown',
  ...overrides,
});

function graphOf(nodes, edges = []) {
  return new EvidenceGraph({ nodes, edges });
}

// 1 + 2: entity-A evidence must not give an entity-B claim supported/contradicted.
{
  const graph = graphOf([evidence(), claim({ supportingEvidenceIds: ['evidence-A'] })]);
  assert.notEqual(graph.evaluateClaim('claim-B').verdict, 'supported', 'out-of-scope support must not make the claim supported');

  const graph2 = graphOf([evidence(), claim({ contradictingEvidenceIds: ['evidence-A'] })]);
  assert.notEqual(graph2.evaluateClaim('claim-B').verdict, 'contradicted', 'out-of-scope contradiction must not make the claim contradicted');
}

// Edge path shares the policy (5).
{
  const graph = graphOf([evidence(), claim()], [{ type: 'supports', from: 'claim-B', to: 'evidence-A' }]);
  assert.notEqual(graph.evaluateClaim('claim-B').verdict, 'supported', 'the edge path must apply the same target-scope policy');

  const graph2 = graphOf([evidence(), claim()], [{ type: 'contradicts', from: 'claim-B', to: 'evidence-A' }]);
  assert.notEqual(graph2.evaluateClaim('claim-B').verdict, 'contradicted', 'the contradicts edge path must apply the same policy');
}

// 3: same-target support/contradiction still applies.
{
  const graph = graphOf([evidence({ id: 'ev-B', targetEntityIds: ['entity-B'] }), claim({ supportingEvidenceIds: ['ev-B'] })]);
  assert.equal(graph.evaluateClaim('claim-B').verdict, 'supported', 'in-scope support keeps its verdict authority');

  const graph2 = graphOf([evidence({ id: 'ev-B', targetEntityIds: ['entity-B'] }), claim({ contradictingEvidenceIds: ['ev-B'] })]);
  assert.equal(graph2.evaluateClaim('claim-B').verdict, 'contradicted', 'in-scope contradiction keeps its verdict authority');

  const graph3 = graphOf([evidence({ id: 'untargeted', targetEntityIds: [] }), claim({ supportingEvidenceIds: ['untargeted'] })]);
  assert.equal(graph3.evaluateClaim('claim-B').verdict, 'supported', 'untargeted evidence keeps its historical contract');
}

// 4: disagreeing binaryId never applies.
{
  const graph = graphOf([
    evidence({ id: 'ev-other-binary', targetEntityIds: ['entity-B'], binaryId: 'bin-other' }),
    claim({ supportingEvidenceIds: ['ev-other-binary'], binaryId: 'bin-A' }),
  ]);
  assert.notEqual(graph.evaluateClaim('claim-B').verdict, 'supported', 'a cross-binary evidence must not support the claim');
}

// 6: missing references stay unresolved, and out-of-scope references are not
// reported as missing (they exist; they are merely not applicable).
{
  const graph = graphOf([evidence(), claim({ supportingEvidenceIds: ['ghost', 'evidence-A'] })]);
  const evaluation = graph.evaluateClaim('claim-B');
  assert.deepEqual(evaluation.missingEvidenceIds, ['ghost'], 'unresolved references keep the existing contract');
  assert.notEqual(evaluation.verdict, 'supported');
}

// 7 + 8: the shared policy keeps #6154's confirmation scope and #1178's
// completeness gate intact.
{
  const graph = graphOf([evidence(), claim({ verdict: 'unverified', confirmedByEvidenceIds: ['evidence-A'] })]);
  assert.equal(graph.evaluateClaim('claim-B').verdict, 'unverified', 'out-of-scope evidence cannot confirm the claim either');

  const graph2 = graphOf([
    evidence({ id: 'ev-B', targetEntityIds: ['entity-B'], completeness: 'partial' }),
    claim({ verdict: 'unverified', confirmedByEvidenceIds: ['ev-B'] }),
  ]);
  assert.equal(graph2.evaluateClaim('claim-B').verdict, 'unverified', '#1178: partial evidence never confirms');
}

console.log('issue #6168 evidence claim target scope: PASS');
