import assert from 'node:assert/strict';
import { createSolverResult, SOLVER_STATUS, isValidSolverResult } from '../js/symbolic/solver/result.js';
import { validateSatModel } from '../js/symbolic/verify/validate-model.js';
import { bvSort, BV_COMPARE_OP } from '../js/symbolic/expr/kinds.js';
import { createFreshSymbol, createBv, createCompare } from '../js/symbolic/expr/factory.js';
import { FakeSolverBackend } from '../js/symbolic/solver/fake-backend.js';
import { verifyConditionalEdgeFeasibility } from '../js/symbolic/verify/edge-feasibility.js';
import { VERDICT } from '../js/symbolic/verify/query.js';

{
  const result = createSolverResult({
    status: SOLVER_STATUS.SAT,
    model: { x: '0', nested: { list: [1, { y: 2 }] } },
    backend: 'b',
    backendVersion: '1',
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.model), 'published SAT model must be frozen');
  assert.ok(Object.isFrozen(result.model.nested));
  assert.ok(Object.isFrozen(result.model.nested.list));
  assert.ok(Object.isFrozen(result.model.nested.list[1]));
  assert.throws(() => { result.model.x = '999'; }, TypeError);
  assert.throws(() => { result.model.nested.list[0] = 9; }, TypeError);
  assert.equal(result.model.x, '0');
  assert.ok(isValidSolverResult(result));
}

{
  const src = { x: '0', nested: { a: 1 } };
  const result = createSolverResult({ status: SOLVER_STATUS.SAT, model: src });
  src.x = '7';
  src.nested.a = 9;
  assert.equal(result.model.x, '0', 'model must be an owned snapshot');
  assert.equal(result.model.nested.a, 1);
}

{
  const result = createSolverResult({ status: SOLVER_STATUS.SAT, model: new Map([['x', '0']]) });
  assert.ok(result.model instanceof Map);
  assert.throws(() => { result.model.set('x', '999'); }, TypeError);
  assert.throws(() => { result.model.delete('x'); }, TypeError);
  assert.throws(() => { result.model.clear(); }, TypeError);
  assert.equal(result.model.get('x'), '0', 'validated witness content must be unchanged');
}

{
  const result = createSolverResult({
    status: SOLVER_STATUS.SAT,
    model: new Map([['x', { deep: [1n] }]]),
  });
  assert.ok(Object.isFrozen(result.model.get('x')));
  assert.ok(Object.isFrozen(result.model.get('x').deep));
}

{
  const x = createFreshSymbol(bvSort(8), 'arg_x0');
  const query = { constraints: [createCompare(BV_COMPARE_OP.EQ, x, createBv(8, 42n))] };
  const sat = createSolverResult({ status: SOLVER_STATUS.SAT, model: new Map([['arg_x0', 42n]]) });
  assert.equal(validateSatModel(query, sat.model).valid, true, 'exact validation on frozen map models must not regress');
  const wrong = createSolverResult({ status: SOLVER_STATUS.SAT, model: { arg_x0: 999n } });
  assert.equal(validateSatModel(query, wrong.model).valid, false);
  const objSat = createSolverResult({ status: SOLVER_STATUS.SAT, model: { arg_x0: 42n } });
  assert.equal(validateSatModel(query, objSat.model).valid, true);
}

{
  const x64 = createFreshSymbol(bvSort(64), 'arg_x0');
  const edgeCond = createCompare(BV_COMPARE_OP.EQ, x64, createBv(64, 42n));
  const backend = new FakeSolverBackend({ defaultStatus: SOLVER_STATUS.SAT, defaultModel: { arg_x0: 42n } });
  const verification = await verifyConditionalEdgeFeasibility({ fromBlock: 1, toBlock: 2, edgeCondition: edgeCond, backend });
  assert.equal(verification.verdict, VERDICT.REFUTED);
  assert.equal(verification.counterexampleValidation.valid, true);
  assert.throws(() => { verification.counterexample.arg_x0 = 'invalid-after-validation'; }, TypeError);
  assert.equal(verification.counterexample.arg_x0, 42n);
  assert.equal(verification.solverResult.model.arg_x0, 42n);
}

console.log('issue-3986 SolverResult immutable SAT model: ok');
