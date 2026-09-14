import assert from 'node:assert/strict';

import { liftArm64SystemEffects } from '../../js/targets/architecture/arm64/effects/system.js';

const gp = (num) => ({ k:'reg', cls:'gp', num, bits:64, text:`x${num}` });
const zr = (num = 31) => ({ k:'reg', cls:'zr', num, bits:64, text:'xzr' });
const other = (text) => ({ k:'other', text });
const imm = (value) => ({ k:'imm', value:BigInt(value), text:`#${value}` });

function lift(mnemonic, ops, id) {
  return liftArm64SystemEffects({
    instructionId:id,
    mnemonic,
    ops,
    mode:'a64',
    origin:{ instructionIds:[id] },
  });
}

function assertAccepted(effect, label) {
  assert.ok(effect, `${label}:effect-required`);
  assert.notEqual(effect.completeness, 'partial', `${label}:must-remain-modelled`);
}

function assertRejected(effect, label) {
  assert.ok(effect, `${label}:effect-required`);
  assert.equal(effect.completeness, 'partial', `${label}:must-fail-closed`);
  const definite = effect.operations.filter((operation) =>
    operation.kind === 'register-read'
      || operation.kind === 'register-write'
      || operation.kind === 'intrinsic');
  assert.equal(definite.length, 0, `${label}:invalid-Xt-must-not-produce-definite-effects`);
}

for (const operand of [gp(0), gp(30), zr(31)]) {
  assertAccepted(lift('mrs', [operand, other('tpidr_el0')], `legal-mrs-${operand.cls}-${operand.num}`), `legal-mrs-${operand.cls}-${operand.num}`);
  assertAccepted(lift('msr', [other('tpidr_el0'), operand], `legal-msr-${operand.cls}-${operand.num}`), `legal-msr-${operand.cls}-${operand.num}`);
  assertAccepted(lift('dc', [other('cvau'), operand], `legal-dc-${operand.cls}-${operand.num}`), `legal-dc-${operand.cls}-${operand.num}`);
  assertAccepted(lift('sys', [imm(0), other('c7'), other('c5'), imm(0), operand], `legal-sys-${operand.cls}-${operand.num}`), `legal-sys-${operand.cls}-${operand.num}`);
}

const invalidXt = [
  { ...gp(-1), text:'x-1' },
  gp(32),
  gp(99),
  { ...gp(1), num:1.5, text:'x1.5' },
  gp(31),
  zr(0),
];

for (const [index, operand] of invalidXt.entries()) {
  assertRejected(lift('mrs', [operand, other('tpidr_el0')], `invalid-mrs-${index}`), `invalid-mrs-${index}`);
  assertRejected(lift('msr', [other('tpidr_el0'), operand], `invalid-msr-${index}`), `invalid-msr-${index}`);
  assertRejected(lift('dc', [other('cvau'), operand], `invalid-dc-${index}`), `invalid-dc-${index}`);
  assertRejected(lift('sys', [imm(0), other('c7'), other('c5'), imm(0), operand], `invalid-sys-${index}`), `invalid-sys-${index}`);
}

console.log('arm64 system Xt register domain regression: ok');
