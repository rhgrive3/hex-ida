import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeEvidenceRecord } from '../../../js/runtime-evidence/index.js';

function baseInput(extra = {}) {
  return {
    sessionId: 'session',
    experimentId: 'experiment',
    caseId: 'case',
    kind: 'observation',
    ...extra,
  };
}

test('P10.9 generated runtime evidence ids retain the canonical existing format', () => {
  assert.equal(createRuntimeEvidenceRecord(baseInput()).id, 'runtime:session:experiment:case:observation');
  assert.equal(createRuntimeEvidenceRecord(baseInput({ id: null })).id, 'runtime:session:experiment:case:observation');
  assert.equal(createRuntimeEvidenceRecord(baseInput({ id: undefined })).id, 'runtime:session:experiment:case:observation');
});

test('P10.9 canonical primitive explicit evidence id is preserved', () => {
  const record = createRuntimeEvidenceRecord(baseInput({ id: 'runtime-evidence-1' }));
  assert.equal(record.id, 'runtime-evidence-1');
  assert.equal(typeof record.id, 'string');
});

test('P10.9 structured and scalar non-string ids cannot become evidence identity', () => {
  const throwingObject = { toString() { throw new Error('must-not-coerce'); } };
  const malformedIds = [
    ['runtime-evidence-1'],
    {},
    throwingObject,
    true,
    false,
    0,
    1,
    1n,
    new String('runtime-evidence-1'),
  ];

  for (const id of malformedIds) {
    assert.throws(
      () => createRuntimeEvidenceRecord(baseInput({ id })),
      (error) => error instanceof TypeError && error.message === 'runtime evidence id must be a non-empty canonical string',
    );
  }
});

test('P10.9 empty or padded explicit string ids fail closed instead of falling back', () => {
  for (const id of ['', '   ', '\t', ' runtime-evidence-1 ', '\truntime-evidence-1']) {
    assert.throws(
      () => createRuntimeEvidenceRecord(baseInput({ id })),
      (error) => error instanceof TypeError && error.message === 'runtime evidence id must be a non-empty canonical string',
    );
  }
});
