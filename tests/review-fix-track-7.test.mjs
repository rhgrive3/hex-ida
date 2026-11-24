import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSemanticModel } from '../js/blocks.js';
import { buildIR, OP, VK } from '../js/ir.js';
import { stackPointerProvenanceOf } from '../js/architecture/compat/ir-core-arm64-aapcs64-v1.js';
import { bvSort, BV_BINARY_OP, BV_COMPARE_OP } from '../js/symbolic/expr/kinds.js';
import { createBv, createFreshSymbol, createBinary, createCompare } from '../js/symbolic/expr/factory.js';
import { SOLVER_STATUS } from '../js/symbolic/solver/result.js';
import { FakeSolverBackend } from '../js/symbolic/solver/fake-backend.js';
import { VERDICT, CLAIM_KIND } from '../js/symbolic/verify/query.js';
import { verifyConditionalEdgeFeasibility } from '../js/symbolic/verify/edge-feasibility.js';
import { verifyBoundedEquivalence } from '../js/symbolic/verify/equivalence.js';

const BASE = 0x100000000n;
function irOf(lines) {
  const rows = lines.map((line, i) => {
    const s = String(line).trim();
    const p = s.indexOf(' ');
    return { row: i, address: BASE + BigInt(i * 4), mn: p < 0 ? s : s.slice(0, p), ops: p < 0 ? '' : s.slice(p + 1) };
  });
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - BASE;
    if (d < 0n || d >= BigInt(lines.length * 4)) return null;
    return Number(d / 4n);
  };
  const model = buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
  return buildIR(model, { rowOfAddress, semanticMigrationMode: 'legacy-v1' });
}

function loadAt(ir, row) {
  return ir.instructions.find((i) => i.op === OP.LOAD && i.row === row);
}

function storeAt(ir, row) {
  return ir.instructions.find((i) => i.op === OP.STORE && i.row === row);
}

// ============================================================================
// P1-S03-003: Precondition translation failure must fail closed (VERDICT.UNKNOWN)
// ============================================================================

test('P1-S03-003: edge-feasibility fails closed on untranslatable Semantic IR precondition', async () => {
  const x = createFreshSymbol(bvSort(64), 'arg_x0');
  const edgeCond = createCompare(BV_COMPARE_OP.EQ, x, createBv(64, 42n));

  let solverCalled = false;
  const backend = new FakeSolverBackend({
    defaultStatus: SOLVER_STATUS.SAT,
    defaultModel: { arg_x0: 42n },
  });
  const origCreate = backend.createSession.bind(backend);
  backend.createSession = (...args) => {
    const session = origCreate(...args);
    const origCheck = session.check.bind(session);
    session.check = async (...cArgs) => {
      solverCalled = true;
      return origCheck(...cArgs);
    };
    return session;
  };

  // Empty plain object has no op/id/kind/const -> translateSemanticIR returns expression: null
  const res = await verifyConditionalEdgeFeasibility({
    fromBlock: 1,
    toBlock: 2,
    edgeCondition: edgeCond,
    preconditions: {},
    backend,
  });

  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.equal(res.claimKind, CLAIM_KIND.EDGE_INFEASIBLE);
  assert.equal(res.reasonCode, 'precondition-translation-failed');
  assert.equal(res.solverStatus, SOLVER_STATUS.UNSUPPORTED);
  assert.equal(res.preconditionStatus, 'unknown');
  assert.equal(res.query, null);
  assert.equal(res.solverResult, null);
  assert.equal(solverCalled, false, 'solver must not be called when precondition translation fails');
});

test('P1-S03-003: edge-feasibility fails closed when precondition array contains untranslatable item', async () => {
  const x = createFreshSymbol(bvSort(64), 'arg_x0');
  const edgeCond = createCompare(BV_COMPARE_OP.EQ, x, createBv(64, 42n));
  const validPre = createCompare(BV_COMPARE_OP.NE, x, createBv(64, 0n));
  const backend = new FakeSolverBackend({
    defaultStatus: SOLVER_STATUS.SAT,
    defaultModel: { arg_x0: 42n },
  });

  const res = await verifyConditionalEdgeFeasibility({
    fromBlock: 1,
    toBlock: 2,
    edgeCondition: edgeCond,
    preconditions: [validPre, {}],
    backend,
  });

  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.equal(res.reasonCode, 'precondition-translation-failed');
  assert.equal(res.solverStatus, SOLVER_STATUS.UNSUPPORTED);
});

test('P1-S03-003: equivalence fails closed on untranslatable Semantic IR precondition instead of returning REFUTED', async () => {
  const x = createFreshSymbol(bvSort(32), 'x');
  const beforeExpr = createBinary(BV_BINARY_OP.ADD, x, createBv(32, 1));
  const afterExpr = createBinary(BV_BINARY_OP.ADD, x, createBv(32, 2));

  let solverCalled = false;
  const backend = new FakeSolverBackend({
    defaultStatus: SOLVER_STATUS.SAT,
    defaultModel: { x: 0n },
  });
  const origCreate = backend.createSession.bind(backend);
  backend.createSession = (...args) => {
    const session = origCreate(...args);
    const origCheck = session.check.bind(session);
    session.check = async (...cArgs) => {
      solverCalled = true;
      return origCheck(...cArgs);
    };
    return session;
  };

  const res = await verifyBoundedEquivalence({
    beforeTarget: beforeExpr,
    afterTarget: afterExpr,
    preconditions: {},
    backend,
  });

  assert.equal(res.verdict, VERDICT.UNKNOWN);
  assert.equal(res.claimKind, CLAIM_KIND.EQUIVALENT);
  assert.equal(res.reasonCode, 'precondition-translation-failed');
  assert.equal(res.solverStatus, SOLVER_STATUS.UNSUPPORTED);
  assert.equal(res.query, null);
  assert.equal(res.solverResult, null);
  assert.equal(res.evidence, null);
  assert.equal(solverCalled, false, 'solver must not be called when precondition translation fails');
});

