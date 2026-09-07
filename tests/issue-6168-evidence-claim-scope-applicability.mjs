import assert from 'node:assert/strict';
import { EvidenceGraph, canConfirmClaim, isEvidenceApplicableToClaim } from '../js/core/evidence/index.js';

const evidenceForA = {
  id: 'evidence-for-A',
  family: 'SemanticEvidence',
  targetEntityIds: ['entity-A'],
  semanticKind: 'identity-proof',
  completeness: 'complete',
  deterministic: true,
};
const claimForB = {
  id: 'claim-for-B',
  family: 'Claim',
  targetEntityIds: ['entity-B'],
  semanticKind: 'identity',
  completeness: 'complete',
  verdict: 'unknown',
};

assert.equal(isEvidenceApplicableToClaim(evidenceForA, claimForB), false, 'unrelated target scope must not be applicable');

function graphWith(claimOverrides, edge) {
  return new EvidenceGraph({
    nodes: [
      evidenceForA,
      { ...claimForB, ...claimOverrides },
    ],
    edges: edge ? [edge] : [],
  });
}

assert.equal(
  graphWith({ supportingEvidenceIds: ['evidence-for-A'] }).evaluateClaim('claim-for-B').verdict,
  'unverified',
  '#6168 unrelated evidence must not support a claim outside its target scope (id-array path)',
);
assert.equal(
  graphWith({ contradictingEvidenceIds: ['evidence-for-A'] }).evaluateClaim('claim-for-B').verdict,
  'unverified',
  '#6168 unrelated evidence must not contradict a claim outside its target scope',
);
assert.equal(
  graphWith({ confirmedByEvidenceIds: ['evidence-for-A'] }).evaluateClaim('claim-for-B').verdict,
  'unverified',
  '#6154/#6168 unrelated evidence must not confirm a claim outside its target scope',
);
assert.equal(
  graphWith({}, { type: 'supports', from: 'claim-for-B', to: 'evidence-for-A' }).evaluateClaim('claim-for-B').verdict,
  'unverified',
  '#6168 edge path must apply the same scope applicability policy (supports)',
);
assert.equal(
  graphWith({}, { type: 'contradicts', from: 'claim-for-B', to: 'evidence-for-A' }).evaluateClaim('claim-for-B').verdict,
  'unverified',
  '#6168 edge path must apply the same scope applicability policy (contradicts)',
);
assert.equal(
  graphWith({}, { type: 'verified-by', from: 'claim-for-B', to: 'evidence-for-A' }).evaluateClaim('claim-for-B').verdict,
  'unverified',
  '#6168 edge path must apply the same scope applicability policy (verified-by)',
);
assert.equal(canConfirmClaim(evidenceForA, claimForB), false, '#6168 confirmation policy must include scope applicability');
assert.equal(
  isEvidenceApplicableToClaim(
    { ...evidenceForA, targetEntityIds: [] },
    { ...claimForB, targetEntityIds: ['entity-A'] },
  ),
  false,
  '#6168 a target-bound claim cannot use evidence with empty targetEntityIds',
);
assert.equal(
  canConfirmClaim(
    { ...evidenceForA, targetEntityIds: [] },
    { ...claimForB, targetEntityIds: ['entity-A'] },
  ),
  false,
  '#6168 confirmation must reject empty evidence targetIds',
);
assert.equal(
  isEvidenceApplicableToClaim(
    evidenceForA,
    { ...claimForB, targetEntityIds: ['entity-A'], binaryId: 'bin-B' },
  ),
  false,
  '#6168 a binary-bound claim requires an evidence binary binding',
);
assert.equal(
  isEvidenceApplicableToClaim(
    evidenceForA,
    { ...claimForB, targetEntityIds: [] },
  ),
  false,
  '#6168 a claim without target/binary/structured scope has no authority',
);

