import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSemanticModel } from '../js/blocks.js';
import { irFor, OP, MK } from '../js/ir.js';
import { findIrValueUpdates } from '../js/dataflow-ir.js';
import { findIrSemanticUpdates } from '../js/dataflow-semantic.js';
import { findIrConstantComparisons } from '../js/dataflow-ir-compare.js';
import { verifyAccessor, fieldUse } from '../js/verify.js';
import { foldShapes, roleOf, evidenceFor, SHAPE, AMOUNT } from '../js/shapes.js';
import { FieldIndex } from '../js/fields.js';
import { parseOperands } from '../js/arm64.js';
import { ARM64_ARCHITECTURE } from '../js/targets/architecture/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../js/semantics/compat/index.js';
import { symbolicExecute } from '../js/symbolic/executor.js';
import { TieredBvBackend } from '../js/symbolic/solver/tiered-backend.js';
import { SolverBackend, PROOF_AUTHORITY } from '../js/symbolic/solver/backend.js';
import { SolverSession } from '../js/symbolic/solver/session.js';
import { SOLVER_STATUS, createSolverResult } from '../js/symbolic/solver/result.js';
import { CLAIM_KIND, VERIFICATION_QUERY_KIND, createVerificationQuery } from '../js/symbolic/verify/query.js';
import { bvSort, BV_COMPARE_OP } from '../js/symbolic/expr/kinds.js';
import { createBool, createBv, createCompare, createFreshSymbol } from '../js/symbolic/expr/factory.js';

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

function scanOf({
  disp,
  size,
  flags,
  amtKind,
  amtDisp,
  addr,
  span,
  amtSize,
  amtSpan,
  baseIdentity,
  amtBaseIdentity,
}) {
  const count = disp.length;
  return {
    count,
    complete: true,
    capped: false,
    disp: Int32Array.from(disp),
    size: Uint8Array.from(size || Array(count).fill(4)),
    flags: Uint8Array.from(flags),
    amtKind: Uint8Array.from(amtKind || Array(count).fill(AMOUNT.NONE)),
    amtDisp: Int32Array.from(amtDisp || Array(count).fill(0)),
    addr: BigUint64Array.from(addr || Array.from({ length: count }, (_, i) => 0x1000n + BigInt(i * 4))),
    span: Int32Array.from(span || Array(count).fill(0x100)),
    amtSize: Uint8Array.from(amtSize || Array(count).fill(4)),
    amtSpan: Int32Array.from(amtSpan || Array(count).fill(0x100)),
    baseIdentity,
    amtBaseIdentity,
  };
}

function makeQuery(constraints) {
  return createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    targetEntity: 'audit-track-4',
    constraints,
    assertion: createBool(true),
  });
}

