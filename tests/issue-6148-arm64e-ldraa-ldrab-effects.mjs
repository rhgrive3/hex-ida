import assert from 'node:assert/strict';
import { categoryOf } from '../js/arm64.js';
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

console.log('Testing #6148: ARM64e LDRAA/LDRAB authenticated load effects...');

// 1. Mnemonic recognition in family and inventory
const authLoadMnemonics = ['ldraa', 'ldrab'];
const inventory = new Set(arm64ePointerAuthenticationMnemonics());
const arities = arm64ePointerAuthenticationOperandArities();

for (const mnemonic of authLoadMnemonics) {
  assert.equal(isArm64ePointerAuthenticationInstruction({ mnemonic }), true, `${mnemonic} recognized`);
  assert.equal(inventory.has(mnemonic), true, `${mnemonic} in inventory`);
  assert.equal(arities[mnemonic], 2, `${mnemonic} has arity 2`);
  assert.equal(categoryOf(mnemonic), 'load', `${mnemonic} is categorized as a load`);
}

// 2. LDRAA Xt, [Xn]: Data Key A (APDAKey), 64-bit load, no writeback
const ldraaBundle = liftArm64eEffects({
  mnemonic: 'ldraa',
  instructionId: 'i_ldraa',
  ops: ['x0', '[x1]'],
});
assert.ok(ldraaBundle, 'ldraa produces bundle');
assert.equal(ldraaBundle.completeness, 'exact-with-intrinsic');
assert.equal(ldraaBundle.metadata.destinationRegister, 'x0');
assert.equal(ldraaBundle.metadata.baseRegister, 'x1');
assert.equal(ldraaBundle.metadata.keyIdentity, 'APDAKey');
assert.equal(ldraaBundle.metadata.preIndex, false);
assert.equal(ldraaBundle.possibleFaults.some((f) => f.kind === 'pointer-authentication-fault'), true);
assert.equal(ldraaBundle.possibleFaults.some((f) => f.kind === 'data-abort'), true);
assert.ok(ldraaBundle.operations.some((op) => op.kind === 'register-read' && op.register.registerId === 'APDAKey'));

// Verify memory read and register write operations
const memReadOp = ldraaBundle.operations.find((op) => op.kind === 'memory-read');
assert.ok(memReadOp, 'memory-read operation exists');
assert.equal(memReadOp.access.widthBits, 64);
const destWriteOp = ldraaBundle.operations.find((op) => op.kind === 'register-write' && op.register.registerId === 'x0');
assert.ok(destWriteOp, 'register-write to x0 exists');
const baseWriteOp = ldraaBundle.operations.find((op) => op.kind === 'register-write' && op.register.registerId === 'x1');
assert.equal(baseWriteOp, undefined, 'no writeback to x1');

// 3. LDRAB Xt, [Xn, #imm]: Data Key B (APDBKey), no writeback
const ldrabBundle = liftArm64eEffects({
  mnemonic: 'ldrab',
  instructionId: 'i_ldrab',
  ops: ['x2', '[x3, #16]'],
});
assert.ok(ldrabBundle, 'ldrab produces bundle');
assert.equal(ldrabBundle.metadata.destinationRegister, 'x2');
assert.equal(ldrabBundle.metadata.baseRegister, 'x3');
assert.equal(ldrabBundle.metadata.keyIdentity, 'APDBKey');
assert.equal(ldrabBundle.metadata.displacement, '16');
assert.equal(ldrabBundle.metadata.preIndex, false);
assert.ok(ldrabBundle.operations.some((op) => op.kind === 'register-read' && op.register.registerId === 'APDBKey'));

// 4. Pre-index variant: writeback to base register
const preIndexBundle = liftArm64eEffects({
  mnemonic: 'ldraa',
  instructionId: 'i_pre',
  ops: ['x0', '[x1, #8]!'],
});
assert.ok(preIndexBundle, 'pre-index ldraa produces bundle');
assert.equal(preIndexBundle.metadata.preIndex, true);
const preBaseWrite = preIndexBundle.operations.find((op) => op.kind === 'register-write' && op.register.registerId === 'x1');
assert.ok(preBaseWrite, 'pre-index performs writeback to x1');

// 5. SP base register supported
const spBaseBundle = liftArm64eEffects({
  mnemonic: 'ldraa',
  instructionId: 'i_sp',
  ops: ['x0', '[sp, #24]'],
});
assert.ok(spBaseBundle, 'sp base supported');
assert.equal(spBaseBundle.metadata.baseRegister, 'sp');

// 6. XZR destination: architectural discard (no register-write for destination)
const xzrBundle = liftArm64eEffects({
  mnemonic: 'ldraa',
  instructionId: 'i_xzr',
  ops: ['xzr', '[x1]'],
});
assert.ok(xzrBundle, 'xzr destination handled');
const xzrWrite = xzrBundle.operations.find((op) => op.kind === 'register-write');
assert.equal(xzrWrite, undefined, 'xzr destination does not write to register');

// 7. Structured memory operand support
const structuredBundle = liftArm64eEffects({
  mnemonic: 'ldraa',
  instructionId: 'i_struct',
  ops: [
    { k: 'reg', cls: 'gp', num: 5, bits: 64 },
    { k: 'mem', base: 'x6', disp: 32, pre: true },
  ],
});
assert.ok(structuredBundle, 'structured operand produces bundle');
assert.equal(structuredBundle.metadata.destinationRegister, 'x5');
assert.equal(structuredBundle.metadata.baseRegister, 'x6');
assert.equal(structuredBundle.metadata.preIndex, true);

// 8. Fail-closed: invalid displacement (not multiple of 8 or out of range)
const misalignedBundle = liftArm64eEffects({
  mnemonic: 'ldraa',
  instructionId: 'i_misaligned',
  ops: ['x0', '[x1, #7]'],
});
assert.equal(misalignedBundle.completeness, 'partial');

const outOfRangeBundle = liftArm64eEffects({
  mnemonic: 'ldraa',
  instructionId: 'i_range',
  ops: ['x0', '[x1, #5000]'],
});
assert.equal(outOfRangeBundle.completeness, 'partial');

// 9. Fail-closed: XZR cannot be base register
const xzrBaseBundle = liftArm64eEffects({
  mnemonic: 'ldraa',
  instructionId: 'i_xzr_base',
  ops: ['x0', '[xzr]'],
});
assert.equal(xzrBaseBundle.completeness, 'partial');

// 10. Arity validation
const shapeFailure = arm64ePointerAuthenticationOperandShapeFailure({
  mnemonic: 'ldraa',
  instructionId: 'i_bad_arity',
  ops: ['x0'],
});
assert.ok(shapeFailure, 'single operand fails arity');

console.log('#6148 tests passed successfully.');
