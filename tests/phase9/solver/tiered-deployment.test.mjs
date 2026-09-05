import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bvSort,
  boolSort,
  BV_BINARY_OP,
  BV_COMPARE_OP,
  CAST_OP,
  BOOL_CONNECTIVE_OP,
} from '../../../js/symbolic/expr/kinds.js';
import {
  createBinary,
  createBool,
  createBv,
  createCompare,
  createConcat,
  createConnective,
  createCast,
  createExtract,
  createFreshSymbol,
  createIte,
  createUnknownSemantic,
} from '../../../js/symbolic/expr/factory.js';
import { evaluateExpr } from '../../../js/symbolic/expr/evaluate.js';
import { PROOF_AUTHORITY, SolverBackend } from '../../../js/symbolic/solver/backend.js';
import { BitBlastBvBackend } from '../../../js/symbolic/solver/bitblast-backend.js';
import { collectSymbols, ExhaustiveBvBackend } from '../../../js/symbolic/solver/exhaustive-backend.js';
import { defaultSolverRegistry } from '../../../js/symbolic/solver/registry.js';
import { SOLVER_STATUS, createSolverResult } from '../../../js/symbolic/solver/result.js';
import { TieredBvBackend, classifyTieredQuery } from '../../../js/symbolic/solver/tiered-backend.js';
import { WorkerSolverBackend } from '../../../js/symbolic/solver/worker-backend.js';
import { validateSatModel } from '../../../js/symbolic/verify/validate-model.js';
import { CLAIM_KIND, VERIFICATION_QUERY_KIND, createVerificationQuery, validateVerificationQuery } from '../../../js/symbolic/verify/query.js';

function query(assertion, constraints = []) {
  return createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    targetEntity: 'tiered-deployment-test',
    constraints,
    assertion,
  });
}

async function checkConcreteBinary(backend, width, op, leftValue, rightValue, expectedValue) {
  const left = createFreshSymbol(bvSort(width), `left_${width}_${op}_${leftValue}_${rightValue}`);
  const right = createFreshSymbol(bvSort(width), `right_${width}_${op}_${leftValue}_${rightValue}`);
  const expression = createBinary(op, left, right);
  const constraints = [
    createCompare(BV_COMPARE_OP.EQ, left, createBv(width, leftValue)),
    createCompare(BV_COMPARE_OP.EQ, right, createBv(width, rightValue)),
  ];
  const validQuery = query(createCompare(BV_COMPARE_OP.EQ, expression, createBv(width, expectedValue)), constraints);
  const valid = await backend.createSession({ timeoutMs: 5000 }).check(validQuery, { timeoutMs: 5000 });
  assert.equal(valid.status, SOLVER_STATUS.SAT, `${op} BV${width} expected SAT (${valid.reason || 'no reason'})`);
  assert.equal(validateSatModel(validQuery, valid.model).valid, true);

  const invalidQuery = query(
    createCompare(BV_COMPARE_OP.NE, expression, createBv(width, expectedValue)),
    constraints,
  );
  const invalid = await backend.createSession({ timeoutMs: 5000 }).check(invalidQuery, { timeoutMs: 5000 });
  assert.equal(invalid.status, SOLVER_STATUS.UNSAT, `${op} BV${width} expected UNSAT (${invalid.reason || 'no reason'})`);
}

test('production registry routes exact <=8-bit and 32/64-bit QF_BV capabilities explicitly', async () => {
  const backend = defaultSolverRegistry.getDefaultBackend();
  assert.equal(backend.id, 'hex-tiered-qfbv');
  assert.equal(backend.proofAuthority, PROOF_AUTHORITY.EXACT);
  assert.equal(backend.capabilities().supportedLogic, 'QF_BV');
  assert.equal(backend.capabilities().maxBvWidth, 64);
  assert.equal(backend.capabilities().routingPolicy, 'exhaustive-oracle-then-bitblast-v1');
  assert.equal(backend.capabilities().overlapAgreementPolicy, 'all-overlapping-exact-tiers-v1');
  assert.equal(backend.capabilities().singleEngineAuthority, 'nonoverlapping-capability-route-only-v1');

  const small = createFreshSymbol(bvSort(4), 'route_small');
  const smallQuery = query(createCompare(BV_COMPARE_OP.EQ, small, createBv(4, 3n)));
  assert.equal(classifyTieredQuery(smallQuery).tier, 'exhaustive-oracle');
  const smallResult = await backend.createSession().check(smallQuery);
  assert.equal(smallResult.status, SOLVER_STATUS.SAT);
  assert.equal(smallResult.stats.routingTier, 'exhaustive-oracle');
  assert.equal(smallResult.stats.engineBackend, 'hex-exhaustive-bv');
  assert.throws(() => smallResult.model.set(small.symbolId, 4n), TypeError);
  assert.throws(() => smallResult.model.delete(small.symbolId), TypeError);
  assert.throws(() => smallResult.model.clear(), TypeError);

  const wide = createFreshSymbol(bvSort(32), 'route_wide');
  const wideQuery = query(createCompare(BV_COMPARE_OP.EQ, wide, createBv(32, 0x12345678n)));
  assert.equal(classifyTieredQuery(wideQuery).tier, 'bitblast-qfbv');
  const wideResult = await backend.createSession().check(wideQuery);
  assert.equal(wideResult.status, SOLVER_STATUS.SAT);
  assert.equal(wideResult.stats.routingTier, 'bitblast-qfbv');
  assert.equal(wideResult.stats.engineBackend, 'hex-bitblast-qfbv');
  assert.deepEqual(wideResult.stats.eligibility.map(({ backend, eligible }) => ({ backend, eligible })), [
    { backend: 'hex-exhaustive-bv', eligible: false },
    { backend: 'hex-bitblast-qfbv', eligible: true },
  ]);
});

test('tiered backend proves 32/64-bit SAT and UNSAT with independently validated models', async () => {
  const backend = new TieredBvBackend();
  for (const width of [32, 64]) {
    const symbol = createFreshSymbol(bvSort(width), `wide_sat_${width}`);
    const satQuery = query(createCompare(BV_COMPARE_OP.EQ,
      createBinary(BV_BINARY_OP.ADD, symbol, createBv(width, 1n)),
      createBv(width, 0n)));
    const sat = await backend.createSession().check(satQuery);
    assert.equal(sat.status, SOLVER_STATUS.SAT);
    assert.equal(validateSatModel(satQuery, sat.model).valid, true);
    const modelValue = sat.model instanceof Map ? sat.model.get(symbol.symbolId) : sat.model[symbol.symbolId];
    assert.equal(modelValue, (1n << BigInt(width)) - 1n, `BV${width} wrap witness`);

    const unsatQuery = query(null, [
      createCompare(BV_COMPARE_OP.EQ, symbol, createBv(width, 1n)),
      createCompare(BV_COMPARE_OP.EQ, symbol, createBv(width, 2n)),
    ]);
    const unsat = await backend.createSession().check(unsatQuery);
    assert.equal(unsat.status, SOLVER_STATUS.UNSAT);
    assert.equal(unsat.model, null);
  }
});

