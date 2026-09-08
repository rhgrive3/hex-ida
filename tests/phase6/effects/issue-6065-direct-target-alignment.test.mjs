import test from 'node:test';
import assert from 'node:assert/strict';
import { liftRiscv64ControlEffects } from '../../../js/targets/architecture/riscv64/effects/control.js';

function regNumber(name) { return Number(String(name).replace(/^x/, '')); }
function littleEndianWord(word) {
  return Uint8Array.from([word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff]);
}
function encodeJal(rd, immediate) {
  const imm = Number(BigInt.asUintN(21, BigInt(immediate)));
  const word = (((imm >>> 20) & 1) << 31)
    | (((imm >>> 1) & 0x3ff) << 21)
    | (((imm >>> 11) & 1) << 20)
    | (((imm >>> 12) & 0xff) << 12)
    | (regNumber(rd) << 7)
    | 0x6f;
  return littleEndianWord(word >>> 0);
}
function encodeBranch(op, rs1, rs2, immediate) {
  const funct3 = { beq: 0, bne: 1, blt: 4, bge: 5, bltu: 6, bgeu: 7 }[op];
  const imm = Number(BigInt.asUintN(13, BigInt(immediate)));
  const word = (((imm >>> 12) & 1) << 31)
    | (((imm >>> 5) & 0x3f) << 25)
    | (regNumber(rs2) << 20)
    | (regNumber(rs1) << 15)
    | (funct3 << 12)
    | (((imm >>> 1) & 0xf) << 8)
    | (((imm >>> 11) & 1) << 7)
    | 0x63;
  return littleEndianWord(word >>> 0);
}
function encodeJalr(rd, rs1, immediate) {
  const imm = Number(BigInt.asUintN(12, BigInt(immediate)));
  const word = (imm << 20) | (regNumber(rs1) << 15) | (regNumber(rd) << 7) | 0x67;
  return littleEndianWord(word >>> 0);
}

function rvControl(op, fields = {}, address = 0x1000n, instructionAlignment = 4) {
  const merged = { rd: 'x0', rs1: 'x10', rs2: 'x11', imm: 4, ...fields };
  const rawBytes = op === 'jal'
    ? encodeJal(merged.rd, merged.imm)
    : op === 'jalr'
      ? encodeJalr(merged.rd, merged.rs1, merged.imm)
      : encodeBranch(op, merged.rs1, merged.rs2, merged.imm);
  return {
    contractVersion: 'riscv64-decoded-instruction/v1', instructionId: `rv-${op}`, origin: { instructionIds: [`rv-${op}`] },
    mode: instructionAlignment === 2 ? 'rv64imc' : 'rv64im', address, size: 4, instructionAlignment, rawBytes,
    fields: { supported: true, op, compressed: false, ...merged },
  };
}

test('6065: aligned JAL target carries no fault under IALIGN=32', () => {
  const jal = liftRiscv64ControlEffects(rvControl('jal', { rd: 'x1', imm: 4 }), { instructionAlignment: 4 });
  assert.deepEqual(jal.possibleFaults, []);
});

test('6065: aligned taken branch target carries no fault under IALIGN=32', () => {
  const branch = liftRiscv64ControlEffects(
    rvControl('beq', { imm: 8 }, 0x2000n), { instructionAlignment: 4 });
  assert.deepEqual(branch.possibleFaults, []);
});

test('6065: 2-mod-4 JAL target keeps the fault candidate', () => {
  const jal = liftRiscv64ControlEffects(rvControl('jal', { rd: 'x1', imm: 6 }), { instructionAlignment: 4 });
  assert.equal(jal.possibleFaults.length, 1);
  assert.equal(jal.possibleFaults[0].kind, 'pc-alignment-fault');
});

test('6065: 2-mod-4 branch target keeps the fault candidate', () => {
  const branch = liftRiscv64ControlEffects(rvControl('beq', { imm: 2 }), { instructionAlignment: 4 });
  assert.equal(branch.possibleFaults.length, 1);
  const [fault] = branch.possibleFaults;
  assert.equal(fault.condition.kind, 'and');
  assert.equal(fault.condition.terms[0].kind, 'riscv64-branch-taken');
  assert.equal(fault.condition.terms[0].value.temporaryId, branch.controlEffect.condition.temporaryId);
  assert.equal(fault.condition.terms[1].kind, 'riscv64-target-misaligned');
  assert.equal(fault.detail.conditionalOn, 'branch-taken');
});

test('6065: jalr keeps its conditional fault (runtime target)', () => {
  const jalr = liftRiscv64ControlEffects(rvControl('jalr', { rd: 'x1', rs1: 'x10', imm: 0 }), { instructionAlignment: 4 });
  assert.equal(jalr.possibleFaults.length, 1);
  const [fault] = jalr.possibleFaults;
  const targetOperation = jalr.operations.find((operation) => operation.kind === 'value' && operation.opcode === 'and');
  assert.ok(targetOperation, 'JALR must materialize its runtime target');
  assert.equal(fault.condition.kind, 'riscv64-target-misaligned');
  assert.equal(fault.condition.target.temporaryId, targetOperation.outputs[0].temporaryId);
  assert.equal(fault.detail.targetSource, 'runtime-expression');
});

test('6065: IALIGN=16 behavior unchanged', () => {
  const jal = liftRiscv64ControlEffects(rvControl('jal', { imm: 2 }, 0x1000n, 2));
  assert.deepEqual(jal.possibleFaults, []);
});
