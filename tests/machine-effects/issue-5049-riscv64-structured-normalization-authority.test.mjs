import assert from 'node:assert/strict';

import { createRiscv64DecodedInstruction } from '../../js/targets/architecture/riscv64/decoded-instruction.js';
import { normalizeRiscv64Instruction } from '../../js/targets/architecture/riscv64/effects/common.js';
import { liftRiscv64ControlEffects } from '../../js/targets/architecture/riscv64/effects/control.js';
import { liftRiscv64IntegerEffects } from '../../js/targets/architecture/riscv64/effects/integer.js';
import { liftRiscv64MemoryEffects } from '../../js/targets/architecture/riscv64/effects/memory.js';

const origin = Object.freeze({ instructionIds: ['issue-5049:0'] });

const forgedWithoutBytes = {
  contractVersion: 'riscv64-decoded-instruction/v1',
  instructionId: 'issue-5049:forged-no-bytes',
  origin,
  mode: 'rv64imc',
  fields: {
    supported: true,
    compressed: false,
    op: 'addi',
    rd: 'x1',
    rs1: 'x0',
    imm: 123n,
  },
};
assert.throws(
  () => normalizeRiscv64Instruction(forgedWithoutBytes),
  /riscv64-decoded-instruction-invalid-address/,
  'contractVersion/instructionId/origin must not bypass canonical construction',
);
assert.throws(
  () => liftRiscv64IntegerEffects(forgedWithoutBytes),
  /riscv64-decoded-instruction-invalid-address/,
  'forged fields without authoritative bytes must not become exact integer effects',
);

const nopBytesWithForgedFields = {
  contractVersion: 'riscv64-decoded-instruction/v1',
  instructionId: 'issue-5049:nop-forged-addi',
  origin,
  mode: 'rv64imc',
  address: 0x1000n,
  size: 4,
  rawBytes: new Uint8Array([0x13, 0x00, 0x00, 0x00]), // addi x0,x0,0
  fields: {
    supported: true,
    compressed: false,
    op: 'addi',
    rd: 'x5',
    rs1: 'x7',
    imm: 999n,
  },
};
const normalizedNop = normalizeRiscv64Instruction(nopBytesWithForgedFields);
assert.equal(normalizedNop.fields.op, 'addi');
assert.equal(normalizedNop.fields.rd, 'x0');
assert.equal(normalizedNop.fields.rs1, 'x0');
assert.equal(normalizedNop.fields.imm, 0n);
assert.equal(
  liftRiscv64IntegerEffects(nopBytesWithForgedFields).operations.some((operation) => operation.kind === 'register-write'),
  false,
  'forged rd/rs1/imm must not override the raw NOP-equivalent encoding',
);

const forgedMemory = {
  ...nopBytesWithForgedFields,
  instructionId: 'issue-5049:nop-forged-store',
  fields: {
    supported: true,
    compressed: false,
    op: 'sd',
    kind: 'store',
    rs1: 'x1',
    rs2: 'x2',
    imm: 64n,
    memoryWidthBits: 64,
  },
};
assert.equal(
  liftRiscv64MemoryEffects(forgedMemory),
  null,
  'NOP bytes with forged store metadata must not produce an exact memory-write',
);

const forgedBranch = {
  ...nopBytesWithForgedFields,
  instructionId: 'issue-5049:nop-forged-branch',
  fields: {
    supported: true,
    compressed: false,
    op: 'beq',
    rs1: 'x1',
    rs2: 'x2',
    imm: 0x400n,
  },
};
assert.equal(
  liftRiscv64ControlEffects(forgedBranch),
  null,
  'NOP bytes with forged branch metadata must not produce an exact CFG target',
);

const unsupportedBytesWithForgedFields = {
  ...nopBytesWithForgedFields,
  instructionId: 'issue-5049:unsupported-forged-supported',
  rawBytes: new Uint8Array([0x53, 0x00, 0x00, 0x00]), // unsupported FP opcode in the frozen RV64IMC profile
  fields: {
    supported: true,
    compressed: false,
    op: 'addi',
    rd: 'x1',
    rs1: 'x0',
    imm: 1n,
  },
};
const normalizedUnsupported = normalizeRiscv64Instruction(unsupportedBytesWithForgedFields);
assert.equal(normalizedUnsupported.fields.supported, false);
assert.equal(liftRiscv64IntegerEffects(unsupportedBytesWithForgedFields), null);

const canonical = createRiscv64DecodedInstruction({
  address: 0x2000n,
  size: 4,
  rawBytes: new Uint8Array([0x93, 0x00, 0xb0, 0x07]), // addi x1,x0,123
  mode: 'rv64imc',
  instructionId: 'issue-5049:canonical',
  origin: { instructionIds: ['issue-5049:canonical'] },
});
const renormalized = normalizeRiscv64Instruction(canonical);
assert.equal(renormalized.fields.supported, true);
assert.equal(renormalized.fields.op, 'addi');
assert.equal(renormalized.fields.rd, 'x1');
assert.equal(renormalized.fields.rs1, 'x0');
assert.equal(renormalized.fields.imm, 123n);
const canonicalEffects = liftRiscv64IntegerEffects(canonical);
assert.equal(canonicalEffects.completeness, 'exact');
assert.equal(
  canonicalEffects.operations.some((operation) => operation.kind === 'register-write'),
  true,
  'valid constructor output must retain its existing exact effects',
);

console.log('issue-5049-riscv64-structured-normalization-authority: PASS');
