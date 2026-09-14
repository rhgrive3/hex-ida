import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resetSymbolCounterForTesting,
  createFreshSymbol,
  createCompare,
  createBv,
  createBool,
} from '../../../js/symbolic/expr/factory.js';
import { bvSort, EXPR_KIND, BV_COMPARE_OP } from '../../../js/symbolic/expr/kinds.js';
import {
  createVerificationQuery,
  VERIFICATION_QUERY_KIND,
  CLAIM_KIND,
} from '../../../js/symbolic/verify/query.js';
import { validateSatModel } from '../../../js/symbolic/verify/validate-model.js';
import { ExhaustiveBvBackend } from '../../../js/symbolic/solver/exhaustive-backend.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';

const TOP = createBool(true);

function rawConst(width, value) {
  return Object.freeze({ kind: EXPR_KIND.CONST, sort: bvSort(width), value });
}

function query(assertion, constraints = []) {
  return createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    targetEntity: 'issue-3944',
    constraints,
    assertion,
  });
}

async function check(assertion, constraints = []) {
  const q = query(assertion, constraints);
  const result = await new ExhaustiveBvBackend().createSession().check(q);
  return { q, result };
}

test('#3944 raw out-of-range BV1 constant must not mint UNSAT via fixed bindings', async () => {
  resetSymbolCounterForTesting(0);
  const x = createFreshSymbol(bvSort(1), 'x');
  const { result } = await check(TOP, [
    createCompare(BV_COMPARE_OP.EQ, x, createBv(1, 0n)),
    createCompare(BV_COMPARE_OP.EQ, x, rawConst(1, 2n)),
  ]);
  assert.notEqual(result.status, SOLVER_STATUS.UNSAT, 'x==0bv1 with raw 2bv1 is SAT modulo width; never UNSAT');
  assert.equal(result.status, SOLVER_STATUS.UNSUPPORTED);
  assert.equal(result.reason, 'non-canonical-bv-constant');
});

test('#3944 raw out-of-range BV8 constant 256 follows the same rejection policy', async () => {
  resetSymbolCounterForTesting(0);
  const x = createFreshSymbol(bvSort(8), 'x');
  const { result } = await check(TOP, [
    createCompare(BV_COMPARE_OP.EQ, x, createBv(8, 0n)),
    createCompare(BV_COMPARE_OP.EQ, x, rawConst(8, 256n)),
  ]);
  assert.notEqual(result.status, SOLVER_STATUS.UNSAT);
  assert.equal(result.status, SOLVER_STATUS.UNSUPPORTED);
  assert.equal(result.reason, 'non-canonical-bv-constant');
});

test('#3944 negative raw BV constants are rejected, not silently wrapped', async () => {
  resetSymbolCounterForTesting(0);
  const x = createFreshSymbol(bvSort(8), 'x');
  const { result } = await check(TOP, [
    createCompare(BV_COMPARE_OP.EQ, x, createBv(8, 255n)),
    createCompare(BV_COMPARE_OP.EQ, x, rawConst(8, -1n)),
  ]);
  assert.notEqual(result.status, SOLVER_STATUS.UNSAT);
  assert.equal(result.status, SOLVER_STATUS.UNSUPPORTED);
  assert.equal(result.reason, 'non-canonical-bv-constant');
});

test('#3944 non-canonical constant outside the fixed-binding path is still invalid input', async () => {
  resetSymbolCounterForTesting(0);
  const x = createFreshSymbol(bvSort(1), 'x');
  const { result } = await check(createCompare(BV_COMPARE_OP.EQ, x, rawConst(1, 3n)));
  assert.notEqual(result.status, SOLVER_STATUS.SAT, 'a malformed DAG must never become a proof by accident');
  assert.notEqual(result.status, SOLVER_STATUS.UNSAT);
  assert.equal(result.status, SOLVER_STATUS.UNSUPPORTED);
  assert.equal(result.reason, 'non-canonical-bv-constant');
});

test('#3944 canonical boundary constants remain accepted', async () => {
  resetSymbolCounterForTesting(0);
  const low = createFreshSymbol(bvSort(1), 'low');
  const lowQuery = await check(TOP, [createCompare(BV_COMPARE_OP.EQ, low, createBv(1, 0n))]);
  assert.equal(lowQuery.result.status, SOLVER_STATUS.SAT);
  assert.equal(lowQuery.result.model[low.symbolId], 0n);
  assert.equal(validateSatModel(lowQuery.q, lowQuery.result.model).valid, true);

  const high = createFreshSymbol(bvSort(8), 'high');
  const highQuery = await check(TOP, [createCompare(BV_COMPARE_OP.EQ, high, createBv(8, 255n))]);
  assert.equal(highQuery.result.status, SOLVER_STATUS.SAT);
  assert.equal(highQuery.result.model[high.symbolId], 255n);
  assert.equal(validateSatModel(highQuery.q, highQuery.result.model).valid, true);
});

test('#3944 fixed-binding optimization still agrees with full evaluation on canonical input', async () => {
  resetSymbolCounterForTesting(0);
  const x = createFreshSymbol(bvSort(4), 'x');
  const agreed = await check(createCompare(BV_COMPARE_OP.EQ, x, createBv(4, 9n)), [
    createCompare(BV_COMPARE_OP.EQ, x, createBv(4, 9n)),
  ]);
  assert.equal(agreed.result.status, SOLVER_STATUS.SAT);
  assert.equal(agreed.result.model[x.symbolId], 9n);
  assert.equal(validateSatModel(agreed.q, agreed.result.model).valid, true);

  const realConflict = await check(TOP, [
    createCompare(BV_COMPARE_OP.EQ, x, createBv(4, 9n)),
    createCompare(BV_COMPARE_OP.EQ, x, createBv(4, 10n)),
  ]);
  assert.equal(realConflict.result.status, SOLVER_STATUS.UNSAT, 'distinct canonical bindings are a genuine UNSAT proof');
  assert.equal(realConflict.result.lifecycle.publishable, true);
});
