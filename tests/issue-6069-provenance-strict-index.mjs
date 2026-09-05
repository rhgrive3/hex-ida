import test from 'node:test';
import assert from 'node:assert/strict';
import { createFunctionSummary } from '../js/analysis/summary/contract.js';

function summaryWith(provenance) {
  return createFunctionSummary({
    functionId: 'callee',
    returnProvenance: [provenance],
    status: {
      snapshotId: 's',
      analyzerId: 'summary-test',
      analyzerVersion: '1',
      completeness: 'complete',
      stopReason: null,
    },
  });
}

test('6069: structured indices are rejected, not laundered', () => {
  assert.throws(
    () => summaryWith({ kind: 'arg', argIndex: ['1'], returnIndex: ['0'], offset: ['8'] }),
    /function-summary-invalid-return-provenance/,
  );
  assert.throws(
    () => summaryWith({ kind: 'arg', argIndex: true }),
    /function-summary-invalid-return-provenance/,
  );
  assert.throws(
    () => summaryWith({ kind: 'arg', argIndex: 0, offset: false }),
    /function-summary-invalid-return-provenance/,
  );
  assert.throws(
    () => summaryWith({ kind: 'arg', argIndex: {} }),
    /function-summary-invalid-return-provenance/,
  );
});

test('6069: canonical indices still accepted', () => {
  const summary = summaryWith({ kind: 'arg', argIndex: 1, returnIndex: 0, offset: 8 });
  assert.equal(summary.returnProvenance[0].argIndex, 1);
  assert.equal(summary.returnProvenance[0].returnIndex, 0);
  assert.equal(summary.returnProvenance[0].offset, '8');
  const bigint = summaryWith({ kind: 'arg', argIndex: 2n, offset: 16n });
  assert.equal(bigint.returnProvenance[0].argIndex, 2);
  assert.equal(bigint.returnProvenance[0].offset, '16');
  const strings = summaryWith({ kind: 'arg', argIndex: '3', offset: '0x20' });
  assert.equal(strings.returnProvenance[0].argIndex, 3);
  assert.equal(strings.returnProvenance[0].offset, '32');
});
