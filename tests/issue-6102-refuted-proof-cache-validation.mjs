import test from 'node:test';
import assert from 'node:assert/strict';

import { isCacheableProof } from '../js/symbolic/evidence/cache-policy.js';
import { SOLVER_STATUS } from '../js/symbolic/solver/result.js';
import { PROOF_AUTHORITY } from '../js/symbolic/solver/backend.js';
import { COMPLETENESS_STATUS } from '../js/symbolic/translate/support-matrix.js';
import { VALIDATION_STATUS } from '../js/symbolic/evidence/symbolic-evidence.js';

const allComplete = Object.freeze({
  translation: COMPLETENESS_STATUS.COMPLETE,
  controlFlow: COMPLETENESS_STATUS.COMPLETE,
  memoryEffects: COMPLETENESS_STATUS.COMPLETE,
  pathCoverage: COMPLETENESS_STATUS.COMPLETE,
  queryScope: COMPLETENESS_STATUS.COMPLETE,
});

function refutedProof({ validationStatus = null, ...rest } = {}) {
  return {
    verdict: 'refuted',
    solverStatus: SOLVER_STATUS.SAT,
    completeness: allComplete,
    hasUnresolvedUnknowns: false,
    preconditionStatus: 'satisfiable',
    validationStatus,
    proofAuthority: PROOF_AUTHORITY.EXACT,
    capabilityFingerprint: 'cap-fp',
    backendId: 'exact-backend',
    backendVersion: '1.0.0',
    ...rest,
  };
}

test('#6102 refuted + SAT + validated counterexample is cacheable', () => {
  for (const status of ['validated', VALIDATION_STATUS.VALIDATED]) {
    assert.equal(isCacheableProof(refutedProof({ validationStatus: status })), true, String(status));
  }
});

test('#6102 refuted + SAT with unvalidated counterexample is not cacheable', () => {
  for (const status of ['unvalidated', VALIDATION_STATUS.UNVALIDATED]) {
    assert.equal(isCacheableProof(refutedProof({ validationStatus: status })), false, String(status));
  }
});

test('#6102 refuted + SAT with not-applicable counterexample is not cacheable', () => {
  for (const status of ['not-applicable', VALIDATION_STATUS.NOT_APPLICABLE]) {
    assert.equal(isCacheableProof(refutedProof({ validationStatus: status })), false, String(status));
  }
});

test('#6102 refuted + SAT with null validationStatus is not cacheable', () => {
  assert.equal(isCacheableProof(refutedProof({ validationStatus: null })), false);
  assert.equal(isCacheableProof({ ...refutedProof(), validationStatus: undefined }), false);
  assert.equal(isCacheableProof({ ...refutedProof(), validationStatus: 'totally-unknown' }), false);
});

test('#6102 refuted + SAT with rejected/failed counterexample stays not cacheable', () => {
  for (const status of ['rejected', 'failed', VALIDATION_STATUS.REJECTED, VALIDATION_STATUS.FAILED]) {
    assert.equal(isCacheableProof(refutedProof({ validationStatus: status })), false, String(status));
  }
});

test('#6102 proved + UNSAT cache policy does not regress (validation not required)', () => {
  assert.equal(isCacheableProof(refutedProof({ verdict: 'proved', solverStatus: SOLVER_STATUS.UNSAT })), true);
  assert.equal(
    isCacheableProof(
      refutedProof({ verdict: 'proved', solverStatus: SOLVER_STATUS.UNSAT, validationStatus: 'rejected' }),
    ),
    true,
  );
});

test('#6102 refuted verdict never cacheable without SAT solver status', () => {
  assert.equal(isCacheableProof(refutedProof({ solverStatus: SOLVER_STATUS.UNSAT })), false);
  assert.equal(isCacheableProof(refutedProof({ solverStatus: SOLVER_STATUS.UNKNOWN })), false);
});
