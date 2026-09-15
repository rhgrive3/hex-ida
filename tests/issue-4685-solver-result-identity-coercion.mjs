import assert from 'node:assert/strict';
import test from 'node:test';

import { bvSort, BV_COMPARE_OP } from '../js/symbolic/expr/kinds.js';
import { createBv, createCompare, createFreshSymbol } from '../js/symbolic/expr/factory.js';
import {
  CLAIM_KIND,
  VERIFICATION_QUERY_KIND,
  createVerificationQuery,
} from '../js/symbolic/verify/query.js';
import { SOLVER_STATUS, createSolverResult, isValidSolverResult } from '../js/symbolic/solver/result.js';
import { SolverSession } from '../js/symbolic/solver/session.js';

// #4685 — SolverResult identity must be exact primitive strings, never String()-coerced.

function canonicalQuery() {
  const x = createFreshSymbol(bvSort(1), 'x4685');
  return createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
    targetEntity: 'q4685',
    assertion: createCompare(BV_COMPARE_OP.EQ, x, createBv(1, 0n)),
  });
}

const CANONICAL_BACKEND = Object.freeze({ id: 'exact-solver', version: '1' });

test('#4685 canonical primitive-string identity is preserved and stays valid', () => {
  const result = createSolverResult({
    status: SOLVER_STATUS.UNSAT,
    backend: 'exact-solver',
    backendVersion: '1',
    queryHash: 'hash-abc',
  });
  assert.equal(result.backend, 'exact-solver');
  assert.equal(result.backendVersion, '1');
  assert.equal(result.queryHash, 'hash-abc');
  assert.equal(isValidSolverResult(result, { backend: CANONICAL_BACKEND }), true);
});

test('#4685 createSolverResult rejects a structured backend identity instead of String()-laundering it', () => {
  assert.throws(
    () => createSolverResult({
      status: SOLVER_STATUS.UNSAT,
      backend: ['exact-solver'],
      backendVersion: ['1'],
      queryHash: ['hash-abc'],
    }),
    TypeError,
  );
});

test('#4685 createSolverResult rejects empty and non-string identity fields', () => {
  assert.throws(() => createSolverResult({ status: SOLVER_STATUS.UNSAT, backend: '', backendVersion: '1' }), TypeError);
  assert.throws(() => createSolverResult({ status: SOLVER_STATUS.UNSAT, backend: 'b', backendVersion: 1 }), TypeError);
  assert.throws(() => createSolverResult({ status: SOLVER_STATUS.UNSAT, backend: 'b', backendVersion: '1', queryHash: {} }), TypeError);
  assert.equal(createSolverResult({ status: SOLVER_STATUS.UNSAT, backend: 'b', backendVersion: '1' }).queryHash, null);
});

test('#4685 a query-bound result must match the recomputed canonical queryHash (#3963 leg preserved)', () => {
  const query = canonicalQuery();
  const good = createSolverResult({
    status: SOLVER_STATUS.UNSAT,
    backend: 'exact-solver',
    backendVersion: '1',
    queryHash: query.queryHash,
  });
  assert.equal(isValidSolverResult(good, { query, backend: CANONICAL_BACKEND }), true);

  const mismatch = createSolverResult({
    status: SOLVER_STATUS.UNSAT,
    backend: 'exact-solver',
    backendVersion: '1',
    queryHash: 'not-the-canonical-hash',
  });
  assert.equal(isValidSolverResult(mismatch, { query, backend: CANONICAL_BACKEND }), false);
});

class MalformedIdentityProviderSession extends SolverSession {
  async _executeCheck() {
    return {
      status: SOLVER_STATUS.UNSAT,
      backend: ['exact-solver'],
      backendVersion: ['1'],
    };
  }
}

test('#4685 a provider returning structured identity resolves exactly once as PROVIDER_FAILURE (no orphaned promise)', async () => {
  const session = new MalformedIdentityProviderSession(CANONICAL_BACKEND, { timeoutMs: 25 });
  const settled = await Promise.race([
    session.check({}).then((r) => ({ raced: false, r })),
    new Promise((resolve) => setTimeout(() => resolve({ raced: true }), 250)),
  ]);
  assert.equal(settled.raced, false, 'check() must not hang after normalization throws');
  assert.equal(settled.r.status, SOLVER_STATUS.PROVIDER_FAILURE);
  assert.equal(settled.r.lifecycle.publishable, false);
});
