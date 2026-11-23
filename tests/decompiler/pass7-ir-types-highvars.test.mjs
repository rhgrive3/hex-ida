import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR, setSemanticMigrationMode, OP, VK } from '../../js/ir.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';
import { inferSemanticTypes, semanticSignature } from '../../js/decompiler/type-recovery.js';
import { recoverHighVariables } from '../../js/decompiler/types/high-variables.js';

const BASE = 0x100000000n;

function buildV2Ir(lines, extraOpts = {}) {
  const rows = lines.map((line, row) => {
    const trimmed = String(line).trim();
    const split = trimmed.indexOf(' ');
    return {
      row,
      address: BASE + BigInt(row * 4),
      mn: split < 0 ? trimmed : trimmed.slice(0, split),
      ops: split < 0 ? '' : trimmed.slice(split + 1).trim(),
    };
  });
  const rowOfAddress = (address) => {
    const delta = address - BASE;
    return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
  };
  const model = buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
  try {
    return buildIR(model, { rowOfAddress, ...extraOpts });
  } finally {
    setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
  }
}

test('Fix 1: ccmp preserves structured conditional-compare carrier and feeds following cbr', () => {
  const ir = buildV2Ir([
    'cmp w0, #0',
    'ccmp w1, #5, #4, gt',
    'b.eq 0x100000010',
    'mov w0, #1',
    'ret',
  ]);
  const cmps = ir.instructions.filter((i) => i.op === OP.CMP);
  assert.equal(cmps.length, 2, 'expected both cmp and ccmp OP.CMP nodes');
  const [firstCmp, ccmp] = cmps;
  assert.equal(ccmp.extra.conditional, true);
  assert.equal(ccmp.extra.guardCond, 'gt');
  assert.equal(ccmp.extra.guardCmp, firstCmp.dst.id);
  assert.equal(ccmp.extra.innerOp, 'cmp');
  assert.equal(ccmp.extra.innerLhs, ccmp.args[0].value.id);
  assert.equal(ccmp.extra.innerRhs, ccmp.args[1].value.id);
  assert.equal(ccmp.extra.fallbackNzcv, 4);
  assert.equal(ccmp.args[2]?.value, firstCmp.dst, 'guard carrier attached as args[2]');

  const cbr = ir.instructions.find((i) => i.op === OP.CBR);
  assert.ok(cbr, 'expected conditional branch');
  assert.equal(cbr.cond, 'eq');
  assert.equal(cbr.extra.kind, 'cond');
  assert.equal(cbr.extra.conditionCarrierValueId, ccmp.dst.id);
  assert.equal(cbr.args[0]?.value, ccmp.dst);
});

test('Fix 1: ccmn sets innerOp=cmn and chained ccmp links to prior ccmp carrier', () => {
  const ir = buildV2Ir([
    'cmp w0, #0',
    'ccmn w1, #3, #0, ne',
    'ccmp w2, #7, #4, lt',
    'b.eq 0x100000014',
    'mov w0, #0',
    'ret',
  ]);
  const cmps = ir.instructions.filter((i) => i.op === OP.CMP);
  assert.equal(cmps.length, 3);
  const [cmp0, ccmn1, ccmp2] = cmps;
  assert.equal(ccmn1.extra.conditional, true);
  assert.equal(ccmn1.extra.innerOp, 'cmn');
  assert.equal(ccmn1.extra.guardCond, 'ne');
  assert.equal(ccmn1.extra.guardCmp, cmp0.dst.id);
  assert.equal(ccmn1.extra.fallbackNzcv, 0);

  assert.equal(ccmp2.extra.conditional, true);
  assert.equal(ccmp2.extra.innerOp, 'cmp');
  assert.equal(ccmp2.extra.guardCond, 'lt');
  assert.equal(ccmp2.extra.guardCmp, ccmn1.dst.id);
  assert.equal(ccmp2.extra.fallbackNzcv, 4);

  const cbr = ir.instructions.find((i) => i.op === OP.CBR);
  assert.ok(cbr);
  assert.equal(cbr.extra.kind, 'cond');
  assert.equal(cbr.extra.conditionCarrierValueId, ccmp2.dst.id);
});

test('Fix 2: call canonical return values (x0/v0) are never marked clobbered while non-return clobbers stay clobbered', () => {
  const ir = buildV2Ir([
    'bl 0x100000040',
    'fadd d0, d0, d1',
    'add x0, x0, x1',
    'ret',
  ]);
  const callInst = ir.instructions.find((i) => i.op === OP.CALL);
  assert.ok(callInst, 'expected call instruction');
  const callDefs = ir.values.filter((v) => v.def === callInst);
  const x0Def = callDefs.find((v) => v.reg === 'x0');
  const v0Def = callDefs.find((v) => v.reg === 'v0');
  const x1Def = callDefs.find((v) => v.reg === 'x1');
  const v1Def = callDefs.find((v) => v.reg === 'v1');
  const x30Def = callDefs.find((v) => v.reg === 'x30');

  assert.ok(x0Def, 'expected call-defined x0');
  assert.notEqual(x0Def.clobbered, true, 'call return x0 must not be marked clobbered');
  assert.ok(v0Def, 'expected call-defined v0');
  assert.notEqual(v0Def.clobbered, true, 'call return v0/d0 must not be marked clobbered');

  assert.ok(x1Def && x1Def.clobbered === true, 'caller-saved x1 must remain clobbered');
  assert.ok(v1Def && v1Def.clobbered === true, 'caller-saved v1 must remain clobbered');
  assert.ok(x30Def && x30Def.clobbered === true, 'caller-saved x30 must remain clobbered');
});

