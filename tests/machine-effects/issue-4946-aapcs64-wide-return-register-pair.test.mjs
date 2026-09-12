import assert from 'node:assert/strict';
import test from 'node:test';

import { buildIR, OP } from '../../js/architecture/compat/ir-core-arm64-aapcs64-v1.js';

/* AAPCS64 Result Return: "the same registers as would be used to pass the
 * type as an argument" — a 16-byte Integral Type returns in the consecutive
 * pair x0/x1 (via parameter rules C.10/C.11). The compat v1 lifter published
 * a single {reg:'x0', bits:128} result location: a 128-bit value claimed to
 * live inside one 64-bit register, while x1 was shadowed by an "unknown"
 * clobber definition, detaching the real x1 dataflow from use-def (#4946). */

const WIDE_PROTO = { returnType: '__int128', returnBits: 128, returnsValue: true };

function irWith(instructions, opts = {}) {
  return buildIR({
    instructions,
    basicBlocks: [{ startRow: 0, endRow: instructions.length - 1, rows: instructions.map((_, i) => i) }],
    startAddress: 0x1000n,
  }, opts);
}

function defValues(ir) {
  return (ir.values || []).filter((v) => v.kind === 'def');
}

test('a 128-bit integral call return defines the x0/x1 pair, not a 128-bit x0', () => {
  const ir = irWith([{
    row: 0, address: 0x1000n, mnemonic: 'bl', operands: [],
    isCall: true, callTarget: 0x2000n,
    callPrototype: { ...WIDE_PROTO, args: [] },
  }]);
  const callRow = ir.instructions.find((p) => p.op === OP.CALL);
  assert.equal(callRow.dst.reg, 'x0');
  assert.equal(callRow.dst.bits, 64, 'the primary result definition stays register-width');

  const defs = defValues(ir);
  const x0 = defs.filter((v) => v.reg === 'x0');
  const x1 = defs.filter((v) => v.reg === 'x1');
  assert.equal(x0.length, 1);
  assert.equal(x0[0].bits, 64);
  assert.equal(x1.length, 1, 'x1 must carry a real return-value definition');
  assert.equal(x1[0].bits, 64);
  assert.notEqual(x1[0].clobbered, true, 'the x1 definition must not be shadowed by an unknown clobber');
});

test('a 128-bit integral function return uses both registers in RET srcs', () => {
  const ir = irWith([
    { row: 0, address: 0x1000n, mnemonic: 'mov', operands: [] },
    { row: 1, address: 0x1004n, mnemonic: 'ret', operands: [], isReturn: true },
  ], { functionPrototype: WIDE_PROTO });
  const retRow = ir.instructions.find((p) => p.op === OP.RET);
  assert.deepEqual((retRow.extra?.srcs ?? []).map((s) => s.reg), ['x0', 'x1']);
  assert.deepEqual(retRow.extra?.returnRegs ?? [], ['x0', 'x1']);
  assert.equal(retRow.extra?.returnBits ?? null, 128);
});

test('64-bit integer and FP returns keep their single-register records', () => {
  const ir = irWith([
    { row: 0, address: 0x1000n, mnemonic: 'bl', operands: [], isCall: true, callTarget: 0x2000n,
      callPrototype: { returnType: 'uint64_t', returnBits: 64, returnsValue: true, args: [] } },
  ]);
  const callRow = ir.instructions.find((p) => p.op === OP.CALL);
  assert.equal(callRow.dst.reg, 'x0');
  assert.equal(callRow.dst.bits, 64);
  assert.deepEqual(defValues(ir).filter((v) => v.reg === 'x1' && !v.clobbered), [], 'no phantom x1 definition');

  const fp = irWith([
    { row: 0, address: 0x1000n, mnemonic: 'bl', operands: [], isCall: true, callTarget: 0x2000n,
      callPrototype: { returnType: 'double', returnBits: 64, returnsValue: true, args: [] } },
  ]);
  const fpRow = fp.instructions.find((p) => p.op === OP.CALL);
  assert.equal(fpRow.dst.reg, 'v0');
  assert.equal(fpRow.dst.bits, 64);
});

