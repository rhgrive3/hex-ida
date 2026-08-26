import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64SystemEffects } from '../../js/targets/architecture/arm64/effects/system.js';

function lift(mnemonic, operands = '') {
  return liftArm64SystemEffects({
    instructionId:`shape:${mnemonic}:${operands || 'none'}`,
    mnemonic,
    operands,
    ops:parseOperands(operands),
    mode:'a64',
  });
}

function assertRejected(mnemonic, operands, reason) {
  const effects = lift(mnemonic, operands);
  assert.equal(effects.completeness, 'partial', `${mnemonic} ${operands}: completeness`);
  assert.equal(effects.unknownEffects?.reason, reason, `${mnemonic} ${operands}: reason`);
  assert.equal(effects.operations.filter((operation) => operation.kind === 'intrinsic').length, 0, `${mnemonic} ${operands}: no intrinsic`);
  assert.equal(effects.operations.filter((operation) => operation.kind === 'register-write').length, 0, `${mnemonic} ${operands}: no register write`);
}

for (const [mnemonic, operands] of [
  ['nop', ''],
  ['yield', ''],
  ['wfe', ''],
  ['wfi', ''],
  ['sev', ''],
  ['sevl', ''],
  ['clrex', ''],
  ['clrex', '#0'],
  ['clrex', '#15'],
  ['bti', ''],
  ['bti', 'c'],
  ['bti', 'j'],
  ['bti', 'jc'],
  ['bti', 'C'],
  ['hint', '#0'],
  ['hint', '#127'],
  ['mrs', 'x0, nzcv'],
  ['msr', 'nzcv, x0'],
  ['eret', ''],
]) {
  const effects = lift(mnemonic, operands);
  assert.notEqual(effects.completeness, 'partial', `${mnemonic} ${operands}: valid shape must remain supported`);
}

for (const mnemonic of ['nop','yield','wfe','wfi','sev','sevl']) {
  assertRejected(mnemonic, '#1', `${mnemonic}-operand-shape-invalid`);
}

assertRejected('clrex', '#0, #1', 'clrex-operand-shape-invalid');
assertRejected('bti', 'bad', 'bti-target-invalid');
assertRejected('bti', 'c, j', 'bti-operand-shape-invalid');
assertRejected('hint', '', 'generic-hint-operand-shape-invalid');
assertRejected('hint', '#0, #1', 'generic-hint-operand-shape-invalid');
assertRejected('mrs', 'x0, nzcv, #1', 'mrs-operand-shape-invalid');
assertRejected('msr', 'nzcv, x0, #1', 'msr-operand-shape-invalid');
assertRejected('eret', '#1', 'eret-operand-shape-invalid');

// Existing immediate-domain contracts remain intact and stay in exact-head regression coverage.
assertRejected('clrex', '#-1', 'clrex-imm4-out-of-range');
assertRejected('clrex', '#16', 'clrex-imm4-out-of-range');
assertRejected('hint', '#-1', 'generic-hint-imm7-out-of-range');
assertRejected('hint', '#128', 'generic-hint-imm7-out-of-range');

// Keep this suite anchored to the exact PR head so GitHub Actions validates the reconciled branch.
console.log('arm64 system operand-shape tests passed');