test('32/64-bit wrap, saturated shifts, and SMT-LIB div/rem boundaries are exact', async () => {
  const backend = new BitBlastBvBackend();
  for (const width of [32, 64]) {
    const mask = (1n << BigInt(width)) - 1n;
    const min = 1n << BigInt(width - 1);
    const cases = [
      [BV_BINARY_OP.ADD, mask, 1n, 0n],
      [BV_BINARY_OP.SUB, 0n, 1n, mask],
      [BV_BINARY_OP.MUL, min, 2n, 0n],
      [BV_BINARY_OP.SHL, 1n, BigInt(width), 0n],
      [BV_BINARY_OP.LSHR, mask, BigInt(width + 1), 0n],
      [BV_BINARY_OP.ASHR, min, BigInt(width), mask],
      [BV_BINARY_OP.UDIV, 17n, 0n, mask],
      [BV_BINARY_OP.UREM, 17n, 0n, 17n],
      [BV_BINARY_OP.SDIV, min, mask, min],
      [BV_BINARY_OP.SREM, min, mask, 0n],
      [BV_BINARY_OP.SDIV, min, 0n, 1n],
      [BV_BINARY_OP.SDIV, 17n, 0n, mask],
      [BV_BINARY_OP.SREM, min, 0n, min],
    ];
    for (const [op, left, right, expected] of cases) {
      await checkConcreteBinary(backend, width, op, left, right, expected);
    }
  }
});

test('32/64 comparisons, ITE, extract, concat, and casts preserve QF_BV sorts', async () => {
  const backend = new BitBlastBvBackend();
  for (const width of [32, 64]) {
    const min = 1n << BigInt(width - 1);
    const max = (1n << BigInt(width)) - 1n;
    const x = createFreshSymbol(bvSort(width), `struct_x_${width}`);
    const y = createFreshSymbol(bvSort(width), `struct_y_${width}`);
    const constraints = [
      createCompare(BV_COMPARE_OP.EQ, x, createBv(width, min)),
      createCompare(BV_COMPARE_OP.EQ, y, createBv(width, max)),
    ];
    const signedLess = query(createCompare(BV_COMPARE_OP.SLT, x, y), constraints);
    const unsignedLess = query(createCompare(BV_COMPARE_OP.ULT, x, y), constraints);
    assert.equal((await backend.createSession().check(signedLess)).status, SOLVER_STATUS.SAT);
    assert.equal((await backend.createSession().check(unsignedLess)).status, SOLVER_STATUS.SAT);
    const selected = createIte(createCompare(BV_COMPARE_OP.SLT, x, y), x, y);
    const selectedQuery = query(createCompare(BV_COMPARE_OP.EQ, selected, createBv(width, min)), constraints);
    assert.equal((await backend.createSession().check(selectedQuery)).status, SOLVER_STATUS.SAT);
  }

  const high = createFreshSymbol(bvSort(32), 'concat_high');
  const low = createFreshSymbol(bvSort(32), 'concat_low');
  const combined = createConcat(high, low);
  const structuralQuery = query(createConnective(BOOL_CONNECTIVE_OP.AND,
    createCompare(BV_COMPARE_OP.EQ, combined, createBv(64, 0x89abcdef01234567n)),
    createCompare(BV_COMPARE_OP.EQ, createExtract(combined, 15, 8), createBv(8, 0x45n)),
    createCompare(BV_COMPARE_OP.EQ, createCast(CAST_OP.TRUNC, combined, 32), createBv(32, 0x01234567n)),
    createCompare(BV_COMPARE_OP.EQ, createCast(CAST_OP.ZEXT, low, 64), createBv(64, 0x01234567n)),
    createCompare(BV_COMPARE_OP.EQ, createCast(CAST_OP.SEXT, high, 64), createBv(64, 0xffffffff89abcdefn)),
  ), [
    createCompare(BV_COMPARE_OP.EQ, high, createBv(32, 0x89abcdefn)),
    createCompare(BV_COMPARE_OP.EQ, low, createBv(32, 0x01234567n)),
  ]);
  const structural = await backend.createSession().check(structuralQuery);
  assert.equal(structural.status, SOLVER_STATUS.SAT);
  assert.equal(validateSatModel(structuralQuery, structural.model).valid, true);
});

test('bit-blast engine agrees with exhaustive oracle over a complete shared-width corpus', async () => {
  const bitblast = new BitBlastBvBackend({ maxBvWidth: 8 });
  const exhaustive = new ExhaustiveBvBackend({ maxBvWidth: 8 });
  const width = 3;
  const operations = Object.values(BV_BINARY_OP);
  for (const op of operations) {
    for (let leftValue = 0n; leftValue < 8n; leftValue++) {
      for (let rightValue = 0n; rightValue < 8n; rightValue++) {
        const left = createFreshSymbol(bvSort(width), `diff_left_${op}_${leftValue}_${rightValue}`);
        const right = createFreshSymbol(bvSort(width), `diff_right_${op}_${leftValue}_${rightValue}`);
        const expression = createBinary(op, left, right);
        const expected = evaluateExpr(expression, { [left.symbolId]: leftValue, [right.symbolId]: rightValue }).value;
        const candidate = query(createCompare(BV_COMPARE_OP.EQ, expression, createBv(width, expected)), [
          createCompare(BV_COMPARE_OP.EQ, left, createBv(width, leftValue)),
          createCompare(BV_COMPARE_OP.EQ, right, createBv(width, rightValue)),
        ]);
        const [bitblastResult, exhaustiveResult] = await Promise.all([
          bitblast.createSession().check(candidate),
          exhaustive.createSession().check(candidate),
        ]);
        assert.equal(bitblastResult.status, exhaustiveResult.status, `${op}(${leftValue},${rightValue})`);
        assert.equal(bitblastResult.status, SOLVER_STATUS.SAT, `${op}(${leftValue},${rightValue})`);
        assert.equal(validateSatModel(candidate, bitblastResult.model).valid, true);

        const negative = query(createCompare(BV_COMPARE_OP.NE, expression, createBv(width, expected)), [
          createCompare(BV_COMPARE_OP.EQ, left, createBv(width, leftValue)),
          createCompare(BV_COMPARE_OP.EQ, right, createBv(width, rightValue)),
        ]);
        const [bitblastNegative, exhaustiveNegative] = await Promise.all([
          bitblast.createSession().check(negative),
          exhaustive.createSession().check(negative),
        ]);
        assert.equal(bitblastNegative.status, exhaustiveNegative.status, `negative ${op}(${leftValue},${rightValue})`);
        assert.equal(bitblastNegative.status, SOLVER_STATUS.UNSAT, `negative ${op}(${leftValue},${rightValue})`);
      }
    }
  }
});

