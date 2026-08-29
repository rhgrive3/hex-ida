import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { liftArm64IntegerEffects } from '../../js/targets/architecture/arm64/effects/integer.js';

let sequence = 0;
function make(mnemonic, operands, mutate = null) {
  const ops = parseOperands(operands);
  mutate?.(ops);
  const instructionId = `arm64-bitfield-shape-${++sequence}`;
  return {instructionId,mnemonic,operands,ops,mode:'a64',origin:{instructionIds:[instructionId]}};
}
function assertExact(input) {
  const effect = liftArm64MachineEffects(input);
  assert.ok(effect, `${input.mnemonic}: effect required`);
  assert.notEqual(effect.completeness, 'partial', `${input.mnemonic}: legal register shape`);
}
function assertClosed(input) {
  for (const effect of [liftArm64MachineEffects(input), liftArm64IntegerEffects(input)]) {
    assert.ok(effect, `${input.mnemonic}: fail-closed effect required`);
    assert.equal(effect.completeness, 'partial', `${input.mnemonic}: invalid register shape must be partial`);
    assert.equal(effect.operations.length, 0, `${input.mnemonic}: invalid register shape must emit zero definite operations`);
  }
}

for (const input of [
  make('ubfm','w0, w1, #1, #7'),
  make('ubfm','x0, x1, #1, #7'),
  make('sbfm','xzr, x1, #1, #7'),
  make('ubfx','x0, xzr, #1, #8'),
  make('bfi','w0, wzr, #1, #8'),
  make('bfc','x0, #1, #8'),
]) assertExact(input);

for (const input of [
  make('ubfm','x0, w1, #1, #7'),
  make('sbfm','w0, x1, #1, #7'),
  make('ubfx','x0, w1, #1, #8'),
  make('bfi','x0, w1, #1, #8'),
  make('bfm','x0, x1, #1, #7',(ops)=>{ops[0].shift={op:'lsl',amount:1};}),
  make('bfxil','x0, x1, #1, #8',(ops)=>{ops[0].extend={op:'uxtw',amount:0};}),
  make('ubfiz','x0, x1, #1, #8',(ops)=>{ops[1].shift={op:'lsl',amount:1};}),
  make('sbfx','x0, x1, #1, #8',(ops)=>{ops[1].extend={op:'uxtw',amount:0};}),
  make('bfc','x0, #1, #8',(ops)=>{ops[0].shift={op:'lsl',amount:1};}),
]) assertClosed(input);

console.log('arm64 bitfield register shape: PASS');