test('aggregate/HFA/homogeneous returns fail closed: no result location, no fabricated pair', () => {
  const ir = irWith([
    { row: 0, address: 0x1000n, mnemonic: 'bl', operands: [], isCall: true, callTarget: 0x2000n,
      callPrototype: { returnType: 'struct16', returnBits: 128, returnClass: 'aggregate', returnsValue: true, args: [] } },
  ]);
  const callRow = ir.instructions.find((p) => p.op === OP.CALL);
  assert.equal(callRow.dst, null, 'an unmodelled multi-register composite layout must not mint an exact single-register result');
  assert.equal(callRow.extra.dstReg, null);
  assert.equal(callRow.extra.returnPartial, true);
  assert.equal(callRow.extra.returnReason, 'aapcs64-composite-return-multi-register-layout-unmodelled');
  assert.equal(callRow.extra.returnEvidence, 'prototype', 'prototype evidence is preserved');
  assert.deepEqual(defValues(ir).filter((v) => v.reg === 'x1' && !v.clobbered), [], 'no phantom x1 definition');

  const hfa = irWith([
    { row: 0, address: 0x1000n, mnemonic: 'bl', operands: [], isCall: true, callTarget: 0x2000n,
      callPrototype: { returnType: 'float', returnBits: 64, returnClass: 'hfa', members: 2, returnsValue: true, args: [] } },
  ]);
  const hfaRow = hfa.instructions.find((p) => p.op === OP.CALL);
  assert.equal(hfaRow.dst, null, 'HFA multi-v-register returns must not collapse into a single x0/v0 record');
  assert.equal(hfaRow.extra.returnPartial, true);
});

test('void and indirect-result prototypes still produce no return-value location', () => {
  const voidIr = irWith([
    { row: 0, address: 0x1000n, mnemonic: 'bl', operands: [], isCall: true, callTarget: 0x2000n,
      callPrototype: { returnType: 'void', returnsValue: false, args: [] } },
  ]);
  const voidRow = voidIr.instructions.find((p) => p.op === OP.CALL);
  assert.equal(voidRow.dst, null);
  assert.equal(voidRow.extra.returnEvidence, null);

  const indirect = irWith([
    { row: 0, address: 0x1000n, mnemonic: 'bl', operands: [], isCall: true, callTarget: 0x2000n,
      callPrototype: { returnType: 'struct8', returnBits: 64, indirectResult: true, returnsValue: true, args: [] } },
  ]);
  const indirectRow = indirect.instructions.find((p) => p.op === OP.CALL);
  assert.equal(indirectRow.dst, null);
  assert.equal(indirectRow.extra.returnEvidence, null);
});

test('a post-call x1 read reaches the CALL return definition through use-def', () => {
  const ir = irWith([
    { row: 0, address: 0x1000n, mnemonic: 'bl', operands: [], isCall: true, callTarget: 0x2000n,
      callPrototype: { returnType: '__int128', returnBits: 128, returnsValue: true, args: [] } },
    { row: 1, address: 0x1004n, mnemonic: 'mov', operands: [],
      ops: [{ k: 'reg', cls: 'gp', num: 2, bits: 64 }, { k: 'reg', cls: 'gp', num: 1, bits: 64 }] },
  ]);
  const x1def = defValues(ir).find((v) => v.reg === 'x1' && !v.clobbered);
  assert.ok(x1def, 'x1 must have a return-value definition');
  assert.ok((x1def.uses || []).some((u) => u.row === 1), 'the post-call x1 read must use the CALL return definition');
});

test('a 128-bit integral RET connects both registers to their uses', () => {
  const ir = buildIR({
    instructions: [
      { row: 0, address: 0x1000n, mnemonic: 'mov', operands: [], ops: [{ k: 'reg', cls: 'gp', num: 1, bits: 64 }, { k: 'reg', cls: 'gp', num: 0, bits: 64 }] },
      { row: 1, address: 0x1004n, mnemonic: 'ret', operands: [], isReturn: true },
    ],
    basicBlocks: [{ startRow: 0, endRow: 1, rows: [0, 1] }],
    startAddress: 0x1000n,
  }, { functionPrototype: WIDE_PROTO });
  const retRow = ir.instructions.find((p) => p.op === OP.RET);
  assert.deepEqual((retRow.extra?.srcs ?? []).map((s) => s.reg), ['x0', 'x1']);
  assert.deepEqual((retRow.extra?.srcs ?? []).map((s) => s.bits), [64, 64], 'each pair half stays at register width');
  const x1def = defValues(ir).find((v) => v.reg === 'x1' && !v.clobbered);
  assert.ok((x1def?.uses || []).some((u) => u.row === 1), 'the RET x1 use must reach the x1 return definition');
});
