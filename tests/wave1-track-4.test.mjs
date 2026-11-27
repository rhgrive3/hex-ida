import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSemanticModel } from '../js/blocks.js';
import { OP } from '../js/ir.js';
import { symbolicExecute, SYM } from '../js/symbolic/executor.js';
import { BitBlastBvBackend } from '../js/symbolic/solver/bitblast-backend.js';
import { TieredBvBackend } from '../js/symbolic/solver/tiered-backend.js';
import { analyzeSolverExpressions } from '../js/symbolic/solver/query-analysis.js';
import { WorkerSolverBackend } from '../js/symbolic/solver/worker-backend.js';
import { TieredWorkerSolverBackend } from '../js/symbolic/solver/tiered-worker-backend.js';
import { SolverBackend, PROOF_AUTHORITY } from '../js/symbolic/solver/backend.js';
import { SolverSession } from '../js/symbolic/solver/session.js';
import { SOLVER_STATUS, createSolverResult } from '../js/symbolic/solver/result.js';
import { CLAIM_KIND, VERIFICATION_QUERY_KIND, createVerificationQuery } from '../js/symbolic/verify/query.js';
import { bvSort, boolSort, BV_COMPARE_OP, BV_BINARY_OP, BOOL_CONNECTIVE_OP } from '../js/symbolic/expr/kinds.js';
import {
  createBool,
  createBv,
  createBinary,
  createCompare,
  createConnective,
  createFreshSymbol,
} from '../js/symbolic/expr/factory.js';
import { findIrConstantComparisons } from '../js/dataflow-ir-compare.js';
import { verifyAccessor } from '../js/verify.js';

const BASE = 0x100000000n;

function modelOf(lines) {
  const rows = lines.map((line, i) => {
    const s = line.trim();
    const p = s.indexOf(' ');
    return {
      row: i,
      address: BASE + BigInt(i * 4),
      mn: p < 0 ? s : s.slice(0, p),
      ops: p < 0 ? '' : s.slice(p + 1),
    };
  });
  const rowOfAddress = (addr) => {
    const d = addr - BASE;
    if (d < 0n || d >= BigInt(lines.length * 4)) return null;
    return Number(d / 4n);
  };
  return buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
}

function makeQuery(constraints, assertion = createBool(true)) {
  return createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    targetEntity: 'wave1-track-4',
    constraints,
    assertion,
  });
}

function makeBranchIr({ cmpInst, cond = 'eq', takenConst = 100n, fallthroughConst = 200n, extraEntryInsts = [] }) {
  const vRetTaken = { id: 901, const: takenConst, bits: 64, def: null };
  const vRetFall = { id: 902, const: fallthroughConst, bits: 64, def: null };
  const cbrInst = {
    id: 50,
    row: 10,
    address: 0x1010n,
    op: OP.CBR,
    cond,
    args: [{ value: cmpInst.dst }],
    extra: { target: 0x2000n },
  };
  const retFall = { id: 51, row: 11, address: 0x1014n, op: OP.RET, args: [{ value: vRetFall }], extra: {} };
  const retTaken = { id: 52, row: 12, address: 0x2000n, op: OP.RET, args: [{ value: vRetTaken }], extra: {} };
  return {
    entry: 0,
    blocks: [
      { index: 0, succ: [1, 2], phis: [], insts: [...extraEntryInsts, cmpInst, cbrInst] },
      { index: 1, succ: [], phis: [], insts: [retFall] },
      { index: 2, succ: [], phis: [], insts: [retTaken] },
    ],
  };
}

