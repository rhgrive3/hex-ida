import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { ARM64E_ARCHITECTURE } from '../../js/targets/architecture/index.js';
let sequence = 0;
function lift(mnemonic, operands, mutate = null) {
  const ops = parseOperands(operands); mutate?.(ops);
  const instructionId = `arm64e-pauth-modifier-${++sequence}`;
  return ARM64E_ARCHITECTURE.liftExact({ instructionId, mnemonic, operands, ops, mode:'arm64e', address:0x1000n + BigInt(sequence * 4), origin:{ instructionIds:[instructionId] } });
}
for (const [mnemonic, operands] of [
  ['pacia','x0, x1'], ['pacia','x0, sp'], ['paciza','x0'], ['xpaci','x0'],
  ['pacga','x0, x1, x2'], ['pacga','x0, x1, sp'], ['braa','x16, x17'], ['braa','x16, sp'], ['braaz','x16'], ['blraa','x16, sp'],
]) {
  const effect=lift(mnemonic,operands); assert.ok(effect); assert.notEqual(effect.completeness,'partial'); assert.notEqual(effect.metadata?.failClosed,true);
}
for (const [mnemonic, operands] of [
  ['pacia','x0, x1, lsl #1'], ['autia','x0, x1, uxtw'], ['paciza','x0, lsl #1'], ['xpaci','x0, lsl #1'], ['pacga','x0, x1, x2, lsl #1'], ['braa','x16, x17, lsl #1'], ['blraa','x16, sp, lsl #1'], ['braaz','x16, lsl #1'],
]) {
  const effect=lift(mnemonic,operands); assert.equal(effect.completeness,'partial'); assert.equal(effect.metadata?.failClosed,true); assert.equal(effect.operations.length,0);
}
for (const [mnemonic, operands, index] of [
  ['pacia','x0, x1',0], ['pacia','x0, x1',1], ['pacga','x0, x1, x2',0], ['pacga','x0, x1, x2',1], ['pacga','x0, x1, x2',2], ['braa','x16, x17',0], ['braa','x16, x17',1],
]) {
  const effect=lift(mnemonic,operands,(ops)=>{ops[index].extend={op:'uxtw',amount:0};}); assert.equal(effect.completeness,'partial'); assert.equal(effect.metadata?.failClosed,true); assert.equal(effect.operations.length,0);
}
console.log('arm64e PAuth register modifier validation: PASS');
