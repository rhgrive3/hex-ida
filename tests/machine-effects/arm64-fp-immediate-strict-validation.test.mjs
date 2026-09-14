import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

function fmov(float, id) {
  return liftArm64MachineEffects({
    instructionId:id,
    mnemonic:'fmov',
    mode:'a64',
    ops:[
      { k:'reg', cls:'fp', num:0, bits:64, text:'d0' },
      { k:'imm', float, text:'#1.0' },
    ],
    origin:{ instructionIds:[id] },
  });
}

const valid = fmov(1, 'arm64-fp-immediate-valid');
assert.ok(valid);
assert.equal(valid.completeness, 'exact');
assert.equal(valid.metadata.family, 'arm64-fp');

const unencodable = fmov(1.1, 'arm64-fp-immediate-unencodable');
assert.ok(unencodable);
assert.equal(unencodable.completeness, 'partial');

for (const [label, value] of [
  ['string', '1'],
  ['array', [1]],
  ['object', { valueOf() { return 1; } }],
  ['boolean', true],
  ['infinity', Infinity],
  ['nan', NaN],
]) {
  const effects = fmov(value, `arm64-fp-immediate-invalid-${label}`);
  assert.ok(effects, label);
  assert.equal(effects.completeness, 'partial', label);
  assert.equal(
    effects.operations.some((operation) => ['register-read','register-write','intrinsic'].includes(operation.kind)),
    false,
    `${label}: malformed immediate produced definite FP state`,
  );
}

console.log('arm64 scalar FP strict immediate regression PASS');