// ---------------------------------------------------------------------------
// [T4-P0-1] cloneState preserves comparisonCarriers across forked paths
// ---------------------------------------------------------------------------
test('[T4-P0-1] symbolicExecute preserves comparisonCarriers across forked branch states', () => {
  const ir = buildSemanticV2CompatibilityPipeline({
    architecturePlugin: ARM64_ARCHITECTURE,
    decoderSemanticVersion: 'audit-t4-p0-1',
    binaryId: 'audit-t4-bin',
    sliceId: 'audit-t4-slice',
    addressWidthBits: 64,
    entryBlockKey: 'entry',
    blocks: [
      {
        key: 'entry',
        startAddress: 0x1000n,
        successors: [{ to: 'taken', kind: 'conditional-true' }, { to: 'fallthrough', kind: 'conditional-false' }],
        instructions: [
          { decoded: { address: 0x1000n, mnemonic: 'cbz', operands: 'x0, #0x1010', ops: parseOperands('x0, #0x1010'), mode: 'a64' } },
        ],
      },
      {
        key: 'fallthrough',
        startAddress: 0x1004n,
        successors: [],
        instructions: [
          { decoded: { address: 0x1004n, mnemonic: 'cmp', operands: 'x1, x2', ops: parseOperands('x1, x2'), mode: 'a64' } },
          { decoded: { address: 0x1008n, mnemonic: 'csel', operands: 'x0, x3, x4, lt', ops: parseOperands('x0, x3, x4, lt'), mode: 'a64' } },
          { decoded: { address: 0x100cn, mnemonic: 'ret', operands: '', ops: parseOperands(''), mode: 'a64' } },
        ],
      },
      {
        key: 'taken',
        startAddress: 0x1010n,
        successors: [],
        instructions: [
          { decoded: { address: 0x1010n, mnemonic: 'cmp', operands: 'x1, x2', ops: parseOperands('x1, x2'), mode: 'a64' } },
          { decoded: { address: 0x1014n, mnemonic: 'csel', operands: 'x0, x4, x3, lt', ops: parseOperands('x0, x4, x3, lt'), mode: 'a64' } },
          { decoded: { address: 0x1018n, mnemonic: 'ret', operands: '', ops: parseOperands(''), mode: 'a64' } },
        ],
      },
    ],
  }).legacyV1;

  const hasCarrier = ir.instructions.some((inst) => inst.extra?.semanticComparisonCarrier === true);
  assert.equal(hasCarrier, true, 'fixture must contain canonical semanticComparisonCarrier instructions');

  const res = symbolicExecute(ir, {
    byteMemory: {
      identity: Object.freeze({
        queryId: 'audit-track-4-p0-1',
        snapshotId: 'snap-1',
        binaryId: 'audit-t4-bin',
        functionId: ir.functionId,
        architecture: 'arm64',
        addressSpace: 'data',
        semanticsVersion: '2.0.0',
      }),
      addressBits: 64,
      endian: 'little',
      deterministic: true,
    },
    maxPaths: 16,
  });
  assert.notEqual(res.reason, 'unproved-display-carrier',
    'forked branch state must inherit comparisonCarriers instead of failing with unproved-display-carrier');
  assert.equal(res.terminalControlObservations?.length, 2, 'both forked paths must reach ret with comparisonCarriers preserved');
});