test('unsupported, malformed, timeout, cancellation, and resource limits fail closed', async () => {
  const backend = new BitBlastBvBackend();
  const tooWide = createFreshSymbol(bvSort(65), 'too_wide');
  const unsupported = await backend.createSession().check(query(createCompare(BV_COMPARE_OP.EQ, tooWide, createBv(65, 0n))));
  assert.equal(unsupported.status, SOLVER_STATUS.UNSUPPORTED);
  assert.equal(unsupported.lifecycle.publishable, false);

  const unknown = createUnknownSemantic(bvSort(32), 'adversarial-partial-semantics');
  const malformed = await backend.createSession().check(query(createCompare(BV_COMPARE_OP.EQ, unknown, createBv(32, 0n))));
  assert.equal(malformed.status, SOLVER_STATUS.UNSUPPORTED);
  assert.notEqual(malformed.status, SOLVER_STATUS.UNSAT);

  const canonical = createFreshSymbol(bvSort(32), 'canonical_identity');
  const collided = Object.freeze({ ...canonical, name: 'forged_alias' });
  const collision = await backend.createSession().check(query(null, [
    createCompare(BV_COMPARE_OP.EQ, canonical, createBv(32, 1n)),
    createCompare(BV_COMPARE_OP.EQ, collided, createBv(32, 1n)),
  ]));
  assert.equal(collision.status, SOLVER_STATUS.UNSUPPORTED);
  assert.equal(collision.reason, 'symbol-identity-conflict');

  const x = createFreshSymbol(bvSort(64), 'limited_x');
  const y = createFreshSymbol(bvSort(64), 'limited_y');
  const division = query(createCompare(BV_COMPARE_OP.EQ,
    createBinary(BV_BINARY_OP.UDIV, x, y),
    createBv(64, 7n)));
  const limited = await new BitBlastBvBackend({ maxVariables: 32 }).createSession().check(division);
  assert.equal(limited.status, SOLVER_STATUS.RESOURCE_LIMIT);
  assert.equal(limited.lifecycle.publishable, false);

  const timedOut = await backend.createSession().check(division, { timeoutMs: 1 });
  assert.equal(timedOut.status, SOLVER_STATUS.TIMEOUT);
  assert.equal(timedOut.queryHash, division.queryHash);
  assert.equal(timedOut.lifecycle.publishable, false);

  const controller = new AbortController();
  controller.abort();
  const cancelled = await backend.createSession().check(division, { signal: controller.signal });
  assert.equal(cancelled.status, SOLVER_STATUS.CANCELLED);
  assert.equal(cancelled.queryHash, division.queryHash);
  assert.equal(cancelled.lifecycle.publishable, false);
});

test('tier boundary rejects a corrupt SAT model from an exact-claiming provider', async () => {
  class CorruptExactBackend extends SolverBackend {
    constructor() { super({ id: 'corrupt-exact', version: '1.0.0', proofAuthority: PROOF_AUTHORITY.EXACT }); }
    baseCapabilities() {
      return { ...super.baseCapabilities(), exactProofs: true, supportsModelExtraction: true };
    }
    createSession() {
      return {
        check: async (candidate) => createSolverResult({
          status: SOLVER_STATUS.SAT,
          model: { corrupt_model_x: 0n },
          backend: this.id,
          backendVersion: this.version,
          queryHash: candidate.queryHash,
        }),
        dispose: async () => {},
      };
    }
  }

  const x = createFreshSymbol(bvSort(4), 'corrupt_model_x');
  const candidate = query(createCompare(BV_COMPARE_OP.EQ, x, createBv(4, 9n)));
  const backend = new TieredBvBackend({ narrowBackend: new CorruptExactBackend() });
  const result = await backend.createSession().check(candidate);
  assert.equal(result.status, SOLVER_STATUS.PROVIDER_FAILURE);
  assert.match(result.reason, /^tier-model-validation-failed:/);
  assert.equal(result.lifecycle.publishable, false);
});

test('small-query oracle failure cannot bypass overlapping-tier agreement', async () => {
  class LimitedExactBackend extends SolverBackend {
    constructor() { super({ id: 'limited-exact-oracle', version: '1.0.0', proofAuthority: PROOF_AUTHORITY.EXACT }); }
    baseCapabilities() { return { ...super.baseCapabilities(), exactProofs: true, supportsModelExtraction: true }; }
    createSession() {
      return {
        check: async (candidate) => createSolverResult({
          status: SOLVER_STATUS.RESOURCE_LIMIT,
          reason: 'oracle-test-limit',
          backend: this.id,
          backendVersion: this.version,
          queryHash: candidate.queryHash,
          lifecycle: { budgetExceeded: true, publishable: false },
        }),
        dispose: async () => {},
      };
    }
  }
  const x = createFreshSymbol(bvSort(4), 'fallback_x');
  const candidate = query(createCompare(BV_COMPARE_OP.EQ, x, createBv(4, 6n)));
  const result = await new TieredBvBackend({ narrowBackend: new LimitedExactBackend() }).createSession().check(candidate);
  assert.equal(result.status, SOLVER_STATUS.RESOURCE_LIMIT);
  assert.equal(result.lifecycle.publishable, false);
  assert.match(result.reason, /^exact-tier-agreement-unavailable:/);
  assert.deepEqual(result.stats.attempts, [
    { backend: 'limited-exact-oracle', status: SOLVER_STATUS.RESOURCE_LIMIT },
    { backend: 'hex-bitblast-qfbv', status: SOLVER_STATUS.SAT },
  ]);
});

