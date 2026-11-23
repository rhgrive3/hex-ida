import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR, setSemanticMigrationMode, OP, VK } from '../../js/ir.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';
import { inferSemanticTypes, semanticSignature } from '../../js/decompiler/type-recovery.js';

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

test('arm64.fp.fcmp wires nzcvOut as active NZCV flag carrier for cbr', () => {
  const ir = buildV2Ir([
    'fcmp s0, s1',
    'b.eq 0x10000000c',
    'mov w0, #1',
    'ret',
  ]);
  const cmp = ir.instructions.find((i) => i.op === OP.CMP && i.sub === 'fsub');
  assert.ok(cmp && cmp.dst, 'expected fcmp OP.CMP instruction');
  const cbr = ir.instructions.find((i) => i.op === OP.CBR);
  assert.ok(cbr, 'expected conditional branch');
  assert.equal(cbr.cond, 'eq');
  assert.equal(cbr.extra.kind, 'cond');
  assert.equal(cbr.args[0]?.value, cmp.dst);
  assert.equal(cbr.extra.conditionCarrierValueId, cmp.dst.semanticValueId);
});

test('arm64.fp.fcmpe wires nzcvOut as active NZCV flag carrier for select (cset)', () => {
  const ir = buildV2Ir([
    'fcmpe d0, d1',
    'cset w0, gt',
    'ret',
  ]);
  const cmp = ir.instructions.find((i) => i.op === OP.CMP && i.sub === 'fsub');
  assert.ok(cmp && cmp.dst, 'expected fcmpe OP.CMP instruction');
  assert.equal(cmp.extra.signalingNaN, true);
  const sel = ir.instructions.find((i) => i.op === OP.SEL);
  assert.ok(sel, 'expected cset OP.SEL instruction');
  assert.equal(sel.cond, 'gt');
  assert.ok(sel.args.some((a) => a.value === cmp.dst), 'select must carry fcmpe nzcvOut');
  assert.equal(sel.extra.conditionCarrierValueId, cmp.dst.semanticValueId);
});

test('call clobbering nzcv clears active fcmp NZCV carrier before subsequent b.eq', () => {
  const ir = buildV2Ir([
    'fcmp s0, s1',
    'bl 0x100000040',
    'b.eq 0x100000010',
    'mov w0, #1',
    'ret',
  ]);
  const cmp = ir.instructions.find((i) => i.op === OP.CMP && i.sub === 'fsub');
  const cbr = ir.instructions.find((i) => i.op === OP.CBR);
  assert.ok(cmp && cbr);
  assert.notEqual(cbr.args[0]?.value, cmp.dst, 'post-call b.eq must not reuse pre-call fcmp carrier');
});

test('ccmn preserves guardCarrier and innerOp=cmn across cond/fallbackNzcv and fcmp guard', () => {
  const ir1 = buildV2Ir([
    'cmp w0, #0',
    'ccmn w1, #3, #4, ne',
    'b.eq 0x100000010',
    'mov w0, #1',
    'ret',
  ]);
  const [cmp0, ccmn1] = ir1.instructions.filter((i) => i.op === OP.CMP);
  assert.ok(cmp0 && ccmn1);
  assert.equal(ccmn1.extra.conditional, true);
  assert.equal(ccmn1.extra.innerOp, 'cmn');
  assert.equal(ccmn1.extra.guardCond, 'ne');
  assert.equal(ccmn1.extra.guardCmp, cmp0.dst.id);
  assert.equal(ccmn1.extra.fallbackNzcv, 4);

  const ir2 = buildV2Ir([
    'fcmp s0, s1',
    'ccmn w1, #3, #0, ne',
    'b.eq 0x100000010',
    'mov w0, #1',
    'ret',
  ]);
  const [fcmp0, ccmn2] = ir2.instructions.filter((i) => i.op === OP.CMP);
  assert.ok(fcmp0 && ccmn2);
  assert.equal(ccmn2.extra.conditional, true);
  assert.equal(ccmn2.extra.innerOp, 'cmn');
  assert.equal(ccmn2.extra.guardCmp, fcmp0.dst.id);
});

test('838: floating evidence and 32/64-bit scalar width propagate across mov/trunc/zext and findFpReturnVals', () => {
  const irFloat = buildV2Ir([
    'fmul s0, s0, s1',
    'ret',
  ]);
  const typesFloat = inferSemanticTypes(irFloat, { abi: 'aapcs64', arch: 'arm64' });
  assert.equal(semanticSignature('func0', typesFloat), 'float func0(float a1, float a2)');
  assert.equal(typesFloat.ret.type, 'float');

  const irDouble = buildV2Ir([
    'fadd d0, d0, d1',
    'ret',
  ]);
  const typesDouble = inferSemanticTypes(irDouble, { abi: 'aapcs64', arch: 'arm64' });
  assert.equal(semanticSignature('func0', typesDouble), 'double func0(double a1, double a2)');
  assert.equal(typesDouble.ret.type, 'double');
});