// ---------------------------------------------------------------------------
// #1 [P0] conditionFromCmp handles sub (tst/cmn/fcmp), float, conditional, shift
// ---------------------------------------------------------------------------
test('[W1-T4-#1] conditionFromCmp handles tst, cmn, fcmp, ccmp/ccmn, and operand shift', () => {
  const arg0 = { id: 1, kind: 'arg', reg: 'x0', bits: 32, def: null };
  const arg1 = { id: 2, kind: 'arg', reg: 'x1', bits: 32, def: null };
  const imm1 = { id: 3, const: 1n, bits: 32, def: null };
  const flags = { id: 4, reg: 'nzcv', bits: 4, def: null };

  // (a) tst (sub: 'and'): (2 & 1) == 0 -> taken; (3 & 1) != 0 -> fallthrough
  const tstCmp = { id: 10, row: 1, address: 0x1000n, op: OP.CMP, sub: 'and', dst: flags, args: [{ value: arg0, bits: 32 }, { value: imm1, bits: 32 }], extra: {} };
  flags.def = tstCmp;
  const tstIr = makeBranchIr({ cmpInst: tstCmp, cond: 'eq' });

  const tstTaken = symbolicExecute(tstIr, { symbolicArgs: { 0: 2n } });
  assert.equal(tstTaken.paths.length, 1);
  assert.equal(tstTaken.paths[0].returnValue.value, 100n, 'tst (2 & 1) == 0 must take eq branch');

  const tstFall = symbolicExecute(tstIr, { symbolicArgs: { 0: 3n } });
  assert.equal(tstFall.paths.length, 1);
  assert.equal(tstFall.paths[0].returnValue.value, 200n, 'tst (3 & 1) != 0 must fall through eq branch');

  // (b) cmn (sub: 'add'): (0xffffffff + 1) mod 2^32 == 0 -> taken
  const cmnCmp = { id: 11, row: 1, address: 0x1000n, op: OP.CMP, sub: 'add', dst: flags, args: [{ value: arg0, bits: 32 }, { value: imm1, bits: 32 }], extra: {} };
  flags.def = cmnCmp;
  const cmnEqIr = makeBranchIr({ cmpInst: cmnCmp, cond: 'eq' });
  const cmnRes = symbolicExecute(cmnEqIr, { symbolicArgs: { 0: 0xffffffffn } });
  assert.equal(cmnRes.paths.length, 1);
  assert.equal(cmnRes.paths[0].returnValue.value, 100n, 'cmn (-1 + 1) == 0 must take eq branch');

  // cmn with overflow-dependent condition (lt) fails closed
  const cmnLtIr = makeBranchIr({ cmpInst: cmnCmp, cond: 'lt' });
  const cmnLtRes = symbolicExecute(cmnLtIr, { symbolicArgs: { 0: 5n } });
  assert.equal(cmnLtRes.paths[0].status, 'unknown');
  assert.equal(cmnLtRes.paths[0].reason, 'unsupported-condition');

  // (c) fcmp (sub: 'fsub' or float: true) fails closed
  const fcmpInst = { id: 12, row: 1, address: 0x1000n, op: OP.CMP, sub: 'fsub', float: true, dst: flags, args: [{ value: arg0, bits: 32 }, { value: arg1, bits: 32 }], extra: { float: true } };
  flags.def = fcmpInst;
  const fcmpRes = symbolicExecute(makeBranchIr({ cmpInst: fcmpInst, cond: 'eq' }), { symbolicArgs: { 0: 1n, 1: 1n } });
  assert.equal(fcmpRes.paths[0].status, 'unknown');
  assert.equal(fcmpRes.paths[0].reason, 'unsupported-float-compare');

  // (d) ccmp/ccmn (conditional: true) fails closed
  const ccmpInst = { id: 13, row: 1, address: 0x1000n, op: OP.CMP, sub: 'sub', conditional: true, dst: flags, args: [{ value: arg0, bits: 32 }, { value: arg1, bits: 32 }], extra: { conditional: true } };
  flags.def = ccmpInst;
  const ccmpRes = symbolicExecute(makeBranchIr({ cmpInst: ccmpInst, cond: 'eq' }), { symbolicArgs: { 0: 1n, 1: 1n } });
  assert.equal(ccmpRes.paths[0].status, 'unknown');
  assert.equal(ccmpRes.paths[0].reason, 'unsupported-conditional-compare');

  // (e) cmp with operand shift: cmp w0, w1, lsl #2 (12 == 3 << 2)
  const shiftCmp = {
    id: 14, row: 1, address: 0x1000n, op: OP.CMP, sub: 'sub', dst: flags,
    args: [{ value: arg0, bits: 32 }, { value: arg1, bits: 32, shift: { op: 'lsl', amount: 2 } }],
    extra: {},
  };
  flags.def = shiftCmp;
  const shiftRes = symbolicExecute(makeBranchIr({ cmpInst: shiftCmp, cond: 'eq' }), { symbolicArgs: { 0: 12n, 1: 3n } });
  assert.equal(shiftRes.paths.length, 1);
  assert.equal(shiftRes.paths[0].returnValue.value, 100n, 'cmp w0, w1, lsl #2 with 12 and 3 must take eq branch');

  // Invalid shift fails closed
  const badShiftCmp = {
    id: 15, row: 1, address: 0x1000n, op: OP.CMP, sub: 'sub', dst: flags,
    args: [{ value: arg0, bits: 32 }, { value: arg1, bits: 32, shift: { op: 'uxtw', amount: 2 } }],
    extra: {},
  };
  flags.def = badShiftCmp;
  const badShiftRes = symbolicExecute(makeBranchIr({ cmpInst: badShiftCmp, cond: 'eq' }), { symbolicArgs: { 0: 12n, 1: 3n } });
  assert.equal(badShiftRes.paths[0].status, 'unknown');
  assert.equal(badShiftRes.paths[0].reason, 'unsupported-operand-shift');
});