test('P1-S03-003: equivalence fails closed on untranslatable precondition in array and sort-mismatch paths', async () => {
  const x = createFreshSymbol(bvSort(32), 'x');
  const beforeExpr = createBinary(BV_BINARY_OP.ADD, x, createBv(32, 1));
  const afterExpr = createBinary(BV_BINARY_OP.ADD, x, createBv(32, 2));
  const validPre = createCompare(BV_COMPARE_OP.NE, x, createBv(32, 0));
  const backend = new FakeSolverBackend({
    defaultStatus: SOLVER_STATUS.SAT,
    defaultModel: { x: 1n },
  });

  const arrRes = await verifyBoundedEquivalence({
    beforeTarget: beforeExpr,
    afterTarget: afterExpr,
    preconditions: [validPre, {}],
    backend,
  });
  assert.equal(arrRes.verdict, VERDICT.UNKNOWN);
  assert.equal(arrRes.reasonCode, 'precondition-translation-failed');

  const sortRes = await verifyBoundedEquivalence({
    beforeTarget: createBv(8, 1),
    afterTarget: createBv(32, 1),
    preconditions: {},
    backend,
  });
  assert.equal(sortRes.verdict, VERDICT.UNKNOWN);
  assert.equal(sortRes.reasonCode, 'precondition-translation-failed');
});

// ============================================================================
// P1-S06-002: ARM64 entry x29 != sp provenance & MK.FIELD fail-closed overlap
// ============================================================================

test('P1-S06-002a: stackPointerProvenanceOf separates entry x29 from sp', () => {
  const spArg = { id: 1, kind: VK.ARG, reg: 'sp', def: null };
  const fpArg = { id: 2, kind: VK.ARG, reg: 'x29', def: null };

  const spProv = stackPointerProvenanceOf(spArg);
  const fpProv = stackPointerProvenanceOf(fpArg);

  assert.equal(spProv?.root, 'sp');
  assert.equal(spProv?.must, true);
  assert.equal(spProv?.offset, 0n);

  assert.equal(fpProv?.root, 'x29');
  assert.equal(fpProv?.must, false);
  assert.notEqual(fpProv?.root, spProv?.root);
});

test('P1-S06-002a: entry x29 without mov x29, sp is neither equated with sp nor proven disjoint from sp', () => {
  // 1. Entry [x29, #0] must not forward into [sp, #0]
  const irSameDisp = irOf([
    'mov x0, #11',
    'str x0, [x29, #0]',
    'ldr x1, [sp, #0]',
    'ret',
  ]);
  assert.notEqual(storeAt(irSameDisp, 1)?.loc?.key, loadAt(irSameDisp, 2)?.loc?.key,
    'entry x29 and sp must not canonicalize to the same stack location key');
  assert.notEqual(loadAt(irSameDisp, 2)?.dst?.const, 11n,
    'load from [sp, #0] must not forward constant stored to entry [x29, #0]');

  // 2. Store to [sp, #16] must conservatively clobber entry [x29, #0] (unknown frame offset)
  const irDiffDisp = irOf([
    'mov x0, #11',
    'str x0, [x29, #0]',
    'mov x1, #22',
    'str x1, [sp, #16]',
    'ldr x2, [x29, #0]',
    'ret',
  ]);
  const load = loadAt(irDiffDisp, 4);
  assert.notEqual(load?.reachingStore?.row, 1,
    'store to [sp, #16] must conservatively clobber entry [x29, #0]');
  assert.notEqual(load?.dst?.const, 11n,
    'stale constant 11 must not propagate across may-alias SP store');
});

test('P1-S06-002b: MK.FIELD store through non-argument register x9 conservatively clobbers stack slot', () => {
  // x9 is loaded from memory (not VK.ARG, not x0-x7, no stackPointerProvenanceOf proof).
  // It could hold a pointer to [sp, #8], so storing through [x9, #0] must fail closed.
  const ir = irOf([
    'mov x1, #77',
    'str x1, [sp, #8]',
    'ldr x9, [x0, #0]',
    'mov x2, #99',
    'str x2, [x9, #0]',
    'ldr x3, [sp, #8]',
    'ret',
  ]);
  const load = loadAt(ir, 5);
  assert.ok(load, 'stack load exists');
  assert.notEqual(load?.reachingStore?.row, 1,
    'non-argument MK.FIELD store through unproven x9 must clobber [sp, #8]');
  assert.notEqual(load?.dst?.const, 77n,
    'stale constant 77 must not propagate past unproven MK.FIELD store');
});

test('P1-S06-002b: MK.FIELD store with proven disjoint sp provenance still does not over-clobber', () => {
  const ir = irOf([
    'mov x1, #77',
    'str x1, [sp, #0]',
    'add x9, sp, #16',
    'mov x2, #99',
    'str x2, [x9, #0]',
    'ldr x3, [sp, #0]',
    'ret',
  ]);
  const load = loadAt(ir, 5);
  assert.equal(load?.reachingStore?.row, 1,
    'disjoint sp-proven store at sp+16 must not clobber [sp, #0]');
  assert.equal(load?.dst?.const, 77n);
});
