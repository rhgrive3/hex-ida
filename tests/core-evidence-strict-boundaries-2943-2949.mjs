import assert from 'node:assert/strict';
import { createEvidenceNode, EvidenceGraph } from '../js/core/evidence/index.js';

for (const badConfidence of ['0.9', ['0.9'], true, { valueOf(){ return 0.9; } }]) {
  assert.throws(() => createEvidenceNode({ id:'bad-confidence', family:'RuntimeEvidence', confidence:badConfidence }), /evidence-invalid-confidence/);
}
assert.equal(createEvidenceNode({ id:'good-confidence', family:'RuntimeEvidence', confidence:0.9 }).confidence, 0.9);

const graph = new EvidenceGraph({
  nodes:[{ id:'claim-strict', family:'Claim', semanticKind:'strict', targetEntityIds:['entity-strict'] }],
  edges:[],
});
for (const malformedId of [['claim-strict'], 1, true, { toString(){ return 'claim-strict'; } }]) {
  assert.throws(() => graph.getNode(malformedId), /evidence-id-required/);
  assert.throws(() => graph.hasNode(malformedId), /evidence-id-required/);
  assert.throws(() => graph.evaluateClaim(malformedId), /evidence-id-required/);
}
assert.equal(graph.getNode('claim-strict')?.id, 'claim-strict');
console.log('core evidence strict boundaries #2943/#2949: PASS');
