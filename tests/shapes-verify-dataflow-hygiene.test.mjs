import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSemanticModel } from '../js/blocks.js';
import {
  amountOf,
  amountOfLegacy,
  constantComparisons,
  findValueUpdates,
  findValueUpdatesLegacy,
} from '../js/dataflow.js';
import { findIrValueUpdates } from '../js/dataflow-ir.js';
import { findIrSemanticUpdates } from '../js/dataflow-semantic.js';
import { irFor, MK, OP, VK } from '../js/ir.js';
import {
  AMOUNT,
  byGoal,
  damageSources,
  evidenceFor,
  foldShapes,
  resources,
  roleOf,
  SHAPE,
} from '../js/shapes.js';
import { fieldUse, verifyAccessor } from '../js/verify.js';

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

// ---------------------------------------------------------------------------
// 1. js/shapes.js
// ---------------------------------------------------------------------------

test('shapes: foldShapes preserves target/amount Map keys and collects src.sites', () => {
  const scan = scanOf({
    disp: [0x40, 0x40, 0x40, 0x40],
    flags: [
      SHAPE.DECREASE | SHAPE.CROSS,
      SHAPE.DECREASE | SHAPE.CROSS,
      SHAPE.DECREASE | SHAPE.CROSS,
      SHAPE.DECREASE | SHAPE.CROSS,
    ],
    amtKind: [AMOUNT.FIELD, AMOUNT.FIELD, AMOUNT.FIELD, AMOUNT.FIELD],
    amtDisp: [0x80, 0x80, 0x80, 0x80],
    baseIdentity: ['A', 'A', 'A', 'A'],
    amtBaseIdentity: ['B', 'B', 'B', 'B'],
  });
  const folded = foldShapes(scan);
  assert.equal(folded.size, 2);
  assert.ok(folded.has('target:A:64'));
  assert.ok(folded.has('amount:B:128'));
  const src = folded.get('amount:B:128');
  assert.equal(src.events, 4);
  assert.equal(src.sites.length, 4);
  assert.equal(src.sites[0].addr, 0x1000n);
});

test('shapes: peer cross-reference penalizes self-changing damage source and reconciles roles', () => {
  // Same (identity='P', offset=0x50) is heavily modified as target (8 times) and
  // also used as amount against another field (2 times).
  const scan = scanOf({
    disp: [0x50, 0x50, 0x50, 0x50, 0x50, 0x50, 0x50, 0x50, 0x60, 0x60],
    flags: [
      SHAPE.DECREASE, SHAPE.DECREASE, SHAPE.DECREASE, SHAPE.DECREASE,
      SHAPE.INCREASE, SHAPE.INCREASE, SHAPE.INCREASE, SHAPE.INCREASE,
      SHAPE.DECREASE | SHAPE.CROSS, SHAPE.DECREASE | SHAPE.CROSS,
    ],
    amtKind: [
      AMOUNT.IMM, AMOUNT.IMM, AMOUNT.IMM, AMOUNT.IMM,
      AMOUNT.IMM, AMOUNT.IMM, AMOUNT.IMM, AMOUNT.IMM,
      AMOUNT.FIELD, AMOUNT.FIELD,
    ],
    amtDisp: [0, 0, 0, 0, 0, 0, 0, 0, 0x50, 0x50],
    baseIdentity: ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'Q', 'Q'],
    amtBaseIdentity: [null, null, null, null, null, null, null, null, 'P', 'P'],
  });
  const folded = foldShapes(scan);
  assert.equal(folded.size, 3); // target:P:80, target:Q:96, amount:P:80

  const role = roleOf(folded, 0x50);
  assert.equal(role.role, 'resource');
  assert.notEqual(role.multipleObjects, true);

  const res = resources(folded, 12);
  const pEntries = res.filter((r) => r.identity === 'P' && r.offset === 0x50);
  assert.equal(pEntries.length, 1, 'resources() must not duplicate target and amount peers');

  const dmg = damageSources(folded, res, 12);
  assert.equal(dmg.some((d) => d.identity === 'P' && d.offset === 0x50), false);
});

