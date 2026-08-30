from pathlib import Path

p = Path('js/targets/architecture/arm64/effects/system.js')
s = p.read_text()
old = """function sysRegText(op) {\n  if (!hasNoOperandModifier(op)) return null;\n  const text = String(op?.text || '').trim().toLowerCase();\n  return /^[a-z][a-z0-9_]*$/.test(text) ? text : null;\n}\n"""
new = """function sysRegText(op) {\n  if (!hasNoOperandModifier(op) || typeof op?.text !== 'string') return null;\n  const text = op.text.trim().toLowerCase();\n  return /^[a-z][a-z0-9_]*$/.test(text) ? text : null;\n}\n"""
if old not in s:
    raise SystemExit('sysRegText anchor missing')
p.write_text(s.replace(old, new, 1))

Path('tests/machine-effects/arm64-system-register-text-validation.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

let seq=0;
const gp=(num)=>({k:'reg',cls:'gp',num,bits:64,text:`x${num}`});
const sys=(text,extra={})=>({k:'sysreg',text,...extra});
function lift(mnemonic,ops){
  const instructionId=`arm64-sysreg-text:${++seq}`;
  return liftArm64MachineEffects({instructionId,mnemonic,mode:'a64',ops,origin:{instructionIds:[instructionId]}});
}
function assertSemantic(bundle,label){
  assert.ok(bundle,label);
  assert.notEqual(bundle.completeness,'partial',`${label}: valid string sysreg remains semantic`);
  assert.ok(bundle.operations.some(op=>op.kind!=='unknown'),`${label}: definite operation remains`);
}
function assertFailClosed(bundle,label){
  assert.ok(bundle,label);
  assert.equal(bundle.completeness,'partial',`${label}: malformed sysreg is partial`);
  assert.ok(bundle.operations.every(op=>op.kind==='unknown'),`${label}: malformed sysreg emits no definite operation`);
}

assertSemantic(lift('mrs',[gp(0),sys('nzcv')]),'MRS NZCV');
assertSemantic(lift('msr',[sys('nzcv'),gp(0)]),'MSR NZCV');
assertSemantic(lift('mrs',[gp(0),sys('fpcr')]),'MRS FPCR');
assertSemantic(lift('msr',[sys('fpcr'),gp(0)]),'MSR FPCR');
assertSemantic(lift('mrs',[gp(0),sys('implementation_defined_reg')]),'MRS implementation-defined string');

for (const [label,text] of [
  ['object',{toString(){return 'nzcv';}}],
  ['array',['nzcv']],
  ['boolean',true],
  ['number',123],
  ['null',null],
]) {
  assertFailClosed(lift('mrs',[gp(0),sys(text)]),`MRS ${label}`);
  assertFailClosed(lift('msr',[sys(text),gp(0)]),`MSR ${label}`);
}
assertFailClosed(lift('mrs',[gp(0),sys('')]),'MRS empty');
assertFailClosed(lift('mrs',[gp(0),sys('   ')]),'MRS whitespace');
assertFailClosed(lift('mrs',[gp(0),sys('nzcv!',{})]),'MRS invalid identifier');
assertFailClosed(lift('mrs',[gp(0),sys('nzcv',{shift:{op:'lsl',amount:1}})]),'MRS modified sysreg');

console.log('arm64-system-register-text-validation: PASS');
''')