test('overlapping exact tiers require semantic agreement and publish at most once', async () => {
  class ScriptedExactBackend extends SolverBackend {
    constructor(id, outcome, { delayMs = 0, busyMs = 0, unavailable = false } = {}) {
      super({ id, version: '1.0.0', proofAuthority: PROOF_AUTHORITY.EXACT });
      this.outcome = outcome;
      this.delayMs = delayMs;
      this.busyMs = busyMs;
      this.unavailable = unavailable;
      this.calls = 0;
    }
    baseCapabilities() { return { ...super.baseCapabilities(), exactProofs: true, supportsModelExtraction: true }; }
    createSession() {
      if (this.unavailable) throw new Error('scripted-unavailable');
      return {
        check: async (candidate) => {
          this.calls++;
          if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
          if (this.busyMs) {
            const until = performance.now() + this.busyMs;
            while (performance.now() < until) { /* deliberate timer-starvation backend */ }
          }
          return createSolverResult({
            ...this.outcome,
            backend: this.id,
            backendVersion: this.version,
            queryHash: candidate.queryHash,
          });
        },
        dispose: async () => {},
      };
    }
  }

  const x = createFreshSymbol(bvSort(4), 'agreement_x');
  const candidate = query(createCompare(BV_COMPARE_OP.EQ, x, createBv(4, 7n)));
  const satOutcome = { status: SOLVER_STATUS.SAT, model: { [x.symbolId]: 7n } };
  const unsatOutcome = { status: SOLVER_STATUS.UNSAT };

  for (const [firstOutcome, secondOutcome, expectedReason] of [
    [unsatOutcome, satOutcome, 'unsat-vs-sat'],
    [satOutcome, unsatOutcome, 'sat-vs-unsat'],
  ]) {
    const narrow = new ScriptedExactBackend('agreement-narrow', firstOutcome);
    const wide = new ScriptedExactBackend('agreement-wide', secondOutcome);
    const result = await new TieredBvBackend({ narrowBackend: narrow, wideBackend: wide }).createSession().check(candidate);
    assert.equal(result.status, SOLVER_STATUS.PROVIDER_FAILURE);
    assert.match(result.reason, new RegExp(`exact-tier-semantic-disagreement:${expectedReason}$`));
    assert.equal(result.lifecycle.publishable, false);
    assert.equal(result.model, null);
    assert.equal(narrow.calls, 1);
    assert.equal(wide.calls, 1);
  }

  const wideX = createFreshSymbol(bvSort(32), 'wide_overlap_x');
  const wideCandidate = query(createCompare(BV_COMPARE_OP.EQ, wideX, createBv(32, 7n)));
  const wideNarrow = new ScriptedExactBackend('wide-overlap-narrow', unsatOutcome);
  const wideWide = new ScriptedExactBackend('wide-overlap-wide', { status: SOLVER_STATUS.SAT, model: { [wideX.symbolId]: 7n } });
  const wideDisagreement = await new TieredBvBackend({ narrowBackend: wideNarrow, wideBackend: wideWide }).createSession().check(wideCandidate);
  assert.equal(wideDisagreement.status, SOLVER_STATUS.PROVIDER_FAILURE);
  assert.equal(wideDisagreement.reason, 'exact-tier-semantic-disagreement:unsat-vs-sat');
  assert.equal(wideDisagreement.lifecycle.publishable, false);
  assert.equal(wideNarrow.calls, 1);
  assert.equal(wideWide.calls, 1);

  for (const outcome of [satOutcome, unsatOutcome]) {
    const narrow = new ScriptedExactBackend('same-narrow', outcome);
    const wide = new ScriptedExactBackend('same-wide', outcome);
    const result = await new TieredBvBackend({ narrowBackend: narrow, wideBackend: wide }).createSession().check(candidate);
    assert.equal(result.status, outcome.status);
    assert.equal(result.lifecycle.publishable, true);
    assert.deepEqual(result.stats.agreementBackends, ['same-narrow', 'same-wide']);
    assert.equal(narrow.calls, 1);
    assert.equal(wide.calls, 1);
  }

  const limited = new ScriptedExactBackend('limited-narrow', { status: SOLVER_STATUS.RESOURCE_LIMIT, reason: 'scripted-limit', lifecycle: { budgetExceeded: true, publishable: false } });
  const available = new ScriptedExactBackend('available-wide', satOutcome);
  const limitedResult = await new TieredBvBackend({ narrowBackend: limited, wideBackend: available }).createSession().check(candidate);
  assert.equal(limitedResult.status, SOLVER_STATUS.RESOURCE_LIMIT);
  assert.equal(limitedResult.lifecycle.publishable, false);
  assert.equal(limited.calls, 1);
  assert.equal(available.calls, 1);

  const unavailable = new ScriptedExactBackend('unavailable-narrow', unsatOutcome, { unavailable: true });
  const availableAfterFailure = new ScriptedExactBackend('available-after-failure', satOutcome);
  const unavailableResult = await new TieredBvBackend({ narrowBackend: unavailable, wideBackend: availableAfterFailure }).createSession().check(candidate);
  assert.equal(unavailableResult.status, SOLVER_STATUS.PROVIDER_FAILURE);
  assert.equal(unavailableResult.lifecycle.publishable, false);
  assert.equal(availableAfterFailure.calls, 1);

  const delayed = new ScriptedExactBackend('delayed-narrow', satOutcome, { delayMs: 25 });
  const timeoutWide = new ScriptedExactBackend('timeout-wide', satOutcome);
  const timeoutSession = new TieredBvBackend({ narrowBackend: delayed, wideBackend: timeoutWide }).createSession();
  let timeoutPublications = 0;
  const timeoutResult = await timeoutSession.check(candidate, { timeoutMs: 2 }).then((result) => { timeoutPublications++; return result; });
  assert.equal(timeoutResult.status, SOLVER_STATUS.TIMEOUT);
  assert.equal(timeoutResult.lifecycle.publishable, false);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(timeoutPublications, 1);
  assert.equal(timeoutWide.calls, 0);

  const quick = new ScriptedExactBackend('quick-narrow', satOutcome);
  const blocking = new ScriptedExactBackend('blocking-wide', satOutcome, { busyMs: 100 });
  let starvedPublications = 0;
  const starvedResult = await new TieredBvBackend({ narrowBackend: quick, wideBackend: blocking }).createSession().check(candidate, { timeoutMs: 50 }).then((result) => { starvedPublications++; return result; });
  assert.equal(starvedResult.status, SOLVER_STATUS.TIMEOUT);
  assert.equal(starvedResult.lifecycle.publishable, false);
  assert.equal(starvedResult.model, null);
  assert.equal(quick.calls, 1);
  assert.equal(blocking.calls, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(starvedPublications, 1);

  const cancelNarrow = new ScriptedExactBackend('cancel-narrow', satOutcome, { delayMs: 25 });
  const cancelWide = new ScriptedExactBackend('cancel-wide', satOutcome);
  const controller = new AbortController();
  const cancelSession = new TieredBvBackend({ narrowBackend: cancelNarrow, wideBackend: cancelWide }).createSession();
  let cancelPublications = 0;
  const cancelledPending = cancelSession.check(candidate, { signal: controller.signal }).then((result) => { cancelPublications++; return result; });
  controller.abort();
  const cancelledResult = await cancelledPending;
  assert.equal(cancelledResult.status, SOLVER_STATUS.CANCELLED);
  assert.equal(cancelledResult.lifecycle.publishable, false);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(cancelPublications, 1);
  assert.equal(cancelWide.calls, 0);
});

test('tiered capability identity remains bound to immutable captured provider contracts', async () => {
  class MutableAdvertisementBackend extends SolverBackend {
    constructor(id, maxBvWidth, outcome) {
      super({ id, version: '1.0.0', proofAuthority: PROOF_AUTHORITY.EXACT });
      this.advertisedMaxBvWidth = maxBvWidth;
      this.outcome = outcome;
      this.calls = 0;
    }
    baseCapabilities() {
      return {
        ...super.baseCapabilities(),
        maxBvWidth: this.advertisedMaxBvWidth,
        exactProofs: true,
        supportsModelExtraction: true,
      };
    }
    createSession() {
      return {
        check: async (candidate) => {
          this.calls++;
          return createSolverResult({
            ...this.outcome,
            backend: this.id,
            backendVersion: this.version,
            queryHash: candidate.queryHash,
          });
        },
        dispose: async () => {},
      };
    }
  }

  const x = createFreshSymbol(bvSort(32), 'mutable_capability_x');
  const candidate = query(createCompare(BV_COMPARE_OP.EQ, x, createBv(32, 7n)));
  const narrow = new MutableAdvertisementBackend('mutable-narrow', 8, { status: SOLVER_STATUS.UNSAT });
  const wide = new MutableAdvertisementBackend('mutable-wide', 64, { status: SOLVER_STATUS.SAT, model: { [x.symbolId]: 7n } });
  const capturedNarrowFingerprint = narrow.capabilityFingerprint();
  const first = new TieredBvBackend({ narrowBackend: narrow, wideBackend: wide });
  const firstFingerprint = first.capabilityFingerprint();

  narrow.advertisedMaxBvWidth = 64;
  assert.equal(first.capabilityFingerprint(), firstFingerprint, 'nested provider mutation cannot rewrite an existing tiered identity');
  const second = new TieredBvBackend({ narrowBackend: narrow, wideBackend: wide });
  assert.notEqual(second.capabilityFingerprint(), firstFingerprint, 'different captured routing contracts require different tiered identities');

  const firstCapabilities = first.capabilities();
  assert.equal(firstCapabilities.narrowBackendFingerprint, capturedNarrowFingerprint);
  assert.equal(firstCapabilities.narrowCapabilityContract.maxBvWidth, 8);
  assert.equal(second.capabilities().narrowCapabilityContract.maxBvWidth, 64);
  assert.equal(Object.hasOwn(firstCapabilities.narrowCapabilityContract, 'backend'), false);
  assert.equal(Object.isFrozen(firstCapabilities.narrowCapabilityContract), true);
  assert.equal(Object.isFrozen(firstCapabilities.narrowCapabilityContract.supportedSorts), true);

  const firstResult = await first.createSession().check(candidate);
  assert.equal(firstResult.status, SOLVER_STATUS.SAT);
  assert.equal(firstResult.lifecycle.publishable, true);
  assert.equal(narrow.calls, 0, 'captured BV8 contract remains ineligible for BV32');
  assert.equal(wide.calls, 1);

  const secondResult = await second.createSession().check(candidate);
  assert.equal(secondResult.status, SOLVER_STATUS.PROVIDER_FAILURE);
  assert.equal(secondResult.reason, 'exact-tier-semantic-disagreement:unsat-vs-sat');
  assert.equal(secondResult.lifecycle.publishable, false);
  assert.equal(narrow.calls, 1, 'captured BV64 contract participates in agreement');
  assert.equal(wide.calls, 2);
});

test('tier capability capture rejects accessors, proxies, holes, duplicate sorts, and non-integer scalars', () => {
  class AdversarialCapabilitiesBackend extends SolverBackend {
    constructor(id, mutate) {
      super({ id, version: '1.0.0', proofAuthority: PROOF_AUTHORITY.EXACT });
      this.mutate = mutate;
    }
    capabilityFingerprint() { return `${this.id}-fixed-capability-v1`; }
    capabilities() {
      const capabilities = {
        ...super.baseCapabilities(),
        supportedSorts: ['bool', 'bv'],
        maxBvWidth: 64,
        exactProofs: true,
        supportsModelExtraction: true,
        proofAuthority: PROOF_AUTHORITY.EXACT,
        capabilityFingerprint: this.capabilityFingerprint(),
      };
      return this.mutate(capabilities);
    }
    createSession() { throw new Error('adversarial backend must never execute'); }
  }

  let widthGetterReads = 0;
  assert.throws(() => new TieredBvBackend({
    wideBackend: new AdversarialCapabilitiesBackend('getter-width', (capabilities) => {
      Object.defineProperty(capabilities, 'maxBvWidth', {
        enumerable: true,
        get() { widthGetterReads++; return widthGetterReads === 1 ? 64 : 0; },
      });
      return capabilities;
    }),
  }), /accessors/);
  assert.equal(widthGetterReads, 0, 'descriptor capture rejects the getter without executing it');

  let forgedArrayReads = 0;
  assert.throws(() => new TieredBvBackend({
    wideBackend: new AdversarialCapabilitiesBackend('proxy-sorts', (capabilities) => {
      capabilities.supportedSorts = new Proxy(['bool', 'bv'], {
        get(target, property, receiver) {
          if (property === 'some' || property === Symbol.iterator) forgedArrayReads++;
          return Reflect.get(target, property, receiver);
        },
      });
      return capabilities;
    }),
  }), /proxy or non-cloneable data/);
  assert.equal(forgedArrayReads, 0, 'validation never dispatches through proxy array methods or iteration');

  for (const [id, mutate] of [
    ['hole-sorts', (capabilities) => { capabilities.supportedSorts = ['bool', , 'bv']; return capabilities; }],
    ['duplicate-sorts', (capabilities) => { capabilities.supportedSorts = ['bool', 'bv', 'bool']; return capabilities; }],
    ['fraction-width', (capabilities) => { capabilities.maxBvWidth = 63.5; return capabilities; }],
    ['nan-width', (capabilities) => { capabilities.maxBvWidth = Number.NaN; return capabilities; }],
    ['coerced-width', (capabilities) => { capabilities.maxBvWidth = '64'; return capabilities; }],
  ]) {
    assert.throws(() => new TieredBvBackend({ wideBackend: new AdversarialCapabilitiesBackend(id, mutate) }), /backend|capabilities|supported sorts/);
  }
});

test('tier provider identity and exact authority rebind before execution and publication', async () => {
  class MutableIdentityBackend extends SolverBackend {
    constructor(id) {
      super({ id, version: '1.0.0', proofAuthority: PROOF_AUTHORITY.EXACT });
      this.calls = 0;
    }
    baseCapabilities() { return { ...super.baseCapabilities(), maxBvWidth: 64, exactProofs: true, supportsModelExtraction: true }; }
    createSession() {
      return {
        check: async (candidate) => {
          this.calls++;
          return createSolverResult({ status: SOLVER_STATUS.UNSAT, backend: this.id, backendVersion: this.version, queryHash: candidate.queryHash });
        },
        dispose: async () => {},
      };
    }
  }

  const x = createFreshSymbol(bvSort(32), 'rebind_identity_x');
  const candidate = query(createCompare(BV_COMPARE_OP.EQ, x, createBv(32, 7n)));
  for (const mutate of [
    (provider) => { provider.id = 'mutated-provider-id'; },
    (provider) => { provider.proofAuthority = PROOF_AUTHORITY.HEURISTIC; },
  ]) {
    const provider = new MutableIdentityBackend('captured-provider-id');
    const backend = new TieredBvBackend({ wideBackend: provider });
    mutate(provider);
    const result = await backend.createSession().check(candidate);
    assert.equal(result.status, SOLVER_STATUS.PROVIDER_FAILURE);
    assert.equal(result.reason, 'tier-provider-contract-mismatch:wide');
    assert.equal(result.lifecycle.publishable, false);
    assert.equal(result.model, null);
    assert.equal(result.stats.engineBackend, null);
    assert.equal(provider.calls, 0, 'a provider whose contract no longer rebinds is never invoked');
  }

  const mutatesDuringCheck = new MutableIdentityBackend('mutates-during-check');
  mutatesDuringCheck.createSession = function createSession() {
    return {
      check: (checkedQuery) => {
        this.calls++;
        this.proofAuthority = PROOF_AUTHORITY.HEURISTIC;
        return createSolverResult({ status: SOLVER_STATUS.UNSAT, backend: this.id, backendVersion: this.version, queryHash: checkedQuery.queryHash });
      },
      dispose: async () => {},
    };
  };
  const synchronousMutationResult = await new TieredBvBackend({ wideBackend: mutatesDuringCheck }).createSession().check(candidate);
  assert.equal(synchronousMutationResult.status, SOLVER_STATUS.PROVIDER_FAILURE);
  assert.equal(synchronousMutationResult.reason, 'tier-provider-contract-mismatch:wide');
  assert.equal(synchronousMutationResult.lifecycle.publishable, false);
  assert.equal(synchronousMutationResult.model, null);
  assert.equal(mutatesDuringCheck.calls, 1, 'post-call rebind rejects authority changed by a synchronous provider call');

  const accessorIdentity = new MutableIdentityBackend('accessor-provider-id');
  Object.defineProperty(accessorIdentity, 'id', { enumerable: true, get: () => 'accessor-provider-id' });
  assert.throws(() => new TieredBvBackend({ wideBackend: accessorIdentity }), /id must be an own data property/);

  const proxiedIdentity = new Proxy(new MutableIdentityBackend('proxied-provider-id'), {});
  assert.throws(() => new TieredBvBackend({ wideBackend: proxiedIdentity }), /branded SolverBackend instance, not a proxy/);
});

test('supported sort sets have canonical contract ordering and tier fingerprints', () => {
  class OrderedSortsBackend extends SolverBackend {
    constructor(sorts) {
      super({ id: 'canonical-sorts-provider', version: '1.0.0', proofAuthority: PROOF_AUTHORITY.EXACT });
      this.sorts = sorts;
    }
    capabilityFingerprint() { return 'canonical-sorts-provider-capability-v1'; }
    capabilities() {
      return {
        ...super.baseCapabilities(),
        supportedSorts: [...this.sorts],
        maxBvWidth: 64,
        exactProofs: true,
        supportsModelExtraction: true,
        proofAuthority: PROOF_AUTHORITY.EXACT,
        capabilityFingerprint: this.capabilityFingerprint(),
      };
    }
    createSession() { throw new Error('canonicalization test does not execute'); }
  }

  const ascending = new TieredBvBackend({ wideBackend: new OrderedSortsBackend(['bool', 'bv']) });
  const reversed = new TieredBvBackend({ wideBackend: new OrderedSortsBackend(['bv', 'bool']) });
  assert.deepEqual(ascending.capabilities().wideCapabilityContract.supportedSorts, ['bool', 'bv']);
  assert.deepEqual(reversed.capabilities().wideCapabilityContract.supportedSorts, ['bool', 'bv']);
  assert.equal(ascending.capabilityFingerprint(), reversed.capabilityFingerprint());
});

test('deterministic solving binds model identity and structural evidence', async () => {
  const backend = new BitBlastBvBackend();
  const x = createFreshSymbol(bvSort(32), 'deterministic_x');
  const candidate = query(createConnective(BOOL_CONNECTIVE_OP.AND,
    createCompare(BV_COMPARE_OP.UGE, x, createBv(32, 11n)),
    createCompare(BV_COMPARE_OP.ULE, x, createBv(32, 11n))));
  const first = await backend.createSession().check(candidate);
  const second = await backend.createSession().check(candidate);
  assert.equal(first.status, SOLVER_STATUS.SAT);
  assert.equal(second.status, SOLVER_STATUS.SAT);
  assert.equal(first.queryHash, candidate.queryHash);
  assert.equal(second.queryHash, candidate.queryHash);
  assert.equal(first.model.get(x.symbolId), 11n);
  assert.equal(second.model.get(x.symbolId), 11n);
  assert.deepEqual(
    { variables: first.stats.cnfVariables, clauses: first.stats.cnfClauses, decisions: first.stats.decisions, propagations: first.stats.propagations },
    { variables: second.stats.cnfVariables, clauses: second.stats.cnfClauses, decisions: second.stats.decisions, propagations: second.stats.propagations },
  );
});

test('canonical query identity rejects reused hashes after content and identity mutation', async () => {
  const x = createFreshSymbol(bvSort(8), 'identity_x');
  const original = createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    targetEntity: { functionId: 'f_identity', edgeId: 'e_identity' },
    constraints: [createCompare(BV_COMPARE_OP.EQ, x, createBv(8, 7n))],
    assertion: createCompare(BV_COMPARE_OP.UGE, x, createBv(8, 3n)),
    architecture: 'generic',
    bitWidth: 8,
    proofScope: { blockIds: ['b0'] },
  });
  const mutations = [
    (candidate) => { candidate.constraints[0].right.value = 9n; },
    (candidate) => { candidate.assertion.right.value = 4n; },
    (candidate) => { candidate.constraints[0].left.name = 'forged_symbol_name'; },
    (candidate) => { candidate.targetEntity.edgeId = 'e_forged'; },
    (candidate) => { candidate.proofScope.blockIds[0] = 'b_forged'; },
    (candidate) => { candidate.architecture = 'forged-architecture'; },
    (candidate) => { candidate.bitWidth = 7; },
    (candidate) => { candidate.kind = VERIFICATION_QUERY_KIND.BOUNDED_EQUIVALENCE; },
    (candidate) => { candidate.claimKind = CLAIM_KIND.EQUIVALENT; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(original);
    mutate(candidate);
    assert.equal(candidate.queryHash, original.queryHash);
    for (const backend of [new ExhaustiveBvBackend(), new BitBlastBvBackend(), new TieredBvBackend()]) {
      const result = await backend.createSession().check(candidate);
      assert.equal(result.status, SOLVER_STATUS.INVALID_QUERY);
      assert.equal(result.reason, 'query-hash-content-mismatch');
      assert.equal(result.queryHash, null);
      assert.equal(result.lifecycle.publishable, false);
    }
  }

  const posted = [];
  const worker = {
    addEventListener() {},
    removeEventListener() {},
    postMessage(message) { posted.push(message); },
    terminate() {},
  };
  for (const mutate of mutations) {
    const forged = structuredClone(original);
    mutate(forged);
    const workerResult = await new WorkerSolverBackend({ workerFactory: () => worker }).createSession().check(forged);
    assert.equal(workerResult.status, SOLVER_STATUS.INVALID_QUERY);
    assert.equal(workerResult.reason, 'query-hash-content-mismatch');
    assert.equal(workerResult.queryHash, null);
  }
  assert.deepEqual(posted, []);
});