// ---------------------------------------------------------------------------
// #2 [P0] evalValue OP.BIN applies d.args[0].shift / d.args[1].shift
// ---------------------------------------------------------------------------
test('[W1-T4-#2] evalValue OP.BIN applies operand shifts and fails closed on invalid shifts', () => {
  const arg0 = { id: 1, kind: 'arg', reg: 'x0', bits: 32, def: null };
  const arg1 = { id: 2, kind: 'arg', reg: 'x1', bits: 32, def: null };

  function runBin(shift0, shift1, a0, a1) {
    const vOut = { id: 3, reg: 'x0', bits: 32, def: null };
    const binInst = {
      id: 10, row: 1, address: 0x1000n, op: OP.BIN, sub: 'add', dst: vOut,
      args: [
        { value: arg0, bits: 32, ...(shift0 ? { shift: shift0 } : {}) },
        { value: arg1, bits: 32, ...(shift1 ? { shift: shift1 } : {}) },
      ],
      extra: {},
    };
    vOut.def = binInst;
    const retInst = { id: 11, row: 2, address: 0x1004n, op: OP.RET, args: [{ value: vOut }], extra: {} };
    const ir = { entry: 0, blocks: [{ index: 0, succ: [], phis: [], insts: [binInst, retInst] }] };
    return symbolicExecute(ir, { symbolicArgs: { 0: a0, 1: a1 } });
  }

  // 1 + (5 << 3) = 41
  const lslRes = runBin(null, { op: 'lsl', amount: 3 }, 1n, 5n);
  assert.equal(lslRes.paths[0].returnValue.value, 41n);

  // (16 >>> 2) + 3 = 7
  const lsrRes = runBin({ op: 'lsr', amount: 2 }, null, 16n, 3n);
  assert.equal(lsrRes.paths[0].returnValue.value, 7n);

  // (-8 >> 1) + 4 = (-4 + 4) mod 2^32 = 0
  const asrRes = runBin(null, { op: 'asr', amount: 1 }, 4n, 0xfffffff8n);
  assert.equal(asrRes.paths[0].returnValue.value, 0n);

  // ror #4 on 0x10 (32-bit) -> 0x1; 0 + 1 = 1
  const rorRes = runBin(null, { op: 'ror', amount: 4 }, 0n, 0x10n);
  assert.equal(rorRes.paths[0].returnValue.value, 1n);

  // Invalid shift amount (>= width) fails closed
  const invalidRes = runBin(null, { op: 'lsl', amount: 32 }, 1n, 5n);
  assert.equal(invalidRes.paths[0].status, 'unknown');
  assert.equal(invalidRes.paths[0].reason, 'unsupported-operand-shift');
});

