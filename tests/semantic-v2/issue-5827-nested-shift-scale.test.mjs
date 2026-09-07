import assert from 'node:assert/strict';
import { lowerMachineEffectsToLegacyV1 } from '../../js/semantics/compat/index.js';
import { createMachineEffectBundle } from '../../js/semantics/effects/index.js';

// Issue #5827: nested shift-left in a MachineEffects address expression must
// compose shift exponents when projected onto the legacy v1 scaled index:
// (x << 2) << 3 == x << 5. The old projection overwrote the recursive scale
// with the outer amount, projecting scale:3 for an effective x1<<5 address.

const reg = (id) => ({ kind: 'register', registerId: id, widthBits: 64 });
const shl = (amount, value) => ({ kind: 'shift-left', amount, value });

function bundleWithAddress(addressExpr) {
  return createMachineEffectBundle({
    instructionId: 'i0',
    architectureId: 'arm64',
    mode: 'a64',
    operations: [{
      kind: 'memory-read',
      access: {
        space: 'memory',
        widthBits: 64,
        endian: 'little',
        addressExpr: {
          kind: 'add',
          left: reg('x0'),
          right: addressExpr,
        },
      },
      value: reg('x2'),
    }],
    controlEffect: { kind: 'fallthrough' },
    possibleFaults: [],
    origin: { instructionIds: ['i0'] },
    completeness: 'exact',
  });
}

function projectedScale(addressExpr) {
  const out = lowerMachineEffectsToLegacyV1(bundleWithAddress(addressExpr));
  const load = out[0];
  return load?.addr?.scale ?? null;
}

// Nested shifts compose: (x1 << 2) << 3 == x1 << 5.
assert.equal(projectedScale(shl(3, shl(2, reg('x1')))), 5, 'nested shift exponents must add up');

// Single shifts keep their historical behavior.
assert.equal(projectedScale(shl(2, reg('x1'))), 2);
assert.equal(projectedScale(shl(4, reg('x1'))), 4);

// Plain index keeps scale 0.
assert.equal(projectedScale(reg('x1')), 0);

// Only non-negative safe integer amounts may become an exact scale. Values
// that would be coerced by Number() must fail closed without an index.
for (const amount of [true, ['2'], '3', Number.MAX_SAFE_INTEGER + 1]) {
  const address = lowerMachineEffectsToLegacyV1(bundleWithAddress(shl(amount, reg('x1'))))[0].addr;
  assert.equal(address.index, null, 'non-numeric/unsafe shift amount must not mint an exact index');
}

// Each amount can be safe while the composed exponent overflows the safe range.
{
  const address = lowerMachineEffectsToLegacyV1(
    bundleWithAddress(shl(1, shl(Number.MAX_SAFE_INTEGER, reg('x1')))),
  )[0].addr;
  assert.equal(address.index, null, 'overflowed composed scale must fail closed');
}

console.log('issue-5827 machine-effects v1 nested shift scale composition: ok');
