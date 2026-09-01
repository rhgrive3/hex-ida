import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

const fpText = (num, bits) => `${bits === 16 ? 'h' : bits === 32 ? 's' : 'd'}${num}`;
const gpText = (num, bits) => `${bits === 32 ? 'w' : 'x'}${num}`;
const fp = (num, bits) => ({ k:'reg', cls:'fp', num, bits, text:fpText(num, bits) });
const gp = (num, bits) => ({ k:'reg', cls:'gp', num, bits, text:gpText(num, bits) });

function lift(id, mnemonic, ops) {
  return liftArm64MachineEffects({
    instructionId:id,
    mnemonic,
    mode:'a64',
    ops,
    origin:{ instructionIds:[id] },
  });
}

function fadd(bits, id) {
  return lift(id, 'fadd', [fp(0, bits), fp(1, bits), fp(2, bits)]);
}

function assertFailClosed(effects, label) {
  assert.ok(effects, label);
  assert.equal(effects.completeness, 'partial', label);
  assert.equal(
    effects.operations.some((operation) => ['register-read','register-write','intrinsic'].includes(operation.kind)),
    false,
    `${label}: malformed width produced definite FP state`,
  );
}

for (const bits of [16, 32, 64]) {
  const valid = fadd(bits, `arm64-fp-width-valid-${bits}`);
  assert.ok(valid, `valid FADD ${bits}`);
  assert.ok(['exact','exact-with-intrinsic'].includes(valid.completeness), `valid FADD ${bits}`);
  assert.equal(valid.metadata.family, 'arm64-fp');
}

for (const bits of [32, 64]) {
  const gpToFp = lift(`arm64-fmov-gp-to-fp-${bits}`, 'fmov', [fp(0, bits), gp(1, bits)]);
  assert.ok(gpToFp, `FMOV GP->FP ${bits}`);
  assert.equal(gpToFp.completeness, 'exact', `FMOV GP->FP ${bits}`);

  const fpToGp = lift(`arm64-fmov-fp-to-gp-${bits}`, 'fmov', [gp(0, bits), fp(1, bits)]);
  assert.ok(fpToGp, `FMOV FP->GP ${bits}`);
  assert.equal(fpToGp.completeness, 'exact', `FMOV FP->GP ${bits}`);
}

for (const [label, bits] of [
  ['string', '64'],
  ['array', [64]],
  ['object', { valueOf() { return 64; } }],
  ['boolean', true],
  ['fractional', 64.5],
  ['infinity', Infinity],
  ['nan', NaN],
  ['unsupported-form-width', 17],
]) {
  assertFailClosed(fadd(bits, `arm64-fp-width-invalid-${label}`), label);
}

const invalidTransfer = lift('arm64-fmov-invalid-form-width', 'fmov', [fp(0, 16), gp(1, 64)]);
assertFailClosed(invalidTransfer, 'fmov-invalid-form-width');

console.log('arm64 scalar FP strict width regression PASS');