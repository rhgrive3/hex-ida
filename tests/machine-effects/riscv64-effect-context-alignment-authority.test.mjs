import assert from 'node:assert/strict';

import { createRiscv64DecodedInstruction } from '../../js/targets/architecture/riscv64/decoded-instruction.js';
import { createRiscv64EffectContext } from '../../js/targets/architecture/riscv64/effects/common.js';
import { liftRiscv64MachineEffects } from '../../js/targets/architecture/riscv64/effects/index.js';

const BRANCH_PLUS_TWO = Uint8Array.of(0x63, 0x01, 0x00, 0x00);

function branch(mode, instructionAlignment, id) {
  return createRiscv64DecodedInstruction({
    address: 0x1000n,
    size: 4,
    rawBytes: BRANCH_PLUS_TWO,
    mode,
    instructionAlignment,
    instructionId: id,
    origin: { instructionIds: [id] },
  });
}

const rv64imc = branch('rv64imc', 2, 'issue-3946-rv64imc');
const rv64imcContext = createRiscv64EffectContext(rv64imc);
assert.equal(rv64imcContext.instructionAlignment, 2);

const rv64imcEffects = liftRiscv64MachineEffects(rv64imc);
assert.ok(rv64imcEffects);
assert.equal(rv64imcEffects.metadata.instructionAlignment, 2);
assert.deepEqual(rv64imcEffects.possibleFaults, [], 'RV64IMC +2 branch target must not gain a false 4-byte alignment fault');

const rv64imcMatching = liftRiscv64MachineEffects(rv64imc, { instructionAlignment: 2 });
assert.deepEqual(rv64imcMatching, rv64imcEffects, 'matching explicit IALIGN must preserve canonical semantics');
for (const invalidAlignment of [4, 8, '2', [2]]) {
  assert.throws(
    () => liftRiscv64MachineEffects(rv64imc, { instructionAlignment: invalidAlignment }),
    /riscv64-effect-context-instruction-alignment-mismatch/,
    `RV64IMC context override ${JSON.stringify(invalidAlignment)} must fail closed`,
  );
}

const rv64im = branch('rv64im', 4, 'issue-3946-rv64im');
const rv64imEffects = liftRiscv64MachineEffects(rv64im);
assert.ok(rv64imEffects);
assert.equal(rv64imEffects.metadata.instructionAlignment, 4);
assert.equal(rv64imEffects.possibleFaults.length, 1, 'RV64IM +2 branch target must retain its 4-byte alignment fault candidate');
assert.equal(rv64imEffects.possibleFaults[0].kind, 'pc-alignment-fault');
assert.equal(rv64imEffects.possibleFaults[0].condition.kind, 'riscv64-target-misaligned');
assert.equal(rv64imEffects.possibleFaults[0].condition.alignmentBytes, 4);

const rv64imMatching = liftRiscv64MachineEffects(rv64im, { instructionAlignment: 4 });
assert.deepEqual(rv64imMatching, rv64imEffects, 'matching RV64IM IALIGN override must preserve canonical semantics');
for (const invalidAlignment of [2, 8, '4', [4]]) {
  assert.throws(
    () => liftRiscv64MachineEffects(rv64im, { instructionAlignment: invalidAlignment }),
    /riscv64-effect-context-instruction-alignment-mismatch/,
    `RV64IM context override ${JSON.stringify(invalidAlignment)} must fail closed`,
  );
}

console.log('RV64 effect-context instructionAlignment authority regression: PASS');
