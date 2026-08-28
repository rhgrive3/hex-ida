import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

function record(mnemonic, operands) {
  const instructionId = `arm64-ccmp-immediate-modifier:${mnemonic}:${operands}`;
  return {
    instructionId,
    mnemonic,
    operands,
    opStr: operands,
    ops: parseOperands(operands),
    mode: 'a64',
    origin: { instructionIds: [instructionId] },
  };
}

for (const [mnemonic, operands] of [
  ['ccmp', 'x0, #0, #0, eq'],
  ['ccmp', 'x0, #31, #15, ne'],
  ['ccmn', 'w0, #0, #0, eq'],
  ['ccmn', 'w0, #31, #15, ne'],
]) {
  const effects = liftArm64MachineEffects(record(mnemonic, operands));
  assert.ok(effects);
  assert.equal(effects.completeness, 'exact', `${mnemonic}:${operands}:${effects.unknownEffects?.reason}`);
  assert.equal(effects.operations.filter((operation) => operation.kind === 'flag-write').length, 4);
}

const invalid = [
  ['ccmp', 'x0, #1, #0, eq', 1, { extend: { op: 'uxtb', amount: 0 } }],
  ['ccmn', 'w0, #1, #0, eq', 1, { extend: { op: 'sxtw', amount: 0 } }],
  ['ccmp', 'x0, #1, #0, eq', 2, { shift: { op: 'lsl', amount: 1 } }],
  ['ccmp', 'x0, #31, #15, ne', 2, { extend: { op: 'uxtb', amount: 0 } }],
  ['ccmn', 'w0, #1, #0, eq', 2, { shift: { op: 'lsr', amount: 1 } }],
  ['ccmn', 'w0, #31, #15, ne', 2, { extend: { op: 'sxtw', amount: 0 } }],
];

for (const [mnemonic, operands, index, modifier] of invalid) {
  const input = record(mnemonic, operands);
  input.ops[index] = { ...input.ops[index], ...modifier };
  const effects = liftArm64MachineEffects(input);
  assert.ok(effects);
  assert.equal(effects.completeness, 'partial', `${mnemonic}: modifier-bearing immediate must fail closed`);
  assert.equal(effects.operations.length, 0, `${mnemonic}: invalid immediate evidence must emit no definite operations`);
  assert.equal(effects.operations.some((operation) => operation.kind === 'flag-write'), false);
}

console.log('ARM64 conditional compare immediate modifiers: PASS');
