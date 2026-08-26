import assert from 'node:assert/strict';

import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

const x = (num) => ({ k:'reg', text:`x${num}`, cls:'gp', bits:64, num });
const mem = { k:'mem', text:'[x1]', base:x(1), index:null, mode:'offset', disp:null };
const literal = { k:'imm', text:'#0x1000', value:0x1000n };
const prfop = { k:'other', text:'pldl1keep' };
let sequence = 0;

function lift(mnemonic, ops, extra = {}) {
  const instructionId = `arm64-prefetch-shape:${sequence++}`;
  return liftArm64MachineEffects({
    instructionId,
    mnemonic,
    ops,
    mode:'a64',
    address:0x1000n,
    origin:{ instructionIds:[instructionId] },
    ...extra,
  });
}

for (const effect of [
  lift('prfm', [prfop, mem]),
  lift('prfum', [prfop, mem]),
  lift('prfm', [prfop, literal], { literalTarget:0x1000n }),
  lift('prfm', [mem], { word:0xf9800020 }),
  lift('prfm', [literal], { word:0xd8000000, literalTarget:0x1000n }),
]) {
  assert.equal(effect?.completeness, 'exact-with-intrinsic');
}

for (const effect of [
  lift('prfm', [prfop, mem, x(2)]),
  lift('prfum', [prfop, mem, literal]),
  lift('prfm', [prfop, literal, x(2)], { literalTarget:0x1000n }),
  lift('prfm', [mem, x(2)], { word:0xf9800020 }),
  lift('prfm', [literal, mem], { word:0xd8000000, literalTarget:0x1000n }),
  lift('prfm', [prfop, mem, literal], { literalTarget:0x1000n }),
]) {
  assert.equal(effect?.completeness, 'partial');
  assert.equal(effect?.unknownEffects?.reason, 'prefetch instruction operand shape is invalid');
  assert.equal(effect?.operations.length, 0);
}

console.log('ARM64 prefetch operand-shape validation: PASS');