// ---------------------------------------------------------------------------
// #3 [P1] branchCondition non-byteMemory cbz/cbnz passes width to cmp
// ---------------------------------------------------------------------------
test('[W1-T4-#3] non-byteMemory cbz/cbnz respects operand bit width instead of defaulting to 64-bit', () => {
  const arg0 = { id: 1, kind: 'arg', reg: 'x0', bits: 32, def: null };
  const vTaken = { id: 2, const: 1n, bits: 64, def: null };
  const vFall = { id: 3, const: 2n, bits: 64, def: null };
  const cbr = { id: 10, row: 1, address: 0x1000n, op: OP.CBR, args: [{ value: arg0, bits: 32 }], extra: { kind: 'cbz', target: 0x2000n } };
  const ir = {
    entry: 0,
    blocks: [
      { index: 0, succ: [1, 2], phis: [], insts: [cbr] },
      { index: 1, succ: [], phis: [], insts: [{ id: 11, row: 2, address: 0x1004n, op: OP.RET, args: [{ value: vFall }], extra: {} }] },
      { index: 2, succ: [], phis: [], insts: [{ id: 12, row: 3, address: 0x2000n, op: OP.RET, args: [{ value: vTaken }], extra: {} }] },
    ],
  };

  // Lower 32 bits of 0x1_0000_0000n are 0 -> cbz w0 must take the branch
  const concrete = symbolicExecute(ir, { symbolicArgs: { 0: 0x1_0000_0000n } });
  assert.equal(concrete.paths.length, 1);
  assert.equal(concrete.paths[0].returnValue.value, 1n, '32-bit cbz must treat 0x1_0000_0000n as zero');

  // Symbolic path constraints must carry bits: 32
  const sym = symbolicExecute(ir);
  assert.equal(sym.paths.length, 2);
  assert.equal(sym.paths[0].constraints[0].bits, 32);
  assert.equal(sym.paths[1].constraints[0].bits, 32);
});

// ---------------------------------------------------------------------------
// #4 [P1] symbolicExecute forwards opts.deterministic & opts.deterministicTransforms to byteMemory
// ---------------------------------------------------------------------------
test('[W1-T4-#4] symbolicExecute forwards opts.deterministic and opts.deterministicTransforms into byteMemory', () => {
  const vConst = { id: 1, const: 42n, bits: 64, def: null };
  const constInst = { id: 10, row: 0, address: 0x1000n, op: OP.CONST, dst: vConst, value: 42n, args: [], extra: {} };
  vConst.def = constInst;
  const retInst = { id: 11, row: 1, address: 0x1004n, op: OP.RET, args: [{ value: vConst }], extra: {} };
  const ir = {
    entry: 0,
    values: [vConst],
    blocks: [{ index: 0, succ: [], phis: [], insts: [constInst, retInst] }],
  };
  const identity = Object.freeze({
    queryId: 'w1-t4-4',
    snapshotId: 'snap-1',
    binaryId: 'bin-1',
    functionId: 'fn-1',
    architecture: 'arm64',
    addressSpace: 'data',
    semanticsVersion: '2.0.0',
  });

  function makeJumpingClock() {
    let calls = 0;
    return () => (calls++ === 0 ? 0 : 10000);
  }

  // Without deterministic, jumping clock triggers deadline failure
  const nonDet = symbolicExecute(ir, {
    timeoutMs: 100,
    byteMemory: { identity, addressBits: 64, endian: 'little', now: makeJumpingClock() },
  });
  assert.equal(nonDet.status, 'partial');
  assert.equal(nonDet.reason, 'deadline');

  // With top-level opts.deterministic: true, byteMemory suppresses wall-clock deadline
  const det = symbolicExecute(ir, {
    timeoutMs: 100,
    deterministic: true,
    byteMemory: { identity, addressBits: 64, endian: 'little', now: makeJumpingClock() },
  });
  assert.equal(det.status, 'complete');

  // With top-level opts.deterministicTransforms: true, byteMemory also suppresses wall-clock deadline
  const detTransforms = symbolicExecute(ir, {
    timeoutMs: 100,
    deterministicTransforms: true,
    byteMemory: { identity, addressBits: 64, endian: 'little', now: makeJumpingClock() },
  });
  assert.equal(detTransforms.status, 'complete');
});