test('shapes: decreaseCrossObject and decreaseAmountFromCall separate INCREASE from DECREASE for hp/stamina', () => {
  // Offset 0x40: only DECREASE is self-imm; CROSS and CALL happen only on INCREASE.
  // Offset 0x48: DECREASE has CROSS.
  // Offset 0x50: DECREASE has AMOUNT.CALL.
  const scan = scanOf({
    disp: [0x40, 0x40, 0x40, 0x40, 0x48, 0x48, 0x50, 0x50],
    flags: [
      SHAPE.DECREASE, SHAPE.DECREASE,
      SHAPE.INCREASE | SHAPE.CROSS, SHAPE.INCREASE,
      SHAPE.DECREASE | SHAPE.CROSS, SHAPE.DECREASE,
      SHAPE.DECREASE, SHAPE.DECREASE,
    ],
    amtKind: [
      AMOUNT.IMM, AMOUNT.IMM,
      AMOUNT.FIELD, AMOUNT.CALL,
      AMOUNT.FIELD, AMOUNT.IMM,
      AMOUNT.CALL, AMOUNT.IMM,
    ],
    amtDisp: [0, 0, 0x90, 0, 0x94, 0, 0, 0],
    baseIdentity: ['A', 'A', 'A', 'A', 'A', 'A', 'A', 'A'],
    amtBaseIdentity: [null, null, 'B', null, 'B', null, null, null],
  });
  const folded = foldShapes(scan);

  const evHpIncOnly = evidenceFor(folded, 0x40, 'hp');
  assert.equal(evHpIncOnly.codes.some((c) => c.code === 'loc-resource-drain'), false);
  const evStamIncOnly = evidenceFor(folded, 0x40, 'stamina');
  assert.equal(evStamIncOnly.codes.some((c) => c.code === 'loc-resource-drain'), false);

  const evHpDecCross = evidenceFor(folded, 0x48, 'hp');
  assert.equal(evHpDecCross.codes.some((c) => c.code === 'loc-resource-drain'), true);

  const evStamDecCall = evidenceFor(folded, 0x50, 'stamina');
  assert.equal(evStamDecCall.codes.some((c) => c.code === 'loc-resource-drain'), true);

  const hpGoals = byGoal(folded, 'hp', 8).map((e) => e.offset);
  assert.equal(hpGoals.includes(0x40), false, 'byGoal(hp) must exclude increase-only cross/call');
  assert.equal(hpGoals.includes(0x48), true);
  assert.equal(hpGoals.includes(0x50), true);

  const stamGoals = byGoal(folded, 'stamina', 8).map((e) => e.offset);
  assert.equal(stamGoals.includes(0x40), false, 'byGoal(stamina) must exclude increase-only cross/call');
  assert.equal(stamGoals.includes(0x48), true);
  assert.equal(stamGoals.includes(0x50), true);
});

test('shapes: evidenceFor(level) emits loc-self-resource only when crossObject === 0', () => {
  const scan = scanOf({
    disp: [0x40, 0x40, 0x48, 0x48],
    flags: [
      SHAPE.DECREASE, SHAPE.INCREASE,
      SHAPE.DECREASE | SHAPE.CROSS, SHAPE.INCREASE,
    ],
    amtKind: [AMOUNT.IMM, AMOUNT.IMM, AMOUNT.FIELD, AMOUNT.IMM],
    amtDisp: [0, 0, 0x80, 0],
    baseIdentity: ['P', 'P', 'P', 'P'],
    amtBaseIdentity: [null, null, 'E', null],
  });
  const folded = foldShapes(scan);

  const evSelf = evidenceFor(folded, 0x40, 'level');
  assert.equal(evSelf.codes.some((c) => c.code === 'loc-self-resource'), true);

  const evCross = evidenceFor(folded, 0x48, 'level');
  assert.equal(evCross.codes.some((c) => c.code === 'loc-self-resource'), false);

  // byGoal('level') retains existing wide candidate list behavior
  const levelCandidates = byGoal(folded, 'level', 8).map((e) => e.offset);
  assert.equal(levelCandidates.includes(0x40), true);
  assert.equal(levelCandidates.includes(0x48), true);
});

// ---------------------------------------------------------------------------
// 2. js/verify.js
// ---------------------------------------------------------------------------

