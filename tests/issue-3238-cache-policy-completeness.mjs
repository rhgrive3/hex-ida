import test from 'node:test';
import assert from 'node:assert/strict';

import { isCacheableProof } from '../js/symbolic/evidence/cache-policy.js';
import { SOLVER_STATUS } from '../js/symbolic/solver/result.js';
import { PROOF_AUTHORITY } from '../js/symbolic/solver/backend.js';
import { COMPLETENESS_STATUS } from '../js/symbolic/translate/support-matrix.js';

function clean({ completeness, ...rest } = {}) {
  return {
    verdict: 'proved',
    solverStatus: SOLVER_STATUS.UNSAT,
    completeness,
    hasUnresolvedUnknowns: false,
    proofAuthority: PROOF_AUTHORITY.EXACT,
    capabilityFingerprint: 'fp',
    backendId: 'solver',
    backendVersion: '1',
    preconditionStatus: 'satisfiable',
    ...rest,
  };
}

const allComplete = Object.freeze({
  translation: COMPLETENESS_STATUS.COMPLETE,
  controlFlow: COMPLETENESS_STATUS.COMPLETE,
  memoryEffects: COMPLETENESS_STATUS.COMPLETE,
  pathCoverage: COMPLETENESS_STATUS.COMPLETE,
  queryScope: COMPLETENESS_STATUS.COMPLETE,
});

test('#3238 null/missing/empty completeness is not cacheable', () => {
  assert.equal(isCacheableProof(clean({ completeness: null })), false);
  assert.equal(isCacheableProof(clean({})), false);
  assert.equal(isCacheableProof(clean({ completeness: {} })), false);
  assert.equal(isCacheableProof(clean({ completeness: 42 })), false);
});

test('#3238 every missing or non-complete axis fails closed', () => {
  for (const axis of ['translation', 'controlFlow', 'memoryEffects', 'pathCoverage', 'queryScope']) {
    const partial = { ...allComplete, [axis]: COMPLETENESS_STATUS.PARTIAL };
    assert.equal(isCacheableProof(clean({ completeness: partial })), false, axis);
    const missing = { ...allComplete };
    delete missing[axis];
    assert.equal(isCacheableProof(clean({ completeness: missing })), false, `${axis} missing`);
    const unsupported = { ...allComplete, [axis]: COMPLETENESS_STATUS.UNSUPPORTED };
    assert.equal(isCacheableProof(clean({ completeness: unsupported })), false, `${axis} unsupported`);
    const unknownValue = { ...allComplete, [axis]: 'totally-unknown' };
    assert.equal(isCacheableProof(clean({ completeness: unknownValue })), false, `${axis} unknown`);
  }
});

test('#3238 translation-only complete (legacy createCompleteness default) still fails closed', () => {
  assert.equal(
    isCacheableProof(clean({ completeness: createCompletenessDefaults() })),
    false,
  );
  function createCompletenessDefaults() {
    return {
      translation: COMPLETENESS_STATUS.COMPLETE,
      controlFlow: COMPLETENESS_STATUS.PARTIAL,
      memoryEffects: COMPLETENESS_STATUS.PARTIAL,
      pathCoverage: COMPLETENESS_STATUS.PARTIAL,
      queryScope: COMPLETENESS_STATUS.PARTIAL,
    };
  }
});

test('#3238 fully complete five-axis certificate stays cacheable for proved and refuted', () => {
  assert.equal(isCacheableProof(clean({ completeness: allComplete })), true);
  assert.equal(
    isCacheableProof(clean({ completeness: allComplete, verdict: 'refuted', solverStatus: SOLVER_STATUS.SAT })),
    true,
  );
});
