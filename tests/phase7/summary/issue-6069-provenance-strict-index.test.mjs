import test from 'node:test';
import assert from 'node:assert/strict';
import { createFunctionSummary } from '../../../js/analysis/summary/contract.js';

function sw(p) {
  return createFunctionSummary({
    functionId: 'callee',
    returnProvenance: [p],
    status: {
      snapshotId: 's',
      analyzerId: 'summary-test',
      analyzerVersion: '1',
      completeness: 'complete',
      stopReason: null,
    },
  });
}

test('6069 structured provenance rejected', () => {
  assert.throws(
    () => sw({ kind: 'arg', argIndex: ['1'], returnIndex: ['0'], offset: ['8'] }),
    /function-summary-invalid-return-provenance/,
  );
  // Isolate returnIndex so another malformed field cannot make this assertion
  // pass while a structured value is still accepted.
  assert.throws(
    () => sw({ kind: 'arg', returnIndex: ['0'] }),
    /function-summary-invalid-return-provenance-return-index/,
  );
  assert.throws(
    () => sw({ kind: 'arg', argIndex: true }),
    /function-summary-invalid-return-provenance/,
  );
  assert.throws(
    () => sw({ kind: 'arg', argIndex: 0, offset: false }),
    /function-summary-invalid-return-provenance/,
  );
  assert.throws(
    () => sw({ kind: 'arg', offset: 'not-a-number' }),
    /function-summary-invalid-return-provenance-offset/,
  );
});

test('6069 canonical indices and BigInt-compatible offsets accepted', () => {
  let s = sw({ kind: 'arg', argIndex: 1, returnIndex: 0, offset: 8 });
  assert.equal(s.returnProvenance[0].argIndex, 1);
  assert.equal(s.returnProvenance[0].returnIndex, 0);
  assert.equal(s.returnProvenance[0].offset, '8');

  s = sw({ kind: 'arg', argIndex: 2, returnIndex: 4, offset: '0x20' });
  assert.equal(s.returnProvenance[0].argIndex, 2);
  assert.equal(s.returnProvenance[0].returnIndex, 4);
  assert.equal(s.returnProvenance[0].offset, '32');

  s = sw({ kind: 'arg', argIndex: 0, returnIndex: 5, offset: '0b1000' });
  assert.equal(s.returnProvenance[0].returnIndex, 5);
  assert.equal(s.returnProvenance[0].offset, '8');

  s = sw({ kind: 'arg', argIndex: 0, offset: '0o10' });
  assert.equal(s.returnProvenance[0].offset, '8');

  s = sw({ kind: 'arg', argIndex: 0, offset: '+16' });
  assert.equal(s.returnProvenance[0].offset, '16');
});