// ---------------------------------------------------------------------------
// #5 [P1] BitBlastSolverSession._executeCheck respects session-level deterministic: true
// ---------------------------------------------------------------------------
test('[W1-T4-#5] BitBlastSolverSession honors session-level deterministic: true', async () => {
  const x = createFreshSymbol(bvSort(8), 'x');
  const q = makeQuery([createCompare(BV_COMPARE_OP.EQ, x, createBv(8, 7n))]);
  const backend = new BitBlastBvBackend();

  const origDesc = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  let ticks = 0;
  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => (++ticks * 1000) },
    configurable: true,
    writable: true,
  });
  try {
    // Session-level deterministic: true with positive timeoutMs must not time out
    const detSession = backend.createSession({ deterministic: true, timeoutMs: 5 });
    const detRes = await detSession.check(q, { timeoutMs: 5 });
    assert.equal(detRes.status, SOLVER_STATUS.SAT);
    assert.equal(detRes.model.get(x.symbolId), 7n);

    // Control: without deterministic, the same jumping clock times out
    ticks = 0;
    const normalSession = backend.createSession({ timeoutMs: 5 });
    const normalRes = await normalSession.check(q, { timeoutMs: 5 });
    assert.equal(normalRes.status, SOLVER_STATUS.TIMEOUT);
  } finally {
    if (origDesc) Object.defineProperty(globalThis, 'performance', origDesc);
  }
});

// ---------------------------------------------------------------------------
// #6 [P1] TieredSolverSession propagates isCancelled to child sessions without AbortSignal
// ---------------------------------------------------------------------------
class SlowAbortAwareBackend extends SolverBackend {
  constructor(id, { maxBvWidth = 64, delayMs = 300, symKey = 'x' } = {}) {
    super({ id, version: '1.0.0', proofAuthority: PROOF_AUTHORITY.EXACT, isRemote: false, isWasm: false });
    this._maxBvWidth = maxBvWidth;
    this._delayMs = delayMs;
    this._symKey = symKey;
    this.aborted = false;
  }

  baseCapabilities() {
    return {
      ...super.baseCapabilities(),
      supportedSorts: ['bool', 'bv'],
      maxBvWidth: this._maxBvWidth,
      exactProofs: true,
      supportsModelExtraction: true,
    };
  }

  createSession() {
    const backend = this;
    return new (class extends SolverSession {
      async _executeCheck(query, _options, _token, signal) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, backend._delayMs);
          signal?.addEventListener('abort', () => {
            backend.aborted = true;
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
        if (signal?.aborted) {
          return createSolverResult({
            status: SOLVER_STATUS.CANCELLED,
            reason: 'child-cancelled',
            backend: backend.id,
            backendVersion: backend.version,
            queryHash: query.queryHash,
          });
        }
        return createSolverResult({
          status: SOLVER_STATUS.SAT,
          model: { [backend._symKey]: 1n },
          backend: backend.id,
          backendVersion: backend.version,
          queryHash: query.queryHash,
        });
      }
    })(this, { timeoutMs: 0 });
  }
}

test('[W1-T4-#6] TieredSolverSession cancels in-flight child session via isCancelled without AbortSignal', async () => {
  const x = createFreshSymbol(bvSort(8), 'x');
  const q = makeQuery([createCompare(BV_COMPARE_OP.EQ, x, createBv(8, 1n))]);

  let cancelled = false;
  const narrow = new SlowAbortAwareBackend('slow-narrow', { maxBvWidth: 8, delayMs: 400, symKey: x.symbolId });
  const wide = new SlowAbortAwareBackend('slow-wide', { maxBvWidth: 64, delayMs: 400, symKey: x.symbolId });
  const backend = new TieredBvBackend({ narrowBackend: narrow, wideBackend: wide });
  const session = backend.createSession({ isCancelled: () => cancelled });

  const started = Date.now();
  const promise = session.check(q);
  setTimeout(() => { cancelled = true; }, 15);
  const res = await promise;
  const elapsed = Date.now() - started;

  assert.equal(res.status, SOLVER_STATUS.CANCELLED);
  assert.equal(narrow.aborted, true, 'in-flight child session must receive abort when isCancelled turns true');
  assert.ok(elapsed < 300, `expected prompt cancellation, took ${elapsed}ms`);
});

