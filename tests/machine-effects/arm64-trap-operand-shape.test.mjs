import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

let sequence = 0;
function lift(mnemonic, operands) {
  const instructionId = `arm64-trap-operand-shape:${sequence++}`;
  return liftArm64MachineEffects({
    instructionId,
    mnemonic,
    mode:'a64',
    ops:parseOperands(operands),
    origin:{ instructionIds:[instructionId] },
  });
}

for (const mnemonic of ['svc','hvc','smc','brk','hlt']) {
  for (const immediate of ['#0', '#65535']) {
    const effects = lift(mnemonic, immediate);
    assert.equal(effects.completeness, 'exact-with-intrinsic', `${mnemonic} ${immediate}: valid imm16 regressed`);
    assert.equal(effects.controlEffect.kind, 'trap', `${mnemonic} ${immediate}: trap control effect missing`);
  }

  for (const operands of ['', '#0, #1']) {
    const effects = lift(mnemonic, operands);
    assert.equal(effects.completeness, 'partial', `${mnemonic} ${operands}: malformed operand shape must fail closed`);
    assert.match(effects.unknownEffects.reason, new RegExp(`^${mnemonic}-operand-shape-invalid$`));
    assert.notEqual(effects.controlEffect.kind, 'trap', `${mnemonic}: malformed shape must not fabricate trap control`);
    assert.equal(effects.operations.some((operation) => operation.kind === 'intrinsic'), false, `${mnemonic}: malformed shape must not fabricate environment intrinsic`);
  }

  for (const immediate of ['#-1', '#65536']) {
    const effects = lift(mnemonic, immediate);
    assert.equal(effects.completeness, 'partial', `${mnemonic} ${immediate}: invalid imm16 must remain fail-closed`);
    assert.match(effects.unknownEffects.reason, new RegExp(`^${mnemonic}-imm16-out-of-range$`));
  }
}

console.log('arm64 trap operand-shape effects: PASS');
