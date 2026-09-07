import assert from 'node:assert/strict';

import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

const x = (n) => ({ k:'reg', text:`x${n}`, cls:'gp', bits:64, num:n });
const prfop = { k:'other', text:'pldl1keep' };

function registerOffsetMem(amount) {
  return {
    k:'mem',
    text:`[x1, x2, lsl #${amount}]`,
    base:x(1),
    index:x(2),
    shift:{ op:'lsl', amount },
    mode:'offset',
    disp:null,
    addressDisp:null,
    writebackDisp:null,
  };
}

function lift(amount) {
  const instructionId = `arm64-prfm-register-offset:${amount}`;
  return liftArm64MachineEffects({
    instructionId,
    mnemonic:'prfm',
    ops:[prfop, registerOffsetMem(amount)],
    mode:'a64',
    origin:{ instructionIds:[instructionId] },
  });
}

for (const amount of [0, 3]) {
  const effects = lift(amount);
  assert.equal(effects?.completeness, 'exact-with-intrinsic', `PRFM LSL #${amount} must remain valid`);
  assert.ok(effects.operations.some((operation) => operation.kind === 'intrinsic'));
}

for (const amount of [1, 2, 4]) {
  const effects = lift(amount);
  assert.equal(effects?.completeness, 'partial', `PRFM LSL #${amount} is not encodable and must fail closed`);
  assert.match(effects.unknownEffects?.reason || '', /register-offset-shift-does-not-match-access-width/);
  assert.equal(effects.operations.length, 0, 'malformed PRFM must not emit architectural effects');
}

console.log('ARM64 PRFM register-offset validation: PASS');
