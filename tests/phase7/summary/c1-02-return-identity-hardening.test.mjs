import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFunctionSummary,
  summaryIdentityMatches,
} from '../../../js/analysis/summary/contract.js';

const status = {
  snapshotId: 'snapshot-c1-02-identity',
  analyzerId: 'c1-02-identity-regression',
  analyzerVersion: '1.0.0',
  completeness: 'complete',
};

function summaryInput(returnProvenance) {
  return {
    functionId: 'fn_callee',
    inputs: [],
    returnValues: ['ret0'],
    returnProvenance,
    noreturn: false,
    mayThrow: false,
    status,
  };
}

for (const [field, kind] of [
  ['rootEntityId', 'root'],
  ['allocationSiteId', 'allocation'],
]) {
  test(`HEX-C1-02 identity hardening: constructor rejects object-valued ${field}`, () => {
    assert.throws(
      () => createFunctionSummary(summaryInput([{
        kind,
        returnIndex: 0,
        [field]: { id: 'forged-identity' },
        offset: '0',
      }])),
      /function-summary-invalid-return-provenance-identity/,
    );
  });

  test(`HEX-C1-02 identity hardening: serialized object-valued ${field} fails the identity gate`, () => {
    const canonical = createFunctionSummary(summaryInput([{
      kind,
      returnIndex: 0,
      [field]: `${kind}-site-1`,
      offset: '0',
    }]));
    const malformed = {
      ...canonical,
      returnProvenance: [{
        ...canonical.returnProvenance[0],
        [field]: { id: 'forged-identity' },
      }],
    };
    assert.equal(summaryIdentityMatches(malformed, {
      functionId: 'fn_callee',
      snapshotId: status.snapshotId,
    }), false);
  });
}
