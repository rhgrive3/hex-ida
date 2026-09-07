import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

const fp = (num) => ({ k:'reg', cls:'fp', num, bits:64, text:`d${num}` });
const gp = (num) => ({ k:'reg', cls:'gp', num, bits:64, text:`x${num}` });
const fp32 = (num) => ({ k:'reg', cls:'fp', num, bits:32, text:`s${num}` });
const gp32 = (num) => ({ k:'reg', cls:'gp', num, bits:32, text:`w${num}` });
function lift(id, mnemonic, ops) {
  return liftArm64MachineEffects({ instructionId:id, mnemonic, mode:'a64', ops, origin:{ instructionIds:[id] } });
}
function assertFailClosed(bundle, label) {
  assert.ok(bundle, label);
  assert.equal(bundle.completeness, 'partial', label);
  assert.equal(
    bundle.operations.some((operation) => ['register-read','register-write','intrinsic'].includes(operation.kind)),
    false,
    `${label}: malformed evidence produced definite FP/control state`,
  );
}

const validSelect = lift('arm64-fcsel-condition-valid', 'fcsel', [fp(0), fp(1), fp(2), { k:'cond', text:'eq' }]);
assert.ok(validSelect);
assert.equal(validSelect.completeness, 'exact-with-intrinsic');

for (const [label, text] of [
  ['array', ['eq']],
  ['object', { toString() { return 'eq'; } }],
  ['boolean', true],
  ['number', 0],
  ['unknown', 'bogus'],
]) {
  assertFailClosed(
    lift(`arm64-fcsel-condition-invalid-${label}`, 'fcsel', [fp(0), fp(1), fp(2), { k:'cond', text }]),
    `fcsel-${label}`,
  );
}
assertFailClosed(lift('arm64-fcsel-condition-missing', 'fcsel', [fp(0), fp(1), fp(2), { k:'other', text:'eq' }]), 'fcsel-missing');
assertFailClosed(
  lift('arm64-fcsel-condition-duplicate', 'fcsel', [fp(0), fp(1), fp(2), { k:'cond', text:'eq' }, { k:'cond', text:'ne' }]),
  'fcsel-duplicate',
);

for (const fallback of [0n, 15n]) {
  for (const mnemonic of ['fccmp', 'fccmpe']) {
    const valid = lift(`arm64-${mnemonic}-nzcv-valid-${fallback}`, mnemonic, [
      fp(0), fp(1), { k:'imm', value:fallback, text:`#${fallback}` }, { k:'cond', text:'eq' },
    ]);
    assert.ok(valid, `${mnemonic}-${fallback}`);
    assert.equal(valid.completeness, 'exact-with-intrinsic', `${mnemonic}-${fallback}`);
  }
}

for (const mnemonic of ['fccmp', 'fccmpe']) {
  for (const [label, value] of [
    ['string', '5'],
    ['number', 5],
    ['boolean', true],
    ['array', [5]],
    ['object', { valueOf() { return 5n; } }],
    ['negative', -1n],
    ['high', 16n],
  ]) {
    assertFailClosed(
      lift(`arm64-${mnemonic}-nzcv-invalid-${label}`, mnemonic, [fp(0), fp(1), { k:'imm', value, text:'#5' }, { k:'cond', text:'eq' }]),
      `${mnemonic}-${label}`,
    );
  }
  assertFailClosed(
    lift(`arm64-${mnemonic}-condition-object`, mnemonic, [fp(0), fp(1), { k:'imm', value:5n, text:'#5' }, { k:'cond', text:{ toString(){ return 'eq'; } } }]),
    `${mnemonic}-condition-object`,
  );
  assertFailClosed(
    lift(`arm64-${mnemonic}-condition-missing`, mnemonic, [fp(0), fp(1), { k:'imm', value:5n, text:'#5' }, { k:'other', text:'eq' }]),
    `${mnemonic}-condition-missing`,
  );
  assertFailClosed(
    lift(`arm64-${mnemonic}-condition-duplicate`, mnemonic, [
      fp(0), fp(1), { k:'imm', value:5n, text:'#5' }, { k:'cond', text:'eq' }, { k:'cond', text:'ne' },
    ]),
    `${mnemonic}-condition-duplicate`,
  );
}

for (const scale of [1n, 64n]) {
  const valid = lift(`arm64-scvtf-scale-valid-${scale}`, 'scvtf', [fp(0), gp(1), { k:'imm', value:scale, text:`#${scale}` }]);
  assert.ok(valid, `scvtf-${scale}`);
  assert.equal(valid.completeness, 'exact-with-intrinsic', `scvtf-${scale}`);
}

for (const [label, value] of [
  ['string', '8'],
  ['number', 8],
  ['boolean', true],
  ['array', [8]],
  ['object', { valueOf() { return 8n; } }],
  ['zero', 0n],
  ['high', 65n],
]) {
  assertFailClosed(
    lift(`arm64-scvtf-scale-invalid-${label}`, 'scvtf', [fp(0), gp(1), { k:'imm', value, text:'#8' }]),
    `scvtf-${label}`,
  );
}

const validScvtf32 = lift('arm64-scvtf-scale-valid-32bit-boundary', 'scvtf', [
  fp32(0), gp32(1), { k:'imm', value:32n, text:'#32' },
]);
assert.ok(validScvtf32);
assert.equal(validScvtf32.completeness, 'exact-with-intrinsic');
assertFailClosed(
  lift('arm64-scvtf-scale-invalid-32bit-high', 'scvtf', [fp32(0), gp32(1), { k:'imm', value:33n, text:'#33' }]),
  'scvtf-32bit-high',
);

const validFloatToIntegerFixed = lift('arm64-fcvtzs-scale-valid', 'fcvtzs', [gp(0), fp(1), { k:'imm', value:8n, text:'#8' }]);
assert.ok(validFloatToIntegerFixed);
assert.equal(validFloatToIntegerFixed.completeness, 'exact-with-intrinsic');
assertFailClosed(
  lift('arm64-fcvtzs-scale-invalid-string', 'fcvtzs', [gp(0), fp(1), { k:'imm', value:'8', text:'#8' }]),
  'fcvtzs-string',
);

const validFcvtzs32 = lift('arm64-fcvtzs-scale-valid-32bit-boundary', 'fcvtzs', [
  gp32(0), fp32(1), { k:'imm', value:32n, text:'#32' },
]);
assert.ok(validFcvtzs32);
assert.equal(validFcvtzs32.completeness, 'exact-with-intrinsic');
assertFailClosed(
  lift('arm64-fcvtzs-scale-invalid-32bit-high', 'fcvtzs', [gp32(0), fp32(1), { k:'imm', value:33n, text:'#33' }]),
  'fcvtzs-32bit-high',
);

console.log('arm64 scalar FP structured condition/integer immediate regression PASS');
