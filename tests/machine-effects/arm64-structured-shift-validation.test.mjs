import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

let seq = 0;
const gp = (num, bits = 64, extra = {}) => ({ k:'reg', cls:'gp', num, bits, text:`${bits === 32 ? 'w' : 'x'}${num}`, ...extra });
const imm = (value, extra = {}) => ({ k:'imm', value:BigInt(value), text:`#${value}`, ...extra });
const mem = (shift) => ({ k:'mem', base:gp(1), index:gp(2), mode:'offset', ...(shift == null ? {} : {shift}) });
function lift(mnemonic, ops) {
  const instructionId = `arm64-structured-shift:${++seq}`;
  return liftArm64MachineEffects({ instructionId, mnemonic, mode:'a64', ops, origin:{instructionIds:[instructionId]} });
}
function assertSemantic(bundle, label) {
  assert.ok(bundle && bundle.completeness !== 'partial', `${label}: valid encoding remains semantic`);
  assert.ok(bundle.operations.some((op) => op.kind !== 'unknown'), `${label}: valid encoding emits definite operation`);
}
function assertFailClosed(bundle, label) {
  assert.ok(bundle, `${label}: family remains owned`);
  assert.equal(bundle.completeness, 'partial', `${label}: malformed shift descriptor is partial`);
  assert.ok(bundle.operations.every((op) => op.kind === 'unknown'), `${label}: malformed shift descriptor emits no definite operation`);
}

assertSemantic(lift('add', [gp(0), gp(1), gp(2, 64, {shift:{op:'lsl', amount:1}})]), 'ADD lsl #1');
for (const [label, shift] of [
  ['string amount', {op:'lsl', amount:'1'}],
  ['boolean amount', {op:'lsl', amount:true}],
  ['object amount', {op:'lsl', amount:{valueOf(){return 1;}}}],
  ['array amount', {op:'lsl', amount:[1]}],
  ['fraction amount', {op:'lsl', amount:1.5}],
  ['NaN amount', {op:'lsl', amount:NaN}],
  ['Infinity amount', {op:'lsl', amount:Infinity}],
  ['negative amount', {op:'lsl', amount:-1}],
  ['width amount', {op:'lsl', amount:64}],
  ['object op', {op:{toString(){return 'lsl';}}, amount:1}],
  ['array op', {op:['lsl'], amount:1}],
]) assertFailClosed(lift('add', [gp(0), gp(1), gp(2, 64, {shift})]), `ADD ${label}`);

assertSemantic(lift('add', [gp(0), gp(1), imm(1, {shift:{op:'lsl', amount:12}})]), 'ADD immediate lsl #12');
assertFailClosed(lift('add', [gp(0), gp(1), imm(1, {shift:{op:'lsl', amount:'12'}})]), 'ADD immediate string #12');
assertFailClosed(lift('add', [gp(0), gp(1), imm(1, {shift:{op:{toString(){return 'lsl';}}, amount:12}})]), 'ADD immediate object op');

assertSemantic(lift('movz', [gp(0), imm(1, {shift:{op:'lsl', amount:16}})]), 'MOVZ lsl #16');
assertFailClosed(lift('movz', [gp(0), imm(1, {shift:{op:'lsl', amount:'16'}})]), 'MOVZ string shift');

assertSemantic(lift('add', [gp(0), gp(1), gp(2, 32, {shift:{op:'uxtw', amount:1}})]), 'ADD extended uxtw #1');
assertFailClosed(lift('add', [gp(0), gp(1), gp(2, 32, {shift:{op:{toString(){return 'uxtw';}}, amount:1}})]), 'ADD object extend op');

assertSemantic(lift('ldr', [gp(0), mem({op:'lsl', amount:3})]), 'LDR register offset lsl #3');
assertFailClosed(lift('ldr', [gp(0), mem({op:'lsl', amount:'3'})]), 'LDR register offset string amount');
assertFailClosed(lift('ldr', [gp(0), mem({op:{toString(){return 'lsl';}}, amount:3})]), 'LDR register offset object op');

console.log('arm64-structured-shift-validation: PASS');
