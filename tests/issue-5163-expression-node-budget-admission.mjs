import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resetSymbolCounterForTesting,
  createFreshSymbol,
  restoreFreshSymbol,
  createConnective,
  createCompare,
  createBv,
  createUnknownSemantic,
} from '../js/symbolic/expr/factory.js';
import {
  EXPR_KIND,
  boolSort,
  bvSort,
  BOOL_CONNECTIVE_OP,
  BV_COMPARE_OP,
} from '../js/symbolic/expr/kinds.js';
import {
  createVerificationQuery,
  VERIFICATION_QUERY_KIND,
  CLAIM_KIND,
} from '../js/symbolic/verify/query.js';
import { ExhaustiveBvBackend } from '../js/symbolic/solver/exhaustive-backend.js';
import { SOLVER_STATUS } from '../js/symbolic/solver/result.js';

const BUDGET_REASON = 'expression-node-budget-exceeded';

function queryFor(assertion, constraints = []) {
  return createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    targetEntity: 'issue-5163',
    constraints,
    assertion,
  });
}

async function run(assertion, options = {}, constraints = []) {
  const backend = new ExhaustiveBvBackend();
  const query = queryFor(assertion, constraints);
  const result = await backend.createSession().check(query, options);
  return { query, result };
}

function notChain(leaf, links) {
  let expr = leaf;
  for (let i = 0; i < links; i++) expr = createConnective(BOOL_CONNECTIVE_OP.NOT, expr);
  return expr;
}

test('#5163 10-node chain stays within maxExprNodes:10 and is solved normally', async () => {
  resetSymbolCounterForTesting(0);
  const x = createFreshSymbol(boolSort(), 'x');
  const assertion = notChain(x, 9);
  const { result } = await run(assertion, { maxExprNodes: 10 });
  assert.notEqual(result.status, SOLVER_STATUS.RESOURCE_LIMIT);
  assert.equal(result.status, SOLVER_STATUS.SAT);
  assert.equal(result.model[x.symbolId], false);
});

test('#5163 11-node chain exceeds maxExprNodes:10 with node-budget RESOURCE_LIMIT', async () => {
  resetSymbolCounterForTesting(0);
  const x = createFreshSymbol(boolSort(), 'x');
  const assertion = notChain(x, 10);
  const { result } = await run(assertion, { maxExprNodes: 10 });
  assert.equal(result.status, SOLVER_STATUS.RESOURCE_LIMIT);
  assert.equal(result.reason, BUDGET_REASON);
});

test('#5163 50k-node wide DAG with maxExprNodes:10 rejects without traversing the whole graph', async () => {
  resetSymbolCounterForTesting(0);
  const leafSort = boolSort();
  let childArrayReads = 0;
  const leaves = Array.from({ length: 50000 }, () => Object.freeze({
    kind: EXPR_KIND.CONST,
    sort: leafSort,
    value: true,
  }));
  const args = new Proxy(leaves, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) childArrayReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const assertion = Object.freeze({
    kind: EXPR_KIND.CONNECTIVE,
    sort: leafSort,
    op: BOOL_CONNECTIVE_OP.AND,
    args,
  });
  const query = queryFor(assertion);
  const readsAfterQueryConstruction = childArrayReads;

  const backend = new ExhaustiveBvBackend();
  const result = await backend.createSession().check(query, { maxExprNodes: 10 });

  assert.equal(result.status, SOLVER_STATUS.RESOURCE_LIMIT);
  assert.equal(result.reason, BUDGET_REASON);
  const traversedChildReads = childArrayReads - readsAfterQueryConstruction;
  assert.ok(
    traversedChildReads < 100,
    `budget-exceeded admission must stop at node 11, but ${traversedChildReads} child-array elements were still read`,
  );
});

test('#5163 deep chain within the legal query depth rejects via RESOURCE_LIMIT, never a stack failure', async () => {
  resetSymbolCounterForTesting(0);
  const x = createFreshSymbol(boolSort(), 'x');
  const assertion = notChain(x, 250);
  const { result } = await run(assertion, { maxExprNodes: 10 });
  assert.notEqual(result.status, SOLVER_STATUS.PROVIDER_FAILURE);
  assert.equal(result.status, SOLVER_STATUS.RESOURCE_LIMIT);
  assert.equal(result.reason, BUDGET_REASON);
});

test('#5163 shared subterms stay counted once by the visited semantics', async () => {
  resetSymbolCounterForTesting(0);
  const x = createFreshSymbol(bvSort(8), 'x');
  const shared = createCompare(BV_COMPARE_OP.EQ, x, createBv(8, 5n));
  const assertion = createConnective(BOOL_CONNECTIVE_OP.AND, shared, shared);

  const exactBudget = await run(assertion, { maxExprNodes: 4 });
  assert.notEqual(exactBudget.result.status, SOLVER_STATUS.RESOURCE_LIMIT);
  assert.equal(exactBudget.result.status, SOLVER_STATUS.SAT);
  assert.equal(exactBudget.result.model[x.symbolId], 5n);

  const oneBelow = await run(assertion, { maxExprNodes: 3 });
  assert.equal(oneBelow.result.status, SOLVER_STATUS.RESOURCE_LIMIT);
  assert.equal(oneBelow.result.reason, BUDGET_REASON);
});

test('#5163 malformed node inside the budget keeps the prior UNSUPPORTED verdict', async () => {
  resetSymbolCounterForTesting(0);
  const assertion = createUnknownSemantic(boolSort(), 'opaque-call');
  const { result } = await run(assertion, { maxExprNodes: 10 });
  assert.equal(result.status, SOLVER_STATUS.UNSUPPORTED);
  assert.equal(result.reason, 'unknown-semantic:opaque-call');
});

test('#5163 symbol collection and sort-conflict detection keep working under the budget path', async () => {
  resetSymbolCounterForTesting(0);
  const x = createFreshSymbol(bvSort(8), 'x');
  const y = createFreshSymbol(bvSort(8), 'y');
  const assertion = createConnective(
    BOOL_CONNECTIVE_OP.AND,
    createCompare(BV_COMPARE_OP.EQ, x, createBv(8, 3n)),
    createCompare(BV_COMPARE_OP.EQ, y, createBv(8, 7n)),
  );
  const sat = await run(assertion, { maxExprNodes: 100 });
  assert.equal(sat.result.status, SOLVER_STATUS.SAT);
  assert.equal(sat.result.model[x.symbolId], 3n);
  assert.equal(sat.result.model[y.symbolId], 7n);

  const clashA = restoreFreshSymbol(bvSort(8), 'a', 'sym_1_a');
  const clashB = restoreFreshSymbol(boolSort(), 'a', 'sym_1_a');
  const conflict = await run(
    createConnective(BOOL_CONNECTIVE_OP.AND, createCompare(BV_COMPARE_OP.EQ, clashA, createBv(8, 1n)), createConnective(BOOL_CONNECTIVE_OP.NOT, clashB)),
    { maxExprNodes: 100 },
  );
  assert.equal(conflict.result.status, SOLVER_STATUS.UNSUPPORTED);
  assert.equal(conflict.result.reason, 'symbol-sort-conflict');
});
