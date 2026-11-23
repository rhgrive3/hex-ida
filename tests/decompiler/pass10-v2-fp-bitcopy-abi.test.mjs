import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR, setSemanticMigrationMode, OP } from '../../js/ir.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { inferSemanticTypes } from '../../js/decompiler/type-recovery.js';

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
    return { ir: buildIR(model, { rowOfAddress, ...extraOpts }), model };
  } finally {
    setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
  }
}

test('arm64.fp.bitcopy lowers constant FP immediate fmov s0, #0.5 and fmov d0, #1.5 to OP.CONST float', () => {
  const { ir } = buildV2Ir([
    'fmov s0, #0.5',
    'fmov d1, #1.5',
    'ret',
  ]);
  assert.equal(ir.instructions.some((i) => i.op === OP.CLOBBER), false, 'fmov immediates must not fall through to CLOBBER');

  const row0FloatConst = ir.instructions.find((i) => i.row === 0 && i.op === OP.CONST && i.extra?.constKind === 'float');
  assert.ok(row0FloatConst, 'fmov s0, #0.5 must project to OP.CONST float');
  assert.equal(row0FloatConst.extra.float, 0.5);
  assert.equal(row0FloatConst.dst?.float, 0.5);
  assert.equal(row0FloatConst.dst?.constKind, 'float');
  assert.equal(row0FloatConst.bits, 32);

  const row1FloatConst = ir.instructions.find((i) => i.row === 1 && i.op === OP.CONST && i.extra?.constKind === 'float');
  assert.ok(row1FloatConst, 'fmov d1, #1.5 must project to OP.CONST float');
  assert.equal(row1FloatConst.extra.float, 1.5);
  assert.equal(row1FloatConst.dst?.float, 1.5);
  assert.equal(row1FloatConst.dst?.constKind, 'float');
  assert.equal(row1FloatConst.bits, 64);
});

test('arm64.fp.bitcopy lowers FP<->FP fmov d8, d0 and fmov s2, s1 to OP.MOV sub="fmov" with float=true', () => {
  const { ir } = buildV2Ir([
    'fmov d8, d0',
    'fmov s2, s1',
    'ret',
  ]);
  assert.equal(ir.instructions.some((i) => i.op === OP.CLOBBER), false, 'FP<->FP fmov must not fall through to CLOBBER');

  const d8Copy = ir.instructions.find((i) => i.row === 0 && i.op === OP.MOV && i.sub === 'fmov');
  assert.ok(d8Copy, 'fmov d8, d0 must project to OP.MOV sub="fmov"');
  assert.equal(d8Copy.extra?.float, true);
  assert.equal(d8Copy.extra?.bitcopy, undefined);
  assert.equal(d8Copy.bits, 64);

  const s2Copy = ir.instructions.find((i) => i.row === 1 && i.op === OP.MOV && i.sub === 'fmov');
  assert.ok(s2Copy, 'fmov s2, s1 must project to OP.MOV sub="fmov"');
  assert.equal(s2Copy.extra?.float, true);
  assert.equal(s2Copy.extra?.bitcopy, undefined);
  assert.equal(s2Copy.bits, 32);
});

test('arm64.fp.bitcopy lowers GP<->FP fmov s1, w0 (dynamic -> bitcopy MOV; constant 0x42c80000 -> OP.CONST 100.0f)', () => {
  const { ir } = buildV2Ir([
    'fmov s1, w0',
    'fmov w2, s1',
    'ret',
  ]);
  assert.equal(ir.instructions.some((i) => i.op === OP.CLOBBER), false, 'GP<->FP fmov must not fall through to CLOBBER');

  const gpToFp = ir.instructions.find((i) => i.row === 0 && i.op === OP.MOV && i.sub === 'fmov');
  assert.ok(gpToFp, 'dynamic fmov s1, w0 must project to OP.MOV sub="fmov"');
  assert.equal(gpToFp.extra?.float, true);
  assert.equal(gpToFp.extra?.bitcopy, true);
  assert.equal(gpToFp.bits, 32);

  const fpToGp = ir.instructions.find((i) => i.row === 1 && i.op === OP.MOV && i.sub === 'fmov');
  assert.ok(fpToGp, 'dynamic fmov w2, s1 must project to OP.MOV sub="fmov"');
  assert.equal(fpToGp.extra?.float, true);
  assert.equal(fpToGp.extra?.bitcopy, true);

  // Synthetic v2 IR where GP constant 0x42c80000 (100.0f) feeds arm64.fp.bitcopy into FP dst
  const origin = (id, addr) => ({ instructionIds: [id], virtualRanges: [{ start: addr, end: addr + 4n }] });
  const bit32 = { kind: 'bitvector', widthBits: 32 };
  const v2Ir = {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: 'fn_bitcopy_const_100f',
    entryBlockId: 'b0',
    blocks: [{ id: 'b0', nodeIds: ['n_c', 'n_bc', 'n_ret'], origin: origin('b0', 0x1000n) }],
    values: [
      { id: 'v_c', kind: 'definition', machineType: bit32, definitionNodeId: 'n_c', sourceEntityId: 'n_c', origin: origin('i0', 0x1000n) },
      { id: 'v_out', kind: 'definition', machineType: bit32, definitionNodeId: 'n_bc', sourceEntityId: 'n_bc', origin: origin('i1', 0x1004n) },
    ],
    nodes: [
      { id: 'n_c', kind: 'const', blockId: 'b0', inputs: [], outputs: ['v_c'], attributes: { value: 0x42c80000n }, completeness: 'complete', origin: origin('i0', 0x1000n) },
      {
        id: 'n_bc', kind: 'intrinsic', operator: 'arm64.fp.bitcopy', blockId: 'b0',
        inputs: ['v_c'], outputs: ['v_out'],
        attributes: { machineEffects: { operationMetadata: { dstClass: 'fp' } } },
        intrinsic: {
          inputs: ['v_c'], outputs: ['v_out'], determinism: 'deterministic', symbolicDetail: 'summary-only', stateReads: [], stateWrites: [],
          memoryRead: { scope: 'none' }, memoryWrite: { scope: 'none' }, controlEffects: [],
        },
        completeness: 'complete', origin: origin('i1', 0x1004n),
      },
      { id: 'n_ret', kind: 'return', blockId: 'b0', inputs: [], outputs: [], completeness: 'complete', origin: origin('i2', 0x1008n) },
    ],
    completeness: 'complete',
    unknowns: [],
    origin: origin('fn', 0x1000n),
  };
  const projected = projectSemanticIrV2ToLegacyV1(v2Ir, { architectureId: 'arm64' });
  const decoded = projected.instructions.find((i) => i.semanticNodeId === 'n_bc');
  assert.ok(decoded);
  assert.equal(decoded.op, OP.CONST);
  assert.equal(decoded.extra?.float, 100);
  assert.equal(decoded.extra?.constKind, 'float');
  assert.equal(decoded.dst?.float, 100);
  assert.equal(decoded.dst?.constKind, 'float');
});

