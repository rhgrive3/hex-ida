import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SOLVER_STATUS,
  isSolverFailure,
  isValidSolverResult,
} from '../js/symbolic/solver/result.js';

test('#5820 unknown truthy statuses are treated as failures (fail-closed)', () => {
  assert.equal(isSolverFailure({ status: 'garbage' }), true);
  assert.equal(isSolverFailure({ status: 'proved' }), true);
  assert.equal(isSolverFailure({ status: 'SAT' }), true, 'case-sensitive taxonomy');
  assert.equal(isSolverFailure({ status: 1 }), true);
});

test('#5820 the strict taxonomy policy is unchanged for known statuses', () => {
  assert.equal(isSolverFailure({ status: SOLVER_STATUS.SAT }), false);
  assert.equal(isSolverFailure({ status: SOLVER_STATUS.UNSAT }), false);
  for (const status of [
    SOLVER_STATUS.UNKNOWN,
    SOLVER_STATUS.TIMEOUT,
    SOLVER_STATUS.RESOURCE_LIMIT,
    SOLVER_STATUS.UNSUPPORTED,
    SOLVER_STATUS.CANCELLED,
    SOLVER_STATUS.PROVIDER_FAILURE,
    SOLVER_STATUS.INVALID_QUERY,
  ]) {
    assert.equal(isSolverFailure({ status }), true);
  }
  assert.equal(isSolverFailure(null), true);
  assert.equal(isSolverFailure({}), true);
});

test('#5820 out-of-taxonomy statuses fail both predicates (policy alignment)', () => {
  // isValidSolverResult rejects unknown statuses via taxonomy membership; the
  // failure predicate must not treat them as successes either.
  for (const status of ['garbage', 'proved', '']) {
    assert.equal(isValidSolverResult({ status, model: null, backend: 'b', backendVersion: '1', lifecycle: {} }), false);
    assert.equal(isSolverFailure({ status }), true);
  }
});