// ---------------------------------------------------------------------------
// #7 [P1] query-analysis.js: (a) maxDepth on shared DAG, (b) traversalCount guard
// ---------------------------------------------------------------------------
test('[W1-T4-#7] analyzeSolverExpressions computes shared-DAG maxDepth and bounds traversalCount', () => {
  const leaf = createFreshSymbol(boolSort(), 'p');
  // Subtree of height 4: NOT(NOT(NOT(leaf)))
  const n1 = createConnective(BOOL_CONNECTIVE_OP.NOT, leaf);
  const n2 = createConnective(BOOL_CONNECTIVE_OP.NOT, n1);
  const shared = createConnective(BOOL_CONNECTIVE_OP.NOT, n2);

  // Root visits `shared` first at shallow depth (stack=2), then under a deeper chain (stack=4)
  // Total depth through deeper branch = 4 + 4 = 8
  const d1 = createConnective(BOOL_CONNECTIVE_OP.NOT, shared);
  const d2 = createConnective(BOOL_CONNECTIVE_OP.NOT, d1);
  const d3 = createConnective(BOOL_CONNECTIVE_OP.NOT, d2);
  const root = createConnective(BOOL_CONNECTIVE_OP.AND, shared, d3);

  const ok = analyzeSolverExpressions([root], { maxExprNodes: 100, maxExprDepth: 10 });
  assert.equal(ok.depthExceeded, false);
  assert.equal(ok.maxDepth, 8, 'maxDepth must include cached height of already-visited shared subtree');

  const exceeded = analyzeSolverExpressions([root], { maxExprNodes: 100, maxExprDepth: 7 });
  assert.equal(exceeded.depthExceeded, true, 'depth guard must trigger when shared subtree pushes total depth over maxExprDepth');

  // (b) Duplicate args in a single CONNECTIVE node must be bounded by maxExprNodes via traversalCount
  const dupArgs = Array.from({ length: 50 }, () => leaf);
  const wideConnective = createConnective(BOOL_CONNECTIVE_OP.AND, ...dupArgs);
  const guarded = analyzeSolverExpressions([wideConnective], { maxExprNodes: 10, maxExprDepth: 100 });
  assert.equal(guarded.limitExceeded, true, 'duplicate args DAG must trigger limitExceeded via traversalCount');
});

// ---------------------------------------------------------------------------
// #8 [P1] findIrConstantComparisons applies a.shift on OP.CMP operands
// ---------------------------------------------------------------------------
test('[W1-T4-#8] findIrConstantComparisons applies shift modifiers on OP.CMP constant operands', () => {
  function runWithShift({ constVal, bits, shift, varShift = null }) {
    const vReg = { id: 1, reg: 'x8', bits, def: null };
    const vConst = { id: 2, const: constVal, bits, def: null };
    const cmpInst = {
      id: 10,
      row: 0,
      address: BASE,
      op: OP.CMP,
      bits,
      args: [
        { value: vReg, bits, ...(varShift ? { shift: varShift } : {}) },
        { value: vConst, bits, ...(shift ? { shift } : {}) },
      ],
      extra: {},
    };
    const fakeIr = {
      compat: { projection: 'semantic-ir-v2-to-v1' },
      semanticIrVersion: 'compat-v1',
      instructions: [cmpInst],
      values: [vReg, vConst],
      blocks: [{ id: 0, insts: [cmpInst] }],
    };
    return findIrConstantComparisons(fakeIr, {});
  }

  // cmp w8, #1, lsl #12 -> 0x1000n
  const lsl = runWithShift({ constVal: 1n, bits: 32, shift: { op: 'lsl', amount: 12 } });
  assert.equal(lsl.length, 1);
  assert.equal(lsl[0].value, 0x1000n);

  // lsr #2 on 0x20 -> 0x8
  const lsr = runWithShift({ constVal: 0x20n, bits: 32, shift: { op: 'lsr', amount: 2 } });
  assert.equal(lsr.length, 1);
  assert.equal(lsr[0].value, 0x8n);

  // asr #1 on 0xfffffff0 (-16) -> 0xfffffff8 (-8)
  const asr = runWithShift({ constVal: 0xfffffff0n, bits: 32, shift: { op: 'asr', amount: 1 } });
  assert.equal(asr.length, 1);
  assert.equal(asr[0].value, 0xfffffff8n);

  // ror #4 on 0x10 -> 0x1
  const ror = runWithShift({ constVal: 0x10n, bits: 32, shift: { op: 'ror', amount: 4 } });
  assert.equal(ror.length, 1);
  assert.equal(ror[0].value, 0x1n);

  // Non-zero shift on variable operand fails closed
  const varShifted = runWithShift({ constVal: 10n, bits: 32, shift: null, varShift: { op: 'lsl', amount: 2 } });
  assert.equal(varShifted.length, 0);

  // Invalid shift on constant operand fails closed
  const invalidShift = runWithShift({ constVal: 1n, bits: 32, shift: { op: 'lsl', amount: 32 } });
  assert.equal(invalidShift.length, 0);
});

