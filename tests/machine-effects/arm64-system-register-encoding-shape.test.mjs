import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64SystemEffects } from '../../js/targets/architecture/arm64/effects/system.js';

function lift(id, mnemonic, operands) {
  return liftArm64SystemEffects({
    instructionId:id,
    mnemonic,
    operands,
    ops:parseOperands(operands),
    mode:'a64',
  });
}

for (const [id, mnemonic, operands] of [
  ['mrs-x0-nzcv','mrs','x0, nzcv'],
  ['mrs-xzr-nzcv','mrs','xzr, nzcv'],
  ['msr-nzcv-x0','msr','nzcv, x0'],
  ['msr-nzcv-xzr','msr','nzcv, xzr'],
  ['msr-tpidr-x0','msr','tpidr_el0, x0'],
  ['msr-daifset-0','msr','daifset, #0'],
  ['msr-daifset-15','msr','daifset, #15'],
  ['msr-allint-0','msr','allint, #0'],
  ['msr-allint-1','msr','allint, #1'],
  ['msr-pm-2','msr','pm, #2'],
  ['msr-pm-3','msr','pm, #3'],
  ['msr-svcrsm-2','msr','svcrsm, #2'],
  ['msr-svcrza-4','msr','svcrza, #4'],
  ['msr-svcrsmza-6','msr','svcrsmza, #6'],
]) {
  const effects = lift(id, mnemonic, operands);
  assert.ok(effects, `${id}: system lifter escaped`);
  assert.ok(['exact','exact-with-intrinsic'].includes(effects.completeness), `${id}: ${effects.unknownEffects?.reason}`);
}

for (const [id, mnemonic, operands] of [
  ['bad-mrs-w0','mrs','w0, nzcv'],
  ['bad-mrs-sp','mrs','sp, nzcv'],
  ['bad-msr-nzcv-w0','msr','nzcv, w0'],
  ['bad-msr-nzcv-sp','msr','nzcv, sp'],
  ['bad-msr-nzcv-imm','msr','nzcv, #1'],
  ['bad-msr-fpcr-imm','msr','fpcr, #1'],
  ['bad-msr-fpsr-imm','msr','fpsr, #1'],
  ['bad-msr-tpidr-imm','msr','tpidr_el0, #1'],
  ['bad-msr-daifset-register','msr','daifset, x0'],
  ['bad-msr-allint-2','msr','allint, #2'],
  ['bad-msr-pm-1','msr','pm, #1'],
  ['bad-msr-pm-4','msr','pm, #4'],
  ['bad-msr-svcrsm-1','msr','svcrsm, #1'],
  ['bad-msr-svcrza-3','msr','svcrza, #3'],
  ['bad-msr-svcrsmza-5','msr','svcrsmza, #5'],
  ['bad-msr-daifset-16','msr','daifset, #16'],
]) {
  const effects = lift(id, mnemonic, operands);
  assert.ok(effects, `${id}: system lifter escaped`);
  assert.equal(effects.completeness, 'partial', id);
  assert.match(effects.unknownEffects?.reason || '', new RegExp(`^${mnemonic}-operand-shape-invalid$`), id);
  assert.equal(effects.operations.some((operation) => operation.kind === 'register-write'), false, `${id}: invalid shape wrote register state`);
  assert.equal(effects.operations.some((operation) => operation.kind === 'intrinsic'), false, `${id}: invalid shape emitted intrinsic`);
}

console.log('ARM64 MRS/MSR encoding-shape validation: PASS');
