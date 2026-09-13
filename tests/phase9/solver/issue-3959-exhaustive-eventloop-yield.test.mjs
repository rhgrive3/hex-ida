import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFreshSymbol,
  createConnective,
  createCompare,
} from '../../../js/symbolic/expr/factory.js';
import { bvSort, BOOL_CONNECTIVE_OP, BV_COMPARE_OP } from '../../../js/symbolic/expr/kinds.js';
import {
  createVerificationQuery,
  VERIFICATION_QUERY_KIND,
  CLAIM_KIND,
} from '../../../js/symbolic/verify/query.js';
import { ExhaustiveBvBackend } from '../../../js/symbolic/solver/exhaustive-backend.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';

function alwaysFalseFullDomainQuery() {
  const x = createFreshSymbol(bvSort(8), 'x');
  const y = createFreshSymbol(bvSort(8), 'y');
  const impossible = createConnective(
    BOOL_CONNECTIVE_OP.OR,
    createCompare(BV_COMPARE_OP.NE, x, x),
    createCompare(BV_COMPARE_OP.NE, y, y),
  );
  return createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
    targetEntity: 'issue-3959',
    assertion: impossible,
  });
}

test('#3959 full-domain enumeration honors a 1ms timeout instead of publishing UNSAT', async () => {
  const backend = new ExhaustiveBvBackend({ maxBvWidth: 8, maxAssignments: 100000 });
  const session = backend.createSession();
  const query = alwaysFalseFullDomainQuery();
  const started = Date.now();
  const result = await session.check(query, {
    timeoutMs: 1,
    maxAssignments: 100000,
    yieldEvery: 1,
  });
  const elapsed = Date.now() - started;
  assert.equal(result.status, SOLVER_STATUS.TIMEOUT, 'a starved 1ms timeout must not be reported as a completed UNSAT proof');
  assert.equal(result.lifecycle.publishable, false, 'a timed-out query must never be publishable');
  assert.ok(elapsed < 2000, `timeout must bound runtime, was ${elapsed}ms`);
});

test('#3959 external AbortSignal aborted by a timer is observed with bounded latency', async () => {
  const backend = new ExhaustiveBvBackend({ maxBvWidth: 8, maxAssignments: 100000 });
  const session = backend.createSession();
  const query = alwaysFalseFullDomainQuery();
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 2);
  const result = await session.check(query, {
    timeoutMs: 5000,
    maxAssignments: 100000,
    yieldEvery: 1,
    signal: controller.signal,
  });
  const elapsed = Date.now() - started;
  assert.equal(result.status, SOLVER_STATUS.CANCELLED, 'a timer-driven external abort must cancel before completion');
  assert.equal(result.lifecycle.publishable, false);
  assert.ok(elapsed < 2000, `cancellation must be bounded, was ${elapsed}ms`);
});

test('#3959 small exact queries still return SAT/UNSAT within normal overhead', async () => {
  const backend = new ExhaustiveBvBackend({ maxBvWidth: 8, maxAssignments: 100000 });
  const d = createFreshSymbol(bvSort(4), 'd');
  const satQuery = createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    targetEntity: 'issue-3959-sat',
    assertion: createCompare(BV_COMPARE_OP.EQ, d, d),
  });
  const sat = await backend.createSession().check(satQuery);
  assert.equal(sat.status, SOLVER_STATUS.SAT);

  const a = createFreshSymbol(bvSort(4), 'a');
  const b = createFreshSymbol(bvSort(4), 'b');
  const unsatQuery = createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    targetEntity: 'issue-3959-unsat',
    assertion: createConnective(
      BOOL_CONNECTIVE_OP.AND,
      createCompare(BV_COMPARE_OP.NE, a, a),
      createCompare(BV_COMPARE_OP.EQ, b, b),
    ),
  });
  const unsat = await backend.createSession().check(unsatQuery);
  assert.equal(unsat.status, SOLVER_STATUS.UNSAT);
});
