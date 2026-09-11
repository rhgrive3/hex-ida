import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { liftArm64IntegerEffects } from '../../js/targets/architecture/arm64/effects/integer.js';

let sequence = 0;
function lift(operands, lifter) {
  sequence += 1;
  const decoded = {
    instructionId: `arm64-mov-alias-${sequence}`,
    mnemonic: 'mov',
    mode: 'a64',
    ops: parseOperands(operands),
    origin: { instructionIds: [`arm64-mov-alias-${sequence}`] },
  };
  return lifter === 'integer' ? liftArm64IntegerEffects(decoded) : liftArm64MachineEffects(decoded);
}

function assertExact(operands, label, lifter) {
  const effect = lift(operands, lifter);
  assert.ok(effect, `${label}: effect required`);
  assert.equal(effect.completeness, 'exact', `${label}: encodable MOV alias must stay exact (${effect.unknownEffects?.reason})`);
}

function assertClosed(operands, label, lifter) {
  const effect = lift(operands, lifter);
  assert.ok(effect, `${label}: fail-closed effect required`);
  assert.equal(effect.completeness, 'partial', `${label}: unencodable MOV immediate must be partial`);
  assert.equal(effect.operations.length, 0, `${label}: unencodable MOV immediate emits zero definite operations`);
}

const exactCases = [
  ['movz-zero', 'x0, #0'],
  ['movz-lane', 'x0, #0x1234'],
  ['movz-shifted-lane', 'x0, #0x12340000'],
  ['movn-all-ones', 'x0, #-1'],
  ['gp-bitmask', 'x0, #0xff00ff00ff00ff00'],
  ['w-movz', 'w0, #0xabcd'],
  ['zr-destination', 'xzr, #0x1234'],
  ['sp-bitmask-64', 'sp, #0x00ff00ff00ff00ff'],
  ['sp-bitmask-32', 'wsp, #0x00ff00ff'],
];

const closedCases = [
  ['multi-wide-64', 'x0, #0x0000000200000001'],
  ['multi-wide-32', 'w0, #0x12345678'],
  ['sp-not-bitmask-64', 'sp, #0x0000000200000001'],
  ['sp-wide-only-lane', 'sp, #0x12340000'],
  ['sp-small-constant', 'sp, #0x1234'],
  ['sp-not-bitmask-32', 'wsp, #0x12345678'],
];

for (const [suffix, operands] of exactCases) {
  assertExact(operands, `${suffix} (top level)`);
  assertExact(operands, `${suffix} (integer family)`, 'integer');
}

for (const [suffix, operands] of closedCases) {
  assertClosed(operands, `${suffix} (top level)`);
  assertClosed(operands, `${suffix} (integer family)`, 'integer');
}

// Register-to-register forms keep their existing contract, including the
// SP/XZR exclusion for 31-encoded register positions.
assertExact('x0, x1', 'register form');
assertExact('sp, x0', 'SP from GP');
const spFromZr = lift('sp, xzr');
assert.equal(spFromZr.completeness, 'partial', 'SP from XZR is not an encodable MOV form');

console.log('ARM64 MOV immediate alias encoding validation: PASS');
