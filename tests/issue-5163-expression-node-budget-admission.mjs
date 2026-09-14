import assert from 'node:assert/strict';
import test from 'node:test';

import { bvSort, BV_UNARY_OP, BV_COMPARE_OP } from '../js/symbolic/expr/kinds.js';
import { createBv, createCompare, createFreshSymbol, createUnary } from '../js/symbolic/expr/factory.js';
import {
  CLAIM_KIND,
  VERIFICATION_QUERY_KIND,
  createVerificationQuery,
} from '../js/symbolic/verify/query.js';
import { ExhaustiveBvBackend } from '../js/symbolic/solver/exhaustive-backend.js';
import { SOLVER_STATUS } from '../js/symbolic/solver/result.js';

// #5163 — maxExprNodes must be an admission bound enforced *during* expression-graph
// traversal, not a post-hoc check after a full (recursive) walk.

const BUDGET_REASON = 'expression-node-budget-exceeded';

function deepChainQuery(depth) {
  let expr = createFreshSymbol(bvSort(8), 'x5163');
  for (let i = 0; i < depth; i++) expr = createUnary(BV_UNARY_OP.NOT, expr);
  return createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
    targetEntity: 'q5163',
    assertion: createCompare(BV_COMPARE_OP.EQ, expr, createBv(8, 0n)),
  });
}

function smallQuery() {
  const x = createFreshSymbol(bvSort(1), 'y5163');
  return createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
    targetEntity: 'q5163small',
    assertion: createCompare(BV_COMPARE_OP.EQ, x, createBv(1, 0n)),
  });
}

test('#5163 an over-budget deep chain resolves RESOURCE_LIMIT without recursing the JS stack', async () => {
  const backend = new ExhaustiveBvBackend({ maxBvWidth: 8, maxAssignments: 4096 });
  const session = backend.createSession();
  const query = deepChainQuery(300); // ~302 expression nodes, under the query metadata depth cap
  const result = await session.check(query, { maxExprNodes: 20 });
  assert.equal(result.status, SOLVER_STATUS.RESOURCE_LIMIT);
  assert.equal(result.reason, BUDGET_REASON);
});

test('#5163 within-budget small query still collects symbols and decides normally (no false budget rejection)', async () => {
  const backend = new ExhaustiveBvBackend({ maxBvWidth: 8 });
  const session = backend.createSession();
  const result = await session.check(smallQuery(), { maxExprNodes: 1000 });
  assert.notEqual(result.reason, BUDGET_REASON);
  assert.ok(
    result.status === SOLVER_STATUS.UNSAT || result.status === SOLVER_STATUS.SAT,
    `expected a decision, got ${result.status}`,
  );
});

test('#5163 exactly-at-budget traversal does not spuriously short-circuit the admission check one node early', async () => {
  const backend = new ExhaustiveBvBackend({ maxBvWidth: 8 });
  const session = backend.createSession();
  // depth 10 -> 12 expression nodes (x, 10 NOT, compare). Budget 12 admits it.
  const query = deepChainQuery(10);
  const over = await session.check(query, { maxExprNodes: 5 });
  assert.equal(over.status, SOLVER_STATUS.RESOURCE_LIMIT);
  assert.equal(over.reason, BUDGET_REASON);
  // Same graph with a generous budget is admitted and decided.
  const ok = await session.check(deepChainQuery(10), { maxExprNodes: 100000, maxAssignments: 4096 });
  assert.notEqual(ok.reason, BUDGET_REASON);
});
