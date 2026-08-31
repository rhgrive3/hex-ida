import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscoveryProducerRegistry, fuseFunctionCandidates } from '../../../js/analysis/discovery/fusion.js';
import { createPatternProducer } from '../../../js/analysis/discovery/producers.js';

const malformedIds = [['p1'], 1, true, { toString(){ return 'p1'; } }, ''];
for (const id of malformedIds) {
  const registry = new DiscoveryProducerRegistry();
  assert.throws(() => registry.register({ id, produce(){ return []; } }), /discovery-producer-id-required/);
}
const registry = new DiscoveryProducerRegistry();
registry.register({ id:'p1', architectureId:null, produce(){ return []; } });
assert.deepEqual(registry.collect({}, 'arm64').producerIds, ['p1']);

for (const malformed of ['1', ['1'], true, 1.5, 0, -1, Infinity]) {
  assert.throws(() => fuseFunctionCandidates([], { budget:{ maxCandidates:malformed } }), /discovery-budget-maxCandidates-invalid/);
  assert.throws(() => fuseFunctionCandidates([], { budget:{ maxEvidencePerCandidate:malformed } }), /discovery-budget-maxEvidencePerCandidate-invalid/);
}
assert.throws(() => fuseFunctionCandidates([], { budget:['bad'] }), /discovery-budget-invalid/);
assert.equal(fuseFunctionCandidates([], { budget:{ maxCandidates:1, maxEvidencePerCandidate:1 }, snapshotId:'s' }).status.completeness, 'complete');

test('pattern producer identity fields are string-only', () => {
  for (const bad of [['p'], 1, true, { toString(){ return 'p'; } }, '']) {
    assert.throws(() => createPatternProducer({ id:bad, architectureId:'arm64', patterns:[{ bytes:[0xaa] }] }), /producer-id-required/);
  }
  for (const bad of [['arm64'], 1, true, { toString(){ return 'arm64'; } }, '']) {
    assert.throws(() => createPatternProducer({ id:'p', architectureId:bad, patterns:[{ bytes:[0xaa] }] }), /architecture-id/);
  }
  for (const bad of [['sig'], 1, true, { toString(){ return 'sig'; } }, '']) {
    assert.throws(() => createPatternProducer({ id:'p', architectureId:'arm64', patterns:[{ id:bad, bytes:[0xaa] }] }), /invalid-id/);
  }
  const valid = createPatternProducer({ id:'p', architectureId:'arm64', patterns:[{ bytes:[0xaa] }] });
  assert.equal(valid.id, 'p');
  assert.equal(valid.architectureId, 'arm64');
});

test('pattern bytes and masks never coerce malformed elements', () => {
  const badValues = [256, -1, '170', true, 1.5, NaN, Infinity, [170], { valueOf(){ return 170; } }];
  for (const value of badValues) {
    assert.throws(() => createPatternProducer({ id:'p', architectureId:'arm64', patterns:[{ bytes:[value] }] }), /invalid-bytes/);
    assert.throws(() => createPatternProducer({ id:'p', architectureId:'arm64', patterns:[{ bytes:[0xaa], mask:[value] }] }), /invalid-mask/);
  }
  const validArray = createPatternProducer({ id:'p', architectureId:'arm64', patterns:[{ id:'sig', bytes:[0xaa], mask:[0xff] }], alignment:1 });
  assert.equal(validArray.produce({ image:{ code:Uint8Array.of(0xaa), codeBaseAddress:'4096' } }).length, 1);
  const validTyped = createPatternProducer({ id:'q', architectureId:null, patterns:[{ bytes:Uint8Array.of(0xbb), mask:Uint8Array.of(0xff) }], alignment:1 });
  assert.equal(validTyped.produce({ image:{ code:Uint8Array.of(0xbb), codeBaseAddress:'8192' } }).length, 1);
  assert.throws(() => createPatternProducer({ id:'wild', architectureId:'arm64', patterns:[{ bytes:[0xaa], mask:[256] }] }), /invalid-mask/);
});

console.log('discovery strict boundaries #3052/#3053/#3080/#3081: PASS');
