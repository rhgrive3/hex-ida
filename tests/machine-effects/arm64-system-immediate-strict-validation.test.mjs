import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

const imm = (value) => ({ k:'imm', value, text:`#${String(value)}` });
const sysreg = (text) => ({ k:'sysreg', text });
const cr = (text) => ({ k:'other', text });

function lift(id, mnemonic, ops) {
  return liftArm64MachineEffects({
    instructionId:id,
    mnemonic,
    mode:'a64',
    ops,
    origin:{ instructionIds:[id] },
  });
}

function assertFailClosed(bundle, label) {
  assert.ok(bundle, label);
  assert.equal(bundle.completeness, 'partial', label);
  assert.notEqual(bundle.controlEffect?.kind, 'trap', `${label}: malformed immediate produced definite trap`);
  assert.equal(
    bundle.operations.some((operation) => ['intrinsic','register-read','register-write','barrier'].includes(operation.kind)),
    false,
    `${label}: malformed immediate produced definite system state`,
  );
}

for (const mnemonic of ['svc','hvc','smc','brk','hlt']) {
  const low = lift(`${mnemonic}-imm16-low`, mnemonic, [imm(0n)]);
  assert.ok(low);
  assert.equal(low.completeness, 'exact-with-intrinsic');
  assert.equal(low.controlEffect.kind, 'trap');

  const high = lift(`${mnemonic}-imm16-high`, mnemonic, [imm(0xffffn)]);
  assert.ok(high);
  assert.equal(high.completeness, 'exact-with-intrinsic');

  for (const [label, value] of [
    ['string', '1'],
    ['number', 1],
    ['boolean', true],
    ['array', [1]],
    ['object', { valueOf(){ return 1n; } }],
  ]) {
    assertFailClosed(lift(`${mnemonic}-invalid-${label}`, mnemonic, [imm(value)]), `${mnemonic}-${label}`);
  }
  assertFailClosed(lift(`${mnemonic}-negative`, mnemonic, [imm(-1n)]), `${mnemonic}-negative`);
  assertFailClosed(lift(`${mnemonic}-overflow`, mnemonic, [imm(0x10000n)]), `${mnemonic}-overflow`);
}

const hintHigh = lift('hint-imm7-high', 'hint', [imm(127n)]);
assert.ok(hintHigh);
assert.equal(hintHigh.completeness, 'exact-with-intrinsic');
assertFailClosed(lift('hint-string', 'hint', [imm('127')]), 'hint-string');
assertFailClosed(lift('hint-overflow', 'hint', [imm(128n)]), 'hint-overflow');

const msrPstate = lift('msr-daifset-valid', 'msr', [sysreg('daifset'), imm(15n)]);
assert.ok(msrPstate);
assert.equal(msrPstate.completeness, 'exact-with-intrinsic');
assertFailClosed(lift('msr-daifset-string', 'msr', [sysreg('daifset'), imm('15')]), 'msr-daifset-string');

const sysValid = lift('sys-immediates-valid', 'sys', [imm(7n), cr('c15'), cr('c15'), imm(7n)]);
assert.ok(sysValid);
assert.equal(sysValid.completeness, 'exact-with-intrinsic');
assertFailClosed(lift('sys-op1-string', 'sys', [imm('7'), cr('c15'), cr('c15'), imm(7n)]), 'sys-op1-string');
assertFailClosed(lift('sys-op2-string', 'sys', [imm(7n), cr('c15'), cr('c15'), imm('7')]), 'sys-op2-string');

console.log('arm64 system immediate strict validation regression PASS');
