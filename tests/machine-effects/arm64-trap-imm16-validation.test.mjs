import assert from 'node:assert/strict';

import { liftArm64SystemEffects } from '../../js/targets/architecture/arm64/effects/system.js';

function trap(mnemonic, value) {
  return liftArm64SystemEffects({
    instructionId:`issue-1893:${mnemonic}:${value}`,
    mnemonic,
    mode:'a64',
    ops:[{ k:'imm', value:BigInt(value), text:`#${value}` }],
  });
}

for (const mnemonic of ['svc','hvc','smc','brk','hlt']) {
  for (const value of [0, 65535]) {
    const effect = trap(mnemonic, value);
    assert.ok(effect, `${mnemonic} #${value}:effect-required`);
    assert.equal(effect.completeness, 'exact-with-intrinsic', `${mnemonic} #${value}:valid imm16 must remain exact-with-intrinsic`);
    assert.equal(effect.operations.some((operation) => operation.kind === 'unknown'), false, `${mnemonic} #${value}:valid imm16 must not gain unknown effects`);
  }

  for (const value of [-1, 65536]) {
    const effect = trap(mnemonic, value);
    assert.ok(effect, `${mnemonic} #${value}:fail-closed-effect-required`);
    assert.equal(effect.completeness, 'partial', `${mnemonic} #${value}:out-of-range imm16 must fail closed`);
    assert.equal(effect.unknownEffects?.reason, `${mnemonic}-imm16-out-of-range`, `${mnemonic} #${value}:explicit reason required`);
    assert.ok(effect.operations.some((operation) => operation.kind === 'unknown'), `${mnemonic} #${value}:unknown operation required`);
  }
}

console.log('ARM64 trap imm16 validation (#1893): PASS');