// ---------------------------------------------------------------------------
// [T4-P1-1] matchAshrSignMask & matchSignMaskClamp: non-commutative bic,
//           shift validation, and bit-width consistency in IR & semantic paths
// ---------------------------------------------------------------------------
test('[T4-P1-1] dataflow-ir rejects reversed bic, width mismatches, and invalid shifts', () => {
  const loc = { kind: MK.FIELD, base: { id: 1, reg: 'x0' }, disp: 0x20n, size: 4, key: 'field:arg:x0+32' };
  const dummyModel = { instructions: [{ row: 0 }, { row: 1 }, { row: 2 }, { row: 3 }, { row: 4 }], calls: [] };

  function runSynthetic({ bits, shiftVal, reverseBic = false, inlineShift = false, inlineShiftOnArg0 = false, inlineShiftAmount = 31, extraShiftOnNormal = false, useAnd = false }) {
    const vLoad = { id: 10, reg: 'x8', bits, def: null };
    const loadInst = { id: 1, row: 0, address: BASE, op: OP.LOAD, loc, dst: vLoad, addr: { baseReg: 'x0', base: loc.base }, args: [] };
    vLoad.def = loadInst;

    const vImm5 = { id: 11, const: 5n, bits, def: null };
    const vSub = { id: 12, reg: 'x8', bits, def: null };
    const subInst = { id: 2, row: 1, address: BASE + 4n, op: OP.BIN, sub: 'sub', dst: vSub, args: [{ value: vLoad }, { value: vImm5 }] };
    vSub.def = subInst;

    const chain = [subInst];
    let finalVal;

    if (inlineShift) {
      const vBic = { id: 15, reg: 'x8', bits, def: null };
      const arg0 = inlineShiftOnArg0
        ? { value: vSub, shift: { op: 'asr', amount: inlineShiftAmount } }
        : { value: vSub };
      const arg1 = inlineShiftOnArg0
        ? { value: vSub }
        : { value: vSub, shift: { op: 'asr', amount: inlineShiftAmount } };
      const bicInst = { id: 4, row: 2, address: BASE + 8n, op: OP.BIN, sub: 'bic', dst: vBic, args: [arg0, arg1] };
      vBic.def = bicInst;
      chain.push(bicInst);
      finalVal = vBic;
    } else if (useAnd) {
      const vShift = { id: 13, const: shiftVal, def: null };
      const vAshr = { id: 14, reg: 'x9', bits, def: null };
      const ashrInst = { id: 3, row: 2, address: BASE + 8n, op: OP.BIN, sub: 'ashr', dst: vAshr, args: [{ value: vSub }, { value: vShift }] };
      vAshr.def = ashrInst;
      const vNot = { id: 16, reg: 'x9', bits, def: null };
      const notInst = { id: 4, row: 3, address: BASE + 12n, op: OP.UN, sub: 'not', dst: vNot, args: [{ value: vAshr }] };
      vNot.def = notInst;
      const vAnd = { id: 17, reg: 'x8', bits, def: null };
      const andArgs = extraShiftOnNormal
        ? [{ value: vSub, shift: { op: 'lsl', amount: 1 } }, { value: vNot }]
        : [{ value: vSub }, { value: vNot }];
      const andInst = { id: 5, row: 4, address: BASE + 16n, op: OP.BIN, sub: 'and', dst: vAnd, args: andArgs };
      vAnd.def = andInst;
      chain.push(ashrInst, notInst, andInst);
      finalVal = vAnd;
    } else {
      const vShift = { id: 13, const: shiftVal, def: null };
      const vAshr = { id: 14, reg: 'x9', bits, def: null };
      const ashrInst = { id: 3, row: 2, address: BASE + 8n, op: OP.BIN, sub: 'ashr', dst: vAshr, args: [{ value: vSub }, { value: vShift }] };
      vAshr.def = ashrInst;
      const vBic = { id: 15, reg: 'x8', bits, def: null };
      const bicArgs = reverseBic
        ? [{ value: vAshr }, { value: vSub }]
        : (extraShiftOnNormal ? [{ value: vSub, shift: { op: 'lsl', amount: 1 } }, { value: vAshr }] : [{ value: vSub }, { value: vAshr }]);
      const bicInst = { id: 4, row: 3, address: BASE + 12n, op: OP.BIN, sub: 'bic', dst: vBic, args: bicArgs };
      vBic.def = bicInst;
      chain.push(ashrInst, bicInst);
      finalVal = vBic;
    }

    const storeInst = { id: 6, row: 4, address: BASE + 20n, op: OP.STORE, loc, addr: { baseReg: 'x0', base: loc.base }, args: [{ value: finalVal }] };
    const updates = findIrValueUpdates(dummyModel, null, {
      ir: {},
      readModifyWriteProofs: [{ kind: 'compute', location: loc, load: loadInst, store: storeInst, chain }],
    });
    return updates[0]?.steps || [];
  }

  // Valid 32-bit normal bic
  const valid32 = runSynthetic({ bits: 32, shiftVal: 31n });
  assert.equal(valid32.some((s) => s.op === 'bic' && s.signMaskClamp === true), true);

  // Reversed bic (non-commutative: (x >> 31) & ~x is NOT a clamp)
  const reversed = runSynthetic({ bits: 32, shiftVal: 31n, reverseBic: true });
  assert.equal(reversed.some((s) => s.signMaskClamp === true), false);

  // Inline bic with shift on arg0 instead of arg1
  const inlineArg0 = runSynthetic({ bits: 32, inlineShift: true, inlineShiftOnArg0: true, inlineShiftAmount: 31 });
  assert.equal(inlineArg0.some((s) => s.signMaskClamp === true), false);

  // Inline bic with null shift amount
  const inlineNullAmt = runSynthetic({ bits: 32, inlineShift: true, inlineShiftOnArg0: false, inlineShiftAmount: null });
  assert.equal(inlineNullAmt.some((s) => s.signMaskClamp === true), false);

  // 64-bit value with 31-bit shift (width mismatch)
  const mismatch64With31 = runSynthetic({ bits: 64, shiftVal: 31n });
  assert.equal(mismatch64With31.some((s) => s.signMaskClamp === true), false);

  // 32-bit value with 63-bit shift (width mismatch)
  const mismatch32With63 = runSynthetic({ bits: 32, shiftVal: 63n });
  assert.equal(mismatch32With63.some((s) => s.signMaskClamp === true), false);

  // Extra shift on normal bic or normal and
  const extraShiftBic = runSynthetic({ bits: 32, shiftVal: 31n, extraShiftOnNormal: true });
  assert.equal(extraShiftBic.some((s) => s.signMaskClamp === true), false);

  const extraShiftAnd = runSynthetic({ bits: 32, shiftVal: 31n, useAnd: true, extraShiftOnNormal: true });
  assert.equal(extraShiftAnd.some((s) => s.signMaskClamp === true), false);

  // Valid 64-bit and (~(x >> 63))
  const validAnd64 = runSynthetic({ bits: 64, shiftVal: 63n, useAnd: true });
  assert.equal(validAnd64.some((s) => s.op === 'and' && s.signMaskClamp === true), true);
});

