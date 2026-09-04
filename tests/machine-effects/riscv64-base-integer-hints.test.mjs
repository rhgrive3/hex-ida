import assert from 'node:assert/strict';

import { createRiscv64DecodedInstruction } from '../../js/targets/architecture/riscv64/decoded-instruction.js';
import { liftRiscv64MachineEffects } from '../../js/targets/architecture/riscv64/effects/index.js';
import { decodeRiscv64InstructionWord } from '../../js/targets/architecture/riscv64/instruction-word.js';

function bytes32(word) {
  const value = Number(word) >>> 0;
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function encodeI(opcode, funct3, rs1, immediate, rd = 0) {
  return (((immediate & 0xfff) << 20)
    | ((rs1 & 0x1f) << 15)
    | ((funct3 & 0x7) << 12)
    | ((rd & 0x1f) << 7)
    | opcode) >>> 0;
}

function encodeR(opcode, funct3, funct7, rs1 = 1, rs2 = 2, rd = 0) {
  return (((funct7 & 0x7f) << 25)
    | ((rs2 & 0x1f) << 20)
    | ((rs1 & 0x1f) << 15)
    | ((funct3 & 0x7) << 12)
    | ((rd & 0x1f) << 7)
    | opcode) >>> 0;
}

function encodeU(opcode, immediate = 0x12345, rd = 0) {
  return (((immediate & 0xfffff) << 12) | ((rd & 0x1f) << 7) | opcode) >>> 0;
}

function encodeShiftImmediate(funct3, shamt, arithmetic = false, rs1 = 1, rd = 0) {
  return (((arithmetic ? 0x10 : 0) << 26)
    | ((shamt & 0x3f) << 20)
    | ((rs1 & 0x1f) << 15)
    | ((funct3 & 0x7) << 12)
    | ((rd & 0x1f) << 7)
    | 0x13) >>> 0;
}

function encodeShiftImmediate32(funct3, shamt, funct7 = 0, rs1 = 1, rd = 0) {
  return encodeR(0x1b, funct3, funct7, rs1, shamt & 0x1f, rd);
}

function decoded(word, instructionId) {
  return createRiscv64DecodedInstruction({
    address: 0x1000n,
    size: 4,
    rawBytes: bytes32(word),
    mode: 'rv64imc',
    instructionId,
    origin: { instructionIds: [instructionId] },
  });
}

const HINT_FAMILIES = Object.freeze([
  ['lui', encodeU(0x37)],
  ['auipc', encodeU(0x17)],
  ['addi', encodeI(0x13, 0, 1, 1)],
  ['slti', encodeI(0x13, 2, 1, 1)],
  ['sltiu', encodeI(0x13, 3, 1, 1)],
  ['xori', encodeI(0x13, 4, 1, 1)],
  ['ori', encodeI(0x13, 6, 1, 1)],
  ['andi', encodeI(0x13, 7, 1, 1)],
  ['slli', encodeShiftImmediate(1, 3)],
  ['srli', encodeShiftImmediate(5, 3)],
  ['srai', encodeShiftImmediate(5, 3, true)],
  ['addiw', encodeI(0x1b, 0, 1, 1)],
  ['slliw', encodeShiftImmediate32(1, 3)],
  ['srliw', encodeShiftImmediate32(5, 3)],
  ['sraiw', encodeShiftImmediate32(5, 3, 0x20)],
  ...[[0, 'add'], [1, 'sll'], [2, 'slt'], [3, 'sltu'], [4, 'xor'], [5, 'srl'], [6, 'or'], [7, 'and']]
    .map(([funct3, op]) => [op, encodeR(0x33, funct3, 0)]),
  ['sub', encodeR(0x33, 0, 0x20)],
  ['sra', encodeR(0x33, 5, 0x20)],
  ['addw', encodeR(0x3b, 0, 0)],
  ['sllw', encodeR(0x3b, 1, 0)],
  ['srlw', encodeR(0x3b, 5, 0)],
  ['subw', encodeR(0x3b, 0, 0x20)],
  ['sraw', encodeR(0x3b, 5, 0x20)],
]);

assert.equal(HINT_FAMILIES.length, 30, 'RV64I base integer HINT family denominator drift');

for (const [underlyingOp, word] of HINT_FAMILIES) {
  const instructionId = `rv64i-base-hint-${underlyingOp}`;
  const fields = decodeRiscv64InstructionWord(bytes32(word));
  assert.equal(fields.supported, true, instructionId);
  assert.equal(fields.op, 'hint', instructionId);
  assert.equal(fields.architecturalNoOp, true, instructionId);
  assert.equal(fields.hint, true, instructionId);
  assert.equal(fields.hintKind, 'integer', instructionId);
  assert.equal(fields.underlyingOp, underlyingOp, instructionId);
  assert.equal(fields.compressed, false, instructionId);
  assert.equal(fields.expandedFrom, undefined, `${instructionId}: base HINT must not claim compressed provenance`);

  const effects = liftRiscv64MachineEffects(decoded(word, instructionId));
  assert.ok(effects, `${instructionId}: MachineEffects owner required`);
  assert.equal(effects.completeness, 'exact', instructionId);
  assert.equal(effects.controlEffect?.kind, 'fallthrough', instructionId);
  assert.deepEqual(effects.operations, [], `${instructionId}: HINT must not manufacture register dependencies or mutations`);
  assert.deepEqual(effects.statePreservation, {
    proven: true,
    reason: 'riscv64-base-architectural-hint',
  }, instructionId);
  assert.equal(effects.metadata.family, 'hint', instructionId);
  assert.equal(effects.metadata.instructionFamily, 'hint', instructionId);
}

// Minimal issue reproducer: ADDI x0,x1,1 is a HINT and must not publish an x1 dependency.
assert.equal(decodeRiscv64InstructionWord(bytes32(0x00108013)).underlyingOp, 'addi');

// Standard HINT suballocations remain in the same state-preserving family.
for (const [name, word, underlyingOp] of [
  ['semihosting-entry', encodeShiftImmediate(1, 31, false, 0), 'slli'],
  ['semihosting-exit', encodeShiftImmediate(5, 7, true, 0), 'srai'],
  ['ntl-p1', encodeR(0x33, 0, 0, 0, 2, 0), 'add'],
]) {
  const fields = decodeRiscv64InstructionWord(bytes32(word));
  assert.equal(fields.op, 'hint', name);
  assert.equal(fields.underlyingOp, underlyingOp, name);
}

// Boundaries: canonical NOP is not part of the HINT table row, ordinary rd!=x0
// computation remains integer semantics, and M-extension writes to x0 are not
// reclassified as base-I HINTs.
for (const [name, word, expectedOp] of [
  ['canonical-nop', 0x00000013, 'addi'],
  ['ordinary-addi', encodeI(0x13, 0, 1, 1, 2), 'addi'],
  ['mul-x0', encodeR(0x33, 0, 0x01), 'mul'],
]) {
  const fields = decodeRiscv64InstructionWord(bytes32(word));
  assert.equal(fields.supported, true, name);
  assert.equal(fields.op, expectedOp, name);
  assert.equal(fields.architecturalNoOp, undefined, name);
}

// Illegal shift encodings still fail closed before HINT classification.
const reservedSlli = (0x04000013 | (1 << 15)) >>> 0;
const reservedFields = decodeRiscv64InstructionWord(bytes32(reservedSlli));
assert.equal(reservedFields.supported, false);
assert.equal(reservedFields.reason, 'riscv64-reserved-slli-encoding');
