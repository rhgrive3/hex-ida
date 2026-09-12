import assert from 'node:assert/strict';
import test from 'node:test';

import {
  boolSort,
  bvSort,
  BV_BINARY_OP,
  BV_COMPARE_OP,
  BV_UNARY_OP,
  BOOL_CONNECTIVE_OP,
  CAST_OP,
} from '../../../js/symbolic/expr/kinds.js';
import {
  createBinary,
  createBool,
  createBv,
  createCast,
  createCompare,
  createConcat,
  createConnective,
  createExtract,
  createFreshSymbol,
  createIte,
  createUnary,
} from '../../../js/symbolic/expr/factory.js';
import { evaluateExpr } from '../../../js/symbolic/expr/evaluate.js';
import { BitBlastBvBackend } from '../../../js/symbolic/solver/bitblast-backend.js';
import { ExhaustiveBvBackend } from '../../../js/symbolic/solver/exhaustive-backend.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';
import { CLAIM_KIND, VERIFICATION_QUERY_KIND, createVerificationQuery } from '../../../js/symbolic/verify/query.js';
import { validateSatModel } from '../../../js/symbolic/verify/validate-model.js';

const bitblast = new BitBlastBvBackend({ maxBvWidth: 8 });
const exhaustive = new ExhaustiveBvBackend({ maxBvWidth: 8 });

function query(assertion, constraints = [], targetEntity = 'full-differential') {
  return createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    targetEntity,
    constraints,
    assertion,
  });
}

function corpusValues(width) {
  if (width <= 4) return Array.from({ length: 1 << width }, (_, value) => BigInt(value));
  const mask = (1n << BigInt(width)) - 1n;
  return [...new Set([
    0n, 1n, mask, 1n << BigInt(width - 1),
    BigInt(width - 1), BigInt(width), BigInt(width + 1),
  ].filter((value) => value <= mask).map(String))].map(BigInt);
}

async function crossCheck(candidate, expected, label) {
  const [wide, oracle] = await Promise.all([
    bitblast.createSession().check(candidate),
    exhaustive.createSession().check(candidate),
  ]);
  assert.equal(wide.status, oracle.status, `${label}: exact backends disagree`);
  assert.equal(wide.status, expected, `${label}: unexpected decision (${wide.reason || 'no reason'})`);
  if (expected === SOLVER_STATUS.SAT) assert.equal(validateSatModel(candidate, wide.model).valid, true, `${label}: invalid model`);
}

async function checkConcreteExpression(expression, expected, constraints, outputWidth, label) {
  const positiveAssertion = expression.sort.kind === 'bool'
    ? (expected ? expression : createConnective(BOOL_CONNECTIVE_OP.NOT, expression))
    : createCompare(BV_COMPARE_OP.EQ, expression, createBv(outputWidth, expected));
  const negativeAssertion = expression.sort.kind === 'bool'
    ? (expected ? createConnective(BOOL_CONNECTIVE_OP.NOT, expression) : expression)
    : createCompare(BV_COMPARE_OP.NE, expression, createBv(outputWidth, expected));
  await crossCheck(query(positiveAssertion, constraints, `${label}:positive`), SOLVER_STATUS.SAT, `${label}:positive`);
  await crossCheck(query(negativeAssertion, constraints, `${label}:negative`), SOLVER_STATUS.UNSAT, `${label}:negative`);
}