test('[T4-P1-1] dataflow-semantic matches valid sign-mask clamp and rejects mismatched bic', () => {
  // Valid 32-bit bic clamp on direct write (value read from field_10, clamped, written to field_20)
  const validModel = modelOf([
    'ldr w8, [x0, #0x10]',
    'sub w8, w8, #5',
    'bic w8, w8, w8, asr #31',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  const validUpdates = findIrSemanticUpdates(validModel);
  const writeValid = validUpdates.find((u) => (u.kind === 'write' || u.kind === 'move') && u.location.disp === 0x20n);
  assert.ok(writeValid);
  assert.equal(writeValid.steps.some((s) => s.signMaskClamp === true), true);

  // 64-bit bic with asr #31 is NOT a full 64-bit sign-mask clamp
  const mismatchModel = modelOf([
    'ldr x8, [x0, #0x10]',
    'sub x8, x8, #5',
    'bic x8, x8, x8, asr #31',
    'str x8, [x0, #0x20]',
    'ret',
  ]);
  const mismatchUpdates = findIrSemanticUpdates(mismatchModel);
  const writeMismatch = mismatchUpdates.find((u) => (u.kind === 'write' || u.kind === 'move') && u.location.disp === 0x20n);
  assert.ok(writeMismatch);
  assert.equal(writeMismatch.steps.some((s) => s.signMaskClamp === true), false);
});

// ---------------------------------------------------------------------------
// [T4-P1-2] fieldUse breaks when subs/adds overwrites tracked register without reading it
// ---------------------------------------------------------------------------
test('[T4-P1-2] fieldUse stops tracking when subs/adds overwrites loaded register without reading it', () => {
  const overwrittenModel = modelOf([
    'ldr w8, [x0, #0x20]',
    'subs w8, w1, w2',
    'cmp w8, #100',
    'b.gt #0x100000010',
    'ret',
  ]);
  const useOverwritten = fieldUse(overwrittenModel, 0x20n);
  assert.equal(useOverwritten.loads, 1);
  assert.equal(useOverwritten.compares.length, 0,
    'cmp after subs w8, w1, w2 must not be attributed to the overwritten field load');

  const preservedModel = modelOf([
    'ldr w8, [x0, #0x20]',
    'subs w8, w8, #1',
    'cmp w8, #0',
    'b.eq #0x100000010',
    'ret',
  ]);
  const usePreserved = fieldUse(preservedModel, 0x20n);
  assert.equal(usePreserved.compares.length, 1,
    'in-place subs w8, w8, #1 preserves tracking for subsequent cmp');
});

// ---------------------------------------------------------------------------
// [T4-P1-3] flowsToReturn returns false on conditional/unconditional branch
// ---------------------------------------------------------------------------
test('[T4-P1-3] verifyAccessor does not misclassify branching functions as simple getters', () => {
  const branchingModel = modelOf([
    'ldr w0, [x0, #0x20]',
    'cbz w0, #0x100000010',
    'mov w0, #1',
    'ret',
    'mov w0, #0',
    'ret',
  ]);
  const resBranch = verifyAccessor(branchingModel, { offset: 0x20n });
  assert.equal(resBranch.getter, false, 'conditional branch after load must not verify as getter');

  const simpleGetter = modelOf([
    'ldr w0, [x0, #0x20]',
    'ret',
  ]);
  const resGetter = verifyAccessor(simpleGetter, { offset: 0x20n });
  assert.equal(resGetter.getter, true);
});

// ---------------------------------------------------------------------------
// [T4-P1-4] TieredBvBackend option inheritance, explicit undefined,
//           deterministic propagation, isCancelled validation & child abort
// ---------------------------------------------------------------------------
class RecordingExactBackend extends SolverBackend {
  constructor(id, { maxBvWidth = 64, delayMs = 0, symKey = 'x' } = {}) {
    super({ id, version: '1.0.0', proofAuthority: PROOF_AUTHORITY.EXACT, isRemote: false, isWasm: false });
    this._maxBvWidth = maxBvWidth;
    this._delayMs = delayMs;
    this._symKey = symKey;
    this.receivedOptions = [];
    this.abortedSignals = [];
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
      async _executeCheck(query, options, _token, signal) {
        backend.receivedOptions.push({ ...options });
        if (backend._delayMs > 0) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, backend._delayMs);
            signal?.addEventListener('abort', () => {
              backend.abortedSignals.push(true);
              clearTimeout(timer);
              resolve();
            }, { once: true });
          });
        }
        if (signal?.aborted) {
          return createSolverResult({
            status: SOLVER_STATUS.CANCELLED,
            reason: 'child-aborted',
            backend: backend.id,
            backendVersion: backend.version,
            queryHash: query.queryHash,
          });
        }
        return createSolverResult({
          status: SOLVER_STATUS.SAT,
          model: { [backend._symKey]: 1n },
          reason: 'sat',
          backend: backend.id,
          backendVersion: backend.version,
          queryHash: query.queryHash,
        });
      }
    })(this, { timeoutMs: 0 });
  }
}

