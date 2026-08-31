import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

const fp = (num) => ({ k:'reg', cls:'fp', num, bits:64, text:`d${num}` });
const gp = (num) => ({ k:'reg', cls:'gp', num, bits:64, text:`x${num}` });
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

const validFccmp = lift('arm64-fccmp-nzcv-valid', 'fccmp', [fp(0), fp(1), { k:'imm', value:5n, text:'#5' }, { k:'cond', text:'eq' }]);
assert.ok(validFccmp);
assert.equal(validFccmp.completeness, 'exact-with-intrinsic');

for (const [label, value] of [
  ['string', '5'],
  ['number', 5],
  ['boolean', true],
  ['array', [5]],
  ['object', { valueOf() { return 5n; } }],
]) {
  assertFailClosed(
    lift(`arm64-fccmp-nzcv-invalid-${label}`, 'fccmp', [fp(0), fp(1), { k:'imm', value, text:'#5' }, { k:'cond', text:'eq' }]),
    `fccmp-${label}`,
  );
}
assertFailClosed(
  lift('arm64-fccmp-condition-object', 'fccmp', [fp(0), fp(1), { k:'imm', value:5n, text:'#5' }, { k:'cond', text:{ toString(){ return 'eq'; } } }]),
  'fccmp-condition-object',
);

const validFixed = lift('arm64-scvtf-scale-valid', 'scvtf', [fp(0), gp(1), { k:'imm', value:8n, text:'#8' }]);
assert.ok(validFixed);
assert.equal(validFixed.completeness, 'exact-with-intrinsic');

for (const [label, value] of [
  ['string', '8'],
  ['number', 8],
  ['boolean', true],
  ['array', [8]],
  ['object', { valueOf() { return 8n; } }],
]) {
  assertFailClosed(
    lift(`arm64-scvtf-scale-invalid-${label}`, 'scvtf', [fp(0), gp(1), { k:'imm', value, text:'#8' }]),
    `scvtf-${label}`,
  );
}

console.log('arm64 scalar FP structured condition/integer immediate regression PASS');
