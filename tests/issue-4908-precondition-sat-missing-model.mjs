import assert from 'node:assert/strict';
import test from 'node:test';

import { bvSort, BV_COMPARE_OP } from '../js/symbolic/expr/kinds.js';
import {
  createBv,
  createBool,
  createFreshSymbol,
  createCompare,
} from '../js/symbolic/expr/factory.js';
import { SOLVER_STATUS } from '../js/symbolic/solver/result.js';
import { FakeSolverBackend } from '../js/symbolic/solver/fake-backend.js';
import { SolverBackend, PROOF_AUTHORITY } from '../js/symbolic/solver/backend.js';
import { SolverSession } from '../js/symbolic/solver/session.js';
import { createSolverResult } from '../js/symbolic/solver/result.js';
import { VERDICT } from '../js/symbolic/verify/query.js';
import { checkPreconditionsConsistency } from '../js/symbolic/verify/preconditions.js';
import { verifyConditionalEdgeFeasibility } from '../js/symbolic/verify/edge-feasibility.js';

function nontrivialPrecondition() {
  const x = createFreshSymbol(bvSort(32), 'x');
  return createCompare(BV_COMPARE_OP.UGT, x, createBv(32, 10n));
}

test('#4908 nontrivial precondition with valid SAT model is consistent', async () => {
  const backend = new FakeSolverBackend({
    defaultStatus: SOLVER_STATUS.SAT,
    defaultModel: { x: 15n },
  });
  const res = await checkPreconditionsConsistency(nontrivialPrecondition(), backend.createSession());
  assert.equal(res.consistent, true);
  assert.equal(res.status, SOLVER_STATUS.SAT);
  assert.ok(res.model);
});

test('#4908 nontrivial precondition with SAT but missing model fails closed', async () => {
  const backend = new FakeSolverBackend({ defaultStatus: SOLVER_STATUS.SAT });
  const res = await checkPreconditionsConsistency(nontrivialPrecondition(), backend.createSession());
  assert.equal(res.consistent, false);
  assert.equal(res.status, SOLVER_STATUS.PROVIDER_FAILURE);
  assert.equal(res.reason, 'invalid-precondition-sat-model');
  assert.equal(res.validation.reason, 'missing-model');
});

test('#4908 nontrivial precondition with SAT but invalid model fails closed', async () => {
  const backend = new FakeSolverBackend({
    defaultStatus: SOLVER_STATUS.SAT,
    defaultModel: { x: 5n },
  });
  const res = await checkPreconditionsConsistency(nontrivialPrecondition(), backend.createSession());
  assert.equal(res.consistent, false);
  assert.equal(res.status, SOLVER_STATUS.PROVIDER_FAILURE);
  assert.equal(res.reason, 'invalid-precondition-sat-model');
});

test('#4908 trivial preconditions stay SAT without a model', async () => {
  const backend = new FakeSolverBackend({ defaultStatus: SOLVER_STATUS.SAT });
  const session = backend.createSession();

  const resNull = await checkPreconditionsConsistency(null, session);
  assert.equal(resNull.consistent, true);
  assert.equal(resNull.status, SOLVER_STATUS.SAT);
  assert.equal(resNull.trivial, true);

  const resEmpty = await checkPreconditionsConsistency([], session);
  assert.equal(resEmpty.consistent, true);
  assert.equal(resEmpty.trivial, true);

  const resTrue = await checkPreconditionsConsistency(createBool(true), session);
  assert.equal(resTrue.consistent, true);
  assert.equal(resTrue.trivial, true);

  const resFalse = await checkPreconditionsConsistency(createBool(false), session);
  assert.equal(resFalse.consistent, false);
  assert.equal(resFalse.status, SOLVER_STATUS.UNSAT);
});

class ModelLessPreconditionSession extends SolverSession {
  async _executeCheck(query) {
    if (query.targetEntity === 'preconditions') {
      return createSolverResult({
        status: SOLVER_STATUS.SAT,
        model: null,
        backend: this.backend.id,
        backendVersion: this.backend.version,
        queryHash: query.queryHash,
        lifecycle: { publishable: true },
      });
    }
    return createSolverResult({
      status: SOLVER_STATUS.UNSAT,
      backend: this.backend.id,
      backendVersion: this.backend.version,
      queryHash: query.queryHash,
    });
  }
}

class ExactModelLessBackend extends SolverBackend {
  constructor() {
    super({
      id: 'exact-modelless-4908',
      version: '1.0.0',
      proofAuthority: PROOF_AUTHORITY.EXACT,
      isRemote: false,
      isWasm: false,
    });
  }

  baseCapabilities() {
    return {
      ...super.baseCapabilities(),
      exactProofs: true,
      supportsModelExtraction: true,
    };
  }

  createSession(options = {}) {
    return new ModelLessPreconditionSession(this, options);
  }
}

test('#4908 main UNSAT + model-less precondition SAT must not reach PROVED', async () => {
  const x = createFreshSymbol(bvSort(32), 'arg_x0');
  const edgeCond = createCompare(BV_COMPARE_OP.EQ, x, createBv(32, 999n));
  const p = createCompare(BV_COMPARE_OP.UGT, x, createBv(32, 10n));

  const res = await verifyConditionalEdgeFeasibility({
    fromBlock: 0,
    toBlock: 1,
    edgeCondition: edgeCond,
    preconditions: p,
    backend: new ExactModelLessBackend(),
  });

  assert.notEqual(res.verdict, VERDICT.PROVED);
  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.equal(res.preconditionStatus, 'unknown');
  assert.equal(res.reasonCode, 'invalid-precondition-sat-model');
});