test('expression traversal is iterative, call-local, and stops at node authority', async () => {
  let deep = createBool(true);
  for (let index = 0; index < 512; index++) deep = createConnective(BOOL_CONNECTIVE_OP.NOT, deep);
  const deepQuery = query(deep);
  const wideArgs = Array.from({ length: 256 }, (_, index) => createCompare(
    BV_COMPARE_OP.EQ,
    createBv(8, BigInt(index)),
    createBv(8, BigInt(index)),
  ));
  const wideQuery = query(createConnective(BOOL_CONNECTIVE_OP.AND, ...wideArgs));
  for (const candidate of [deepQuery, wideQuery]) {
    const backends = [
      new ExhaustiveBvBackend({ maxExprNodes: 32 }),
      new BitBlastBvBackend({ maxExprNodes: 32 }),
      new TieredBvBackend({ maxExprNodes: 32 }),
    ];
    for (const backend of backends) {
      const result = await backend.createSession().check(candidate);
      assert.equal(result.status, SOLVER_STATUS.RESOURCE_LIMIT);
      assert.equal(result.reason, 'expression-node-budget-exceeded');
      assert.equal(result.lifecycle.publishable, false);
    }
  }

  const cyclic = { kind: 'connective', op: BOOL_CONNECTIVE_OP.NOT, sort: { kind: 'bool' }, args: [] };
  cyclic.args.push(cyclic);
  const first = collectSymbols([cyclic], { maxExprNodes: 16 });
  const second = collectSymbols([cyclic], { maxExprNodes: 16 });
  assert.equal(first.unsupportedReason, 'cyclic-expression-dag');
  assert.equal(second.unsupportedReason, 'cyclic-expression-dag');
  assert.equal(first.limitExceeded, false);
  assert.equal(first.nodeCount, 1);

  const shared = createBool(true);
  const repeatedEdges = { kind: 'connective', op: BOOL_CONNECTIVE_OP.AND, sort: { kind: 'bool' }, args: Array(256).fill(shared) };
  const repeated = collectSymbols([repeatedEdges], { maxExprNodes: 16 });
  assert.equal(repeated.limitExceeded, true);
  assert.equal(repeated.unsupportedReason, null);
});

