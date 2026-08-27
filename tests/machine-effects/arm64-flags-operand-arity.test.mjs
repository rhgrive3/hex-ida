import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

function lift(mnemonic, operands) {
  const instructionId = `arm64-flags-arity:${mnemonic}:${operands}`;
  return liftArm64MachineEffects({
    instructionId,
    mnemonic,
    operands,
    opStr: operands,
    ops: parseOperands(operands),
    mode: 'a64',
    origin: { instructionIds: [instructionId] },
  });
}

const valid = [
  ['cmp', 'x0, x1'],
  ['cmn', 'x0, #4095'],
  ['tst', 'x0, x1'],
  ['ccmp', 'x0, x1, #15, nv'],
  ['ccmn', 'w0, #31, #0, eq'],
];

for (const [mnemonic, operands] of valid) {
  const effects = lift(mnemonic, operands);
  assert.ok(effects, `${mnemonic}: valid form escaped ownership`);
  assert.equal(effects.completeness, 'exact', `${mnemonic}:${effects.unknownEffects?.reason}`);
  assert.equal(effects.metadata.family, 'flags', mnemonic);
  assert.equal(effects.operations.filter((operation) => operation.kind === 'flag-write').length, 4, `${mnemonic}: NZCV write set`);
}

// Arity rejection must happen before any NZCV write is emitted. TST's
// register-only structured owner can reject a missing RHS even earlier than
// the flags owner; preserve that more-specific fail-closed reason.
const invalid = [
  ['cmp', 'x0', 'arm64-cmp-operand-shape-unencodable'],
  ['cmp', 'x0, x1, x2', 'arm64-cmp-operand-shape-unencodable'],
  ['cmn', 'x0', 'arm64-cmn-operand-shape-unencodable'],
  ['cmn', 'x0, x1, x2', 'arm64-cmn-operand-shape-unencodable'],
  ['tst', 'x0', 'arm64-tst-rhs-register-required'],
  ['tst', 'x0, x1, x2', 'arm64-tst-operand-shape-unencodable'],
  ['ccmp', 'x0, x1, #0', 'arm64-ccmp-operand-shape-unencodable'],
  ['ccmp', 'x0, x1, #0, eq, x2', 'arm64-ccmp-operand-shape-unencodable'],
  ['ccmn', 'x0, x1, #0', 'arm64-ccmn-operand-shape-unencodable'],
  ['ccmn', 'x0, x1, #0, eq, x2', 'arm64-ccmn-operand-shape-unencodable'],
];

for (const [mnemonic, operands, expectedReason] of invalid) {
  const effects = lift(mnemonic, operands);
  assert.ok(effects, `${mnemonic}: invalid structured form must fail closed`);
  assert.equal(effects.completeness, 'partial', `${mnemonic}:${operands}`);
  assert.equal(effects.unknownEffects?.reason, expectedReason, `${mnemonic}:${operands}`);
  assert.equal(effects.operations.some((operation) => operation.kind === 'flag-write'), false, `${mnemonic}: invalid shape must not write NZCV`);
}

const invalidFallback = lift('ccmp', 'x0, x1, #16, eq');
assert.equal(invalidFallback.completeness, 'partial');
assert.equal(invalidFallback.operations.some((operation) => operation.kind === 'flag-write'), false);

console.log('ARM64 flags operand arity: PASS');
