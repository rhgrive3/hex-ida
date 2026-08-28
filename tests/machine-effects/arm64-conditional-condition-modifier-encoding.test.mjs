import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

let sequence = 0;
function lift(mnemonic, operands) {
  const instructionId = `arm64-conditional-condition-modifier-${++sequence}`;
  return liftArm64MachineEffects({
    instructionId,
    mnemonic,
    operands,
    ops: parseOperands(operands),
    mode: 'a64',
    origin: { instructionIds: [instructionId] },
  });
}

for (const [mnemonic, operands] of [
  ['csel', 'x0, x1, x2, eq'],
  ['csinc', 'w0, w1, w2, ne'],
  ['cset', 'x0, eq'],
  ['csetm', 'w0, ne'],
  ['cinc', 'x0, x1, ne'],
  ['cneg', 'w0, w1, lt'],
  ['cinv', 'x0, x1, ge'],
]) {
  const effect = lift(mnemonic, operands);
  assert.ok(effect, `${mnemonic} ${operands}: effect required`);
  assert.ok(['exact', 'exact-with-intrinsic'].includes(effect.completeness), `${mnemonic} ${operands}: legal condition form`);
}

for (const [mnemonic, operands] of [
  ['csel', 'x0, x1, x2, eq, lsl #1'],
  ['csneg', 'w0, w1, w2, lt, ror #1'],
  ['cset', 'x0, eq, lsl #1'],
  ['cinc', 'x0, x1, ne, uxtw #1'],
]) {
  const parsed = parseOperands(operands);
  assert.ok(parsed.at(-1)?.shift, `${mnemonic} ${operands}: parser must retain the contradictory condition modifier`);
  const effect = liftArm64MachineEffects({
    instructionId: `arm64-conditional-condition-modifier-${++sequence}`,
    mnemonic,
    operands,
    ops: parsed,
    mode: 'a64',
  });
  assert.ok(effect, `${mnemonic} ${operands}: fail-closed effect required`);
  assert.equal(effect.completeness, 'partial', `${mnemonic} ${operands}: impossible condition modifier must be partial`);
  assert.equal(
    effect.operations.some((operation) => ['register-read', 'register-write', 'value', 'intrinsic'].includes(operation.kind)),
    false,
    `${mnemonic} ${operands}: invalid form must not emit definite conditional semantics`,
  );
}

console.log('arm64 conditional condition modifier encoding: PASS');