test('Fix 3: high-variables never renames sp, xzr, wzr, or nzcv to local_<N>', () => {
  const spVal = { id: 1, kind: VK.ARG, reg: 'sp', bits: 64, def: null, uses: [] };
  const xzrVal = { id: 2, kind: VK.DEF, reg: 'xzr', bits: 64, def: { op: OP.MOV, args: [] }, uses: [] };
  const wzrVal = { id: 3, kind: VK.DEF, reg: 'wzr', bits: 32, def: { op: OP.MOV, args: [] }, uses: [] };
  const x8Val = { id: 4, kind: VK.DEF, reg: 'x8', bits: 64, def: { op: OP.MOV, args: [{ value: spVal }] }, uses: [] };
  spVal.uses.push(x8Val.def);

  const ir = { values: [spVal, xzrVal, wzrVal, x8Val], instructions: [x8Val.def] };
  const hv = recoverHighVariables(ir, { values: new Map() });

  const nameOf = (v) => hv.groups[hv.valueToGroup.get(v.id) - 1]?.name;
  assert.equal(nameOf(spVal), 'sp');
  assert.equal(nameOf(xzrVal), 'xzr');
  assert.equal(nameOf(wzrVal), 'wzr');
  assert.notEqual(nameOf(x8Val), 'sp', 'mov from sp must not coalesce x8 into sp');
  assert.equal(nameOf(x8Val), 'local_x8');
});

