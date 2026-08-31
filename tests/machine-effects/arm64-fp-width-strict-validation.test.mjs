import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

function fadd(bits, id) {
  return liftArm64MachineEffects({
    instructionId:id,
    mnemonic:'fadd',
    mode:'a64',
    ops:[
      { k:'reg', cls:'fp', num:0, bits, text:'d0' },
      { k:'reg', cls:'fp', num:1, bits, text:'d1' },
      { k:'reg', cls:'fp', num:2, bits, text:'d2' },
    ],
    origin:{ instructionIds:[id] },
  });
}

const valid = fadd(64, 'arm64-fp-width-valid');
assert.ok(valid);
assert.ok(['exact','exact-with-intrinsic'].includes(valid.completeness));
assert.equal(valid.metadata.family, 'arm64-fp');

for (const [label, bits] of [
  ['string', '64'],
  ['array', [64]],
  ['object', { valueOf() { return 64; } }],
  ['boolean', true],
  ['fractional', 64.5],
  ['infinity', Infinity],
  ['nan', NaN],
]) {
  const effects = fadd(bits, `arm64-fp-width-invalid-${label}`);
  assert.ok(effects, label);
  assert.equal(effects.completeness, 'partial', label);
  assert.equal(
    effects.operations.some((operation) => ['register-read','register-write','intrinsic'].includes(operation.kind)),
    false,
    `${label}: malformed width produced definite FP state`,
  );
}

console.log('arm64 scalar FP strict width regression PASS');
