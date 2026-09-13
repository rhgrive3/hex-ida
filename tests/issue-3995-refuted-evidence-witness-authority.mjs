import assert from 'node:assert/strict';
import {
  createSymbolicEvidence,
  isRefutedEvidence,
  EVIDENCE_VERDICT,
  VALIDATION_STATUS,
  PRECONDITION_STATUS,
  CLAIM_KIND,
} from '../js/symbolic/evidence/symbolic-evidence.js';
import { SOLVER_STATUS } from '../js/symbolic/solver/result.js';

function refutedInput(overrides = {}) {
  return {
    queryKind: 'bounded-equivalence',
    claimKind: CLAIM_KIND.BOUNDED_EQUIVALENCE,
    proofStatement: 'deterministic divergence witness',
    targetEntities: ['f'],
    queryHash: 'a'.repeat(64),
    backendId: 'b',
    backendVersion: '1',
    solverStatus: SOLVER_STATUS.SAT,
    preconditionStatus: PRECONDITION_STATUS.SATISFIABLE,
    validationStatus: VALIDATION_STATUS.VALIDATED,
    verdict: EVIDENCE_VERDICT.REFUTED,
    witnessModel: { arg_x0: 42n },
    ...overrides,
  };
}

{
  const evidence = createSymbolicEvidence(refutedInput());
  assert.equal(evidence.verdict, EVIDENCE_VERDICT.REFUTED);
  assert.equal(evidence.validationStatus, VALIDATION_STATUS.VALIDATED);
  assert.equal(isRefutedEvidence(evidence), true, 'validated witness refutation must not regress');
}

assert.throws(
  () => createSymbolicEvidence(refutedInput({ validationStatus: VALIDATION_STATUS.NOT_APPLICABLE, witnessModel: null })),
  /refuted evidence requires/,
  'SAT + not-applicable + null witness must not mint REFUTED evidence',
);
assert.throws(
  () => createSymbolicEvidence(refutedInput({ validationStatus: VALIDATION_STATUS.UNVALIDATED })),
  /refuted evidence requires/,
);
assert.throws(
  () => createSymbolicEvidence(refutedInput({ validationStatus: VALIDATION_STATUS.FAILED })),
  /refuted evidence requires/,
);
assert.throws(
  () => createSymbolicEvidence(refutedInput({ validationStatus: VALIDATION_STATUS.REJECTED })),
  /cannot mint refuted evidence when witness model validation was rejected/,
);
assert.throws(
  () => createSymbolicEvidence(refutedInput({ witnessModel: null })),
  /refuted evidence requires/,
  'validated status without a witness must not mint REFUTED evidence',
);

{
  assert.equal(
    isRefutedEvidence({
      verdict: EVIDENCE_VERDICT.REFUTED,
      solverStatus: SOLVER_STATUS.SAT,
      validationStatus: VALIDATION_STATUS.NOT_APPLICABLE,
      witnessModel: null,
    }),
    false,
    'unvalidated witness must not carry refuted authority',
  );
  assert.equal(
    isRefutedEvidence({
      verdict: EVIDENCE_VERDICT.REFUTED,
      solverStatus: SOLVER_STATUS.SAT,
      validationStatus: VALIDATION_STATUS.VALIDATED,
      witnessModel: null,
    }),
    false,
    'missing witness must not carry refuted authority',
  );
}

console.log('issue-3995 REFUTED evidence witness-validation authority: ok');
