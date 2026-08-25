import assert from 'node:assert/strict';

import { liftArm64ControlEffects } from '../js/targets/architecture/arm64/effects/control.js';

const gp64 = { k:'reg', cls:'gp', num:0, bits:64, text:'x0' };
const imm0 = { k:'imm', value:0n, text:'#0' };

const cases = [
  ['b', []],
  ['bl', []],
  ['b.eq', []],
  ['cbz', [gp64]],
  ['cbnz', [gp64]],
  ['tbz', [gp64, imm0]],
  ['tbnz', [gp64, imm0]],
];

for (const [mnemonic, ops] of cases) {
  const invalid = liftArm64ControlEffects({
    instructionId:`issue-1907:${mnemonic}:misaligned`,
    mnemonic,
    mode:'a64',
    address:0x1000n,
    branchTarget:0x1001n,
    callTarget:mnemonic === 'bl' ? 0x1001n : undefined,
    ops,
  });
  assert.ok(invalid, `${mnemonic}:misaligned effect required`);
  assert.equal(invalid.completeness, 'partial', `${mnemonic}:misaligned target must fail closed`);
  assert.match(invalid.unknownEffects?.reason || '', /target-misaligned-encoding$/);

  const valid = liftArm64ControlEffects({
    instructionId:`issue-1907:${mnemonic}:aligned`,
    mnemonic,
    mode:'a64',
    address:0x1000n,
    branchTarget:0x1004n,
    callTarget:mnemonic === 'bl' ? 0x1004n : undefined,
    ops,
  });
  assert.ok(valid, `${mnemonic}:aligned effect required`);
  assert.notEqual(valid.completeness, 'partial', `${mnemonic}:aligned target must retain modeled semantics`);
}

console.log('ARM64 direct branch target alignment (#1907): PASS');