test('capability and runtime budgets reject coercion, NaN, fractions, and widening', async () => {
  const malformed = [undefined, null, '64', Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0, -1];
  for (const value of malformed) {
    assert.throws(() => new ExhaustiveBvBackend({ maxExprNodes: value }), TypeError);
    assert.throws(() => new BitBlastBvBackend({ maxVariables: value }), TypeError);
    assert.throws(() => new TieredBvBackend({ maxBvWidth: value }), TypeError);
    assert.throws(() => new WorkerSolverBackend({ maxClauses: value }), TypeError);
  }
  assert.throws(() => new TieredBvBackend({ maxBvWidth: 8, exhaustiveMaxBvWidth: 9 }), TypeError);
  assert.throws(() => new WorkerSolverBackend({ maxBvWidth: 8, exhaustiveMaxBvWidth: 9 }), TypeError);

  const candidate = query(createBool(true));
  for (const [name, value] of [['maxExprNodes', '100'], ['maxVariables', Number.NaN], ['yieldEvery', 1.25]]) {
    const result = await new BitBlastBvBackend().createSession().check(candidate, { [name]: value });
    assert.equal(result.status, SOLVER_STATUS.INVALID_QUERY);
    assert.match(result.reason, /^invalid-budget:/);
    assert.equal(result.queryHash, null);
  }
  const badTimeout = await new BitBlastBvBackend().createSession().check(candidate, { timeoutMs: '5' });
  assert.equal(badTimeout.status, SOLVER_STATUS.INVALID_QUERY);
  assert.equal(badTimeout.queryHash, null);
  const route = classifyTieredQuery(candidate, { maxExprNodes: Number.NaN });
  assert.equal(route.status, SOLVER_STATUS.INVALID_QUERY);
});

