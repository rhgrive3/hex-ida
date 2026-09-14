import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

let sequence = 0;
function lift(mnemonic, bits, bit) {
  const instructionId = `arm64-tbz-bit-domain-${++sequence}`;
  const target = 0x1800n;
  return liftArm64MachineEffects({
    instructionId,
    mnemonic,
    address:0x1000n,
    branchTarget:target,
    mode:'a64',
    ops:[
      { k:'reg', cls:'gp', num:0, bits, text:`${bits === 32 ? 'w' : 'x'}0` },
      { k:'imm', value:BigInt(bit), text:`#${bit}` },
      { k:'imm', value:target, text:'0x1800' },
    ],
    origin:{ instructionIds:[instructionId] },
  });
}

const btypeWrite = (effect) => effect.operations.some((operation) =>
  operation.kind === 'register-write' && operation.register?.registerId === 'pstate.btype');

for (const [mnemonic, bits, bit] of [
  ['tbz', 32, 32],
  ['tbnz', 32, 63],
  ['tbz', 64, 64],
  ['tbnz', 64, -1],
]) {
  const effect = lift(mnemonic, bits, bit);
  assert.equal(effect.completeness, 'partial', `${mnemonic} ${bits}/#${bit} must fail closed`);
  assert.equal(effect.operations.length, 0, `${mnemonic} ${bits}/#${bit} must emit no definite operations`);
  assert.equal(btypeWrite(effect), false, `${mnemonic} ${bits}/#${bit} must not reset BTYPE`);
}

for (const [mnemonic, bits, bit] of [
  ['tbz', 32, 0],
  ['tbz', 32, 31],
  ['tbnz', 64, 0],
  ['tbnz', 64, 63],
]) {
  const effect = lift(mnemonic, bits, bit);
  assert.ok(['exact','exact-with-intrinsic'].includes(effect.completeness), `${mnemonic} ${bits}/#${bit} must remain exact`);
  assert.equal(btypeWrite(effect), true, `${mnemonic} ${bits}/#${bit} must retain direct BTYPE reset`);
}

console.log('arm64 TBZ/TBNZ bit domain BTYPE: PASS');
