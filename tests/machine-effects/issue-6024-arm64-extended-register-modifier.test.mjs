import assert from 'node:assert/strict';

import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

function gp(num, bits = 64, modifiers = {}) {
  return {
    k:'reg',
    cls:'gp',
    num,
    bits,
    text:`${bits === 64 ? 'x' : 'w'}${num}`,
    ...modifiers,
  };
}

function lift(mnemonic, rhs, id = mnemonic) {
  return liftArm64MachineEffects({
    instructionId:`issue-6024:${id}`,
    architectureId:'arm64',
    mode:'a64',
    mnemonic,
    ops:[gp(0,64), gp(1,64), rhs],
    origin:{ instructionIds:[`issue-6024:${id}`] },
  });
}

function valueOps(bundle, opcode) {
  return bundle.operations.filter((operation) => operation.kind === 'value' && operation.opcode === opcode);
}

function assertExtensionChain(bundle, opcode, fromBits, amount) {
  assert.equal(bundle.completeness, 'exact', bundle.unknownEffects?.reason);
  const extensions = valueOps(bundle, opcode).filter((operation) =>
    operation.metadata?.fromBits === fromBits && operation.metadata?.toBits === 64);
  assert.equal(extensions.length, 1, `${opcode} ${fromBits}->64 must be emitted exactly once`);
  const extension = extensions[0];
  if (amount === 0) return extension;

  const shifts = valueOps(bundle, 'shl').filter((operation) => operation.metadata?.amount === amount);
  assert.equal(shifts.length, 1, `post-extend shift #${amount} must be emitted exactly once`);
  assert.deepEqual(shifts[0].inputs[0], extension.outputs[0], 'shift must consume the extended value');
  return shifts[0];
}

const sxtw = lift('add', gp(2,32,{ extend:{ op:'sxtw', amount:1 } }), 'add-sxtw-extend-field');
const shiftedSigned = assertExtensionChain(sxtw, 'sext', 32, 1);
const addSxtw = valueOps(sxtw, 'add');
assert.equal(addSxtw.length, 1);
assert.deepEqual(addSxtw[0].inputs[1], shiftedSigned.outputs[0], 'ADD must consume the shifted SXTW value');

const sxtwZero = lift('add', gp(2,32,{ extend:{ op:'sxtw', amount:0 } }), 'add-sxtw-zero');
assertExtensionChain(sxtwZero, 'sext', 32, 0);
assert.equal(valueOps(sxtwZero, 'shl').length, 0);

const uxtw = lift('add', gp(2,32,{ extend:{ op:'uxtw', amount:4 } }), 'add-uxtw-four');
assertExtensionChain(uxtw, 'zext', 32, 4);

for (const [kind, opcode, fromBits] of [
  ['sxtb','sext',8],
  ['sxth','sext',16],
  ['uxtb','zext',8],
  ['uxth','zext',16],
]) {
  const bundle = lift('add', gp(2,32,{ extend:{ op:kind, amount:1 } }), `add-${kind}`);
  assertExtensionChain(bundle, opcode, fromBits, 1);
}

const shiftedRepresentation = lift('add', gp(2,32,{ shift:{ op:'sxtw', amount:1 } }), 'existing-shift-representation');
assertExtensionChain(shiftedRepresentation, 'sext', 32, 1);

const subs = lift('subs', gp(2,32,{ extend:{ op:'sxtw', amount:1 } }), 'subs-sxtw');
assertExtensionChain(subs, 'sext', 32, 1);
assert.equal(subs.operations.filter((operation) => operation.kind === 'flag-write').length, 4);

for (const ambiguous of [
  gp(2,32,{ shift:{ op:'lsl', amount:1 }, extend:{ op:'sxtw', amount:1 } }),
  gp(2,32,{ shift:{ op:'sxtw', amount:1 }, extend:{ op:'uxtw', amount:1 } }),
]) {
  const bundle = lift('add', ambiguous, 'ambiguous-modifiers');
  assert.equal(bundle.completeness, 'partial');
  assert.equal(bundle.operations.length, 0, 'conflicting modifier authorities must fail before definite operations');
}

const invalidMulExtend = lift('mul', gp(2,64,{ extend:{ op:'sxtx', amount:1 } }), 'mul-invalid-extend');
assert.equal(invalidMulExtend.completeness, 'partial');
assert.equal(invalidMulExtend.operations.length, 0, 'non-ADD/SUB extend must fail before definite operations');

const plainMul = lift('mul', gp(2,64), 'plain-mul');
assert.equal(plainMul.completeness, 'exact', plainMul.unknownEffects?.reason);
assert.equal(valueOps(plainMul, 'mul').length, 1);

const plain = lift('add', gp(2,64), 'plain-x-register');
assert.equal(plain.completeness, 'exact', plain.unknownEffects?.reason);
assert.equal(plain.metadata?.family, 'integer');

console.log('issue #6024 ARM64 extended-register modifier semantics: PASS');
