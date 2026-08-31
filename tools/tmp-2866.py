from pathlib import Path
p=Path('js/targets/architecture/arm64/effects/system.js')
s=p.read_text()
old="""function barrier(instruction, context, mnemonic, ops) {
  const operand = ops[0];
  const scope = {
    architecture:'arm64',
    barrier:mnemonic,
    domain:String(operand?.text || instruction?.operands || 'sy').toLowerCase(),
    semantics:mnemonic === 'isb' ? 'instruction-synchronization' : mnemonic === 'dsb' ? 'data-synchronization' : 'data-memory-ordering',
  };"""
new="""function barrier(instruction, context, mnemonic, ops) {
  const operand = ops[0];
  let domain = 'sy';
  if (operand?.k === 'imm') {
    domain = typeof operand.text === 'string' && operand.text.trim()
      ? operand.text.trim().toLowerCase()
      : `#${BigInt(operand.value).toString()}`;
  } else if (operand != null) {
    domain = textOperand(operand);
    if (!domain) return partial(instruction, context, `${mnemonic}-operand-shape-invalid`, ['other']);
  }
  const scope = {
    architecture:'arm64',
    barrier:mnemonic,
    domain,
    semantics:mnemonic === 'isb' ? 'instruction-synchronization' : mnemonic === 'dsb' ? 'data-synchronization' : 'data-memory-ordering',
  };"""
if old not in s: raise SystemExit('barrier anchor drift')
s=s.replace(old,new,1)
old="""function textOperand(op) {
  if (!hasNoOperandModifier(op)) return null;
  const text = String(op?.text || '').trim().toLowerCase();
  return text || null;
}"""
new="""function textOperand(op) {
  if (!hasNoOperandModifier(op) || typeof op?.text !== 'string') return null;
  const text = op.text.trim().toLowerCase();
  return text || null;
}"""
if old not in s: raise SystemExit('textOperand anchor drift')
p.write_text(s.replace(old,new,1))

Path('tests/machine-effects/arm64-barrier-selector-strict.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

let seq=0;
function lift(mnemonic,ops){
  const instructionId=`barrier:${++seq}`;
  return liftArm64MachineEffects({instructionId,mnemonic,mode:'a64',ops,origin:{instructionIds:[instructionId]}});
}
function assertPartialNoBarrier(result,label){
  assert.equal(result?.completeness,'partial',label);
  assert.equal(result.operations.some((op)=>op.kind==='barrier'),false,label);
}
for (const text of [['sy'],{toString(){return 'ish';}},true,1]) {
  assertPartialNoBarrier(lift('dmb',[{k:'other',text}]),'DMB malformed selector');
}
for (const [mnemonic,text] of [['dmb','sy'],['dmb','ish'],['dmb','ishst'],['dsb','synxs'],['isb','sy']]) {
  const result=lift(mnemonic,[{k:'other',text}]);
  assert.equal(result.completeness,'exact',`${mnemonic} ${text}`);
  assert.equal(result.operations.some((op)=>op.kind==='barrier'),true,`${mnemonic} ${text}`);
}
const immediate=lift('dmb',[{k:'imm',value:15n,text:'#15'}]);
assert.equal(immediate.completeness,'exact');
assert.equal(immediate.operations.some((op)=>op.kind==='barrier'),true);
assertPartialNoBarrier(lift('dmb',[{k:'other',text:'bogus'}]),'unknown selector');
console.log('arm64-barrier-selector-strict: PASS');
''')
