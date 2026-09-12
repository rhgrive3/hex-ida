import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BV_BINARY_OP,
  BV_COMPARE_OP,
  bvSort,
} from '../../../js/symbolic/expr/kinds.js';
import {
  createBinary,
  createBv,
  createCompare,
  createFreshSymbol,
} from '../../../js/symbolic/expr/factory.js';
import { SolverBackend, PROOF_AUTHORITY, isExactProofBackend } from '../../../js/symbolic/solver/backend.js';
import { BitBlastBvBackend } from '../../../js/symbolic/solver/bitblast-backend.js';
import { ExhaustiveBvBackend } from '../../../js/symbolic/solver/exhaustive-backend.js';
import { defaultSolverRegistry } from '../../../js/symbolic/solver/registry.js';
import { SOLVER_STATUS, createSolverResult } from '../../../js/symbolic/solver/result.js';
import { SolverSession } from '../../../js/symbolic/solver/session.js';
import { TieredBvBackend, classifyTieredQuery } from '../../../js/symbolic/solver/tiered-backend.js';
import {
  CLAIM_KIND,
  VERIFICATION_QUERY_KIND,
  createVerificationQuery,
  validateVerificationQuery,
} from '../../../js/symbolic/verify/query.js';
import { validateSatModel } from '../../../js/symbolic/verify/validate-model.js';

function query(assertion = null, constraints = [], targetEntity = 'sym01-focused') {
  return createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
    targetEntity,
    constraints,
    assertion,
  });
}

function equality(symbol, value) {
  return createCompare(BV_COMPARE_OP.EQ, symbol, createBv(symbol.sort.width, value));
}

class ControlledExactBackend extends SolverBackend {
  constructor({ id = 'controlled-exact', width = 64, delayMs = 0, resultFactory } = {}) {
    super({ id, version: '1.0.0', proofAuthority: PROOF_AUTHORITY.EXACT, requiresCanonicalQueryIdentity: true });
    this.width = width;
    this.delayMs = delayMs;
    this.resultFactory = resultFactory;
  }

  baseCapabilities() {
    return {
      ...super.baseCapabilities(),
      supportedSorts: ['bool', 'bv'],
      maxBvWidth: this.width,
      exactProofs: true,
      supportsModelExtraction: true,
      maxConstraints: 4096,
      maxExprNodes: 100000,
      maxExprDepth: 1024,
    };
  }

  createSession() {
    const backend = this;
    return new class extends SolverSession {
      async _executeCheck(q) {
        if (backend.delayMs) await new Promise((resolve) => setTimeout(resolve, backend.delayMs));
        return backend.resultFactory(q, backend);
      }
    }(backend);
  }
}

test('production default is a branded exact 64-bit tiered QF_BV backend', () => {
  const backend = defaultSolverRegistry.getDefaultBackend();
  assert.ok(backend instanceof TieredBvBackend);
  assert.equal(isExactProofBackend(backend), true);
  const capabilities = backend.capabilities();
  assert.equal(capabilities.maxBvWidth, 64);
  assert.equal(capabilities.exhaustiveMaxBvWidth, 8);
  assert.equal(capabilities.routingPolicy, 'exhaustive-oracle-then-bitblast-v1');
  assert.equal(capabilities.exactProofs, true);
});

test('tier classifier preserves <=8-bit exact floor and routes 32/64-bit queries wide', () => {
  const x4 = createFreshSymbol(bvSort(4), 'route4');
  const q4 = query(equality(x4, 3n));
  assert.equal(classifyTieredQuery(q4).tier, 'exhaustive-oracle');

  for (const width of [32, 64]) {
    const x = createFreshSymbol(bvSort(width), `route${width}`);
    const routed = classifyTieredQuery(query(equality(x, 7n)));
    assert.equal(routed.supported, true);
    assert.equal(routed.tier, 'bitblast-qfbv');
    assert.equal(routed.maxBvWidth, width);
  }
});

test('tiered backend solves realistic fixed 32/64-bit BV arithmetic with independently validated SAT models', async () => {
  const backend = new TieredBvBackend();
  for (const width of [32, 64]) {
    const x = createFreshSymbol(bvSort(width), `wide_x_${width}`);
    const y = createFreshSymbol(bvSort(width), `wide_y_${width}`);
    const xValue = width === 32 ? 0x12345678n : 0x123456789abcdef0n;
    const yValue = width === 32 ? 0x10203040n : 0x0102030405060708n;
    const expression = createBinary(BV_BINARY_OP.XOR, createBinary(BV_BINARY_OP.ADD, x, y), y);
    const expected = BigInt.asUintN(width, (xValue + yValue) ^ yValue);
    const q = query(
      createCompare(BV_COMPARE_OP.EQ, expression, createBv(width, expected)),
      [equality(x, xValue), equality(y, yValue)],
      `wide-sat-${width}`,
    );
    const result = await backend.createSession({ timeoutMs: 3000 }).check(q, { timeoutMs: 3000 });
    assert.equal(result.status, SOLVER_STATUS.SAT, `BV${width} SAT`);
    assert.equal(result.stats.routingTier, 'bitblast-qfbv');
    assert.equal(result.stats.engineBackend, 'hex-bitblast-qfbv');
    assert.equal(validateSatModel(q, result.model).valid, true);
    assert.throws(() => result.model.set(x.symbolId, 0n), /read-only/, 'validated witness must be immutable after publication');
    assert.equal(validateSatModel(q, result.model).valid, true);
    assert.equal(result.lifecycle.publishable, true);
  }
});

