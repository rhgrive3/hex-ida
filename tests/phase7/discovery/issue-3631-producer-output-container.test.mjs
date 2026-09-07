import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryEvidence } from '../../../js/analysis/discovery/candidates.js';
import {
  DiscoveryProducerRegistry,
  fuseFunctionCandidates,
} from '../../../js/analysis/discovery/fusion.js';

function registryReturning(value) {
  return new DiscoveryProducerRegistry().register({
    id: 'test-producer',
    architectureId: 'arm64',
    produce() { return value; },
  });
}

test('registry rejects non-Array producer output instead of laundering it to complete-empty', () => {
  const malformed = [
    'not-evidence',
    new Set(),
    new Uint8Array([1, 2, 3]),
    {},
  ];

  for (const output of malformed) {
    assert.throws(
      () => registryReturning(output).collect({}, 'arm64'),
      /discovery-producer-evidence-invalid/,
    );
  }
});

test('registry preserves nullish and empty Array producer semantics', () => {
  for (const output of [null, undefined, []]) {
    const collected = registryReturning(output).collect({}, 'arm64');
    assert.deepEqual(collected.evidence, []);
    assert.deepEqual(collected.producerIds, ['test-producer']);
  }
});

test('registry preserves canonical Array evidence and provenance before fusion', () => {
  const evidence = createDiscoveryEvidence({
    kind: 'loader-function-start',
    start: 0x1000,
    producerId: 'source-producer',
  });

  const collected = registryReturning([evidence]).collect({}, 'arm64');
  assert.equal(collected.evidence.length, 1);
  assert.equal(collected.evidence[0].producerId, 'test-producer');
  assert.equal(collected.evidence[0].architectureId, 'arm64');

  const fused = fuseFunctionCandidates(collected.evidence, { architectureId: 'arm64' });
  assert.equal(fused.status.completeness, 'complete');
  assert.equal(fused.status.stopReason, null);
  assert.equal(fused.candidates.length, 1);
  assert.equal(fused.candidates[0].start, '4096');
  assert.equal(fused.candidates[0].startState, 'exact');
});