test('Fix 4a: 32-bit w0 integer returns infer int32 while genuinely 64-bit x0 and pointers stay uint64/void *', () => {
  const irNeg1 = buildV2Ir([
    'cmp w0, #0',
    'b.gt 0x100000010',
    'mov w0, #-1',
    'ret',
    'mov w0, #1',
    'ret',
  ]);
  const recNeg1 = inferSemanticTypes(irNeg1);
  assert.equal(recNeg1.ret.type, 'int32');
  assert.match(semanticSignature('fn_neg1', recNeg1), /^int32 fn_neg1\(/);

  const irZero32 = buildV2Ir([
    'mov w0, #0',
    'ret',
  ]);
  const recZero32 = inferSemanticTypes(irZero32);
  assert.equal(recZero32.ret.type, 'int32');

  const ir64 = buildV2Ir([
    'mov x0, #0',
    'ret',
  ]);
  const rec64 = inferSemanticTypes(ir64);
  assert.notEqual(rec64.ret.type, 'int32', 'genuinely 64-bit x0 return must not be forced to int32');
  assert.match(semanticSignature('fn_64', rec64), /^uint64 fn_64\(/);

  const irPtr = buildV2Ir([
    'ldr x8, [x0]',
    'ret',
  ]);
  const recPtr = inferSemanticTypes(irPtr);
  assert.equal(recPtr.ret.type, 'void *');
});

test('Fix 4b: stdlib string callees propagate const char * onto incoming parameters without overriding concrete types', () => {
  const makeCallIr = (calleeName, argCount) => {
    const argsMap = new Map();
    const vals = [];
    for (let i = 0; i < argCount; i++) {
      const v = { id: i + 1, kind: VK.ARG, reg: `x${i}`, bits: 64, def: null, uses: [] };
      argsMap.set(`x${i}`, v);
      vals.push(v);
    }
    const callDst = { id: 10, kind: VK.DEF, reg: 'x0', bits: 64, def: null, uses: [] };
    const callInst = {
      id: 1, op: OP.CALL, block: 0, row: 0,
      args: vals.map((v) => ({ value: v, bits: 64 })),
      dst: callDst,
      extra: { name: calleeName },
    };
    callDst.def = callInst;
    for (const v of vals) v.uses.push(callInst);
    const retInst = { id: 2, op: OP.RET, block: 0, row: 1, args: [{ value: callDst, bits: 64 }], dst: null };
    callDst.uses.push(retInst);
    vals.push(callDst);
    return {
      values: vals,
      instructions: [callInst, retInst],
      blocks: [{ index: 0, succ: [], pred: [], insts: [callInst, retInst] }],
      args: argsMap,
      stackSlots: [],
      idom: [-1],
    };
  };

  const recStrlen = inferSemanticTypes(makeCallIr('strlen', 1));
  assert.equal(recStrlen.args[0]?.type, 'const char *');

  const recStrcmp = inferSemanticTypes(makeCallIr('strcmp', 2));
  assert.equal(recStrcmp.args[0]?.type, 'const char *');
  assert.equal(recStrcmp.args[1]?.type, 'const char *');

  const recStrcpy = inferSemanticTypes(makeCallIr('strcpy', 2));
  assert.equal(recStrcpy.args[0]?.type, 'void *', 'strcpy dst must remain void *, not const char *');
  assert.equal(recStrcpy.args[1]?.type, 'const char *', 'strcpy src must be const char *');

  const recStrtod = inferSemanticTypes(makeCallIr('strtod', 2));
  assert.equal(recStrtod.args[0]?.type, 'const char *');
  assert.equal(recStrtod.args[1]?.type, 'void *', 'strtod endptr must not become const char *');
});

test('Fix 4c: discontiguous uninitialized-PHI GP entry register is rejected while contiguous PHI and direct reads stay', () => {
  // Case 1: x0 directly read, x1 unused, x2 only enters as PHI seed -> only x0 promoted.
  const x0 = { id: 1, kind: VK.ARG, reg: 'x0', bits: 64, def: null, uses: [] };
  const x1 = { id: 2, kind: VK.ARG, reg: 'x1', bits: 64, def: null, uses: [] };
  const x2 = { id: 3, kind: VK.ARG, reg: 'x2', bits: 64, def: null, uses: [] };
  const x2Phi = { id: 4, kind: VK.PHI, reg: 'x2', bits: 64, def: null, uses: [] };
  const sum = { id: 5, kind: VK.DEF, reg: 'x0', bits: 64, def: null, uses: [] };

  const phiInst = { id: 1, op: OP.PHI, block: 1, row: 1, args: [{ value: x2, bits: 64 }], dst: x2Phi };
  x2Phi.def = phiInst;
  x2.uses.push(phiInst);

  const addInst = { id: 2, op: OP.BIN, sub: 'add', block: 1, row: 2, args: [{ value: x0, bits: 64 }, { value: x2Phi, bits: 64 }], dst: sum };
  sum.def = addInst;
  x0.uses.push(addInst);
  x2Phi.uses.push(addInst);

  const retInst = { id: 3, op: OP.RET, block: 1, row: 3, args: [{ value: sum, bits: 64 }], dst: null };
  sum.uses.push(retInst);

  const irDiscontig = {
    values: [x0, x1, x2, x2Phi, sum],
    instructions: [phiInst, addInst, retInst],
    blocks: [
      { index: 0, succ: [1], pred: [], insts: [] },
      { index: 1, succ: [], pred: [0], insts: [phiInst, addInst, retInst] },
    ],
    args: new Map([['x0', x0], ['x1', x1], ['x2', x2]]),
    stackSlots: [],
    idom: [-1, 0],
  };
  const recDiscontig = inferSemanticTypes(irDiscontig);
  assert.deepEqual(recDiscontig.args.map((a) => a.reg), ['x0']);

  // Case 2: x0 directly read, x1 enters as PHI seed (contiguous) -> both x0 and x1 promoted.
  const c0 = { id: 1, kind: VK.ARG, reg: 'x0', bits: 64, def: null, uses: [] };
  const c1 = { id: 2, kind: VK.ARG, reg: 'x1', bits: 64, def: null, uses: [] };
  const c1Phi = { id: 3, kind: VK.PHI, reg: 'x1', bits: 64, def: null, uses: [] };
  const cSum = { id: 4, kind: VK.DEF, reg: 'x0', bits: 64, def: null, uses: [] };
  const cPhiInst = { id: 1, op: OP.PHI, block: 1, row: 1, args: [{ value: c1, bits: 64 }], dst: c1Phi };
  c1Phi.def = cPhiInst;
  c1.uses.push(cPhiInst);
  const cAddInst = { id: 2, op: OP.BIN, sub: 'add', block: 1, row: 2, args: [{ value: c0, bits: 64 }, { value: c1Phi, bits: 64 }], dst: cSum };
  cSum.def = cAddInst;
  c0.uses.push(cAddInst);
  c1Phi.uses.push(cAddInst);
  const cRetInst = { id: 3, op: OP.RET, block: 1, row: 3, args: [{ value: cSum, bits: 64 }], dst: null };
  cSum.uses.push(cRetInst);

  const irContig = {
    values: [c0, c1, c1Phi, cSum],
    instructions: [cPhiInst, cAddInst, cRetInst],
    blocks: [
      { index: 0, succ: [1], pred: [], insts: [] },
      { index: 1, succ: [], pred: [0], insts: [cPhiInst, cAddInst, cRetInst] },
    ],
    args: new Map([['x0', c0], ['x1', c1]]),
    stackSlots: [],
    idom: [-1, 0],
  };
  const recContig = inferSemanticTypes(irContig);
  assert.deepEqual(recContig.args.map((a) => a.reg), ['x0', 'x1']);
});
