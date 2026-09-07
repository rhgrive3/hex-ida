import assert from 'node:assert/strict';

import { fuseFunctionCandidates } from '../../js/analysis/discovery/fusion.js';

const corroborating = (kind, producerId) => ({
  kind,
  authority: 'corroborating',
  extentRole: 'complete',
  producerId,
  start: '4096',
  regions: [],
});

const valid = fuseFunctionCandidates([
  corroborating('direct-call-target', 'producer:a'),
  corroborating('relocation-target', 'producer:b'),
]);
assert.equal(valid.candidates.length, 1);
assert.equal(valid.candidates[0].startState, 'probable');
assert.deepEqual(valid.candidates[0].startEvidence.map((e) => e.producerId), ['producer:a', 'producer:b']);

for (const malformed of [{ source: 'a' }, ['producer:a'], 1, true, false, '']) {
  assert.throws(() => fuseFunctionCandidates([
    corroborating('direct-call-target', malformed),
    corroborating('relocation-target', 'producer:b'),
  ]), /discovery-evidence-invalid-producer-id/);
}

const duplicate = fuseFunctionCandidates([
  corroborating('direct-call-target', 'producer:a'),
  corroborating('relocation-target', 'producer:a'),
]);
assert.equal(duplicate.candidates[0].startState, 'heuristic');

console.log('issue #2736 strict discovery producer identity regression PASS');
