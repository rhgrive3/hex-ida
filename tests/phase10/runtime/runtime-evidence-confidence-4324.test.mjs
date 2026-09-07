import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRuntimeEvidenceRecord,
  dynamicTypeAnnotation,
  fuseStaticDynamic,
  traceToSemanticFacts,
} from '../../../js/runtime-evidence/index.js';

const malformedConfidences = ['0.9', ['0.9'], true, false, {}, { valueOf: () => 0.9 }];

for (const confidence of malformedConfidences) {
  test(`P10.9 runtime evidence does not coerce ${typeof confidence} confidence`, () => {
    const record = createRuntimeEvidenceRecord({
      sessionId: 'session',
      experimentId: 'experiment',
      caseId: 'case',
      confidence,
    });
    assert.equal(record.confidence, 0.5);
  });
}

test('P10.9 runtime evidence preserves numeric clamp semantics', () => {
  assert.equal(createRuntimeEvidenceRecord({ confidence: -0.25 }).confidence, 0);
  assert.equal(createRuntimeEvidenceRecord({ confidence: 0.4 }).confidence, 0.4);
  assert.equal(createRuntimeEvidenceRecord({ confidence: 1.25 }).confidence, 1);
  assert.equal(createRuntimeEvidenceRecord({ confidence: Number.NaN }).confidence, 0.5);
  assert.equal(createRuntimeEvidenceRecord({ confidence: Number.POSITIVE_INFINITY }).confidence, 0.5);
});

test('P10.9 trace fact confidence falls back instead of coercing structured input', () => {
  const result = traceToSemanticFacts(
    { events: [{ type: 'return', value: 7 }] },
    { sessionId: 'session', traceId: 'trace', confidence: ['0.95'] },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].confidence, 0.8);
});

test('P10.9 dynamic type confidence falls back instead of coercing booleans', () => {
  const annotation = dynamicTypeAnnotation({ dynamicType: 'Example.Type' }, { confidence: true });
  assert.equal(annotation.confidence, 0.85);
});

test('P10.9 fusion base confidence falls back instead of coercing structured input', () => {
  const fused = fuseStaticDynamic({
    binaryHash: 'binary',
    functionAddress: 0x1000n,
    confidence: ['0.9'],
  }, []);
  assert.equal(fused.status, 'inconclusive');
  assert.equal(fused.confidence, 0.5);
});
