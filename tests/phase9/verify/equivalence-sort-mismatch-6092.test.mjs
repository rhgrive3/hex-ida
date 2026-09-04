import assert from 'node:assert/strict';
import test from 'node:test';

import { createBv, createBool } from '../../../js/symbolic/expr/factory.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';
import { FakeSolverBackend } from '../../../js/symbolic/solver/fake-backend.js';
import { VERDICT } from '../../../js/symbolic/verify/query.js';
import { verifyBoundedEquivalence } from '../../../js/symbolic/verify/equivalence.js';

// Issue 6092: sort mismatch must not bypass the vacuous-proof guard.
test('6092: BV8 vs BV16 with contradictory preconditions is not REFUTED', async () => {
  const backend = new FakeSolverBackend({ defaultStatus: SOLVER_STATUS.UNSAT });
  const res = await verifyBoundedEquivalence({
    beforeTarget: createBv(8, 1n),
    afterTarget: createBv(16, 1n),
    preconditions: createBool(false),
    backend,
  });
  assert.notEqual(res.verdict, VERDICT.REFUTED);
  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.equal(res.reasonCode, 'inconsistent-preconditions');
});

test('6092: sort mismatch without preconditions is UNKNOWN, never fake SAT', async () => {
  const backend = new FakeSolverBackend();
  const res = await verifyBoundedEquivalence({
    beforeTarget: createBv(8, 42),
    afterTarget: createBv(32, 42),
    backend,
  });
  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.equal(res.reasonCode, 'sort-width-mismatch');
  assert.notEqual(res.solverStatus, SOLVER_STATUS.SAT);
  assert.equal(res.query, null);
  assert.equal(res.solverResult, null);
});

test('6092: sort mismatch with satisfiable preconditions stays UNKNOWN', async () => {
  const backend = new FakeSolverBackend({ defaultStatus: SOLVER_STATUS.SAT });
  const res = await verifyBoundedEquivalence({
    beforeTarget: createBv(8, 1n),
    afterTarget: createBv(16, 1n),
    preconditions: createBool(true),
    backend,
  });
  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.equal(res.reasonCode, 'sort-width-mismatch');
});