// ---------------------------------------------------------------------------
// #9 [P2] worker-backend & tiered-worker-backend: exhaustiveMaxBvWidth + onError cleanup
// ---------------------------------------------------------------------------
function makeFakeWorker() {
  const listeners = new Map();
  return {
    terminated: false,
    posted: [],
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    postMessage(msg) {
      this.posted.push(msg);
    },
    terminate() {
      this.terminated = true;
    },
    emitError(message) {
      for (const fn of [...(listeners.get('error') || [])]) fn({ message });
    },
  };
}

test('[W1-T4-#9] WorkerSolverBackend forwards exhaustiveMaxBvWidth and both worker backends terminate on error with queryHash', async () => {
  // (a) baseCapabilities forwards exhaustiveMaxBvWidth to TieredBvBackend
  const wbCaps = new WorkerSolverBackend({ maxBvWidth: 32, exhaustiveMaxBvWidth: 4, workerFactory: makeFakeWorker }).baseCapabilities();
  assert.equal(wbCaps.exhaustiveMaxBvWidth, 4);

  const x = createFreshSymbol(bvSort(8), 'x');
  const q = makeQuery([createCompare(BV_COMPARE_OP.EQ, x, createBv(8, 3n))]);

  // (b1) WorkerSolverBackend onError terminates worker and preserves queryHash
  let fakeWorker1;
  const wb = new WorkerSolverBackend({
    maxBvWidth: 32,
    workerFactory: () => { fakeWorker1 = makeFakeWorker(); return fakeWorker1; },
  });
  const ws1 = wb.createSession({ timeoutMs: 0 });
  const p1 = ws1.check(q);
  await new Promise((r) => setTimeout(r, 5));
  fakeWorker1.emitError('worker-crashed');
  const r1 = await p1;
  assert.equal(r1.status, SOLVER_STATUS.PROVIDER_FAILURE);
  assert.equal(r1.reason, 'worker-crashed');
  assert.equal(r1.queryHash, q.queryHash);
  assert.equal(fakeWorker1.terminated, true, 'WorkerSolverSession must terminate broken worker on error');
  assert.equal(ws1.worker, null);

  // Subsequent check fails closed without posting to broken worker
  const r1After = await ws1.check(q);
  assert.equal(r1After.status, SOLVER_STATUS.PROVIDER_FAILURE);
  assert.equal(fakeWorker1.posted.length, 1);

  // (b2) TieredWorkerSolverBackend onError terminates worker and preserves queryHash
  let fakeWorker2;
  const twb = new TieredWorkerSolverBackend({
    maxBvWidth: 32,
    workerFactory: () => { fakeWorker2 = makeFakeWorker(); return fakeWorker2; },
  });
  const ws2 = twb.createSession({ timeoutMs: 0 });
  const p2 = ws2.check(q);
  await new Promise((r) => setTimeout(r, 5));
  fakeWorker2.emitError('tiered-worker-crashed');
  const r2 = await p2;
  assert.equal(r2.status, SOLVER_STATUS.PROVIDER_FAILURE);
  assert.equal(r2.reason, 'tiered-worker-crashed');
  assert.equal(r2.queryHash, q.queryHash);
  assert.equal(fakeWorker2.terminated, true, 'TieredWorkerSolverSession must terminate broken worker on error');
  assert.equal(ws2.worker, null);
});

