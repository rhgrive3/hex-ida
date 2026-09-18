import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bvSort,
  BV_BINARY_OP,
  BV_COMPARE_OP,
  BV_UNARY_OP,
  BOOL_CONNECTIVE_OP,
} from '../../../js/symbolic/expr/kinds.js';
import {
  createBinary,
  createBv,
  createCompare,
  createConnective,
  createFreshSymbol,
  createUnary,
} from '../../../js/symbolic/expr/factory.js';
import { evaluateExpr } from '../../../js/symbolic/expr/evaluate.js';
import { BitBlastBvBackend } from '../../../js/symbolic/solver/bitblast-backend.js';
import { ExhaustiveBvBackend } from '../../../js/symbolic/solver/exhaustive-backend.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';
import {
  CLAIM_KIND,
  VERIFICATION_QUERY_KIND,
  createVerificationQuery,
} from '../../../js/symbolic/verify/query.js';
import { validateSatModel } from '../../../js/symbolic/verify/validate-model.js';

const bitblast = new BitBlastBvBackend({ maxBvWidth: 8 });
const exhaustive = new ExhaustiveBvBackend({ maxBvWidth: 8 });

function query(assertion, constraints, targetEntity) {
  return createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    targetEntity,
    constraints,
    assertion,
  });
}

async function crossCheck(candidate, expected, label) {
  const [actual, oracle] = await Promise.all([
    bitblast.createSession().check(candidate, { timeoutMs: 2000 }),
    exhaustive.createSession().check(candidate, { timeoutMs: 2000 }),
  ]);
  assert.equal(actual.status, oracle.status, `${label}: exact backends disagree`);
  assert.equal(actual.status, expected, `${label}: unexpected decision (${actual.reason || 'no reason'})`);
  if (actual.status === SOLVER_STATUS.SAT) {
    assert.equal(validateSatModel(candidate, actual.model).valid, true, `${label}: invalid SAT model`);
  }
}

function boundaryPairs(width) {
  const mask = (1n << BigInt(width)) - 1n;
  const sign = 1n << BigInt(width - 1);
  return [
    [0n, 0n],
    [1n & mask, 0n],
    [mask, 1n & mask],
    [sign, mask],
    [mask, sign],
  ];
}

test('bitblast agrees with exhaustive on SAT/UNSAT for every Bool/BV operation across widths 1-8', async () => {
  for (let width = 1; width <= 8; width++) {
    for (const [leftValue, rightValue] of boundaryPairs(width)) {
      for (const op of Object.values(BV_BINARY_OP)) {
        const left = createFreshSymbol(bvSort(width), `diff_l_${width}_${op}_${leftValue}_${rightValue}`);
        const right = createFreshSymbol(bvSort(width), `diff_r_${width}_${op}_${leftValue}_${rightValue}`);
        const expression = createBinary(op, left, right);
        const expected = evaluateExpr(expression, {
          [left.symbolId]: leftValue,
          [right.symbolId]: rightValue,
        }).value;
        const constraints = [
          createCompare(BV_COMPARE_OP.EQ, left, createBv(width, leftValue)),
          createCompare(BV_COMPARE_OP.EQ, right, createBv(width, rightValue)),
        ];
        await crossCheck(
          query(createCompare(BV_COMPARE_OP.EQ, expression, createBv(width, expected)), constraints, `sat:${width}:${op}`),
          SOLVER_STATUS.SAT,
          `BV${width}:${op}:sat`,
        );
        await crossCheck(
          query(createCompare(BV_COMPARE_OP.NE, expression, createBv(width, expected)), constraints, `unsat:${width}:${op}`),
          SOLVER_STATUS.UNSAT,
          `BV${width}:${op}:unsat`,
        );
      }

      for (const op of Object.values(BV_COMPARE_OP)) {
        const left = createFreshSymbol(bvSort(width), `cmp_l_${width}_${op}_${leftValue}_${rightValue}`);
        const right = createFreshSymbol(bvSort(width), `cmp_r_${width}_${op}_${leftValue}_${rightValue}`);
        const expression = createCompare(op, left, right);
        const expected = evaluateExpr(expression, {
          [left.symbolId]: leftValue,
          [right.symbolId]: rightValue,
        }).value;
        const constraints = [
          createCompare(BV_COMPARE_OP.EQ, left, createBv(width, leftValue)),
          createCompare(BV_COMPARE_OP.EQ, right, createBv(width, rightValue)),
        ];
        const negated = createConnective(BOOL_CONNECTIVE_OP.NOT, expression);
        await crossCheck(
          query(expected ? expression : negated, constraints, `cmp-sat:${width}:${op}`),
          SOLVER_STATUS.SAT,
          `BV${width}:${op}:cmp-sat`,
        );
        await crossCheck(
          query(expected ? negated : expression, constraints, `cmp-unsat:${width}:${op}`),
          SOLVER_STATUS.UNSAT,
          `BV${width}:${op}:cmp-unsat`,
        );
      }
    }

    for (const op of Object.values(BV_UNARY_OP)) {
      const mask = (1n << BigInt(width)) - 1n;
      for (const value of [0n, 1n & mask, mask]) {
        const symbol = createFreshSymbol(bvSort(width), `unary_${width}_${op}_${value}`);
        const expression = createUnary(op, symbol);
        const expected = evaluateExpr(expression, { [symbol.symbolId]: value }).value;
        const constraints = [createCompare(BV_COMPARE_OP.EQ, symbol, createBv(width, value))];
        await crossCheck(
          query(createCompare(BV_COMPARE_OP.EQ, expression, createBv(width, expected)), constraints, `unary-sat:${width}:${op}`),
          SOLVER_STATUS.SAT,
          `BV${width}:${op}:unary-sat`,
        );
        await crossCheck(
          query(createCompare(BV_COMPARE_OP.NE, expression, createBv(width, expected)), constraints, `unary-unsat:${width}:${op}`),
          SOLVER_STATUS.UNSAT,
          `BV${width}:${op}:unary-unsat`,
        );
      }
    }
  }
});
