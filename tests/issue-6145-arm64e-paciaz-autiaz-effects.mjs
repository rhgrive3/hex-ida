import assert from 'node:assert/strict';
import {
  isArm64ePointerAuthenticationInstruction,
  liftArm64eEffects,
  arm64ePointerAuthenticationMnemonics,
} from '../js/targets/architecture/arm64e/effects.js';
import {
  arm64ePointerAuthenticationOperandShapeFailure,
  arm64ePointerAuthenticationOperandShapeFailureBundle,
  arm64ePointerAuthenticationOperandArities,
} from '../js/targets/architecture/arm64e/encoding.js';

console.log('Testing #6145: ARM64e PACIAZ/PACIBZ/AUTIAZ/AUTIBZ effects...');

// 1. Mnemonic recognition in family and inventory
const pauthMnemonics = ['paciaz', 'pacibz', 'autiaz', 'autibz'];
const inventory = new Set(arm64ePointerAuthenticationMnemonics());
const arities = arm64ePointerAuthenticationOperandArities();

for (const mnemonic of pauthMnemonics) {
  assert.equal(isArm64ePointerAuthenticationInstruction({ mnemonic }), true, `${mnemonic} recognized`);
  assert.equal(inventory.has(mnemonic), true, `${mnemonic} in inventory`);
  assert.equal(arities[mnemonic], 0, `${mnemonic} has arity 0`);
}

// 2. PACIAZ: implicit X30, zero modifier, APIAKey
const paciazBundle = liftArm64eEffects({ mnemonic: 'paciaz', instructionId: 'i_paciaz', ops: [] });
assert.ok(paciazBundle, 'paciaz produces bundle');
assert.equal(paciazBundle.completeness, 'exact-with-intrinsic');
assert.equal(paciazBundle.controlEffect.kind, 'fallthrough');
assert.equal(paciazBundle.metadata.destinationRegister, 'x30');
assert.equal(paciazBundle.metadata.keyIdentity, 'APIAKey');
assert.equal(paciazBundle.metadata.modifier.kind, 'constant-zero');
assert.equal(paciazBundle.possibleFaults.length, 0);

// 3. PACIBZ: implicit X30, zero modifier, APIBKey
const pacibzBundle = liftArm64eEffects({ mnemonic: 'pacibz', instructionId: 'i_pacibz', ops: [] });
assert.ok(pacibzBundle, 'pacibz produces bundle');
assert.equal(pacibzBundle.metadata.destinationRegister, 'x30');
assert.equal(pacibzBundle.metadata.keyIdentity, 'APIBKey');
assert.equal(pacibzBundle.metadata.modifier.kind, 'constant-zero');

// 4. AUTIAZ: implicit X30, zero modifier, APIAKey, authenticate fault
const autiazBundle = liftArm64eEffects({ mnemonic: 'autiaz', instructionId: 'i_autiaz', ops: [] });
assert.ok(autiazBundle, 'autiaz produces bundle');
assert.equal(autiazBundle.completeness, 'exact-with-intrinsic');
assert.equal(autiazBundle.metadata.destinationRegister, 'x30');
assert.equal(autiazBundle.metadata.keyIdentity, 'APIAKey');
assert.equal(autiazBundle.metadata.modifier.kind, 'constant-zero');
assert.equal(autiazBundle.possibleFaults.some((f) => f.kind === 'pointer-authentication-fault'), true);

// 5. AUTIBZ: implicit X30, zero modifier, APIBKey, authenticate fault
const autibzBundle = liftArm64eEffects({ mnemonic: 'autibz', instructionId: 'i_autibz', ops: [] });
assert.ok(autibzBundle, 'autibz produces bundle');
assert.equal(autibzBundle.metadata.destinationRegister, 'x30');
assert.equal(autibzBundle.metadata.keyIdentity, 'APIBKey');
assert.equal(autibzBundle.metadata.modifier.kind, 'constant-zero');
assert.equal(autibzBundle.possibleFaults.some((f) => f.kind === 'pointer-authentication-fault'), true);

// 6. Arity validation: 0 operands valid, extra operands fail-closed
for (const mnemonic of pauthMnemonics) {
  const failure = arm64ePointerAuthenticationOperandShapeFailure({ mnemonic, instructionId: 'v', ops: [] });
  assert.equal(failure, null, `${mnemonic} with 0 operands has no shape failure`);

  const failureBundle = arm64ePointerAuthenticationOperandShapeFailureBundle({ mnemonic, instructionId: 'inv', ops: ['x0'] });
  assert.ok(failureBundle, `${mnemonic} with 1 operand produces failure bundle`);
  assert.equal(failureBundle.completeness, 'partial');
}

console.log('#6145 tests passed successfully.');