const structuredScope = { kind: 'function', functionId: 'entity-B' };
const scopeClaim = {
  ...claimForB,
  targetEntityIds: [],
  scope: structuredScope,
};
const scopeEvidence = {
  ...evidenceForA,
  targetEntityIds: [],
  payload: { scope: structuredScope },
};
assert.equal(isEvidenceApplicableToClaim(scopeEvidence, scopeClaim), true, '#6154 exact structured scope proves applicability');
assert.equal(canConfirmClaim({ ...scopeEvidence, deterministic: true, completeness: 'complete' }, scopeClaim), true, '#6154 exact structured scope permits confirmation');
assert.equal(
  isEvidenceApplicableToClaim(scopeEvidence, { ...scopeClaim, scope: { ...structuredScope, functionId: 'entity-A' } }),
  false,
  '#6154 mismatched structured scope fails closed',
);


assert.equal(
  graphWith({ targetEntityIds: ['entity-A'] }).evaluateClaim('claim-for-B').verdict,
  'unknown',
  'evidence with no relation declared must not change the verdict',
);
assert.equal(
  graphWith({ targetEntityIds: ['entity-A'], supportingEvidenceIds: ['evidence-for-A'] }).evaluateClaim('claim-for-B').verdict,
  'supported',
  'same-target support must keep working',
);
assert.equal(
  graphWith({ targetEntityIds: ['entity-A'], contradictingEvidenceIds: ['evidence-for-A'] }).evaluateClaim('claim-for-B').verdict,
  'contradicted',
  'same-target contradiction must keep working',
);
assert.equal(
  graphWith({ targetEntityIds: ['entity-A'], confirmedByEvidenceIds: ['evidence-for-A'] }).evaluateClaim('claim-for-B').verdict,
  'confirmed',
  'same-target deterministic complete confirmation must keep working',
);
assert.equal(
  graphWith({ targetEntityIds: ['entity-A'], supportingEvidenceIds: ['evidence-for-A'] }, { type: 'supports', from: 'claim-for-B', to: 'evidence-for-A' }).evaluateClaim('claim-for-B').verdict,
  'supported',
  'same-target support via edge path must keep working',
);

const binaryGraph = new EvidenceGraph({
  nodes: [
    { ...evidenceForA, binaryId: 'bin-A' },
    { ...claimForB, binaryId: 'bin-B', supportingEvidenceIds: ['evidence-for-A'], contradictingEvidenceIds: ['evidence-for-A'], confirmedByEvidenceIds: ['evidence-for-A'] },
  ],
});
assert.equal(binaryGraph.evaluateClaim('claim-for-B').verdict, 'unverified', '#6168 explicit binaryId mismatch must reject applicability');

const sharedBinary = new EvidenceGraph({
  nodes: [
    { ...evidenceForA, binaryId: 'bin-A' },
    { ...claimForB, binaryId: 'bin-A', targetEntityIds: ['entity-A'], supportingEvidenceIds: ['evidence-for-A'] },
  ],
});
assert.equal(sharedBinary.evaluateClaim('claim-for-B').verdict, 'supported', 'matching binaryId must keep working');

const claimBinaryOnly = new EvidenceGraph({
  nodes: [
    evidenceForA,
    { ...claimForB, binaryId: 'bin-B', supportingEvidenceIds: ['evidence-for-A'] },
  ],
});
assert.equal(
  claimBinaryOnly.evaluateClaim('claim-for-B').verdict,
  'unverified',
  '#6168 evidence without binaryId must not satisfy a claim bound to a specific binary',
);

const evidenceBinaryOnly = new EvidenceGraph({
  nodes: [
    { ...evidenceForA, binaryId: 'bin-A' },
    { ...claimForB, targetEntityIds: ['entity-A'], supportingEvidenceIds: ['evidence-for-A'] },
  ],
});
assert.equal(evidenceBinaryOnly.evaluateClaim('claim-for-B').verdict, 'supported', 'claim without declared binary keeps accepting evidence that matches its targets');

const unresolved = new EvidenceGraph({
  nodes: [{ ...claimForB, supportingEvidenceIds: ['missing-support'] }],
});
const unresolvedResult = unresolved.evaluateClaim('claim-for-B');
assert.equal(unresolvedResult.verdict, 'unverified', 'missing references stay unresolved');
assert.deepEqual(unresolvedResult.missingEvidenceIds, ['missing-support'], 'missing references must still be reported');

console.log('#6168/#6154 evidence scope applicability: PASS');
