import assert from 'node:assert/strict';
import test from 'node:test';

import { bvSort, BV_BINARY_OP } from '../js/symbolic/expr/kinds.js';
import { createFreshSymbol, createBv, createBinary } from '../js/symbolic/expr/factory.js';
import { ExhaustiveBvBackend } from '../js/symbolic/solver/exhaustive-backend.js';
import { createSolverResult, isValidSolverResult, SOLVER_STATUS } from '../js/symbolic/solver/result.js';
import { verifyBoundedEquivalence } from '../js/symbolic/verify/equivalence.js';
import { VERDICT } from '../js/symbolic/verify/query.js';

function sameExprPair() {
  const x = createFreshSymbol(bvSort(4), 'x');
  const before = createBinary(BV_BINARY_OP.ADD, x, x);
  const after = createBinary(BV_BINARY_OP.SHL, x, createBv(4, 1));
  return { before, after };
}

test('#5787 a check()-only session on the UNSAT path does not throw a TypeError', async () => {
  const { before, after } = sameExprPair();
  const session = {
    async check(query) {
      return { status: SOLVER_STATUS.UNSAT, queryHash: query.queryHash, lifecycle: {} };
    },
  };
  const res = await verifyBoundedEquivalence({ beforeTarget: before, afterTarget: after, session });
  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.equal(res.reasonCode, 'proof-ineligible');
  assert.equal(res.eligibility.reasons.includes('invalid-solver-result'), false);
});

function makeSession(cancelled) {
  const backend = new ExhaustiveBvBackend();
  return {
    backend,
    isCancelled() { return cancelled; },
    async check(query) {
      const result = createSolverResult({
        status: SOLVER_STATUS.UNSAT,
        backend: backend.id,
        backendVersion: backend.version,
        queryHash: query.queryHash,
      });
      assert.equal(isValidSolverResult(result, { query, backend }), true);
      return result;
    },
  };
}

test('#5787 cancellation is the decisive proof-eligibility gate for an otherwise valid UNSAT result', async () => {
  const { before, after } = sameExprPair();
  const active = await verifyBoundedEquivalence({
    beforeTarget: before,
    afterTarget: after,
    session: makeSession(false),
  });
  assert.equal(active.verdict, VERDICT.PROVED);
  assert.equal(active.reasonCode, 'proved-equivalent');

  const cancelled = await verifyBoundedEquivalence({
    beforeTarget: before,
    afterTarget: after,
    session: makeSession(true),
  });
  assert.equal(cancelled.verdict, VERDICT.UNKNOWN);
  assert.equal(cancelled.reasonCode, 'proof-ineligible');
  assert.equal(cancelled.eligibility.reasons.includes('session-cancelled'), true);
  assert.equal(cancelled.eligibility.reasons.includes('invalid-solver-result'), false);
});