test('[T4-P1-4] TieredBvBackend propagates options, handles explicit undefined, validates isCancelled, and aborts children', async () => {
  const x = createFreshSymbol(bvSort(8), 'x');
  const q = makeQuery([createCompare(BV_COMPARE_OP.EQ, x, createBv(8, 1n))]);

  // 1. Explicit undefined on optional constructor/session/check fields + deterministic propagation + omitting isCancelled for child
  const narrow = new RecordingExactBackend('rec-narrow', { maxBvWidth: 8, symKey: x.symbolId });
  const wide = new RecordingExactBackend('rec-wide', { maxBvWidth: 64, symKey: x.symbolId });
  const backend = new TieredBvBackend({
    id: undefined,
    version: undefined,
    timeoutMs: undefined,
    deterministic: true,
    maxBvWidth: undefined,
    exhaustiveMaxBvWidth: undefined,
    narrowBackend: narrow,
    wideBackend: wide,
  });
  assert.equal(backend.timeoutMs, undefined);
  assert.equal(backend.deterministic, true);
  assert.ok(backend.maxBvWidth > 0, "explicit undefined maxBvWidth falls back to DEFAULTS");

  const session = backend.createSession({
    timeoutMs: undefined,
    deterministic: undefined,
    maxBvWidth: undefined,
    isCancelled: () => false,
  });
  assert.equal(session.options.timeoutMs, undefined, 'unspecified timeoutMs stays undefined to delegate to SolverSession default');
  assert.equal(session.options.deterministic, true, 'session inherits backend deterministic: true');

  const res = await session.check(q, {
    maxBvWidth: undefined,
    deterministic: undefined,
    isCancelled: () => false,
  });
  assert.equal(res.status, SOLVER_STATUS.SAT);
  assert.ok(narrow.receivedOptions.length >= 1);
  assert.equal(narrow.receivedOptions[0].deterministic, true, 'child receives effectiveDeterministic=true');
  assert.equal('isCancelled' in narrow.receivedOptions[0], false, 'parent-only isCancelled is excluded from child options');

  // 2. Invalid isCancelled rejected in createSession (TypeError) and check (INVALID_QUERY)
  assert.throws(() => backend.createSession({ isCancelled: 'nope' }), TypeError);
  const badCheck = await backend.createSession().check(q, { isCancelled: 123 });
  assert.equal(badCheck.status, SOLVER_STATUS.INVALID_QUERY);
  assert.match(badCheck.reason, /isCancelled/);

  // 3. Throwing isCancelled fails closed as CANCELLED
  const throwingSession = backend.createSession({ isCancelled: () => { throw new Error('boom'); } });
  const throwRes = await throwingSession.check(q);
  assert.equal(throwRes.status, SOLVER_STATUS.CANCELLED);

  const queryThrowRes = await backend.createSession().check(q, { isCancelled: () => { throw new Error('query-boom'); } });
  assert.equal(queryThrowRes.status, SOLVER_STATUS.CANCELLED);

  // 4. Session-level AbortSignal aborts child provider and detaches listener cleanly
  const slowNarrow = new RecordingExactBackend('slow-narrow', { maxBvWidth: 8, delayMs: 200, symKey: x.symbolId });
  const slowWide = new RecordingExactBackend('slow-wide', { maxBvWidth: 64, delayMs: 200, symKey: x.symbolId });
  const slowBackend = new TieredBvBackend({ narrowBackend: slowNarrow, wideBackend: slowWide });
  const sessionCtrl = new AbortController();
  const abortSession = slowBackend.createSession({ signal: sessionCtrl.signal });
  const pending = abortSession.check(q);
  setTimeout(() => sessionCtrl.abort(), 15);
  const abortedRes = await pending;
  assert.equal(abortedRes.status, SOLVER_STATUS.CANCELLED);
  assert.ok(slowNarrow.abortedSignals.length >= 1, 'child provider signal must be aborted when session signal aborts');
});

