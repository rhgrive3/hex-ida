import test from 'node:test';
import assert from 'node:assert/strict';

import { OP } from '../js/ir.js';
import { symbolicExecute } from '../js/symbolic/executor.js';
import { TieredBvBackend } from '../js/symbolic/solver/tiered-backend.js';
import { SOLVER_STATUS, createSolverResult } from '../js/symbolic/solver/result.js';
import { verifyBoundedEquivalence } from '../js/symbolic/verify/equivalence.js';
import { verifyConditionalEdgeFeasibility } from '../js/symbolic/verify/edge-feasibility.js';
import {
  CLAIM_KIND,
  VERDICT,
  VERIFICATION_QUERY_KIND,
  createVerificationQuery,
} from '../js/symbolic/verify/query.js';
import {
  bvSort,
  BV_BINARY_OP,
  BV_COMPARE_OP,
} from '../js/symbolic/expr/kinds.js';
import {
  createBool,
  createBv,
  createBinary,
  createCompare,
  createFreshSymbol,
} from '../js/symbolic/expr/factory.js';

function makeQuery(constraints, assertion = createBool(true)) {
  return createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    targetEntity: 'full-fix-track-3',
    constraints,
    assertion,
  });
}

// ---------------------------------------------------------------------------
// #1 [P1] tiered-backend.js: providerEligible respects effective limits
// ---------------------------------------------------------------------------
test('[FF-T3-#1] TieredBvBackend providerEligible honors limits (exhaustiveMaxAssignments / exhaustiveMaxBvWidth) so narrow does not poison wide', async () => {
  const backend = new TieredBvBackend();
  const x8 = createFreshSymbol(bvSort(8), 'x8');
  const satQuery8 = makeQuery([createCompare(BV_COMPARE_OP.EQ, x8, createBv(8, 42n))]);
  const unsatQuery8 = makeQuery([
    createCompare(BV_COMPARE_OP.EQ, x8, createBv(8, 1n)),
    createCompare(BV_COMPARE_OP.EQ, x8, createBv(8, 2n)),
  ]);

  // (a) Tight exhaustiveMaxAssignments (8 < 256 domain): narrow must be ineligible, wide must succeed
  const sessionA = backend.createSession({ exhaustiveMaxAssignments: 8 });
  const satResA = await sessionA.check(satQuery8);
  assert.equal(satResA.status, SOLVER_STATUS.SAT);
  assert.equal(satResA.model.get(x8.symbolId), 42n);
  assert.equal(satResA.stats.eligibility[0].eligible, false, 'narrow must be ineligible when domain exceeds limits.exhaustiveMaxAssignments');
  assert.equal(satResA.stats.eligibility[1].eligible, true);
  assert.equal(satResA.stats.engineBackend, backend.wideBackend.id);

  const unsatResA = await sessionA.check(unsatQuery8);
  assert.equal(unsatResA.status, SOLVER_STATUS.UNSAT);
  assert.equal(unsatResA.stats.eligibility[0].eligible, false);
  assert.equal(unsatResA.stats.engineBackend, backend.wideBackend.id);

  // Per-check override of exhaustiveMaxAssignments also excludes narrow
  const defaultSession = backend.createSession();
  const perCheckRes = await defaultSession.check(satQuery8, { exhaustiveMaxAssignments: 16 });
  assert.equal(perCheckRes.status, SOLVER_STATUS.SAT);
  assert.equal(perCheckRes.stats.eligibility[0].eligible, false);
  assert.equal(perCheckRes.stats.engineBackend, backend.wideBackend.id);

  // (b) Tight exhaustiveMaxBvWidth (4 < 8): narrow must be ineligible, wide must succeed
  const narrowWidthRes = await defaultSession.check(satQuery8, { exhaustiveMaxBvWidth: 4 });
  assert.equal(narrowWidthRes.status, SOLVER_STATUS.SAT);
  assert.equal(narrowWidthRes.model.get(x8.symbolId), 42n);
  assert.equal(narrowWidthRes.stats.eligibility[0].eligible, false, 'narrow must be ineligible when maxBvWidth exceeds limits.exhaustiveMaxBvWidth');
  assert.equal(narrowWidthRes.stats.eligibility[1].eligible, true);
  assert.equal(narrowWidthRes.stats.engineBackend, backend.wideBackend.id);

  // (c) Within both limits (4-bit, domain 16 <= 32): both narrow and wide remain eligible and agree
  const x4 = createFreshSymbol(bvSort(4), 'x4');
  const satQuery4 = makeQuery([createCompare(BV_COMPARE_OP.EQ, x4, createBv(4, 9n))]);
  const overlapRes = await defaultSession.check(satQuery4, { exhaustiveMaxBvWidth: 4, exhaustiveMaxAssignments: 32 });
  assert.equal(overlapRes.status, SOLVER_STATUS.SAT);
  assert.equal(overlapRes.model instanceof Map ? overlapRes.model.get(x4.symbolId) : overlapRes.model[x4.symbolId], 9n);
  assert.equal(overlapRes.stats.eligibility[0].eligible, true);
  assert.equal(overlapRes.stats.eligibility[1].eligible, true);
  assert.equal(overlapRes.stats.agreementBackends.length, 2);
});