// ---------------------------------------------------------------------------
// #10 [P2] BitBlastSolverSession snapshots query to prevent TOCTOU across yield
// ---------------------------------------------------------------------------
test('[W1-T4-#10] BitBlastSolverSession snapshots query before solving so caller mutation during yield cannot corrupt validation', async () => {
  const x = createFreshSymbol(bvSort(8), 'x');
  const y = createFreshSymbol(bvSort(8), 'y');
  const sum = createBinary(BV_BINARY_OP.ADD, x, y);
  const original = makeQuery([
    createCompare(BV_COMPARE_OP.EQ, sum, createBv(8, 15n)),
    createCompare(BV_COMPARE_OP.ULT, x, createBv(8, 10n)),
  ]);
  // Construct a mutable plain-object copy with the exact same queryHash
  const mutableQuery = {
    ...original,
    constraints: [...original.constraints],
  };

  const backend = new BitBlastBvBackend({ yieldEvery: 1 });
  const session = backend.createSession({ timeoutMs: 0 });
  const pending = session.check(mutableQuery, { yieldEvery: 1 });

  // Mutate the caller's query after _executeCheck has started and while solveCnf yields
  await Promise.resolve();
  mutableQuery.constraints[0] = createBool(false);
  mutableQuery.assertion = createBool(false);

  const res = await pending;
  assert.equal(res.status, SOLVER_STATUS.SAT, 'mutating caller query during yield must not break SAT validation');
  assert.equal(res.queryHash, original.queryHash);
  assert.equal((res.model.get(x.symbolId) + res.model.get(y.symbolId)) & 0xffn, 15n);
});

// ---------------------------------------------------------------------------
// #11 [P2] js/verify.js: regView supports q/v/h/b and flowsToReturn fails closed
// ---------------------------------------------------------------------------
test('[W1-T4-#11] verifyAccessor handles q/v/h/b FP/SIMD registers accurately and fails closed on unknown dst', () => {
  // Non-return SIMD/FP register loads must NOT be misclassified as getters
  for (const reg of ['q8', 'h8', 'b8']) {
    const nonGetter = modelOf([
      `ldr ${reg}, [x0, #0x10]`,
      'ret',
    ]);
    const res = verifyAccessor(nonGetter, { offset: 0x10n });
    assert.equal(res.getter, false, `ldr ${reg}, [x0, #0x10]; ret must not verify as getter`);
  }

  // Return SIMD/FP register loads (v0 family: q0/h0/b0) verify as getters
  for (const reg of ['q0', 'h0', 'b0']) {
    const getter = modelOf([
      `ldr ${reg}, [x0, #0x10]`,
      'ret',
    ]);
    const res = verifyAccessor(getter, { offset: 0x10n });
    assert.equal(res.getter, true, `ldr ${reg}, [x0, #0x10]; ret must verify as getter`);
  }

  // Unknown destination register with non-empty writes must fail closed (getter: false)
  const syntheticModel = {
    instructions: [
      {
        row: 0,
        address: BASE,
        mnemonic: 'ldr',
        ops: [{ k: 'reg', text: 'xzr' }],
        reads: ['x0'],
        writes: ['xzr'],
        memory: { kind: 'load', base: 'x0', disp: 0x10n, size: 8, stack: false, indexed: false },
      },
      {
        row: 1,
        address: BASE + 4n,
        mnemonic: 'ret',
        ops: [],
        reads: [],
        writes: [],
        memory: null,
      },
    ],
  };
  const unknownDstRes = verifyAccessor(syntheticModel, { offset: 0x10n });
  assert.equal(unknownDstRes.getter, false, 'unrecognized load destination register must fail closed');
});