// ---------------------------------------------------------------------------
// [T4-P2-1] roleOf & evidenceFor multi-object role conflict consistency
// ---------------------------------------------------------------------------
test('[T4-P2-1] roleOf ignores null-role peers and evidenceFor reconciles multi-object conflicts without mixing counters', () => {
  // Case A: Single object preserves return shape (no multipleObjects)
  const single = foldShapes(scanOf({
    disp: [0x20],
    flags: [SHAPE.DECREASE | SHAPE.CROSS_OBJECT | SHAPE.CLAMP],
    amtKind: [AMOUNT.ARG],
    baseIdentity: ['Player'],
  }));
  const singleRole = roleOf(single, 0x20);
  assert.equal(singleRole.role, 'resource');
  assert.equal('multipleObjects' in singleRole, false);

  // Case B: Two objects at offset 0x20: ObjA is resource (1 event), ObjB has role: null (3 pure reads / zero score)
  const nonConflict = foldShapes(scanOf({
    disp: [0x20, 0x20, 0x20, 0x20],
    flags: [SHAPE.DECREASE | SHAPE.CROSS_OBJECT | SHAPE.CLAMP, 0, 0, 0],
    amtKind: [AMOUNT.ARG, AMOUNT.NONE, AMOUNT.NONE, AMOUNT.NONE],
    baseIdentity: ['ObjA', 'ObjB', 'ObjB', 'ObjB'],
  }));
  const ncRole = roleOf(nonConflict, 0x20);
  assert.equal(ncRole.role, 'resource', 'null-role sibling must not cause false ambiguity');
  const ncEv = evidenceFor(nonConflict, 0x20, 'hp');
  assert.equal(ncEv.codes.some((c) => c.code === 'loc-role-conflict'), false);
  // ObjB is bestAt (3 events) and has role=null, so it must NOT emit loc-resource-drain from ObjA
  assert.equal(ncEv.codes.some((c) => c.code === 'loc-resource-drain'), false);

  // Case C: Two objects at offset 0x20: ObjA is resource (3 events), ObjB is damage-source (used as amount against Target+0x40)
  const conflict = foldShapes(scanOf({
    disp: [0x20, 0x20, 0x20, 0x40],
    flags: [
      SHAPE.DECREASE | SHAPE.CROSS_OBJECT | SHAPE.CLAMP,
      SHAPE.DECREASE | SHAPE.CROSS_OBJECT | SHAPE.CLAMP,
      SHAPE.DECREASE | SHAPE.CROSS_OBJECT | SHAPE.CLAMP,
      SHAPE.DECREASE | SHAPE.CROSS_OBJECT,
    ],
    amtKind: [AMOUNT.ARG, AMOUNT.ARG, AMOUNT.ARG, AMOUNT.FIELD],
    amtDisp: [0, 0, 0, 0x20],
    baseIdentity: ['ObjA', 'ObjA', 'ObjA', 'Target'],
    amtBaseIdentity: [null, null, null, 'ObjB'],
  }));
  const cRole = roleOf(conflict, 0x20);
  assert.equal(cRole.role, 'ambiguous');
  assert.equal(cRole.multipleObjects, true);
  const cEv = evidenceFor(conflict, 0x20, 'hp');
  assert.equal(cEv.codes.some((c) => c.code === 'loc-role-conflict'), true,
    'multi-object role conflict must emit loc-role-conflict');
  assert.equal(cEv.codes.some((c) => c.code === 'loc-resource-drain' || c.code === 'loc-self-resource'), false,
    'positive evidence must be suppressed on multi-object role conflict');
});