test('result snapshots are transitively immutable including Map models and nested evidence', () => {
  const source = new Map([['x', { witness: [7n] }]]);
  const result = createSolverResult({ status: SOLVER_STATUS.SAT, model: source, stats: { evidence: { path: ['a'] } } });
  source.get('x').witness[0] = 8n;
  assert.equal(result.model.get('x').witness[0], 7n);
  assert.throws(() => result.model.set('y', 1n), TypeError);
  assert.throws(() => result.model.delete('x'), TypeError);
  assert.throws(() => result.model.clear(), TypeError);
  assert.throws(() => Map.prototype.set.call(result.model, 'x', 9n), TypeError);
  assert.throws(() => { result.model.get('x').witness[0] = 9n; }, TypeError);
  assert.throws(() => { result.stats.evidence.path.push('b'); }, TypeError);
  assert.throws(() => { result.status = SOLVER_STATUS.UNSAT; }, TypeError);
  assert.equal(result.status, SOLVER_STATUS.SAT);
});

test('identity data is canonical plain immutable data with bounded edges and longest DAG depth', async () => {
  for (const invalid of [new Map([['edge', 'a']]), new Set(['a']), new Date(0), new Uint8Array([1])]) {
    assert.throws(() => createVerificationQuery({
      kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
      claimKind: CLAIM_KIND.EDGE_FEASIBLE,
      targetEntity: invalid,
      assertion: createBool(true),
    }), /unsupported-query-identity-object/);
  }
  for (const edge of ['edge-A', 'edge-B']) assert.throws(() => createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    targetEntity: new Map([['edge', edge]]),
    assertion: createBool(true),
  }), /unsupported-query-identity-object/);
  const base = structuredClone(query(createBool(true)));
  base.targetEntity = new Map([['edge', 'forged']]);
  assert.equal(validateVerificationQuery(base).valid, false);
  for (const backend of [new ExhaustiveBvBackend(), new BitBlastBvBackend(), new TieredBvBackend()]) {
    const result = await backend.createSession().check(base);
    assert.equal(result.status, SOLVER_STATUS.INVALID_QUERY);
    assert.equal(result.lifecycle.publishable, false);
  }

  const shared = Object.freeze({ leaf: Object.freeze({}) });
  const longest = structuredClone(query(createBool(true)));
  longest.targetEntity = { shallow: shared, deep: { shared } };
  const depth = validateVerificationQuery(longest, { maxIdentityDepth: 3 });
  assert.equal(depth.valid, false);
  assert.equal(depth.reason, 'query-identity-depth-exceeded');

  const repeated = structuredClone(query(createBool(true)));
  repeated.targetEntity = Array(10000).fill(Object.freeze({ edge: 'same' }));
  const edges = validateVerificationQuery(repeated, { maxIdentityNodes: 5 });
  assert.equal(edges.valid, false);
  assert.equal(edges.reason, 'query-identity-edge-budget-exceeded');
});