test('wide contradiction returns UNSAT while small-domain overlap requires exact-tier agreement', async () => {
  const backend = new TieredBvBackend();
  const wide = createFreshSymbol(bvSort(32), 'wide_unsat');
  const wideQuery = query(null, [equality(wide, 1n), equality(wide, 2n)], 'wide-unsat');
  const wideResult = await backend.createSession().check(wideQuery);
  assert.equal(wideResult.status, SOLVER_STATUS.UNSAT);
  assert.equal(wideResult.stats.routingTier, 'bitblast-qfbv');
  assert.equal(wideResult.lifecycle.publishable, true);

  const small = createFreshSymbol(bvSort(4), 'small_unsat');
  const smallQuery = query(null, [equality(small, 1n), equality(small, 2n)], 'small-unsat');
  const smallResult = await backend.createSession().check(smallQuery);
  assert.equal(smallResult.status, SOLVER_STATUS.UNSAT);
  assert.equal(smallResult.stats.routingTier, 'exhaustive-oracle');
  assert.equal(smallResult.stats.agreementPolicy, 'all-overlapping-exact-tiers-v1');
  assert.deepEqual(smallResult.stats.attempts.map((attempt) => attempt.status), ['unsat', 'unsat']);
});

test('tampered/stale query content is rejected even when caller reuses the original queryHash', async () => {
  const backend = new TieredBvBackend();
  const x = createFreshSymbol(bvSort(32), 'tampered');
  const original = query(equality(x, 1n), [], 'tamper');
  const forged = structuredClone(original);
  forged.assertion.right.value = 2n;
  assert.equal(forged.queryHash, original.queryHash, 'precondition: stale caller hash was retained');
  const validation = validateVerificationQuery(forged);
  assert.equal(validation.valid, false);
  assert.equal(validation.reason, 'query-hash-content-mismatch');
  const result = await backend.createSession().check(forged);
  assert.equal(result.status, SOLVER_STATUS.INVALID_QUERY);
  assert.equal(result.lifecycle.publishable, false);
  assert.equal(result.queryHash, null);
});

test('SAT from a corrupt exact provider is rejected by the canonical model boundary', async () => {
  const x = createFreshSymbol(bvSort(32), 'corrupt_model');
  const q = query(equality(x, 0x55n), [], 'corrupt-model');
  const corrupt = new ControlledExactBackend({
    id: 'corrupt-wide',
    resultFactory(queryValue, backend) {
      return createSolverResult({
        status: SOLVER_STATUS.SAT,
        model: new Map([[x.symbolId, 0x56n]]),
        backend: backend.id,
        backendVersion: backend.version,
        queryHash: queryValue.queryHash,
      });
    },
  });
  const backend = new TieredBvBackend({ wideBackend: corrupt });
  const result = await backend.createSession().check(q);
  assert.equal(result.status, SOLVER_STATUS.PROVIDER_FAILURE);
  assert.match(result.reason, /model-validation-failed/);
  assert.equal(result.lifecycle.publishable, false);
});

test('provider identity/capability mutation after registration fails closed before proof publication', async () => {
  const wide = new BitBlastBvBackend();
  const backend = new TieredBvBackend({ wideBackend: wide });
  const x = createFreshSymbol(bvSort(32), 'mutated_provider');
  const q = query(equality(x, 1n), [], 'mutated-provider');
  wide.id = 'mutated-after-contract-capture';
  const result = await backend.createSession().check(q);
  assert.equal(result.status, SOLVER_STATUS.UNSUPPORTED);
  assert.equal(result.lifecycle.publishable, false);
});

test('resource ceilings return RESOURCE_LIMIT instead of a proof', async () => {
  const tinyWide = new BitBlastBvBackend({ maxVariables: 8, maxClauses: 32 });
  const backend = new TieredBvBackend({ wideBackend: tinyWide });
  const x = createFreshSymbol(bvSort(32), 'resource_limit');
  const q = query(equality(x, 1n), [], 'resource-limit');
  const result = await backend.createSession().check(q);
  assert.equal(result.status, SOLVER_STATUS.RESOURCE_LIMIT);
  assert.equal(result.lifecycle.publishable, false);
  assert.match(result.reason, /budget-exceeded/);
});

test('timeout and cancellation remain non-proof outcomes for a wide exact provider', async () => {
  const slow = new ControlledExactBackend({
    id: 'slow-wide',
    delayMs: 50,
    resultFactory(q, backend) {
      return createSolverResult({
        status: SOLVER_STATUS.UNSAT,
        backend: backend.id,
        backendVersion: backend.version,
        queryHash: q.queryHash,
      });
    },
  });
  const backend = new TieredBvBackend({ wideBackend: slow });
  const x = createFreshSymbol(bvSort(32), 'slow');
  const q = query(equality(x, 1n), [], 'slow');

  const timed = await backend.createSession().check(q, { timeoutMs: 5 });
  assert.equal(timed.status, SOLVER_STATUS.TIMEOUT);
  assert.equal(timed.lifecycle.publishable, false);

  const controller = new AbortController();
  const session = backend.createSession();
  const pending = session.check(q, { signal: controller.signal });
  setTimeout(() => controller.abort(), 2);
  const cancelled = await pending;
  assert.equal(cancelled.status, SOLVER_STATUS.CANCELLED);
  assert.equal(cancelled.lifecycle.publishable, false);
});

test('65-bit query is explicitly unsupported rather than advertised as usable', async () => {
  const backend = new TieredBvBackend();
  const x = createFreshSymbol(bvSort(65), 'too_wide');
  const q = query(equality(x, 0n), [], 'too-wide');
  const result = await backend.createSession().check(q);
  assert.equal(result.status, SOLVER_STATUS.UNSUPPORTED);
  assert.match(result.reason, /bitvector-width-exceeds-64/);
  assert.equal(result.lifecycle.publishable, false);
});
