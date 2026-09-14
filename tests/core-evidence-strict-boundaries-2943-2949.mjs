import assert from 'node:assert/strict';
import { EvidenceGraph } from '../js/core/evidence/index.js';

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
assert.equal(graph.hasNode('claim-strict'), true);
const evaluation = graph.evaluateClaim('claim-strict');
assert.equal(evaluation.claimId, 'claim-strict');
assert.equal(evaluation.verdict, 'unknown');
assert.deepEqual(evaluation.missingEvidenceIds, []);
console.log('core evidence strict boundary #2943: PASS');
