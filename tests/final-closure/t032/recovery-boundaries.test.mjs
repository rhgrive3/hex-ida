import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BV_BINARY_OP,
  BV_COMPARE_OP,
  bvSort,
} from '../../../js/symbolic/expr/kinds.js';
import {
  createBinary,
  createBool,
  createBv,
  createCompare,
  createFreshSymbol,
} from '../../../js/symbolic/expr/factory.js';
import { ExhaustiveBvBackend } from '../../../js/symbolic/solver/exhaustive-backend.js';
import { TieredBvBackend } from '../../../js/symbolic/solver/tiered-backend.js';
import { SOLVER_STATUS, createSolverResult } from '../../../js/symbolic/solver/result.js';
import {
  CLAIM_KIND,
  VERIFICATION_QUERY_KIND,
  createVerificationQuery,
} from '../../../js/symbolic/verify/query.js';

function query(assertion, targetEntity = 't032-solver-contract') {
  return createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    targetEntity,
    assertion,
  });
}

test('T032 routes exact 32/64-bit queries and preserves tier evidence', async () => {
  const backend = new TieredBvBackend();
  for (const width of [32, 64]) {
    const symbol = createFreshSymbol(bvSort(width), `t032_x_${width}`);
    const candidate = query(createCompare(
      BV_COMPARE_OP.EQ,
      createBinary(BV_BINARY_OP.ADD, symbol, createBv(width, 1n)),
      createBv(width, 0n),
    ));
    const result = await backend.createSession({ timeoutMs: 5000 }).check(candidate);
    assert.equal(result.status, SOLVER_STATUS.SAT);
    assert.equal(result.lifecycle.publishable, true);
    assert.equal(result.stats.routingTier, 'bitblast-qfbv');
    assert.equal(result.stats.engineBackend, 'hex-bitblast-qfbv');
    assert.ok(result.stats.cnfVariables > 0);
    assert.equal(result.model.get(symbol.symbolId), (1n << BigInt(width)) - 1n);
  }
});

test('T032 overlapping exact tiers require semantic agreement and reject provider drift', async () => {
  class DisagreeBackend extends ExhaustiveBvBackend {
    createSession() {
      return {
        check: async (candidate) => createSolverResult({
          status: SOLVER_STATUS.UNSAT,
          backend: this.id,
          backendVersion: this.version,
          queryHash: candidate.queryHash,
        }),
        dispose: async () => {},
      };
    }
  }

  const disagree = new DisagreeBackend({ id: 't032-disagree', maxBvWidth: 8 });
  const backend = new TieredBvBackend({
    narrowBackend: new ExhaustiveBvBackend({ id: 't032-narrow', maxBvWidth: 8 }),
    wideBackend: disagree,
  });
  const result = await backend.createSession().check(query(createBool(true)));
  assert.equal(result.status, SOLVER_STATUS.PROVIDER_FAILURE);
  assert.match(result.reason, /semantic-disagreement/);

  const stable = new TieredBvBackend();
  stable.narrowBackend.maxBvWidth = 1;
  const drifted = await stable.createSession().check(query(createBool(true)));
  assert.equal(drifted.status, SOLVER_STATUS.PROVIDER_FAILURE);
  assert.match(drifted.reason, /contract-mismatch/);
});

test('T032 freezes tier contracts and keeps returned witnesses immutable', async () => {
  const backend = new TieredBvBackend();
  assert.equal(Object.isFrozen(backend.narrowCapabilityContract), true);
  assert.equal(Object.isFrozen(backend.narrowCapabilityContract.capabilities), true);
  assert.equal(Object.isFrozen(backend.wideCapabilityContract), true);
  assert.equal(Object.isFrozen(backend.wideCapabilityContract.capabilities), true);

  const symbol = createFreshSymbol(bvSort(32), 't032_immutable_x');
  const candidate = query(createCompare(BV_COMPARE_OP.EQ, symbol, createBv(32, 7n)));
  const result = await backend.createSession().check(candidate);
  assert.equal(result.status, SOLVER_STATUS.SAT);
  assert.throws(() => result.model.set(symbol.symbolId, 8n), TypeError);
  assert.equal(result.model.get(symbol.symbolId), 7n);
});

test('T032 cancellation remains a non-publishable lifecycle boundary', async () => {
  const symbol = createFreshSymbol(bvSort(64), 't032_cancel_x');
  const candidate = query(createCompare(
    BV_COMPARE_OP.EQ,
    createBinary(BV_BINARY_OP.MUL, symbol, symbol),
    createBv(64, 3n),
  ));
  const controller = new AbortController();
  const session = new TieredBvBackend().createSession({ timeoutMs: 5000 });
  const pending = session.check(candidate, { signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(result.status, SOLVER_STATUS.CANCELLED);
  assert.equal(result.lifecycle.publishable, false);
  assert.equal(result.lifecycle.cancelled, true);
});

