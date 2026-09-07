import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

let sequence = 0;
const fp = (num, bits) => ({ k:'reg', cls:'fp', num, bits, text:`${bits === 32 ? 's' : 'd'}${num}` });
const zr = (num, bits) => ({ k:'reg', cls:'zr', num, bits, text:bits === 32 ? 'wzr' : 'xzr' });

function lift(ops) {
  const instructionId = `arm64-fp-zr-register31:${++sequence}`;
  return liftArm64MachineEffects({
    instructionId,
    mnemonic:'fmov',
    mode:'a64',
    ops,
    origin:{ instructionIds:[instructionId] },
  });
}

function definiteOperations(bundle) {
  return bundle.operations.filter((operation) => [
    'register-read','register-write','intrinsic','value','memory-read','memory-write',
  ].includes(operation.kind));
}

for (const [bits, src, dst] of [
  [32, zr(31, 32), fp(0, 32)],
  [64, zr(31, 64), fp(0, 64)],
]) {
  const effect = lift([dst, src]);
  assert.ok(effect, `FMOV ${bits}: canonical ZR register 31 remains owned`);
  assert.notEqual(effect.completeness, 'partial', `FMOV ${bits}: canonical ZR register 31 remains exact`);
  assert.ok(definiteOperations(effect).length > 0, `FMOV ${bits}: legal form keeps definite semantics`);
}

for (const [bits, num] of [
  [32, 0], [32, 1], [32, 30],
  [64, 0], [64, 1], [64, 30],
]) {
  const effect = lift([fp(0, bits), zr(num, bits)]);
  assert.ok(effect, `FMOV ${bits}: contradictory ZR num ${num} remains explicitly owned`);
  assert.equal(effect.completeness, 'partial', `FMOV ${bits}: contradictory ZR num ${num} must fail closed`);
  assert.equal(definiteOperations(effect).length, 0, `FMOV ${bits}: contradictory ZR num ${num} must not publish definite semantics`);
}

console.log('arm64 scalar FP ZR register-31 validation: PASS');