// ---------------------------------------------------------------------------
// #2 [P1] equivalence.js & edge-feasibility.js: non-cancelled solver failures
//         must not be remapped to reasonCode: 'cancelled'
// ---------------------------------------------------------------------------
function makeStubSession(resultFactory) {
  return {
    backend: { id: 'stub-backend', version: '1.0.0', proofAuthority: 'exact', capabilityFingerprint: () => 'fp' },
    async check(query) {
      return resultFactory(query);
    },
  };
}

test('[FF-T3-#2] verifyBoundedEquivalence and verifyConditionalEdgeFeasibility classify solver failure statuses instead of mapping publishable:false to cancelled', async () => {
  const x = createFreshSymbol(bvSort(8), 'x');
  const y = createBinary(BV_BINARY_OP.ADD, x, createBv(8, 1n));
  const edgeCond = createCompare(BV_COMPARE_OP.EQ, x, createBv(8, 1n));

  const failureStatuses = [
    { status: SOLVER_STATUS.RESOURCE_LIMIT, reason: 'assignment-budget-exceeded' },
    { status: SOLVER_STATUS.UNSUPPORTED, reason: 'unsupported-operator' },
    { status: SOLVER_STATUS.PROVIDER_FAILURE, reason: 'worker-crashed' },
    { status: SOLVER_STATUS.INVALID_QUERY, reason: 'malformed-query' },
    { status: SOLVER_STATUS.UNKNOWN, reason: 'indeterminate-result' },
  ];

  for (const { status, reason } of failureStatuses) {
    const session = makeStubSession((query) => createSolverResult({
      status,
      reason,
      backend: 'stub-backend',
      backendVersion: '1.0.0',
      queryHash: query.queryHash,
    }));

    const eqRes = await verifyBoundedEquivalence({ beforeTarget: x, afterTarget: y, session });
    assert.equal(eqRes.verdict, VERDICT.UNKNOWN);
    assert.equal(eqRes.solverStatus, status);
    assert.equal(eqRes.reasonCode, `solver-failure-${status}`, `equivalence must preserve ${status} instead of 'cancelled'`);
    assert.notEqual(eqRes.reasonCode, 'cancelled');

    const edgeRes = await verifyConditionalEdgeFeasibility({
      fromBlock: 0,
      toBlock: 1,
      edgeCondition: edgeCond,
      session,
    });
    assert.equal(edgeRes.verdict, VERDICT.UNKNOWN);
    assert.equal(edgeRes.solverStatus, status);
    assert.equal(edgeRes.reasonCode, reason, `edge-feasibility must preserve reason for ${status} instead of 'cancelled'`);
    assert.notEqual(edgeRes.reasonCode, 'cancelled');
  }

  // Explicit lifecycle invalidations still map to their specific reasonCodes
  const lifecycleCases = [
    { status: SOLVER_STATUS.TIMEOUT, lifecycle: { timedOut: true }, expected: 'timeout' },
    { status: SOLVER_STATUS.CANCELLED, lifecycle: { cancelled: true }, expected: 'cancelled' },
    { status: SOLVER_STATUS.UNKNOWN, lifecycle: { stale: true }, expected: 'stale-result' },
    { status: SOLVER_STATUS.UNKNOWN, lifecycle: { disposed: true }, expected: 'disposed-session' },
    { status: SOLVER_STATUS.SAT, lifecycle: { publishable: false, late: true }, expected: 'late-result' },
  ];

  for (const { status, lifecycle, expected } of lifecycleCases) {
    const session = makeStubSession((query) => createSolverResult({
      status,
      model: status === SOLVER_STATUS.SAT ? { [x.symbolId]: 1n } : null,
      backend: 'stub-backend',
      backendVersion: '1.0.0',
      queryHash: query.queryHash,
      lifecycle,
    }));

    const eqRes = await verifyBoundedEquivalence({ beforeTarget: x, afterTarget: y, session });
    assert.equal(eqRes.verdict, VERDICT.UNKNOWN);
    assert.equal(eqRes.reasonCode, expected);

    const edgeRes = await verifyConditionalEdgeFeasibility({
      fromBlock: 0,
      toBlock: 1,
      edgeCondition: edgeCond,
      session,
    });
    assert.equal(edgeRes.verdict, VERDICT.UNKNOWN);
    assert.equal(edgeRes.reasonCode, expected);
  }
});

