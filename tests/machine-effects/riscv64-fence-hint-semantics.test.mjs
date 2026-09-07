import assert from 'node:assert/strict';

import { createRiscv64DecodedInstruction } from '../../js/targets/architecture/riscv64/decoded-instruction.js';
import { liftRiscv64MachineEffects } from '../../js/targets/architecture/riscv64/effects/index.js';
import { decodeRiscv64InstructionWord } from '../../js/targets/architecture/riscv64/instruction-word.js';

function bytes32(word) {
  const value = Number(word) >>> 0;
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
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

function assertArchitecturalHint(word, hintKind, instructionId) {
  const fields = decodeRiscv64InstructionWord(bytes32(word));
  assert.equal(fields.supported, true, instructionId);
  assert.equal(fields.op, 'hint', instructionId);
  assert.equal(fields.architecturalNoOp, true, instructionId);
  assert.equal(fields.hint, true, instructionId);
  assert.equal(fields.hintKind, hintKind, instructionId);
  assert.equal(fields.compressed, false, instructionId);
  assert.equal(fields.expandedFrom, undefined, `${instructionId}: base HINT must not claim compressed provenance`);

  const effects = liftRiscv64MachineEffects(decoded(word, instructionId));
  assert.ok(effects, `${instructionId}: MachineEffects owner required`);
  assert.equal(effects.completeness, 'exact', instructionId);
  assert.equal(effects.controlEffect?.kind, 'fallthrough', instructionId);
  assert.deepEqual(effects.operations, [], `${instructionId}: HINT must not manufacture a barrier or state mutation`);
  assert.deepEqual(effects.statePreservation, {
    proven: true,
    reason: 'riscv64-base-architectural-hint',
  });
  assert.equal(effects.metadata.family, 'hint', instructionId);
  assert.equal(effects.metadata.instructionFamily, 'hint', instructionId);
  assert.equal(effects.metadata.compressed, false, instructionId);
  assert.equal(effects.metadata.compressedEncoding, undefined, instructionId);
}

// Zihintpause: FENCE pred=W, succ=0, fm=0, rd=x0, rs1=x0.
assertArchitecturalHint(0x0100000f, 'pause', 'rv64-pause');
// Base RV64I FENCE HINT table: argument-bearing rd/rs1 forms remain HINTs when
// fm=0 and either the predecessor or successor set is empty.
assertArchitecturalHint(0x0010008f, 'fence', 'rv64-fence-hint-rd');
assertArchitecturalHint(0x0010800f, 'fence', 'rv64-fence-hint-rs1');

for (const [name, word, expectedMode] of [
  ['ordinary-fence-rw-rw', 0x0330000f, 'normal'],
  ['fence-tso', 0x8330000f, 'tso'],
]) {
  const instruction = decoded(word, name);
  assert.equal(instruction.fields.supported, true, name);
  assert.equal(instruction.fields.op, 'fence', name);
  const effects = liftRiscv64MachineEffects(instruction);
  assert.equal(effects.completeness, 'exact', name);
  const barrier = effects.operations.find((operation) => operation.kind === 'barrier');
  assert.ok(barrier, `${name}: ordering barrier must be preserved`);
  assert.equal(barrier.scope?.fenceMode, expectedMode, name);
}

for (const [name, word, reason] of [
  ['both-register-fields-nonzero', 0x0010808f, 'riscv64-reserved-fence-registers'],
  ['reserved-fence-mode', 0x1000000f, 'riscv64-reserved-fence-mode'],
]) {
  const fields = decodeRiscv64InstructionWord(bytes32(word));
  assert.equal(fields.supported, false, name);
  assert.equal(fields.reason, reason, name);
}