test('verifyAccessor: detects intervening overwrites on x2/w2 and s0/d0, accepts same-width orr/fmov copies, rejects #813 extends', () => {
  // Direct GP argument overwritten before store
  const overwrittenGp = verifyAccessor(modelOf([
    'mov w2, #0',
    'str w2, [x0, #0x20]',
    'ret',
  ]), { offset: 0x20n });
  assert.equal(overwrittenGp.setter, true);
  assert.equal(overwrittenGp.fromArgument, false);

  // Copy from overwritten GP argument
  const overwrittenGpCopy = verifyAccessor(modelOf([
    'mov x2, #1',
    'mov x8, x2',
    'str x8, [x0, #0x20]',
    'ret',
  ]), { offset: 0x20n });
  assert.equal(overwrittenGpCopy.fromArgument, false);

  // Same-width ORR alias copy
  const orrCopy = verifyAccessor(modelOf([
    'orr w8, wzr, w2',
    'str w8, [x0, #0x20]',
    'ret',
  ]), { offset: 0x20n });
  assert.equal(orrCopy.fromArgument, true);

  // Direct scalar FP setter and same-width fmov copy
  const directFp = verifyAccessor(modelOf([
    'str s0, [x0, #0x24]',
    'ret',
  ]), { offset: 0x24n });
  assert.equal(directFp.setter, true);
  assert.equal(directFp.fromArgument, true);

  const fmovCopy = verifyAccessor(modelOf([
    'fmov d8, d0',
    'str d8, [x0, #0x28]',
    'ret',
  ]), { offset: 0x28n });
  assert.equal(fmovCopy.fromArgument, true);

  // FP argument overwritten before store
  const overwrittenFp = verifyAccessor(modelOf([
    'fmov s0, #1.0',
    'str s0, [x0, #0x24]',
    'ret',
  ]), { offset: 0x24n });
  assert.equal(overwrittenFp.fromArgument, false);

  // Multiple stores: second store writes argument
  const multiStore = verifyAccessor(modelOf([
    'str wzr, [x0, #0x20]',
    'str w2, [x0, #0x20]',
    'ret',
  ]), { offset: 0x20n });
  assert.equal(multiStore.fromArgument, true);

  // #813 strictness: uxtb / uxth / sxtw / uxtw must remain rejected
  for (const line of ['sxtw x8, w2', 'uxtw x8, w2', 'uxtb w8, w2', 'uxth w8, w2']) {
    const storeReg = line.startsWith('sxtw') || line.startsWith('uxtw') ? 'x8' : 'w8';
    const res = verifyAccessor(modelOf([line, `str ${storeReg}, [x0, #0x20]`, 'ret']), { offset: 0x20n });
    assert.equal(res.fromArgument, false, `${line} must not be accepted as setter copy`);
  }
});

test('verifyAccessor: verifies getter return-register flow when load writes exist while preserving #4139 mock', () => {
  const gpGetter = verifyAccessor(modelOf([
    'ldr w8, [x0, #0x20]',
    'mov w0, w8',
    'ret',
  ]), { offset: 0x20n });
  assert.equal(gpGetter.getter, true);

  const fpGetter = verifyAccessor(modelOf([
    'ldr s8, [x0, #0x24]',
    'fmov s0, s8',
    'ret',
  ]), { offset: 0x24n });
  assert.equal(fpGetter.getter, true);

  const nonGetter = verifyAccessor(modelOf([
    'ldr w8, [x0, #0x20]',
    'str w8, [x1, #0x0]',
    'mov w0, #0',
    'ret',
  ]), { offset: 0x20n });
  assert.equal(nonGetter.getter, false);

  // #4139 minimal mock with writes: []
  const minimalMock = {
    instructions: [
      { row: 0, writes: [], reads: [], ops: [], memory: { base: 'x0', disp: 0x20n, kind: 'load', size: 4, indexed: false, stack: false } },
    ],
  };
  assert.equal(verifyAccessor(minimalMock, { offset: 0x20n }).getter, true);
});

