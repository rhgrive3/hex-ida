import assert from 'node:assert/strict';

import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

const x = (n) => ({ k:'reg', text:`x${n}`, cls:'gp', bits:64, num:n });
const prfop = { k:'other', text:'pldl1keep' };

function immediateMem(value) {
  const immediate = { k:'imm', text:`#${value}`, value:BigInt(value) };
  return {
    k:'mem', text:`[x1, #${value}]`, base:x(1), index:null, shift:null,
    mode:'offset', disp:immediate, addressDisp:immediate, writebackDisp:null,
  };
}

function lift(mnemonic, value) {
  const instructionId = `arm64-${mnemonic}-immediate:${value}`;
  return liftArm64MachineEffects({
    instructionId, mnemonic, ops:[prfop, immediateMem(value)], mode:'a64',
    origin:{ instructionIds:[instructionId] },
  });
}

for (const value of [0, 8, 32760]) {
  assert.equal(lift('prfm', value)?.completeness, 'exact-with-intrinsic', `PRFM #${value} must remain valid`);
}
for (const value of [-256, 0, 255]) {
  assert.equal(lift('prfum', value)?.completeness, 'exact-with-intrinsic', `PRFUM #${value} must remain valid`);
}

for (const value of [-8, 1, 32768]) {
  const effects = lift('prfm', value);
  assert.equal(effects?.completeness, 'partial', `PRFM #${value} is not encodable and must fail closed`);
  assert.match(effects.unknownEffects?.reason || '', /prfm-immediate-invalid/);
  assert.equal(effects.operations.length, 0);
}
for (const value of [-257, 256]) {
  const effects = lift('prfum', value);
  assert.equal(effects?.completeness, 'partial', `PRFUM #${value} is not encodable and must fail closed`);
  assert.match(effects.unknownEffects?.reason || '', /prfum-immediate-out-of-range/);
  assert.equal(effects.operations.length, 0);
}

console.log('ARM64 prefetch immediate validation: PASS');