test('bitblast/exhaustive differential covers every QF_BV operation at widths 1-8', async () => {
  for (let width = 1; width <= 8; width++) {
    const values = corpusValues(width);
    for (const op of Object.values(BV_BINARY_OP)) {
      for (const leftValue of values) for (const rightValue of values) {
        const left = createFreshSymbol(bvSort(width), `full_l_${width}_${op}_${leftValue}_${rightValue}`);
        const right = createFreshSymbol(bvSort(width), `full_r_${width}_${op}_${leftValue}_${rightValue}`);
        const expression = createBinary(op, left, right);
        const expected = evaluateExpr(expression, { [left.symbolId]: leftValue, [right.symbolId]: rightValue }).value;
        const constraints = [
          createCompare(BV_COMPARE_OP.EQ, left, createBv(width, leftValue)),
          createCompare(BV_COMPARE_OP.EQ, right, createBv(width, rightValue)),
        ];
        await checkConcreteExpression(expression, expected, constraints, width, `BV${width}:${op}:${leftValue}:${rightValue}`);
      }
    }

    for (const op of Object.values(BV_COMPARE_OP)) {
      for (const leftValue of values) for (const rightValue of values) {
        const left = createFreshSymbol(bvSort(width), `cmp_l_${width}_${op}_${leftValue}_${rightValue}`);
        const right = createFreshSymbol(bvSort(width), `cmp_r_${width}_${op}_${leftValue}_${rightValue}`);
        const expression = createCompare(op, left, right);
        const expected = evaluateExpr(expression, { [left.symbolId]: leftValue, [right.symbolId]: rightValue }).value;
        const constraints = [
          createCompare(BV_COMPARE_OP.EQ, left, createBv(width, leftValue)),
          createCompare(BV_COMPARE_OP.EQ, right, createBv(width, rightValue)),
        ];
        await checkConcreteExpression(expression, expected, constraints, null, `BV${width}:cmp:${op}:${leftValue}:${rightValue}`);
      }
    }

    for (const op of Object.values(BV_UNARY_OP)) for (const value of values) {
      const symbol = createFreshSymbol(bvSort(width), `unary_${width}_${op}_${value}`);
      const expression = createUnary(op, symbol);
      const expected = evaluateExpr(expression, { [symbol.symbolId]: value }).value;
      await checkConcreteExpression(expression, expected, [
        createCompare(BV_COMPARE_OP.EQ, symbol, createBv(width, value)),
      ], width, `BV${width}:unary:${op}:${value}`);
    }

    const structuralValues = values.slice(0, Math.min(4, values.length));
    for (const value of structuralValues) {
      const symbol = createFreshSymbol(bvSort(width), `struct_${width}_${value}`);
      const bound = [createCompare(BV_COMPARE_OP.EQ, symbol, createBv(width, value))];
      const condition = (value & 1n) === 1n;
      const ite = createIte(createBool(condition), symbol, createBv(width, 0n));
      await checkConcreteExpression(ite, condition ? value : 0n, bound, width, `BV${width}:ite:${value}`);
      const extracted = createExtract(symbol, width - 1, width - 1);
      await checkConcreteExpression(extracted, value >> BigInt(width - 1), bound, 1, `BV${width}:extract:${value}`);
      if (width > 1) {
        const trunc = createCast(CAST_OP.TRUNC, symbol, width - 1);
        await checkConcreteExpression(trunc, BigInt.asUintN(width - 1, value), bound, width - 1, `BV${width}:trunc:${value}`);
        const leftWidth = Math.floor(width / 2);
        const rightWidth = width - leftWidth;
        const leftValue = BigInt.asUintN(leftWidth, value);
        const rightValue = BigInt.asUintN(rightWidth, value >> BigInt(leftWidth));
        const concat = createConcat(createBv(leftWidth, leftValue), createBv(rightWidth, rightValue));
        const concatExpected = (leftValue << BigInt(rightWidth)) | rightValue;
        await checkConcreteExpression(concat, concatExpected, [], width, `BV${width}:concat:${value}`);
      }
      if (width < 8) {
        for (const op of [CAST_OP.ZEXT, CAST_OP.SEXT]) {
          const cast = createCast(op, symbol, width + 1);
          const expected = evaluateExpr(cast, { [symbol.symbolId]: value }).value;
          await checkConcreteExpression(cast, expected, bound, width + 1, `BV${width}:${op}:${value}`);
        }
      }
    }
  }

  for (const left of [false, true]) for (const right of [false, true]) {
    for (const op of Object.values(BOOL_CONNECTIVE_OP)) {
      if (op === BOOL_CONNECTIVE_OP.NOT) continue;
      const expression = createConnective(op, createBool(left), createBool(right));
      const expected = evaluateExpr(expression, {}).value;
      await checkConcreteExpression(expression, expected, [], null, `Bool:${op}:${left}:${right}`);
    }
    const boolIte = createIte(createBool(left), createBool(right), createBool(!right));
    await checkConcreteExpression(boolIte, left ? right : !right, [], null, `Bool:ite:${left}:${right}`);
  }
  for (const value of [false, true]) {
    await checkConcreteExpression(
      createConnective(BOOL_CONNECTIVE_OP.NOT, createBool(value)),
      !value,
      [],
      null,
      `Bool:not:${value}`,
    );
  }
});

function seededRandom(seed = 0x6d2b79f5) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

test('deterministic random formulas cross-check SAT and UNSAT decisions', async () => {
  const random = seededRandom();
  let observedSat = 0;
  let observedUnsat = 0;
  for (let index = 0; index < 96; index++) {
    const width = 1 + (random() % 8);
    const symbol = createFreshSymbol(bvSort(width), `random_formula_${index}`);
    let bvExpr = symbol;
    for (let depth = 0; depth < 4; depth++) {
      const op = Object.values(BV_BINARY_OP)[random() % Object.values(BV_BINARY_OP).length];
      bvExpr = createBinary(op, bvExpr, createBv(width, BigInt(random())));
    }
    const comparison = createCompare(
      Object.values(BV_COMPARE_OP)[random() % Object.values(BV_COMPARE_OP).length],
      bvExpr,
      createBv(width, BigInt(random())),
    );
    const decorated = createConnective(
      Object.values([BOOL_CONNECTIVE_OP.XOR, BOOL_CONNECTIVE_OP.IMPLIES, BOOL_CONNECTIVE_OP.EQ])[random() % 3],
      comparison,
      createBool((random() & 1) === 1),
    );
    const candidate = query(decorated, [], `random:${index}`);
    const [wide, oracle] = await Promise.all([
      bitblast.createSession().check(candidate),
      exhaustive.createSession().check(candidate),
    ]);
    assert.equal(wide.status, oracle.status, `random formula ${index}`);
    assert.ok([SOLVER_STATUS.SAT, SOLVER_STATUS.UNSAT].includes(wide.status));
    if (wide.status === SOLVER_STATUS.SAT) observedSat++;
    else observedUnsat++;

    const contradiction = query(createConnective(
      BOOL_CONNECTIVE_OP.AND,
      decorated,
      createConnective(BOOL_CONNECTIVE_OP.NOT, decorated),
    ), [], `random-unsat:${index}`);
    await crossCheck(contradiction, SOLVER_STATUS.UNSAT, `random contradiction ${index}`);
  }
  assert.ok(observedSat > 0, 'seeded corpus must exercise SAT');
  assert.ok(observedUnsat > 0, 'seeded corpus must exercise UNSAT');
});
