import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyCallTargetProof } from '../../js/analysis/summary/contract.js';

test('issue #2737: valid direct singleton remains exact', () => {
  assert.deepEqual(classifyCallTargetProof({ targetEntityId: 'fn_callee' }), {
    kind: 'direct',
    candidateEntityIds: ['fn_callee'],
    exhaustive: true,
    exactSingletonEntityId: 'fn_callee',
  });
});

test('issue #2737: malformed entity identities never mint exact singleton proof', () => {
  for (const targetEntityId of [{ source: 'malformed' }, ['fn_callee'], 1, true, '   ']) {
    const proof = classifyCallTargetProof({ targetEntityId });
    assert.equal(proof.exhaustive, false);
    assert.equal(proof.exactSingletonEntityId, null);
  }
  const mixed = classifyCallTargetProof({ targetEntityIds: ['fn_callee', { bad: true }] });
  assert.deepEqual(mixed.candidateEntityIds, ['fn_callee']);
  assert.equal(mixed.exhaustive, false);
  assert.equal(mixed.exactSingletonEntityId, null);
});

test('issue #2737: malformed runtime target identities also prevent exactness', () => {
  const proof = classifyCallTargetProof({
    targetEntityId: 'fn_callee',
    targetValueIds: [{ bad: true }],
    completeness: 'complete',
  });
  assert.equal(proof.exhaustive, false);
  assert.equal(proof.exactSingletonEntityId, null);
});

test('issue #2737: incomplete indirect singleton remains non-exhaustive', () => {
  const proof = classifyCallTargetProof({
    targetEntityId: 'fn_callee',
    targetValueIds: ['value_1'],
    completeness: 'partial',
  });
  assert.equal(proof.kind, 'indirect');
  assert.equal(proof.exhaustive, false);
  assert.equal(proof.exactSingletonEntityId, null);
});