test('fieldUse: detects cbz/cbnz/tbz/tbnz before controlBoundary and requires flag consumer for non-zr subs/adds', () => {
  const cbzUse = fieldUse(modelOf([
    'ldr w8, [x0, #0x20]',
    'cbz w8, #0x100000010',
    'ret',
  ]), 0x20n);
  assert.equal(cbzUse.compares.length, 1);
  assert.equal(cbzUse.compares[0].mnemonic, 'cbz');
  assert.equal(cbzUse.compares[0].value, 0n);

  const tbzUse = fieldUse(modelOf([
    'ldr w8, [x0, #0x20]',
    'tbnz w8, #3, #0x100000010',
    'ret',
  ]), 0x20n);
  assert.equal(tbzUse.compares.length, 1);
  assert.equal(tbzUse.compares[0].mnemonic, 'tbnz');
  assert.equal(tbzUse.compares[0].value, 3n);

  // subs with b.le is a real guard
  const subsGuard = fieldUse(modelOf([
    'ldr w8, [x0, #0x20]',
    'subs w8, w8, #1',
    'b.le #0x100000014',
    'str w8, [x0, #0x20]',
    'ret',
  ]), 0x20n);
  assert.equal(subsGuard.compares.length, 1);
  assert.equal(subsGuard.compares[0].mnemonic, 'subs');

  // subs without any flag consumer is pure arithmetic, not a guard
  const subsArithOnly = fieldUse(modelOf([
    'ldr w8, [x0, #0x20]',
    'subs w8, w8, #1',
    'str w8, [x0, #0x20]',
    'ret',
  ]), 0x20n);
  assert.equal(subsArithOnly.compares.length, 0);
});

// ---------------------------------------------------------------------------
// 3. js/dataflow*.js
// ---------------------------------------------------------------------------

test('dataflow: MK.GLOBAL excluded by default and opt-in via includeGlobals for both RMW and direct writes', () => {
  const rmwModel = modelOf([
    'adr x19, #0x100001000',
    'ldr w8, [x19, #0x20]',
    'add w8, w8, #1',
    'str w8, [x19, #0x20]',
    'ret',
  ]);
  const defRmw = findValueUpdates(rmwModel);
  assert.equal(defRmw.some((u) => u.location?.irKind === MK.GLOBAL), false);
  const optRmw = findValueUpdates(rmwModel, { includeGlobals: true });
  assert.equal(optRmw.some((u) => u.kind === 'read-modify-write' && u.location?.irKind === MK.GLOBAL), true);

  const directModel = modelOf([
    'adr x19, #0x100002000',
    'str w2, [x19, #0x10]',
    'ret',
  ]);
  const defDirect = findValueUpdates(directModel);
  assert.equal(defDirect.some((u) => u.location?.irKind === MK.GLOBAL), false);
  const optDirect = findValueUpdates(directModel, { includeGlobals: true });
  assert.equal(optDirect.some((u) => u.engine === 'ir-semantic' && u.location?.irKind === MK.GLOBAL), true);
});

test('dataflow: real ARM64 bic sign-mask clamp (32-bit and 64-bit) marks signMaskClamp and excludes asr/mvn parts', () => {
  for (const [insnLines, expectedReg] of [
    [[
      'ldr w8, [x0, #0x20]',
      'sub w8, w8, w2',
      'bic w8, w8, w8, asr #31',
      'str w8, [x0, #0x20]',
      'ret',
    ], 'x2'],
    [[
      'ldr x8, [x0, #0x20]',
      'sub x8, x8, x2',
      'bic x8, x8, x8, asr #63',
      'str x8, [x0, #0x20]',
      'ret',
    ], 'x2'],
  ]) {
    const model = modelOf(insnLines);
    const updates = findValueUpdates(model);
    const rmw = updates.find((u) => u.kind === 'read-modify-write' && u.engine === 'ir-ssa');
    assert.ok(rmw, 'expected IR-SSA RMW');
    assert.equal(rmw.steps.some((s) => s.signMaskClamp === true), true);
    assert.equal(rmw.steps.some((s) => s.signMaskClampPart === true), true);

    const amt = amountOf(model, rmw);
    assert.equal(amt.clamped, true);
    assert.equal(amt.scaled, false, 'sign-mask asr must not pollute scaled');
    assert.equal(amt.ops.includes('asr'), false, 'sign-mask asr must be excluded from ops');
    assert.equal(amt.ops.includes('mvn'), false, 'sign-mask mvn must be excluded from ops');
    assert.equal(amt.amount?.kind, 'arg');
    assert.equal(amt.amount?.reg, expectedReg);
    assert.equal(amt.amount?.op, 'sub');

    // Legacy path
    const legUpdates = findValueUpdatesLegacy(model);
    const legRmw = legUpdates.find((u) => u.kind === 'read-modify-write');
    assert.ok(legRmw, 'expected legacy RMW');
    assert.equal(legRmw.steps.some((s) => s.op === 'bic' && s.signMaskClamp === true), true);
    const legAmt = amountOfLegacy(model, legRmw);
    assert.equal(legAmt.clamped, true);
    assert.equal(legAmt.scaled, false);
  }
});

