import assert from 'node:assert/strict';
import test from 'node:test';

import { fuseStaticDynamic } from '../../../js/runtime-evidence/index.js';

const candidate = Object.freeze({
  binaryHash: 'binary',
  functionAddress: 0x1000n,
  confidence: 0.5,
});

function runtimeEvidence(id, verdict, observationGroup, provenanceGroup = 'runtime') {
  return {
    id,
    source: 'runtime',
    binaryHash: 'binary',
    function: 0x1000n,
    verdict,
    provenance: {
      group: provenanceGroup,
      observationGroup,
    },
  };
}

test('P10.9 canonical observation-group strings still dedupe support', () => {
  const result = fuseStaticDynamic(candidate, [
    runtimeEvidence('e1', 'supported', 'same-observation'),
    runtimeEvidence('e2', 'confirmed', 'same-observation'),
  ]);

  assert.equal(result.runtimeGroups, 1);
  assert.equal(result.support, 1);
  assert.equal(result.contradictions, 0);
  assert.equal(result.ignoredEvidence, 0);
  assert.equal(result.status, 'supported');
  assert.equal(result.confidence, 0.725);
  assert.deepEqual(result.evidence, ['e2']);
});

test('P10.9 distinct structured observation-group objects cannot mint independent support', () => {
  const result = fuseStaticDynamic(candidate, [
    runtimeEvidence('e1', 'supported', { id: 'same' }),
    runtimeEvidence('e2', 'supported', { id: 'same' }),
  ]);

  assert.equal(result.runtimeGroups, 0);
  assert.equal(result.support, 0);
  assert.equal(result.contradictions, 0);
  assert.equal(result.ignoredEvidence, 2);
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.confidence, 0.5);
  assert.deepEqual(result.evidence, []);
});

test('P10.9 shared structured object identity is not observation authority', () => {
  const structuredGroup = { id: 'same' };
  const result = fuseStaticDynamic(candidate, [
    runtimeEvidence('e1', 'supported', structuredGroup),
    runtimeEvidence('e2', 'supported', structuredGroup),
  ]);

  assert.equal(result.runtimeGroups, 0);
  assert.equal(result.support, 0);
  assert.equal(result.ignoredEvidence, 2);
});

test('P10.9 malformed observation groups cannot amplify contradictions', () => {
  for (const observationGroup of [['same'], true, 1, {}, ' same ', '']) {
    const result = fuseStaticDynamic(candidate, [
      runtimeEvidence('e1', 'contradicted', observationGroup),
      runtimeEvidence('e2', 'contradicted', observationGroup),
    ]);

    assert.equal(result.runtimeGroups, 0);
    assert.equal(result.support, 0);
    assert.equal(result.contradictions, 0);
    assert.equal(result.ignoredEvidence, 2);
    assert.equal(result.status, 'inconclusive');
    assert.equal(result.confidence, 0.5);
  }
});

test('P10.9 nullish observation group retains canonical provenance-group fallback', () => {
  const result = fuseStaticDynamic(candidate, [
    runtimeEvidence('e1', 'supported', null, 'runtime-observation'),
    runtimeEvidence('e2', 'supported', undefined, 'runtime-observation'),
  ]);

  assert.equal(result.runtimeGroups, 1);
  assert.equal(result.support, 1);
  assert.equal(result.ignoredEvidence, 0);
});
