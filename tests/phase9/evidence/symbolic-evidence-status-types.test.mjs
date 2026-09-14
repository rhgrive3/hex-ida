import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLAIM_KIND,
  EVIDENCE_VERDICT,
  PRECONDITION_STATUS,
  VALIDATION_STATUS,
  createSymbolicEvidence,
} from '../../../js/symbolic/evidence/symbolic-evidence.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';

function baseEvidence(overrides = {}) {
  return {
    queryKind: 'bounded-equivalence',
    claimKind: CLAIM_KIND.BOUNDED_EQUIVALENCE,
    proofStatement: 'status boundary regression',
    targetEntities: ['func:0x1000'],
    queryHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    backendId: 'test-backend',
    backendVersion: '1.0.0',
    solverStatus: SOLVER_STATUS.SAT,
    preconditionStatus: PRECONDITION_STATUS.SATISFIABLE,
    validationStatus: VALIDATION_STATUS.VALIDATED,
    verdict: EVIDENCE_VERDICT.REFUTED,
    witnessModel: { arg_x0: '1' },
    ...overrides,
  };
}

test('symbolic evidence accepts canonical primitive status strings', () => {
  const evidence = createSymbolicEvidence(baseEvidence());
  assert.equal(evidence.preconditionStatus, PRECONDITION_STATUS.SATISFIABLE);
  assert.equal(evidence.validationStatus, VALIDATION_STATUS.VALIDATED);
});

test('symbolic evidence rejects structured and scalar-coercible status values', () => {
  for (const invalid of [[PRECONDITION_STATUS.SATISFIABLE], { toString: () => PRECONDITION_STATUS.SATISFIABLE }, 1, true]) {
    assert.throws(
      () => createSymbolicEvidence(baseEvidence({ preconditionStatus: invalid })),
      /invalid preconditionStatus/,
    );
  }

  for (const invalid of [[VALIDATION_STATUS.VALIDATED], { toString: () => VALIDATION_STATUS.VALIDATED }, 1, true]) {
    assert.throws(
      () => createSymbolicEvidence(baseEvidence({ validationStatus: invalid })),
      /invalid validationStatus/,
    );
  }
});
