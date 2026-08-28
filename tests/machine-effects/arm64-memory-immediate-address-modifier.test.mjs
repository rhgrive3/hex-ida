import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

let sequence = 0;
function lift(mnemonic, operands, ops = parseOperands(operands)) {
  const instructionId = `arm64-memory-immediate-modifier-${++sequence}`;
  return liftArm64MachineEffects({
    instructionId,
    mnemonic,
    operands,
    ops,
    mode: 'a64',
    origin: { instructionIds: [instructionId] },
  });
}

for (const [mnemonic, operands] of [
  ['ldr', 'x0, [x1, #8]'],
  ['str', 'w0, [sp, #4]'],
  ['ldr', 'x0, [x1, x2, lsl #3]'],
]) {
  const effect = lift(mnemonic, operands);
  assert.ok(effect, `${mnemonic} ${operands}: effect required`);
  assert.ok(['exact', 'exact-with-intrinsic'].includes(effect.completeness), `${mnemonic} ${operands}: legal addressing must remain exact`);
}

for (const [mnemonic, operands] of [
  ['ldr', 'x0, [x1, #8, lsl #3]'],
  ['str', 'x0, [x1, #8, uxtw]'],
  ['ldp', 'x0, x1, [x2, #16, asr #1]'],
  ['ldr', 'x0, [x1, #8, lsl #3]!'],
  ['str', 'x0, [x1], #8, lsl #3'],
]) {
  const effect = lift(mnemonic, operands);
  assert.ok(effect, `${mnemonic} ${operands}: fail-closed effect required`);
  assert.equal(effect.completeness, 'partial', `${mnemonic} ${operands}: impossible immediate modifier must be partial`);
  assert.equal(
    effect.operations.some((operation) => ['memory-read', 'memory-write', 'register-read', 'register-write', 'value'].includes(operation.kind)),
    false,
    `${mnemonic} ${operands}: invalid addressing must not emit definite address/memory/register operations`,
  );
}

{
  const ops = parseOperands('x0, [x1, #8]');
  ops[1].extend = { op: 'uxtw', amount: 0 };
  const effect = lift('ldr', 'x0, [x1, #8]', ops);
  assert.equal(effect.completeness, 'partial', 'structured mem.extend without index must fail closed');
  assert.equal(effect.operations.length, 0, 'structured mem.extend must not emit definite operations');
}

{
  const ops = parseOperands('x0, [x1], #8');
  ops[1].writebackDisp.extend = { op: 'uxtw', amount: 0 };
  const effect = lift('str', 'x0, [x1], #8', ops);
  assert.equal(effect.completeness, 'partial', 'structured post-index immediate extend must fail closed');
  assert.equal(effect.operations.length, 0, 'structured writeback modifier must not emit definite operations');
}

console.log('arm64 memory immediate addressing modifier: PASS');
