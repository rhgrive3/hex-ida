import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

let sequence = 0;
function liftDirect(mnemonic, address, target) {
  const instructionId = `arm64-btype-invalid-direct-${++sequence}`;
  const operand = { k:'imm', value:BigInt(target), text:`0x${BigInt(target).toString(16)}` };
  return liftArm64MachineEffects({
    instructionId,
    mnemonic,
    address:BigInt(address),
    branchTarget:BigInt(target),
    callTarget:BigInt(target),
    ops:[operand],
    mode:'a64',
    origin:{ instructionIds:[instructionId] },
  });
}

function hasBtypeWrite(effect) {
  return effect.operations.some((operation) =>
    operation.kind === 'register-write' && operation.register?.registerId === 'pstate.btype');
}

for (const [mnemonic, address, target] of [
  ['b', 0x1000n, 0x1002n],
  ['bl', 0x1000n, 0x1002n],
  ['b.eq', 0x1000n, 0x1002n],
]) {
  const effect = liftDirect(mnemonic, address, target);
  assert.ok(effect, `${mnemonic}: effect required`);
  assert.equal(effect.completeness, 'partial', `${mnemonic}: misaligned target must be partial`);
  assert.equal(hasBtypeWrite(effect), false, `${mnemonic}: encoding-invalid target must not write BTYPE`);
}

for (const [mnemonic, address, target] of [
  ['b', 0x1000n, 0x100000000n],
  ['b.eq', 0x1000n, 0x400000n],
]) {
  const effect = liftDirect(mnemonic, address, target);
  assert.ok(effect, `${mnemonic}: effect required`);
  assert.equal(effect.completeness, 'partial', `${mnemonic}: out-of-range target must be partial`);
  assert.equal(hasBtypeWrite(effect), false, `${mnemonic}: out-of-range encoding must not write BTYPE`);
}

{
  const effect = liftDirect('b', 0x1000n, 0x2000n);
  assert.ok(effect, 'valid B effect required');
  assert.ok(['exact','exact-with-intrinsic'].includes(effect.completeness), 'valid B must remain exact');
  assert.equal(hasBtypeWrite(effect), true, 'valid direct B must retain BTYPE=0 reset');
}

console.log('arm64 BTYPE invalid direct encoding: PASS');
