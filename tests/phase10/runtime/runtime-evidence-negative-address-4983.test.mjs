import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareRuntimeDispatch,
  createRuntimeEvidenceRecord,
  fuseStaticDynamic,
} from '../../../js/runtime-evidence/index.js';

const negativeForms = [-1n, -1, '-1', '-42', '-0x1'];

for (const value of negativeForms) {
  test(`issue #4983 rejects negative runtime/static address ${String(value)}`, () => {
    const result = compareRuntimeDispatch([value], { target: value });
    assert.equal(result.status, 'inconclusive');
    assert.equal(result.observed, null);
    assert.deepEqual(result.candidates, []);
  });
}

test('issue #4983 preserves zero and positive canonical addresses', () => {
  for (const value of [0n, 0, '0', '0x0', 1n, 1, '1', '0x10']) {
    const result = compareRuntimeDispatch([value], { target: value });
    assert.equal(result.status, 'supported', `expected supported for ${String(value)}`);
  }
});

test('issue #4983 preserves existing malformed address rejection', () => {
  for (const value of [Number.MAX_SAFE_INTEGER + 1, 1.5, '', ' ', 'not-an-address', {}, []]) {
    const result = compareRuntimeDispatch([value], { target: value });
    assert.equal(result.status, 'inconclusive');
    assert.equal(result.observed, null);
    assert.deepEqual(result.candidates, []);
  }
});

test('issue #4983 rejects negative address forms without discarding a valid peer', () => {
  const negativeObserved = compareRuntimeDispatch([0x1000n], { target: ' -1 ' });
  assert.equal(negativeObserved.status, 'inconclusive');
  assert.equal(negativeObserved.observed, null);
  assert.deepEqual(negativeObserved.candidates, [0x1000n]);

  const negativeCandidate = compareRuntimeDispatch([-Number.MAX_SAFE_INTEGER], { target: 0x1000n });
  assert.equal(negativeCandidate.status, 'inconclusive');
  assert.equal(negativeCandidate.observed, 0x1000n);
  assert.deepEqual(negativeCandidate.candidates, []);
  assert.equal(negativeCandidate.reason, 'runtime-target-observed-without-static-candidate');
});

test('issue #4983 negative zero remains canonical address zero', () => {
  for (const value of [-0, '-0']) {
    const result = compareRuntimeDispatch([value], { target: value });
    assert.equal(result.status, 'supported');
    assert.equal(result.observed, 0n);
    assert.deepEqual(result.candidates, [0n]);
  }
});

test('issue #4983 negative function identity cannot authorize runtime evidence fusion', () => {
  const evidence = createRuntimeEvidenceRecord({
    id: 'negative-function-evidence',
    backend: 'test',
    binaryHash: 'bin-a',
    function: -1n,
    provenanceGroup: 'runtime:test:negative:function',
    verdict: 'supported',
  });
  const fused = fuseStaticDynamic({
    confidence: 0.7,
    binaryHash: 'bin-a',
    functionAddress: -1n,
  }, [evidence]);

  assert.equal(fused.status, 'inconclusive');
  assert.equal(fused.runtimeGroups, 0);
  assert.equal(fused.support, 0);
  assert.equal(fused.contradictions, 0);
  assert.equal(fused.ignoredEvidence, 1);
});

test('issue #4983 positive matching function identity remains compatible', () => {
  const evidence = createRuntimeEvidenceRecord({
    id: 'positive-function-evidence',
    backend: 'test',
    binaryHash: 'bin-a',
    function: 0x1000n,
    provenanceGroup: 'runtime:test:positive:function',
    verdict: 'supported',
  });
  const fused = fuseStaticDynamic({
    confidence: 0.7,
    binaryHash: 'bin-a',
    functionAddress: 0x1000n,
  }, [evidence]);

  assert.equal(fused.status, 'supported');
  assert.equal(fused.runtimeGroups, 1);
  assert.equal(fused.support, 1);
  assert.equal(fused.ignoredEvidence, 0);
});

test('issue #4983 positive candidate ignores negative-function runtime evidence', () => {
  const evidence = createRuntimeEvidenceRecord({
    id: 'negative-function-evidence-for-positive-candidate',
    backend: 'test',
    binaryHash: 'bin-a',
    function: '-1',
    provenanceGroup: 'runtime:test:negative:function:positive-candidate',
    verdict: 'supported',
  });
  const fused = fuseStaticDynamic({
    confidence: 0.7,
    binaryHash: 'bin-a',
    functionAddress: 0x1000n,
  }, [evidence]);

  assert.equal(fused.status, 'inconclusive');
  assert.equal(fused.runtimeGroups, 0);
  assert.equal(fused.support, 0);
  assert.equal(fused.contradictions, 0);
  assert.equal(fused.ignoredEvidence, 1);
});