test('dataflow: ordinary bic flag-clear is NOT treated as clamp in IR or legacy paths', () => {
  // Legacy bic w8, w8, #1
  const immModel = modelOf([
    'ldr w8, [x0, #0x20]',
    'bic w8, w8, #1',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  const legRmw = findValueUpdatesLegacy(immModel).find((u) => u.kind === 'read-modify-write');
  assert.ok(legRmw);
  assert.equal(amountOfLegacy(immModel, legRmw).clamped, false);

  // Real ARM64 IR bic w8, w8, w9
  const regModel = modelOf([
    'ldr w8, [x0, #0x20]',
    'bic w8, w8, w9',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  const irRmw = findValueUpdates(regModel).find((u) => u.kind === 'read-modify-write' && u.engine === 'ir-ssa');
  assert.ok(irRmw);
  assert.equal(amountOf(regModel, irRmw).clamped, false);

  // Synthetic IR OP.BIN(bic) with constant mask #1
  const loc = { kind: MK.FIELD, base: { id: 1, reg: 'x0' }, disp: 0x20n, size: 4, key: 'field:arg:x0+32' };
  const vLoad = { id: 10, reg: 'x8', def: null };
  const loadInst = { id: 1, row: 0, address: BASE, op: OP.LOAD, loc, dst: vLoad, addr: { baseReg: 'x0', base: loc.base }, args: [] };
  vLoad.def = loadInst;
  const vMask = { id: 11, const: 1n, def: null };
  const vBic = { id: 12, reg: 'x8', def: null };
  const bicInst = { id: 2, row: 1, address: BASE + 4n, op: OP.BIN, sub: 'bic', dst: vBic, args: [{ value: vLoad }, { value: vMask }] };
  vBic.def = bicInst;
  const storeInst = { id: 3, row: 2, address: BASE + 8n, op: OP.STORE, loc, addr: { baseReg: 'x0', base: loc.base }, args: [{ value: vBic }] };
  const synthUpd = findIrValueUpdates({ instructions: [{ row: 0 }, { row: 1 }, { row: 2 }], calls: [] }, null, {
    ir: {},
    readModifyWriteProofs: [{ kind: 'compute', location: loc, load: loadInst, store: storeInst, chain: [bicInst] }],
  });
  assert.equal(synthUpd.length, 1);
  assert.equal(amountOf(immModel, synthUpd[0]).clamped, false);
});

test('dataflow: synthetic 2-instruction IR (ashr + bic across distinct rows) marks signMaskClampPart by node/SSA ID', () => {
  const loc = { kind: MK.FIELD, base: { id: 1, reg: 'x0' }, disp: 0x20n, size: 4, key: 'field:arg:x0+32' };
  const vLoad = { id: 10, reg: 'x8', def: null };
  const loadInst = { id: 1, row: 0, address: BASE, op: OP.LOAD, loc, dst: vLoad, addr: { baseReg: 'x0', base: loc.base }, args: [] };
  vLoad.def = loadInst;

  const vImm5 = { id: 11, const: 5n, def: null };
  const vSub = { id: 12, reg: 'x8', def: null };
  const subInst = { id: 2, row: 1, address: BASE + 4n, op: OP.BIN, sub: 'sub', dst: vSub, args: [{ value: vLoad }, { value: vImm5 }] };
  vSub.def = subInst;

  const v31 = { id: 13, const: 31n, def: null };
  const vAshr = { id: 14, reg: 'x9', def: null };
  const ashrInst = { id: 3, row: 2, address: BASE + 8n, op: OP.BIN, sub: 'ashr', dst: vAshr, args: [{ value: vSub }, { value: v31 }] };
  vAshr.def = ashrInst;

  const vBic = { id: 15, reg: 'x8', def: null };
  const bicInst = { id: 4, row: 3, address: BASE + 12n, op: OP.BIN, sub: 'bic', dst: vBic, args: [{ value: vSub }, { value: vAshr }] };
  vBic.def = bicInst;

  const storeInst = { id: 5, row: 4, address: BASE + 16n, op: OP.STORE, loc, addr: { baseReg: 'x0', base: loc.base }, args: [{ value: vBic }] };

  const dummyModel = { instructions: [{ row: 0 }, { row: 1 }, { row: 2 }, { row: 3 }, { row: 4 }], calls: [] };
  const rmwProofs = [{
    kind: 'compute',
    location: loc,
    load: loadInst,
    store: storeInst,
    chain: [subInst, ashrInst, bicInst],
  }];
  const irUpdates = findIrValueUpdates(dummyModel, null, { ir: {}, readModifyWriteProofs: rmwProofs });
  assert.equal(irUpdates.length, 1);
  const ashrStep = irUpdates[0].steps.find((s) => s.op === 'asr');
  const bicStep = irUpdates[0].steps.find((s) => s.op === 'bic');
  assert.equal(ashrStep?.signMaskClampPart, true);
  assert.equal(bicStep?.signMaskClamp, true);

  const amt = amountOf(dummyModel, irUpdates[0]);
  assert.equal(amt.clamped, true);
  assert.equal(amt.scaled, false);
  assert.deepEqual(amt.ops, ['sub', 'bic']);
  assert.equal(amt.amount?.kind, 'imm');
  assert.equal(amt.amount?.value, 5n);

  // Also verify legacyAmountOf excludes signMaskClampPart from loop, L522 fallback, and L525 ops
  const legAmt = amountOfLegacy(dummyModel, {
    steps: [
      { op: 'asr', imm: 31n, row: 2, signMaskClampPart: true },
      { op: 'bic', imm: null, row: 3, signMaskClamp: true },
    ],
  });
  assert.equal(legAmt.clamped, true);
  assert.equal(legAmt.scaled, false);
  assert.equal(legAmt.amount, null, 'signMaskClampPart imm must not be picked by L522 fallback');
  assert.deepEqual(legAmt.ops, ['bic']);
});

test('dataflow: fmax/fmin/fmaxnm/fminnm recognized as clamp in legacy and synthetic IR paths', () => {
  for (const op of ['fmax', 'fmin', 'fmaxnm', 'fminnm']) {
    const model = modelOf([
      'ldr s0, [x0, #0x20]',
      'fsub s0, s0, s1',
      `${op} s0, s0, s2`,
      'str s0, [x0, #0x20]',
      'ret',
    ]);
    const legRmw = findValueUpdatesLegacy(model).find((u) => u.kind === 'read-modify-write');
    assert.ok(legRmw, `legacy RMW expected for ${op}`);
    const legAmt = amountOfLegacy(model, legRmw);
    assert.equal(legAmt.clamped, true, `legacy amountOf should mark ${op} as clamped`);

    // Synthetic IR check
    const loc = { kind: MK.FIELD, base: { id: 1, reg: 'x0' }, disp: 0x20n, size: 4, key: 'field:arg:x0+32' };
    const vLoad = { id: 10, reg: 'v0', def: null };
    const loadInst = { id: 1, row: 0, address: BASE, op: OP.LOAD, loc, dst: vLoad, addr: { baseReg: 'x0', base: loc.base }, args: [] };
    vLoad.def = loadInst;
    const vOther = { id: 11, reg: 'v2', kind: VK.ARG, def: null };
    const vClamp = { id: 12, reg: 'v0', def: null };
    const clampInst = { id: 2, row: 1, address: BASE + 4n, op: OP.BIN, sub: op, dst: vClamp, args: [{ value: vLoad }, { value: vOther }] };
    vClamp.def = clampInst;
    const storeInst = { id: 3, row: 2, address: BASE + 8n, op: OP.STORE, loc, addr: { baseReg: 'x0', base: loc.base }, args: [{ value: vClamp }] };
    const irUpd = findIrValueUpdates({ instructions: [{ row: 0 }, { row: 1 }, { row: 2 }], calls: [] }, null, {
      ir: {},
      readModifyWriteProofs: [{ kind: 'compute', location: loc, load: loadInst, store: storeInst, chain: [clampInst] }],
    });
    assert.equal(irUpd.length, 1);
    assert.equal(amountOf(model, irUpd[0]).clamped, true, `IR amountOf should mark ${op} as clamped`);
  }
});

test('dataflow-semantic: computationPath prefers non-mask arm for signMaskClamp and distinguishes in PHI', () => {
  const srcLoc = { kind: MK.FIELD, base: { id: 1, reg: 'x0' }, disp: 0x20n, size: 4, key: 'field:arg:x0+32' };
  const dstLoc = { kind: MK.FIELD, base: { id: 1, reg: 'x0' }, disp: 0x24n, size: 4, key: 'field:arg:x0+36' };
  const vLoad = { id: 10, reg: 'x8', def: null };
  const loadInst = { id: 1, row: 0, address: BASE, op: OP.LOAD, loc: srcLoc, dst: vLoad, addr: { baseReg: 'x0', base: srcLoc.base }, args: [] };
  vLoad.def = loadInst;

  const v31 = { id: 11, const: 31n, def: null };
  const vAshr = { id: 12, reg: 'x9', def: null };
  const ashrInst = { id: 2, row: 1, address: BASE + 4n, op: OP.BIN, sub: 'ashr', dst: vAshr, args: [{ value: vLoad }, { value: v31 }] };
  vAshr.def = ashrInst;

  const vNot = { id: 13, reg: 'x9', def: null };
  const notInst = { id: 3, row: 1, address: BASE + 4n, op: OP.UN, sub: 'not', dst: vNot, args: [{ value: vAshr }] };
  vNot.def = notInst;

  // Put mask arm FIRST (index 0) to verify computationPath still prefers the non-mask arm (index 1)
  const vAnd = { id: 14, reg: 'x8', def: null };
  const andInst = { id: 4, row: 1, address: BASE + 4n, op: OP.BIN, sub: 'and', dst: vAnd, args: [{ value: vNot }, { value: vLoad }] };
  vAnd.def = andInst;

  const storeInst = { id: 5, row: 2, address: BASE + 8n, op: OP.STORE, loc: dstLoc, addr: { baseReg: 'x0', base: dstLoc.base }, args: [{ value: vAnd }] };

  const synthIr = {
    instructions: [loadInst, ashrInst, notInst, andInst, storeInst],
    blocks: [{ id: 0, phis: [], insts: [loadInst, ashrInst, notInst, andInst, storeInst], idom: -1 }],
    values: [vLoad, v31, vAshr, vNot, vAnd],
    args: new Map(),
  };
  const updates = findIrSemanticUpdates({ instructions: [], calls: [] }, null, [], { ir: synthIr, readModifyWriteProofs: [] });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].steps.some((s) => s.signMaskClamp === true), true);
  assert.equal(updates[0].steps.some((s) => s.op === 'asr' || s.op === 'mvn'), false);
  const amt = amountOf({}, updates[0]);
  assert.equal(amt.clamped, true);
  assert.equal(amt.scaled, false);
});

test('dataflow: failed adapter exception is not cached in updateCache', () => {
  const model = modelOf([
    'ldr w8, [x0, #0x20]',
    'add w8, w8, #1',
    'str w8, [x0, #0x20]',
    'str w2, [x0, #0x24]',
    'ret',
  ]);
  // Prime IR first so irFor(model) succeeds, then fail once on calls access during semantic adapter
  const realCalls = model.calls || [];
  let failOnce = true;
  Object.defineProperty(model, 'calls', {
    configurable: true,
    get() {
      if (failOnce) {
        failOnce = false;
        throw new Error('simulated transient adapter failure');
      }
      return realCalls;
    },
  });

  const first = findValueUpdates(model);
  // First call failed inside try{} before direct writes completed, returning partial rmw without caching
  assert.ok(Array.isArray(first));

  const second = findValueUpdates(model);
  // Second call succeeds and returns both RMW (+0x20) and direct write (+0x24)
  assert.equal(second.some((u) => u.location?.disp === 0x20n), true);
  assert.equal(second.some((u) => u.location?.disp === 0x24n), true);

  // constantComparisons also sees full unpoisoned context
  assert.ok(Array.isArray(constantComparisons(model)));
});
