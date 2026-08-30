import assert from 'node:assert/strict';
import { createEvidenceNode, createClaimNode, createEvidenceEdge } from '../js/core/evidence/index.js';

const evidence = createEvidenceNode({
  id:' ev-1 ',
  family:'RuntimeEvidence',
  binaryId:'bin-1',
  targetEntityIds:[' fn:1 '],
  semanticKind:'runtime-observation',
  completeness:'complete',
  confidence:'0.75',
  deterministic:true,
  createdAt:'2026-08-31T00:00:00Z',
});
assert.equal(evidence.id, 'ev-1');
assert.equal(evidence.family, 'RuntimeEvidence');
assert.equal(evidence.completeness, 'complete');
assert.equal(evidence.confidence, 0.75, 'numeric-string confidence compatibility is preserved');

const malformedEvidence = [
  { id:['ev-1'], family:'RuntimeEvidence' },
  { id:'ev-1', family:['RuntimeEvidence'] },
  { id:'ev-1', family:'RuntimeEvidence', completeness:['complete'] },
  { id:'ev-1', family:'RuntimeEvidence', binaryId:['bin-1'] },
  { id:'ev-1', family:'RuntimeEvidence', semanticKind:{ toString(){ return 'runtime-observation'; } } },
  { id:'ev-1', family:'RuntimeEvidence', createdAt:123 },
];
for (const input of malformedEvidence) assert.throws(() => createEvidenceNode(input), TypeError);

assert.throws(() => createClaimNode({
  id:'claim-1',
  semanticKind:'behavior',
  targetEntityIds:['fn:1'],
  verdict:['supported'],
}), TypeError);
assert.throws(() => createClaimNode({
  id:'claim-1',
  semanticKind:['behavior'],
  targetEntityIds:['fn:1'],
}), TypeError);
assert.throws(() => createClaimNode({
  id:'claim-1',
  semanticKind:'behavior',
  targetEntityIds:['fn:1'],
  binaryId:{ toString(){ return 'bin-1'; } },
}), TypeError);
assert.throws(() => createEvidenceEdge({ type:['supports'], from:'claim-1', to:'ev-1' }), TypeError);
assert.throws(() => createEvidenceEdge({ type:'supports', from:['claim-1'], to:'ev-1' }), TypeError);

console.log('Evidence strict identity/enum tests passed');
