import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { liftArm64IntegerEffects } from '../../js/targets/architecture/arm64/effects/integer.js';

let sequence = 0;
function make(mnemonic, operands, index, field = 'extend') {
  const ops = parseOperands(operands);
  if (index != null) ops[index][field] = field === 'extend' ? {op:'uxtw',amount:0} : {op:'lsl',amount:1};
  const instructionId = `arm64-scalar-imm-mod-${++sequence}`;
  return {instructionId,mnemonic,operands,ops,mode:'a64',origin:{instructionIds:[instructionId]}};
}
function exact(input) {
  const effect = liftArm64MachineEffects(input);
  assert.ok(effect);
  assert.notEqual(effect.completeness,'partial',`${input.mnemonic} legal boundary`);
}
function closed(input) {
  for (const effect of [liftArm64MachineEffects(input), liftArm64IntegerEffects(input)]) {
    assert.ok(effect);
    assert.equal(effect.completeness,'partial',`${input.mnemonic} modifier must fail closed`);
    assert.equal(effect.operations.length,0,`${input.mnemonic} invalid modifier must emit zero definite operations`);
  }
}
for (const input of [
  make('lsl','w0, w1, #31'), make('lsl','x0, x1, #63'),
  make('extr','w0, w1, w2, #31'), make('extr','x0, x1, x2, #63'),
  make('ubfm','x0, x1, #0, #63'), make('sbfm','w0, w1, #31, #31'),
  make('ubfx','x0, x1, #0, #64'), make('bfc','x0, #0, #64'),
]) exact(input);
for (const [mnemonic,operands,index,field] of [
  ['lsl','x0, x1, #1',2,'extend'], ['lsr','w0, w1, #1',2,'shift'],
  ['asr','x0, x1, #1',2,'extend'], ['ror','x0, x1, #1',2,'shift'],
  ['extr','x0, x1, x2, #1',3,'extend'],
  ['ubfm','x0, x1, #1, #7',2,'extend'], ['sbfm','x0, x1, #1, #7',3,'shift'],
  ['bfm','x0, x1, #1, #7',2,'shift'], ['ubfx','x0, x1, #1, #8',2,'extend'],
  ['sbfx','x0, x1, #1, #8',3,'shift'], ['ubfiz','x0, x1, #1, #8',2,'shift'],
  ['sbfiz','x0, x1, #1, #8',3,'extend'], ['bfxil','x0, x1, #1, #8',2,'extend'],
  ['bfi','x0, x1, #1, #8',3,'shift'], ['bfc','x0, #1, #8',1,'extend'],
]) closed(make(mnemonic,operands,index,field));
console.log('arm64 scalar immediate modifiers: PASS');