// ---------------------------------------------------------------------------
// #3 [P2] equivalence.js & edge-feasibility.js: dispose internally created
//         sessions in try...finally without disposing caller-supplied sessions
// ---------------------------------------------------------------------------
function makeDisposableBackend({ throwOnCheck = false } = {}) {
  const sessions = [];
  return {
    sessions,
    createSession() {
      const s = {
        disposed: 0,
        backend: { id: 'disp-backend', version: '1.0.0', proofAuthority: 'exact', capabilityFingerprint: () => 'fp' },
        async check(query) {
          if (throwOnCheck) throw new Error('boom-check');
          return createSolverResult({
            status: SOLVER_STATUS.UNKNOWN,
            reason: 'stub',
            backend: 'disp-backend',
            backendVersion: '1.0.0',
            queryHash: query.queryHash,
          });
        },
        async dispose() {
          this.disposed += 1;
        },
      };
      sessions.push(s);
      return s;
    },
  };
}

test('[FF-T3-#3] verifyBoundedEquivalence and verifyConditionalEdgeFeasibility dispose internally created sessions and preserve caller sessions', async () => {
  const x = createFreshSymbol(bvSort(8), 'x');
  const y = createBinary(BV_BINARY_OP.ADD, x, createBv(8, 1n));
  const z16 = createFreshSymbol(bvSort(16), 'z16');
  const edgeCond = createCompare(BV_COMPARE_OP.EQ, x, createBv(8, 1n));

  // (a) Equivalence: normal completion, early return (sort mismatch), and thrown error all dispose internal session
  const eqBackend = makeDisposableBackend();
  await verifyBoundedEquivalence({ beforeTarget: x, afterTarget: y, backend: eqBackend });
  assert.equal(eqBackend.sessions[0].disposed, 1, 'internal equivalence session must be disposed on normal return');

  await verifyBoundedEquivalence({ beforeTarget: x, afterTarget: z16, backend: eqBackend });
  assert.equal(eqBackend.sessions[1].disposed, 1, 'internal equivalence session must be disposed on early return');

  const eqThrowBackend = makeDisposableBackend({ throwOnCheck: true });
  await assert.rejects(
    () => verifyBoundedEquivalence({ beforeTarget: x, afterTarget: y, backend: eqThrowBackend }),
    /boom-check/,
  );
  assert.equal(eqThrowBackend.sessions[0].disposed, 1, 'internal equivalence session must be disposed when check throws');

  // External session must NOT be disposed
  const externalEqSession = eqBackend.createSession();
  await verifyBoundedEquivalence({ beforeTarget: x, afterTarget: y, session: externalEqSession });
  assert.equal(externalEqSession.disposed, 0, 'caller-supplied equivalence session must not be disposed');

  // (b) Edge feasibility: normal completion, early return (translation failed), and thrown error all dispose internal session
  const edgeBackend = makeDisposableBackend();
  await verifyConditionalEdgeFeasibility({ fromBlock: 0, toBlock: 1, edgeCondition: edgeCond, backend: edgeBackend });
  assert.equal(edgeBackend.sessions[0].disposed, 1, 'internal edge-feasibility session must be disposed on normal return');

  await verifyConditionalEdgeFeasibility({ fromBlock: 0, toBlock: 1, edgeCondition: { unsupportedIrNode: true }, backend: edgeBackend });
  assert.equal(edgeBackend.sessions[1].disposed, 1, 'internal edge-feasibility session must be disposed on early return');

  const edgeThrowBackend = makeDisposableBackend({ throwOnCheck: true });
  await assert.rejects(
    () => verifyConditionalEdgeFeasibility({ fromBlock: 0, toBlock: 1, edgeCondition: edgeCond, backend: edgeThrowBackend }),
    /boom-check/,
  );
  assert.equal(edgeThrowBackend.sessions[0].disposed, 1, 'internal edge-feasibility session must be disposed when check throws');

  // External session must NOT be disposed
  const externalEdgeSession = edgeBackend.createSession();
  await verifyConditionalEdgeFeasibility({ fromBlock: 0, toBlock: 1, edgeCondition: edgeCond, session: externalEdgeSession });
  assert.equal(externalEdgeSession.disposed, 0, 'caller-supplied edge-feasibility session must not be disposed');
});

