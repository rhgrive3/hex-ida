/* Regression coverage for #4685: SolverResult identity fields must keep raw
   primitive-string types at the canonical boundary. Structured provider
   output may never String()-launder onto the exact backend/query identity,
   and isValidSolverResult must compare strictly without coercing operands. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SOLVER_STATUS,
  createSolverResult,
  isValidSolverResult,
} from '../js/symbolic/solver/result.js';
import { SolverSession } from '../js/symbolic/solver/session.js';

const CANONICAL_BACKEND = Object.freeze({ id: 'exact-solver', version: '1' });
const CANONICAL_QUERY = Object.freeze({ queryHash: 'query-abc' });

class MalformedProviderSession extends SolverSession {
  constructor(backend, rawResult, options = {}) {
    super(backend, options);
    this.rawResult = rawResult;
  }

  async _executeCheck() {
    return this.rawResult;
  }
}

function canonicalResult() {
  return createSolverResult({
    status: SOLVER_STATUS.UNSAT,
    backend: 'exact-solver',
    backendVersion: '1',
    queryHash: 'query-abc',
  });
}

test('#4685 canonical primitive-string identity is preserved and stays valid', () => {
  const result = canonicalResult();
  assert.equal(result.backend, 'exact-solver');
  assert.equal(result.backendVersion, '1');
  assert.equal(result.queryHash, 'query-abc');
  assert.equal(isValidSolverResult(result, { query: CANONICAL_QUERY, backend: CANONICAL_BACKEND }), true);
});

test('#4685 createSolverResult rejects structured identity instead of String()-laundering it', () => {
  assert.throws(
    () => createSolverResult({
      status: SOLVER_STATUS.UNSAT,
      backend: ['exact-solver'],
      backendVersion: ['1'],
      queryHash: ['query-abc'],
    }),
    TypeError,
  );
  assert.throws(
    () => createSolverResult({
      status: SOLVER_STATUS.UNSAT,
      backend: { toString: () => 'exact-solver' },
      backendVersion: '1',
      queryHash: 'query-abc',
    }),
    TypeError,
  );
  assert.throws(
    () => createSolverResult({
      status: SOLVER_STATUS.UNSAT,
      backend: 'exact-solver',
      backendVersion: 1,
      queryHash: 'query-abc',
    }),
    TypeError,
  );
  assert.throws(
    () => createSolverResult({
      status: SOLVER_STATUS.UNSAT,
      backend: 'exact-solver',
      backendVersion: '1',
      queryHash: true,
    }),
    TypeError,
  );
  assert.throws(
    () => createSolverResult({ status: SOLVER_STATUS.UNSAT, backend: '', backendVersion: '1' }),
    TypeError,
  );
});

test('#4685 a structured queryHash still accepts null and canonical strings only', () => {
  const withNull = createSolverResult({
    status: SOLVER_STATUS.UNSAT,
    backend: 'exact-solver',
    backendVersion: '1',
    queryHash: null,
  });
  assert.equal(withNull.queryHash, null);
  assert.throws(
    () => createSolverResult({
      status: SOLVER_STATUS.UNSAT,
      backend: 'exact-solver',
      backendVersion: '1',
      queryHash: { toString: () => 'query-abc' },
    }),
    TypeError,
  );
});

test('#4685 malformed provider results fail closed to provider-failure in SolverSession.check', async () => {
  const session = new MalformedProviderSession(CANONICAL_BACKEND, {
    status: SOLVER_STATUS.UNSAT,
    backend: ['exact-solver'],
    backendVersion: ['1'],
    queryHash: ['query-abc'],
  }, { timeoutMs: 50 });
  const result = await session.check(CANONICAL_QUERY);
  assert.equal(result.status, SOLVER_STATUS.PROVIDER_FAILURE);
  assert.equal(result.lifecycle.publishable, false);
  assert.equal(isValidSolverResult(result, { query: CANONICAL_QUERY, backend: CANONICAL_BACKEND }), false);
});

test('#4685 object-toString provider identity also fails closed and never hangs', async () => {
  const session = new MalformedProviderSession(CANONICAL_BACKEND, {
    status: SOLVER_STATUS.UNSAT,
    backend: 'exact-solver',
    backendVersion: '1',
    queryHash: { toString: () => 'query-abc' },
    lifecycle: { publishable: true },
  }, { timeoutMs: 50 });
  const result = await session.check(CANONICAL_QUERY);
  assert.equal(result.status, SOLVER_STATUS.PROVIDER_FAILURE);
  assert.equal(isValidSolverResult(result, { query: CANONICAL_QUERY, backend: CANONICAL_BACKEND }), false);
});

test('#4685 a canonical provider result still settles publishable through the session', async () => {
  const session = new MalformedProviderSession(CANONICAL_BACKEND, {
    status: SOLVER_STATUS.UNSAT,
    backend: 'exact-solver',
    backendVersion: '1',
    queryHash: 'query-abc',
  }, { timeoutMs: 50 });
  const result = await session.check(CANONICAL_QUERY);
  assert.equal(result.status, SOLVER_STATUS.UNSAT);
  assert.equal(result.lifecycle.publishable, true);
  assert.equal(isValidSolverResult(result, { query: CANONICAL_QUERY, backend: CANONICAL_BACKEND }), true);
});

test('#4685 isValidSolverResult compares identity strictly without coercing operands', () => {
  const result = canonicalResult();
  assert.equal(isValidSolverResult(result, { query: { queryHash: ['query-abc'] }, backend: CANONICAL_BACKEND }), false);
  assert.equal(isValidSolverResult(result, { query: { queryHash: { toString: () => 'query-abc' } }, backend: CANONICAL_BACKEND }), false);
  assert.equal(isValidSolverResult(result, { query: CANONICAL_QUERY, backend: { id: ['exact-solver'], version: ['1'] } }), false);
  assert.equal(isValidSolverResult(result, { query: CANONICAL_QUERY, backend: { id: { toString: () => 'exact-solver' }, version: '1' } }), false);
  assert.equal(isValidSolverResult({ status: SOLVER_STATUS.UNSAT, lifecycle: {} }, { query: null, backend: {} }), false);
  assert.equal(isValidSolverResult(result, { query: { queryHash: 'other-query' }, backend: CANONICAL_BACKEND }), false);
});
