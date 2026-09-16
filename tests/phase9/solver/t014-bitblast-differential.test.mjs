import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bvSort, BV_BINARY_OP, BV_COMPARE_OP, BV_UNARY_OP,
} from '../../../js/symbolic/expr/kinds.js';
import {
  createBv, createFreshSymbol, createBinary, createCompare, createUnary,
} from '../../../js/symbolic/expr/factory.js';
import { evaluateExpr, EVAL_STATUS } from '../../../js/symbolic/expr/evaluate.js';
import { createVerificationQuery, VERIFICATION_QUERY_KIND, CLAIM_KIND } from '../../../js/symbolic/verify/query.js';
import { BitBlastBvBackend } from '../../../js/symbolic/solver/bitblast-backend.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';

function query(assertion, constraints = []) {
  return createVerificationQuery({ kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY, claimKind: CLAIM_KIND.EDGE_FEASIBLE, targetEntity: 't014-differential', constraints, assertion });
}

const BINARY = Object.values(BV_BINARY_OP);
const COMPARE = Object.values(BV_COMPARE_OP);

test('T014 bitblast agrees with evaluator for complete 3-bit binary/compare domains', async () => {
  const width = 3;
  const backend = new BitBlastBvBackend({ maxBvWidth: 8, maxDecisions: 200000, maxPropagations: 2000000 });
  for (const op of BINARY) {
    for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) {
      const x = createFreshSymbol(bvSort(width), `x_${op}_${a}_${b}`);
      const y = createFreshSymbol(bvSort(width), `y_${op}_${a}_${b}`);
      const expr = createBinary(op, x, y);
      const expected = evaluateExpr(expr, new Map([[x.symbolId, BigInt(a)], [y.symbolId, BigInt(b)]]));
      assert.equal(expected.status, EVAL_STATUS.VALUE);
      const constraints = [createCompare(BV_COMPARE_OP.EQ, x, createBv(width, BigInt(a))), createCompare(BV_COMPARE_OP.EQ, y, createBv(width, BigInt(b)))];
      const assertion = createCompare(BV_COMPARE_OP.EQ, expr, createBv(width, expected.value));
      const result = await backend.createSession({ timeoutMs: 0 }).check(query(assertion, constraints), { timeoutMs: 1000 });
      assert.equal(result.status, SOLVER_STATUS.SAT, `${op}(${a},${b}) expected ${expected.value}`);
    }
  }
  for (const op of COMPARE) {
    for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) {
      const x = createFreshSymbol(bvSort(width), `cx_${op}_${a}_${b}`);
      const y = createFreshSymbol(bvSort(width), `cy_${op}_${a}_${b}`);
      const expr = createCompare(op, x, y);
      const expected = evaluateExpr(expr, new Map([[x.symbolId, BigInt(a)], [y.symbolId, BigInt(b)]]));
      assert.equal(expected.status, EVAL_STATUS.VALUE);
      const constraints = [createCompare(BV_COMPARE_OP.EQ, x, createBv(width, BigInt(a))), createCompare(BV_COMPARE_OP.EQ, y, createBv(width, BigInt(b)))];
      const assertion = expected.value ? expr : createCompare(BV_COMPARE_OP.NE, x, y); // placeholder replaced below when false
      const q = query(expected.value ? expr : { ...expr });
      const actualAssertion = expected.value ? expr : null;
      // For false comparisons, assert equality of the comparison to false via a bool connective-free contradiction check:
      // constrain the opposite numeric relation by asking the same comparison as the query and expect UNSAT.
      const result = await backend.createSession({ timeoutMs: 0 }).check(query(expr, constraints), { timeoutMs: 1000 });
      assert.equal(result.status, expected.value ? SOLVER_STATUS.SAT : SOLVER_STATUS.UNSAT, `${op}(${a},${b}) expected ${expected.value}`);
    }
  }
});

test('T014 bitblast unary operations agree with evaluator across complete 4-bit domain', async () => {
  const width = 4;
  const backend = new BitBlastBvBackend({ maxBvWidth: 8 });
  for (const op of Object.values(BV_UNARY_OP)) {
    for (let a = 0; a < 16; a++) {
      const x = createFreshSymbol(bvSort(width), `u_${op}_${a}`);
      const expr = createUnary(op, x);
      const expected = evaluateExpr(expr, new Map([[x.symbolId, BigInt(a)]]));
      const constraints = [createCompare(BV_COMPARE_OP.EQ, x, createBv(width, BigInt(a)))];
      const assertion = createCompare(BV_COMPARE_OP.EQ, expr, createBv(width, expected.value));
      const result = await backend.createSession({ timeoutMs: 0 }).check(query(assertion, constraints), { timeoutMs: 1000 });
      assert.equal(result.status, SOLVER_STATUS.SAT, `${op}(${a})`);
    }
  }
});
