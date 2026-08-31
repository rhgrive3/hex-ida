from pathlib import Path

# #2807: shift descriptors are typed decoder evidence; do not Number/String-coerce them.
p=Path('js/targets/architecture/arm64/effects/common.js'); s=p.read_text()
repls=[
("""  function shiftImmediate(value, widthBits, kind, amount) {
    const n = Number(amount);
    if (!Number.isInteger(n) || n < 0 || n >= widthBits) return null;""",
 """  function shiftImmediate(value, widthBits, kind, amount) {
    const n = amount;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= widthBits) return null;"""),
("""    const kind = String(modifier.op || '').toLowerCase();
    const amount = modifier.amount == null ? 0 : Number(modifier.amount);""",
 """    if (typeof modifier.op !== 'string') return null;
    const kind = modifier.op.toLowerCase();
    const amount = modifier.amount == null ? 0 : modifier.amount;
    if (typeof amount !== 'number' || !Number.isInteger(amount)) return null;"""),
("""      const modifierKind = String(op.shift?.op || '').toLowerCase();""",
 """      const modifierKind = typeof op.shift?.op === 'string' ? op.shift.op.toLowerCase() : '';"""),
]
for old,new in repls:
    if old not in s: raise SystemExit('common shift anchor drift')
    s=s.replace(old,new,1)
p.write_text(s)

p=Path('js/targets/architecture/arm64/effects/addressing.js'); s=p.read_text()
old="""  const op = String(shift.op || '').toLowerCase();
  const amount = shift.amount == null ? 0 : Number(shift.amount);
  if (!Number.isInteger(amount) || amount < 0 || amount > 4) fail('arm64-invalid-register-offset-shift');"""
new="""  if (typeof shift.op !== 'string') fail('arm64-invalid-register-offset-shift');
  const op = shift.op.toLowerCase();
  const amount = shift.amount == null ? 0 : shift.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0 || amount > 4) fail('arm64-invalid-register-offset-shift');"""
if old not in s: raise SystemExit('addressing shift anchor drift')
s=s.replace(old,new,1)
p.write_text(s)

p=Path('js/targets/architecture/arm64/effects/index.js'); s=p.read_text()
old="return String(op.shift.op || '').toLowerCase() === 'lsl' && Number(op.shift.amount) === 12;"
new="return typeof op.shift.op === 'string' && op.shift.op.toLowerCase() === 'lsl' && typeof op.shift.amount === 'number' && Number.isInteger(op.shift.amount) && op.shift.amount === 12;"
if old not in s: raise SystemExit('index imm12 shift anchor drift')
s=s.replace(old,new,1)
old="""  const kind = String(operand.shift.op || '').toLowerCase();
  const amount = Number(operand.shift.amount ?? 0);
  return ['lsl','lsr','asr','ror'].includes(kind) && Number.isInteger(amount) && amount >= 0 && amount < widthBits;"""
new="""  if (typeof operand.shift.op !== 'string') return false;
  const kind = operand.shift.op.toLowerCase();
  const amount = operand.shift.amount ?? 0;
  return ['lsl','lsr','asr','ror'].includes(kind) && typeof amount === 'number' && Number.isInteger(amount) && amount >= 0 && amount < widthBits;"""
if old not in s: raise SystemExit('index logical shift anchor drift')
s=s.replace(old,new,1)
p.write_text(s)

p=Path('js/targets/architecture/arm64/effects/integer.js'); s=p.read_text()
repls=[
("return String(op.shift.op || '').toLowerCase() === 'lsl' && Number(op.shift.amount) === 12;",
 "return typeof op.shift.op === 'string' && op.shift.op.toLowerCase() === 'lsl' && typeof op.shift.amount === 'number' && Number.isInteger(op.shift.amount) && op.shift.amount === 12;"),
("""  const kind = String(modifier.op || '').toLowerCase();
  const amount = Number(modifier.amount ?? 0);
  if (!Number.isInteger(amount) || amount < 0 || amount > 4) return false;""",
 """  if (typeof modifier.op !== 'string') return false;
  const kind = modifier.op.toLowerCase();
  const amount = modifier.amount ?? 0;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0 || amount > 4) return false;"""),
("""  const kind = String(modifier.op || '').toLowerCase();
  const amount = Number(modifier.amount ?? 0);
  return ['lsl','lsr','asr'].includes(kind)
    && Number.isInteger(amount) && amount >= 0 && amount < targetBits;""",
 """  if (typeof modifier.op !== 'string') return false;
  const kind = modifier.op.toLowerCase();
  const amount = modifier.amount ?? 0;
  return ['lsl','lsr','asr'].includes(kind)
    && typeof amount === 'number' && Number.isInteger(amount) && amount >= 0 && amount < targetBits;"""),
("const explicitExtend = EXTEND_KINDS.has(String(modifier?.op || '').toLowerCase());",
 "const explicitExtend = typeof modifier?.op === 'string' && EXTEND_KINDS.has(modifier.op.toLowerCase());"),
("""  if (String(src.shift.op || '').toLowerCase() !== 'lsl') return false;
  const amount = Number(src.shift.amount);
  if (!Number.isInteger(amount)) return false;""",
 """  if (typeof src.shift.op !== 'string' || src.shift.op.toLowerCase() !== 'lsl') return false;
  const amount = src.shift.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount)) return false;"""),
]
for old,new in repls:
    if old not in s: raise SystemExit('integer shift anchor drift')
    s=s.replace(old,new,1)
p.write_text(s)