test('constructor ceilings reject caller widening across every route', async () => {
  const candidate = query(null, [createBool(true), createBool(true)]);
  for (const backend of [
    new ExhaustiveBvBackend({ maxConstraints: 1 }),
    new BitBlastBvBackend({ maxConstraints: 1 }),
    new TieredBvBackend({ maxConstraints: 1 }),
  ]) {
    const result = await backend.createSession({ maxConstraints: Number.MAX_SAFE_INTEGER }).check(candidate, { maxConstraints: Number.MAX_SAFE_INTEGER });
    assert.equal(result.status, SOLVER_STATUS.RESOURCE_LIMIT);
    assert.equal(result.reason, 'constraint-budget-exceeded');
    assert.equal(result.lifecycle.publishable, false);
  }
});

test('deep and shared expression DAGs fail closed at the explicit frozen depth ceiling', async () => {
  let deep = createBool(true);
  for (let index = 0; index < 12000; index++) deep = createConnective(BOOL_CONNECTIVE_OP.NOT, deep);
  const deepQuery = query(deep);
  for (const backend of [new ExhaustiveBvBackend(), new BitBlastBvBackend(), new TieredBvBackend()]) {
    const result = await backend.createSession({ maxExprDepth: 20000 }).check(deepQuery, { maxExprDepth: 20000 });
    assert.equal(result.status, SOLVER_STATUS.RESOURCE_LIMIT);
    assert.equal(result.reason, 'expression-depth-budget-exceeded');
    assert.equal(result.lifecycle.publishable, false);
  }

  const leaf = createBool(true);
  const shared = createConnective(BOOL_CONNECTIVE_OP.NOT, createConnective(BOOL_CONNECTIVE_OP.NOT, leaf));
  const deeper = createConnective(BOOL_CONNECTIVE_OP.NOT, shared);
  const collected = collectSymbols([shared, deeper], { maxExprNodes: 20, maxExprDepth: 3 });
  assert.equal(collected.depthExceeded, true);
  const cyclic = { kind: 'connective', op: BOOL_CONNECTIVE_OP.NOT, sort: boolSort(), args: [] };
  cyclic.args.push(cyclic);
  assert.equal(collectSymbols([cyclic], { maxExprNodes: 20, maxExprDepth: 3 }).unsupportedReason, 'cyclic-expression-dag');
});

test('noncanonical BV constants never mint false UNSAT in any exact tier', async () => {
  const x = createFreshSymbol(bvSort(4), 'canonical_constant_x');
  for (const value of [17n, -1n, 16n]) {
    const rawConstant = { kind: 'const', sort: bvSort(4), value };
    const candidate = query(null, [
      createCompare(BV_COMPARE_OP.EQ, x, createBv(4, 1n)),
      createCompare(BV_COMPARE_OP.EQ, x, rawConstant),
    ]);
    for (const backend of [new ExhaustiveBvBackend(), new BitBlastBvBackend(), new TieredBvBackend()]) {
      const result = await backend.createSession().check(candidate);
      assert.equal(result.status, SOLVER_STATUS.UNSUPPORTED);
      assert.equal(result.reason, 'noncanonical-bv-constant');
      assert.equal(result.lifecycle.publishable, false);
    }
  }
});

test('exhaustive internal deadline cannot be widened by yieldEvery', async () => {
  const symbols = Array.from({ length: 20 }, (_, index) => createFreshSymbol(boolSort(), `timeout_bool_${index}`));
  const impossible = createConnective(BOOL_CONNECTIVE_OP.AND, ...symbols, createConnective(BOOL_CONNECTIVE_OP.NOT, symbols[0]));
  for (const backend of [new ExhaustiveBvBackend(), new TieredBvBackend()]) {
    const result = await backend.createSession({ yieldEvery: Number.MAX_SAFE_INTEGER }).check(query(impossible), { timeoutMs: 1, yieldEvery: Number.MAX_SAFE_INTEGER });
    assert.equal(result.status, SOLVER_STATUS.TIMEOUT);
    assert.equal(result.lifecycle.publishable, false);
  }
});

test('tier publication requires primitive canonical BV witnesses at exact boundaries', async () => {
  const x = createFreshSymbol(bvSort(4), 'strict_model_x');
  const candidate = query(createCompare(BV_COMPARE_OP.EQ, x, createBv(4, 7n)));
  class InjectedModelBackend extends SolverBackend {
    constructor(model) { super({ id: 'injected-model', version: '1.0.0', proofAuthority: PROOF_AUTHORITY.EXACT }); this.model = model; }
    baseCapabilities() { return { ...super.baseCapabilities(), exactProofs: true, supportsModelExtraction: true }; }
    createSession() { return { check: async (q) => createSolverResult({ status: SOLVER_STATUS.SAT, model: this.model, backend: this.id, backendVersion: this.version, queryHash: q.queryHash }), dispose: async () => {} }; }
  }
  for (const value of ['7', 7, -1n, 16n]) {
    const injected = new InjectedModelBackend({ [x.symbolId]: value });
    const result = await new TieredBvBackend({ narrowBackend: injected, wideBackend: injected }).createSession().check(candidate);
    assert.equal(result.status, SOLVER_STATUS.PROVIDER_FAILURE);
    assert.equal(result.lifecycle.publishable, false);
  }
  for (const [expected, assertion] of [[0n, createBv(4, 0n)], [15n, createBv(4, 15n)]]) {
    const boundaryQuery = query(createCompare(BV_COMPARE_OP.EQ, x, assertion));
    const injected = new InjectedModelBackend({ [x.symbolId]: expected });
    const result = await new TieredBvBackend({ narrowBackend: injected, wideBackend: injected }).createSession().check(boundaryQuery);
    assert.equal(result.status, SOLVER_STATUS.SAT);
    assert.equal(result.model[x.symbolId], expected);
  }
});
