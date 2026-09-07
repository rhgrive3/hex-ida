import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

function instruction(mnemonic, operands) {
  const instructionId = `arm64-ccmp-condition-modifier:${mnemonic}:${operands}`;
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

function lift(record) {
  return liftArm64MachineEffects(record);
}

for (const [mnemonic, operands] of [
  ['ccmp', 'x0, x1, #0, eq'],
  ['ccmp', 'x0, x1, #15, nv'],
  ['ccmn', 'w0, w1, #0, ne'],
  ['ccmn', 'w0, w1, #15, eq'],
]) {
  const effects = lift(instruction(mnemonic, operands));
  assert.ok(effects, `${mnemonic}: valid form escaped ownership`);
  assert.equal(effects.completeness, 'exact', `${mnemonic}:${operands}:${effects.unknownEffects?.reason}`);
  assert.equal(effects.operations.filter((operation) => operation.kind === 'flag-write').length, 4, `${mnemonic}: valid form writes NZCV`);
}

const invalidCases = [
  ['ccmp', 'x0, x1, #0, eq', { shift: { op: 'lsl', amount: 1 } }],
  ['ccmp', 'x0, x1, #15, ne', { extend: { op: 'uxtb', amount: 0 } }],
  ['ccmn', 'w0, w1, #0, eq', { shift: { op: 'lsr', amount: 1 } }],
  ['ccmn', 'w0, w1, #15, ne', { extend: { op: 'sxtw', amount: 0 } }],
];

for (const [mnemonic, operands, modifier] of invalidCases) {
  const record = instruction(mnemonic, operands);
  assert.equal(record.ops.length, 4, `${mnemonic}: fixture arity`);
  assert.equal(record.ops[3]?.k, 'cond', `${mnemonic}: fixture condition kind`);
  record.ops[3] = { ...record.ops[3], ...modifier };

  const effects = lift(record);
  assert.ok(effects, `${mnemonic}: invalid form escaped ownership`);
  assert.equal(effects.completeness, 'partial', `${mnemonic}: modifier-bearing condition must fail closed`);
  assert.equal(effects.operations.length, 0, `${mnemonic}: invalid condition must not emit definite operations`);
  assert.equal(effects.operations.some((operation) => operation.kind === 'flag-write'), false, `${mnemonic}: invalid condition must not write NZCV`);
}

console.log('ARM64 conditional compare condition modifiers: PASS');