// ---------------------------------------------------------------------------
// [T4-P2-2] provenConstant OP.MOV cast masking & memory-forward passthrough
// ---------------------------------------------------------------------------
test('[T4-P2-2] findIrConstantComparisons masks trunc/zext/sext/memory-forward and fails closed on invalid srcBits', () => {
  function runCompareWithMov({ srcConst, srcBits, dstBits, sub, extraSrcBits }) {
    const vReg = { id: 1, reg: 'x8', bits: dstBits, def: null };
    const vSrc = { id: 2, const: srcConst, bits: srcBits, def: null };
    const vMov = { id: 3, bits: dstBits, def: null };
    const movInst = {
      id: 10,
      row: 0,
      address: BASE,
      op: OP.MOV,
      sub,
      dst: vMov,
      args: [{ value: vSrc }],
      extra: extraSrcBits !== undefined ? { srcBits: extraSrcBits } : {},
    };
    vMov.def = movInst;
    const cmpInst = {
      id: 11,
      row: 1,
      address: BASE + 4n,
      op: OP.CMP,
      args: [{ value: vReg }, { value: vMov }],
      extra: {},
    };
    const fakeIr = {
      compat: { projection: 'semantic-ir-v2-to-v1' },
      semanticIrVersion: 'compat-v1',
      instructions: [movInst, cmpInst],
      values: [vReg, vSrc, vMov],
      blocks: [{ id: 0, insts: [movInst, cmpInst] }],
    };
    return findIrConstantComparisons(fakeIr, {});
  }

  // memory-forward passthrough masked to dstBits
  const mf = runCompareWithMov({ srcConst: 0x100000064n, srcBits: 64, dstBits: 32, sub: 'memory-forward' });
  assert.equal(mf.length, 1);
  assert.equal(mf[0].value, 0x64n);

  // trunc masks to dstBits
  const tr = runCompareWithMov({ srcConst: 0x1_0000_00ffn, srcBits: 64, dstBits: 8, sub: 'trunc' });
  assert.equal(tr.length, 1);
  assert.equal(tr[0].value, 0xffn);

  // zext with valid srcBits (8 -> 32)
  const ze = runCompareWithMov({ srcConst: 0x1ffn, srcBits: 8, dstBits: 32, sub: 'zext' });
  assert.equal(ze.length, 1);
  assert.equal(ze[0].value, 0xffn);

  // sext with valid srcBits (8 -> 32: 0xff -> 0xffffffff)
  const se = runCompareWithMov({ srcConst: 0xffn, srcBits: 8, dstBits: 32, sub: 'sext' });
  assert.equal(se.length, 1);
  assert.equal(se[0].value, 0xffffffffn);

  // zext/sext missing or out-of-range srcBits -> fail closed (no comparison)
  assert.equal(runCompareWithMov({ srcConst: 0xffn, srcBits: undefined, dstBits: 32, sub: 'zext' }).length, 0);
  assert.equal(runCompareWithMov({ srcConst: 0xffn, srcBits: undefined, dstBits: 32, sub: 'sext' }).length, 0);
  assert.equal(runCompareWithMov({ srcConst: 0xffn, srcBits: 0, dstBits: 32, sub: 'sext' }).length, 0);
  assert.equal(runCompareWithMov({ srcConst: 0xffn, srcBits: 65, dstBits: 32, sub: 'zext' }).length, 0);
});