// ---------------------------------------------------------------------------
// #4 [P2] executor.js: legacy lshr / tbz / tbnz use unsigned logical right shift
// ---------------------------------------------------------------------------
function makeTbzIr({ kind = 'tbz', bits = 64, bit = 0 }) {
  const arg0 = { id: 1, kind: 'arg', reg: 'x0', bits, def: null };
  const vTaken = { id: 2, const: 100n, bits: 64, def: null };
  const vFall = { id: 3, const: 200n, bits: 64, def: null };
  const cbr = {
    id: 10,
    row: 1,
    address: 0x1000n,
    op: OP.CBR,
    args: [{ value: arg0, bits }],
    extra: { kind, bit, target: 0x2000n },
  };
  return {
    entry: 0,
    blocks: [
      { index: 0, succ: [1, 2], phis: [], insts: [cbr] },
      { index: 1, succ: [], phis: [], insts: [{ id: 11, row: 2, address: 0x1004n, op: OP.RET, args: [{ value: vFall }], extra: {} }] },
      { index: 2, succ: [], phis: [], insts: [{ id: 12, row: 3, address: 0x2000n, op: OP.RET, args: [{ value: vTaken }], extra: {} }] },
    ],
  };
}

test('[FF-T3-#4] executor.js legacy tbz/tbnz uses unsigned logical right shift without sign-extending negative BigInt', () => {
  // 32-bit -1n has bits 0..31 set and bit 32 clear: BigInt.asUintN(32, -1n) >> 32n === 0n
  const tbz32OutOfRange = symbolicExecute(makeTbzIr({ kind: 'tbz', bits: 32, bit: 32 }), {
    symbolicArgs: { 0: -1n },
  });
  assert.equal(tbz32OutOfRange.paths.length, 1);
  assert.equal(tbz32OutOfRange.paths[0].returnValue.value, 100n, 'tbz bit 32 on 32-bit -1n must see 0 (taken)');

  const tbnz32OutOfRange = symbolicExecute(makeTbzIr({ kind: 'tbnz', bits: 32, bit: 32 }), {
    symbolicArgs: { 0: -1n },
  });
  assert.equal(tbnz32OutOfRange.paths.length, 1);
  assert.equal(tbnz32OutOfRange.paths[0].returnValue.value, 200n, 'tbnz bit 32 on 32-bit -1n must see 0 (fallthrough)');

  // 64-bit -1n shifted by 64 must be 0, not sign-extended -1n
  const tbz64Bit64 = symbolicExecute(makeTbzIr({ kind: 'tbz', bits: 64, bit: 64 }), {
    symbolicArgs: { 0: -1n },
  });
  assert.equal(tbz64Bit64.paths.length, 1);
  assert.equal(tbz64Bit64.paths[0].returnValue.value, 100n, 'tbz bit 64 on 64-bit -1n must see 0 (taken)');

  // 32-bit -0x80000000n has bit 31 set
  const tbz32Bit31Set = symbolicExecute(makeTbzIr({ kind: 'tbz', bits: 32, bit: 31 }), {
    symbolicArgs: { 0: -0x80000000n },
  });
  assert.equal(tbz32Bit31Set.paths.length, 1);
  assert.equal(tbz32Bit31Set.paths[0].returnValue.value, 200n, 'tbz bit 31 on 32-bit -0x80000000n must see 1 (fallthrough)');

  const tbnz32Bit31Set = symbolicExecute(makeTbzIr({ kind: 'tbnz', bits: 32, bit: 31 }), {
    symbolicArgs: { 0: -0x80000000n },
  });
  assert.equal(tbnz32Bit31Set.paths.length, 1);
  assert.equal(tbnz32Bit31Set.paths[0].returnValue.value, 100n, 'tbnz bit 31 on 32-bit -0x80000000n must see 1 (taken)');
});