test('projectSemanticIrV2ToLegacyV1 stamps arch, architectureId, and compat.architectureId', () => {
  const { ir } = buildV2Ir([
    'fadd d0, d0, d1',
    'ret',
  ]);
  assert.equal(ir.arch, 'arm64');
  assert.equal(ir.architectureId, 'arm64');
  assert.equal(ir.compat?.architectureId, 'arm64');
});

test('scalar FP ldr/str (sN/dN) sets inst.extra.float = true while GP ldr/str does not', () => {
  const { ir } = buildV2Ir([
    'ldr s0, [x0]',
    'str s0, [x1]',
    'ldr d2, [x0, #8]',
    'str d2, [x1, #8]',
    'ldr w3, [x0, #16]',
    'str w3, [x1, #16]',
    'ldr x4, [x0, #24]',
    'str x4, [x1, #24]',
    'ret',
  ]);
  const loadAt = (row) => ir.instructions.find((i) => i.row === row && i.op === OP.LOAD);
  const storeAt = (row) => ir.instructions.find((i) => i.row === row && i.op === OP.STORE);

  assert.equal(loadAt(0)?.extra?.float, true, 'ldr s0 must tag extra.float = true');
  assert.equal(storeAt(1)?.extra?.float, true, 'str s0 must tag extra.float = true');
  assert.equal(loadAt(2)?.extra?.float, true, 'ldr d2 must tag extra.float = true');
  assert.equal(storeAt(3)?.extra?.float, true, 'str d2 must tag extra.float = true');

  assert.equal(loadAt(4)?.extra?.float, undefined, 'ldr w3 must not tag extra.float');
  assert.equal(storeAt(5)?.extra?.float, undefined, 'str w3 must not tag extra.float');
  assert.equal(loadAt(6)?.extra?.float, undefined, 'ldr x4 must not tag extra.float');
  assert.equal(storeAt(7)?.extra?.float, undefined, 'str x4 must not tag extra.float');
});

test('type-recovery propagates floating evidence across scalar FP load/store and fmov', () => {
  // 1. Scalar float load returned directly -> return type float
  const loadRet = buildV2Ir([
    'ldr s0, [x0]',
    'ret',
  ]);
  const loadRetTypes = inferSemanticTypes(loadRet.ir, loadRet.model);
  assert.equal(loadRetTypes.ret.type, 'float', 'ldr s0; ret must recover float return type');

  // 2. Scalar double fmov copy -> d0 arg and double return type
  const fmovCopy = buildV2Ir([
    'fmov d8, d0',
    'fmov d0, d8',
    'ret',
  ]);
  const fmovCopyTypes = inferSemanticTypes(fmovCopy.ir, fmovCopy.model);
  assert.equal(fmovCopyTypes.ret.type, 'double', 'fmov d8, d0; fmov d0, d8; ret must recover double return');

  // 3. Scalar float store of incoming s0 -> s0/v0 arg typed as float
  const storeArg = buildV2Ir([
    'str s0, [x0]',
    'ret',
  ]);
  const storeArgTypes = inferSemanticTypes(storeArg.ir, storeArg.model);
  const fpArg = storeArgTypes.args.find((a) => /^[sdv]0$/.test(a.reg));
  assert.ok(fpArg, 'str s0, [x0] must recover incoming FP argument');
  assert.equal(fpArg.type, 'float', 'str s0, [x0] must type incoming FP argument as float');
});
