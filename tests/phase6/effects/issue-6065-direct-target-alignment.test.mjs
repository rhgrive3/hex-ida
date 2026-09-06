import test from 'node:test';
import assert from 'node:assert/strict';
import { liftRiscv64ControlEffects } from '../../../js/targets/architecture/riscv64/effects/control.js';

function rvControl(op, fields = {}, address = 0x1000n, instructionAlignment = 4) {
  return {
    contractVersion: 'riscv64-decoded-instruction/v1', instructionId: `rv-${op}`, origin: { instructionIds: [`rv-${op}`] },
    mode: 'rv64im', address, size: 4, instructionAlignment,
    fields: { supported: true, op, compressed: false, rd: 'x0', rs1: 'x10', rs2: 'x11', imm: 4, ...fields },
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
});

test('6065: jalr keeps its conditional fault (runtime target)', () => {
  const jalr = liftRiscv64ControlEffects(rvControl('jalr', { rd: 'x1', rs1: 'x10', imm: 0 }), { instructionAlignment: 4 });
  assert.equal(jalr.possibleFaults.length, 1);
});

test('6065: IALIGN=16 behavior unchanged', () => {
  const jal = liftRiscv64ControlEffects(rvControl('jal', { imm: 2 }, 0x1000n, 2));
  assert.deepEqual(jal.possibleFaults, []);
});