// ---------------------------------------------------------------------------
// [T4-P2-3] findFields & findClasses clone stateful RegExp without mutating caller lastIndex
// ---------------------------------------------------------------------------
test('[T4-P2-3] FieldIndex findFields and findClasses do not mutate caller RegExp lastIndex', () => {
  const index = new FieldIndex({
    classes: [
      {
        name: 'PlayerStats',
        instanceSize: 0x40,
        ivars: [
          { name: '_hp', offset: 0x10n, size: 4, property: { name: 'hp' } },
          { name: '_maxHp', offset: 0x14n, size: 4, property: { name: 'maxHp' } },
        ],
      },
      {
        name: 'PlayerInventory',
        instanceSize: 0x40,
        ivars: [
          { name: '_gold', offset: 0x10n, size: 4, property: { name: 'gold' } },
        ],
      },
    ],
  });

  const fieldRe = /hp/gi;
  fieldRe.lastIndex = 7;
  const fields = index.findFields(fieldRe);
  assert.equal(fields.length, 2);
  assert.equal(fieldRe.lastIndex, 7, 'caller global RegExp lastIndex must remain unchanged after findFields');

  const classRe = /Player/y;
  classRe.lastIndex = 4;
  const classes = index.findClasses(classRe);
  assert.equal(classes.length, 2);
  assert.equal(classRe.lastIndex, 4, 'caller sticky RegExp lastIndex must remain unchanged after findClasses');
});

// ---------------------------------------------------------------------------
// [T4-P2-4] fieldUse excludes stack RMW from out.rmw
// ---------------------------------------------------------------------------
test('[T4-P2-4] fieldUse excludes stack-slot RMW from out.rmw when selfOnly is false', () => {
  const model = modelOf([
    'ldr w9, [x1, #0x20]',
    'ldr w8, [sp, #0x20]',
    'add w8, w8, #1',
    'str w8, [sp, #0x20]',
    'ret',
  ]);
  const use = fieldUse(model, 0x20n, { selfOnly: false });
  assert.equal(use.loads, 1);
  assert.equal(use.rmw.length, 0, 'stack RMW at [sp, #0x20] must be excluded from out.rmw');
});
