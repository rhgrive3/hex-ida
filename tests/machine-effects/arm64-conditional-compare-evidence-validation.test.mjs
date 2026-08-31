import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

const gp = (num) => ({ k:'reg', cls:'gp', num, bits:64, text:`x${num}` });
const imm = (value, text = `#${String(value)}`) => ({ k:'imm', value, text });
const cond = (text) => ({ k:'cond', text });

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
  assert.equal(
    bundle.operations.some((operation) => ['flag-read','flag-write','register-read','intrinsic'].includes(operation.kind)),
    false,
    `${label}: malformed conditional-compare evidence produced definite state`,
  );
}

for (const mnemonic of ['ccmp','ccmn']) {
  const validRegister = lift(`${mnemonic}-register-valid`, mnemonic, [gp(0), gp(1), imm(0n), cond('eq')]);
  assert.ok(validRegister);
  assert.equal(validRegister.completeness, 'exact');

  const validImmediateLow = lift(`${mnemonic}-imm-low-valid`, mnemonic, [gp(0), imm(0n), imm(0n), cond('ne')]);
  assert.ok(validImmediateLow);
  assert.equal(validImmediateLow.completeness, 'exact');

  const validImmediateHigh = lift(`${mnemonic}-imm-high-valid`, mnemonic, [gp(0), imm(31n), imm(15n), cond('al')]);
  assert.ok(validImmediateHigh);
  assert.equal(validImmediateHigh.completeness, 'exact');

  for (const [label, text] of [
    ['array', ['eq']],
    ['object', { toString(){ return 'eq'; } }],
    ['boolean', true],
    ['number', 0],
    ['unknown', 'bogus'],
  ]) {
    assertFailClosed(
      lift(`${mnemonic}-condition-${label}`, mnemonic, [gp(0), gp(1), imm(5n), cond(text)]),
      `${mnemonic}-condition-${label}`,
    );
  }

  for (const [label, value] of [
    ['string', '5'],
    ['number', 5],
    ['boolean', true],
    ['array', [5]],
    ['object', { valueOf(){ return 5n; } }],
    ['negative', -1n],
    ['high', 16n],
  ]) {
    assertFailClosed(
      lift(`${mnemonic}-fallback-${label}`, mnemonic, [gp(0), gp(1), imm(value), cond('eq')]),
      `${mnemonic}-fallback-${label}`,
    );
  }

  for (const [label, value] of [
    ['string', '31'],
    ['number', 31],
    ['boolean', true],
    ['array', [31]],
    ['object', { valueOf(){ return 31n; } }],
    ['negative', -1n],
    ['high', 32n],
  ]) {
    assertFailClosed(
      lift(`${mnemonic}-comparison-${label}`, mnemonic, [gp(0), imm(value), imm(5n), cond('eq')]),
      `${mnemonic}-comparison-${label}`,
    );
  }
}

console.log('arm64 CCMP/CCMN structured evidence regression PASS');