# #2809/#2866: system-register and barrier selectors must remain explicit strings.
p=Path('js/targets/architecture/arm64/effects/system.js'); s=p.read_text()
old="""function sysRegText(op) {
  if (!hasNoOperandModifier(op)) return null;
  const text = String(op?.text || '').trim().toLowerCase();
  return /^[a-z][a-z0-9_]*$/.test(text) ? text : null;
}"""
new="""function sysRegText(op) {
  if (!hasNoOperandModifier(op) || typeof op?.text !== 'string') return null;
  const text = op.text.trim().toLowerCase();
  return /^[a-z][a-z0-9_]*$/.test(text) ? text : null;
}"""
if old not in s: raise SystemExit('sysreg text anchor drift')
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
s=s.replace(old,new,1)
old="""  const scope = {
    architecture:'arm64',
    barrier:mnemonic,
    domain:String(operand?.text || instruction?.operands || 'sy').toLowerCase(),
    semantics:mnemonic === 'isb' ? 'instruction-synchronization' : mnemonic === 'dsb' ? 'data-synchronization' : 'data-memory-ordering',
  };"""
new="""  const textualOperand = operand == null ? null : textOperand(operand);
  const fallbackText = typeof instruction?.operands === 'string' ? instruction.operands.trim().toLowerCase() : null;
  const domain = operand == null ? (fallbackText || 'sy')
    : operand.k === 'imm' ? (fallbackText || `imm:${operand.value}`)
      : textualOperand;
  const scope = {
    architecture:'arm64',
    barrier:mnemonic,
    domain,
    semantics:mnemonic === 'isb' ? 'instruction-synchronization' : mnemonic === 'dsb' ? 'data-synchronization' : 'data-memory-ordering',
  };"""
if old not in s: raise SystemExit('barrier domain anchor drift')
s=s.replace(old,new,1)
p.write_text(s)

Path('tests/machine-effects/arm64-structured-shift-validation.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
let seq=0;
const gp=(num,bits=64,extra={})=>({k:'reg',cls:'gp',num,bits,text:`${bits===32?'w':'x'}${num}`,...extra});
const imm=(value,extra={})=>({k:'imm',value:BigInt(value),text:`#${value}`,...extra});
const mem=(shift)=>({k:'mem',base:gp(1),index:gp(2),mode:'offset',...(shift==null?{}:{shift})});
const lift=(mnemonic,ops)=>liftArm64MachineEffects({instructionId:`shift:${++seq}`,mnemonic,mode:'a64',ops,origin:{instructionIds:[`shift:${seq}`]}});
const fail=(bundle,label)=>{assert.ok(bundle,label);assert.equal(bundle.completeness,'partial',label);assert.ok(bundle.operations.every((op)=>op.kind==='unknown'),label);};
assert.notEqual(lift('add',[gp(0),gp(1),gp(2,64,{shift:{op:'lsl',amount:1}})]).completeness,'partial');
for(const shift of [{op:'lsl',amount:'1'},{op:'lsl',amount:true},{op:'lsl',amount:[1]},{op:'lsl',amount:1.5},{op:'lsl',amount:NaN},{op:'lsl',amount:Infinity},{op:{toString(){return 'lsl';}},amount:1}]) fail(lift('add',[gp(0),gp(1),gp(2,64,{shift})]),'malformed register shift');
assert.notEqual(lift('add',[gp(0),gp(1),imm(1,{shift:{op:'lsl',amount:12}})]).completeness,'partial');
fail(lift('add',[gp(0),gp(1),imm(1,{shift:{op:'lsl',amount:'12'}})]),'malformed immediate shift');
assert.notEqual(lift('ldr',[gp(0),mem({op:'lsl',amount:3})]).completeness,'partial');
fail(lift('ldr',[gp(0),mem({op:'lsl',amount:'3'})]),'malformed address shift');
console.log('arm64 structured shift #2807: PASS');
''')

Path('tests/machine-effects/arm64-system-selector-strict-validation.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
let seq=0;
const gp=(num)=>({k:'reg',cls:'gp',num,bits:64,text:`x${num}`});
const lift=(mnemonic,ops,extra={})=>liftArm64MachineEffects({instructionId:`sys:${++seq}`,mnemonic,mode:'a64',ops,origin:{instructionIds:[`sys:${seq}`]},...extra});
const fail=(bundle,label)=>{assert.ok(bundle,label);assert.equal(bundle.completeness,'partial',label);assert.ok(bundle.operations.every((op)=>op.kind==='unknown'),label);};
assert.notEqual(lift('mrs',[gp(0),{k:'sysreg',text:'nzcv'}]).completeness,'partial');
assert.notEqual(lift('msr',[{k:'sysreg',text:'fpcr'},gp(0)]).completeness,'partial');
for(const text of [['nzcv'],{toString(){return 'nzcv';}},true,1]) fail(lift('mrs',[gp(0),{k:'sysreg',text}]),'malformed MRS sysreg');
for(const text of [['fpcr'],{toString(){return 'fpcr';}},true,1]) fail(lift('msr',[{k:'sysreg',text},gp(0)]),'malformed MSR sysreg');
for(const [mnemonic,text] of [['dmb','sy'],['dsb','ish'],['isb','sy']]) assert.notEqual(lift(mnemonic,[{k:'other',text}]).completeness,'partial');
for(const malformed of [['sy'],{toString(){return 'sy';}},true,1]) {
  fail(lift('dmb',[{k:'other',text:malformed}]),'malformed DMB selector');
  fail(lift('dsb',[{k:'other',text:malformed}]),'malformed DSB selector');
  fail(lift('isb',[{k:'other',text:malformed}]),'malformed ISB selector');
}
console.log('arm64 system selectors #2809/#2866: PASS');
''')
