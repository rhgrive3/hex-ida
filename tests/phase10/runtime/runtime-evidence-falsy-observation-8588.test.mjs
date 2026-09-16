import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeEvidenceRecord } from '../../../js/runtime-evidence/index.js';

const base = Object.freeze({
  sessionId: 'session-8588',
  experimentId: 'experiment-8588',
  caseId: 'case-8588',
  kind: 'observation',
  timestamp: '2026-09-13T00:00:00.000Z',
  occurrence: 'run-1',
});

test('#8588 falsy observation payloads are preserved instead of collapsing to null', () => {
  for (const value of [false, 0, '']) {
    const record = createRuntimeEvidenceRecord({ ...base, input: value });
    assert.strictEqual(record.input, value);
  }
});

test('#8588 all canonical observation slots use the same nullish preservation rule', () => {
  for (const field of ['input', 'initialState', 'observedState']) {
    for (const value of [false, 0, '']) {
      const record = createRuntimeEvidenceRecord({ ...base, [field]: value });
      assert.strictEqual(record[field], value, `${field} must preserve ${JSON.stringify(value)}`);
    }

    assert.strictEqual(createRuntimeEvidenceRecord({ ...base, [field]: null })[field], null);
    assert.strictEqual(createRuntimeEvidenceRecord({ ...base, [field]: undefined })[field], null);
  }
});

test('#8588 stored observation payload stays aligned with occurrence identity material', () => {
  const falseRecord = createRuntimeEvidenceRecord({ ...base, input: false });
  const nullRecord = createRuntimeEvidenceRecord({ ...base, input: null });
  const zeroRecord = createRuntimeEvidenceRecord({ ...base, input: 0 });
  const emptyRecord = createRuntimeEvidenceRecord({ ...base, input: '' });

  assert.notEqual(falseRecord.id, nullRecord.id);
  assert.notEqual(zeroRecord.id, nullRecord.id);
  assert.notEqual(emptyRecord.id, nullRecord.id);
  assert.strictEqual(falseRecord.input, false);
  assert.strictEqual(zeroRecord.input, 0);
  assert.strictEqual(emptyRecord.input, '');
  assert.strictEqual(nullRecord.input, null);
});

test('#8588 existing structured observation payloads remain lossless', () => {
  const input = { args: [0, false, ''] };
  const initialState = { registers: { x0: 0 } };
  const observedState = { returnValue: false };
  const record = createRuntimeEvidenceRecord({ ...base, input, initialState, observedState });

  assert.deepEqual(record.input, input);
  assert.deepEqual(record.initialState, initialState);
  assert.deepEqual(record.observedState, observedState);
});
