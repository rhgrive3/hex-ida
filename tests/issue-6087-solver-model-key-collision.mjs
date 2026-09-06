import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resetSymbolCounterForTesting,
  createFreshSymbol,
  createConnective,
  createCompare,
  createBv,
} from '../js/symbolic/expr/factory.js';
import {
  boolSort,
  bvSort,
  BOOL_CONNECTIVE_OP,
  BV_COMPARE_OP,
} from '../js/symbolic/expr/kinds.js';
import { evaluateExpr, EVAL_STATUS } from '../js/symbolic/expr/evaluate.js';
import {
  createVerificationQuery,
  VERIFICATION_QUERY_KIND,
  CLAIM_KIND,
} from '../js/symbolic/verify/query.js';
import { validateSatModel } from '../js/symbolic/verify/validate-model.js';
import { ExhaustiveBvBackend } from '../js/symbolic/solver/exhaustive-backend.js';
import { SOLVER_STATUS } from '../js/symbolic/solver/result.js';

function queryFor(assertion, constraints = []) {
  return createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    targetEntity: 'issue-6087',
    constraints,
    assertion,
  });
}

async function check(backend, assertion, constraints = []) {
  const query = queryFor(assertion, constraints);
  const result = await backend.createSession().check(query);
  return { query, result };
}

test('#6087 name(A) === symbolId(B): Bool A XOR B is SAT with independent bindings', async () => {
  resetSymbolCounterForTesting(0);
  // Allocator starts at 1: A.symbolId = 'sym_1_sym_2_b', A.name = 'sym_2_b';
  // B.symbolId = 'sym_2_b', B.name = 'b'. A's name collides with B's symbolId.
  const a = createFreshSymbol(boolSort(), 'sym_2_b');
  const b = createFreshSymbol(boolSort(), 'b');
  assert.equal(a.name, 'sym_2_b');
  assert.equal(b.symbolId, 'sym_2_b');
  assert.notEqual(a.symbolId, b.symbolId);

  const backend = new ExhaustiveBvBackend();
  const xorAssertion = createConnective(BOOL_CONNECTIVE_OP.XOR, a, b);
  const { query, result } = await check(backend, xorAssertion);
  assert.equal(result.status, SOLVER_STATUS.SAT, 'A XOR B must be SAT; name/symbolId collision must not fake UNSAT');
  assert.ok(result.model);
  assert.equal(validateSatModel(query, result.model).valid, true);

  // Witness replay through the public evaluator keeps A and B independent.
  const replay = evaluateExpr(xorAssertion, result.model);
  assert.equal(replay.status, EVAL_STATUS.VALUE);
  assert.equal(replay.value, true);
});

test('#6087 witness A=false,B=true and A=true,B=false both satisfy A XOR B', async () => {
  resetSymbolCounterForTesting(0);
  const a = createFreshSymbol(boolSort(), 'sym_2_b');
  const b = createFreshSymbol(boolSort(), 'b');
  const xor = createConnective(BOOL_CONNECTIVE_OP.XOR, a, b);
  const model1 = new Map([[a.symbolId, false], [b.symbolId, true]]);
  const model2 = new Map([[a.symbolId, true], [b.symbolId, false]]);
  assert.equal(evaluateExpr(xor, Object.fromEntries(model1)).value, true);
  assert.equal(evaluateExpr(xor, Object.fromEntries(model2)).value, true);
});

test('#6087 BV symbols do not alias across name/symbolId namespaces', async () => {
  resetSymbolCounterForTesting(0);
  const a = createFreshSymbol(bvSort(4), 'sym_2_b');
  const b = createFreshSymbol(bvSort(4), 'b');
  const assertion = createConnective(
    BOOL_CONNECTIVE_OP.AND,
    createCompare(BV_COMPARE_OP.EQ, a, createBv(4, 3n)),
    createCompare(BV_COMPARE_OP.EQ, b, createBv(4, 5n)),
  );
  const backend = new ExhaustiveBvBackend();
  const { query, result } = await check(backend, assertion);
  assert.equal(result.status, SOLVER_STATUS.SAT, 'a=3 AND b=5 must be SAT');
  assert.equal(validateSatModel(query, result.model).valid, true);
  assert.equal(result.model[a.symbolId], 3n);
  assert.equal(result.model[b.symbolId], 5n);
});

test('#6087 UNSAT formula A XOR A stays UNSAT', async () => {
  resetSymbolCounterForTesting(0);
  const a = createFreshSymbol(boolSort(), 'a');
  const backend = new ExhaustiveBvBackend();
  const { result } = await check(backend, createConnective(BOOL_CONNECTIVE_OP.XOR, a, a));
  assert.equal(result.status, SOLVER_STATUS.UNSAT);
  assert.equal(result.model, null);
});

test('#6087 duplicate display names on distinct symbolIds keep distinct bindings', async () => {
  resetSymbolCounterForTesting(0);
  const a = createFreshSymbol(boolSort(), 'shared');
  const b = createFreshSymbol(boolSort(), 'shared');
  assert.notEqual(a.symbolId, b.symbolId);
  const assertion = createConnective(BOOL_CONNECTIVE_OP.XOR, a, b);
  const backend = new ExhaustiveBvBackend();
  const { query, result } = await check(backend, assertion);
  assert.equal(result.status, SOLVER_STATUS.SAT);
  assert.equal(validateSatModel(query, result.model).valid, true);
  assert.notEqual(result.model[a.symbolId], result.model[b.symbolId]);
});
