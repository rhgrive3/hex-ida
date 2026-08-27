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

// Arity rejection must happen before any NZCV write is emitted.
const invalid = [
  ['cmp', 'x0'],
  ['cmp', 'x0, x1, x2'],
  ['cmn', 'x0'],
  ['cmn', 'x0, x1, x2'],
  ['tst', 'x0'],
  ['tst', 'x0, x1, x2'],
  ['ccmp', 'x0, x1, #0'],
  ['ccmp', 'x0, x1, #0, eq, x2'],
  ['ccmn', 'x0, x1, #0'],
  ['ccmn', 'x0, x1, #0, eq, x2'],
];

for (const [mnemonic, operands] of invalid) {
  const effects = lift(mnemonic, operands);
  assert.ok(effects, `${mnemonic}: invalid structured form must fail closed`);
  assert.equal(effects.completeness, 'partial', `${mnemonic}:${operands}`);
  assert.equal(effects.unknownEffects?.reason, `arm64-${mnemonic}-operand-shape-unencodable`, `${mnemonic}:${operands}`);
  assert.equal(effects.operations.some((operation) => operation.kind === 'flag-write'), false, `${mnemonic}: invalid shape must not write NZCV`);
}

const invalidFallback = lift('ccmp', 'x0, x1, #16, eq');
assert.equal(invalidFallback.completeness, 'partial');
assert.equal(invalidFallback.operations.some((operation) => operation.kind === 'flag-write'), false);

console.log('ARM64 flags operand arity: PASS');