test('838: floating evidence and v0 return trace through OP.PHI and OP.MOV', () => {
  const argV0 = { id: 0, vid: 1, kind: VK.ARG, reg: 'v0', bits: 128, def: null, uses: [] };
  const argV1 = { id: 1, vid: 2, kind: VK.ARG, reg: 'v1', bits: 128, def: null, uses: [] };
  const s0a = { id: 2, vid: 3, kind: VK.DEF, reg: null, bits: 32, def: null, uses: [] };
  const s1a = { id: 3, vid: 4, kind: VK.DEF, reg: null, bits: 32, def: null, uses: [] };
  const fmulRes = { id: 4, vid: 5, kind: VK.DEF, reg: null, bits: 32, def: null, uses: [] };
  const zextV0 = { id: 5, vid: 6, kind: VK.DEF, reg: null, bits: 128, def: null, uses: [] };
  const phiV0 = { id: 6, vid: 7, kind: VK.DEF, reg: 'v0', bits: 128, def: null, uses: [] };

  const i0 = { id: 0, row: 0, block: 0, op: OP.MOV, sub: 'trunc', dst: s0a, args: [{ value: argV0, bits: 128 }], extra: { sourceBits: 128, targetBits: 32 } };
  const i1 = { id: 1, row: 1, block: 0, op: OP.MOV, sub: 'trunc', dst: s1a, args: [{ value: argV1, bits: 128 }], extra: { sourceBits: 128, targetBits: 32 } };
  const i2 = { id: 2, row: 2, block: 0, op: OP.BIN, sub: 'fmul', dst: fmulRes, args: [{ value: s0a, bits: 32 }, { value: s1a, bits: 32 }], extra: { float: true } };
  const i3 = { id: 3, row: 3, block: 0, op: OP.MOV, sub: 'zext', dst: zextV0, args: [{ value: fmulRes, bits: 32 }], extra: { sourceBits: 32, targetBits: 128 } };
  const i4 = { id: 4, row: 4, block: 1, op: OP.PHI, sub: null, dst: phiV0, args: [{ value: zextV0, bits: 128 }, { value: argV0, bits: 128 }] };
  const i5 = { id: 5, row: 5, block: 1, op: OP.RET, sub: null, dst: null, args: [] };

  s0a.def = i0; s1a.def = i1; fmulRes.def = i2; zextV0.def = i3; phiV0.def = i4;
  argV0.uses.push(i0, i4);
  argV1.uses.push(i1);
  s0a.uses.push(i2);
  s1a.uses.push(i2);
  fmulRes.uses.push(i3);
  zextV0.uses.push(i4);
  phiV0.uses.push(i5);

  const ir = {
    values: [argV0, argV1, s0a, s1a, fmulRes, zextV0, phiV0],
    args: new Map([['v0', argV0], ['v1', argV1]]),
    instructions: [i0, i1, i2, i3, i4, i5],
    blocks: [
      { index: 0, startRow: 0, endRow: 3, pred: [], succ: [1], insts: [i0, i1, i2, i3], phis: [] },
      { index: 1, startRow: 4, endRow: 5, pred: [0], succ: [], insts: [i4, i5], phis: [i4] },
    ],
  };

  const types = inferSemanticTypes(ir, { abi: 'aapcs64', arch: 'arm64' });
  assert.equal(types.ret.type, 'float');
  assert.equal(types.args.length, 2);
  assert.equal(types.args[0].type, 'float');
  assert.equal(types.args[1].type, 'float');
});

test('942: uninitialized entry GP register reaching RET only through mixed PHI is not an argument', () => {
  const entryX0 = { id: 0, vid: 1, kind: VK.ARG, reg: 'x0', bits: 64, def: null, uses: [] };
  const const1 = { id: 1, vid: 2, kind: VK.CONST, reg: null, bits: 64, const: 1n, def: null, uses: [] };
  const phiX0 = { id: 2, vid: 3, kind: VK.DEF, reg: 'x0', bits: 64, def: null, uses: [] };

  const i0 = { id: 0, row: 0, block: 0, op: OP.CONST, sub: null, dst: const1, args: [] };
  const i1 = { id: 1, row: 1, block: 1, op: OP.PHI, sub: null, dst: phiX0, args: [{ value: entryX0, bits: 64 }, { value: const1, bits: 64 }] };
  const i2 = { id: 2, row: 2, block: 1, op: OP.RET, sub: null, dst: null, args: [{ value: phiX0, bits: 64 }] };

  const1.def = i0;
  phiX0.def = i1;
  entryX0.uses.push(i1);
  const1.uses.push(i1);
  phiX0.uses.push(i2);

  const ir = {
    values: [entryX0, const1, phiX0],
    args: new Map([['x0', entryX0]]),
    instructions: [i0, i1, i2],
    blocks: [
      { index: 0, startRow: 0, endRow: 0, pred: [], succ: [1], insts: [i0], phis: [] },
      { index: 1, startRow: 1, endRow: 2, pred: [0], succ: [], insts: [i1, i2], phis: [i1] },
    ],
  };

  const types = inferSemanticTypes(ir, { abi: 'aapcs64', arch: 'arm64' });
  assert.equal(types.args.length, 0, 'uninitialized entry x0 via mixed PHI to RET must not be recovered as an argument');
});
