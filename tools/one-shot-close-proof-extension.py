from pathlib import Path

# #2807: dedicated focused regression matching the issue's final comment scope.
Path('tests/machine-effects/arm64-structured-shift-validation.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
let seq=0;
const gp=(num,bits=64,extra={})=>({k:'reg',cls:'gp',num,bits,text:`${bits===32?'w':'x'}${num}`,...extra});
const imm=(value,extra={})=>({k:'imm',value:BigInt(value),text:`#${value}`,...extra});
const mem=(shift)=>({k:'mem',base:gp(1),index:gp(2),mode:'offset',...(shift==null?{}:{shift})});
function lift(mnemonic,ops){const instructionId=`shift:${++seq}`;return liftArm64MachineEffects({instructionId,mnemonic,mode:'a64',ops,origin:{instructionIds:[instructionId]}});}
function semantic(r,label){assert.ok(r&&r.completeness!=='partial',label);assert.ok(r.operations.some(op=>op.kind!=='unknown'),label);}
function failClosed(r,label){assert.ok(r,label);assert.equal(r.completeness,'partial',label);assert.ok(r.operations.every(op=>op.kind==='unknown'),label);}
semantic(lift('add',[gp(0),gp(1),gp(2,64,{shift:{op:'lsl',amount:1}})]),'ADD lsl1');
for(const [label,shift] of [['string',{op:'lsl',amount:'1'}],['boolean',{op:'lsl',amount:true}],['object',{op:'lsl',amount:{valueOf(){return 1;}}}],['array',{op:'lsl',amount:[1]}],['fraction',{op:'lsl',amount:1.5}],['NaN',{op:'lsl',amount:NaN}],['Infinity',{op:'lsl',amount:Infinity}],['negative',{op:'lsl',amount:-1}],['width',{op:'lsl',amount:64}],['object-op',{op:{toString(){return 'lsl';}},amount:1}],['array-op',{op:['lsl'],amount:1}]]) failClosed(lift('add',[gp(0),gp(1),gp(2,64,{shift})]),label);
semantic(lift('add',[gp(0),gp(1),imm(1,{shift:{op:'lsl',amount:12}})]),'ADD imm lsl12');
failClosed(lift('add',[gp(0),gp(1),imm(1,{shift:{op:'lsl',amount:'12'}})]),'ADD imm string');
semantic(lift('movz',[gp(0),imm(1,{shift:{op:'lsl',amount:16}})]),'MOVZ 16');
failClosed(lift('movz',[gp(0),imm(1,{shift:{op:'lsl',amount:'16'}})]),'MOVZ string');
semantic(lift('ldr',[gp(0),mem({op:'lsl',amount:3})]),'LDR offset');
failClosed(lift('ldr',[gp(0),mem({op:'lsl',amount:'3'})]),'LDR string');
console.log('arm64-structured-shift-validation: PASS');
''')

# Runtime focused tests must assert structured error codes, not only Error.message.
p = Path('tests/phase10/runtime-unlinked-strict-boundaries.test.mjs')
s = p.read_text()
repls = {
    "assert.throws(()=>conservativeCompleteness(['complete']),/runtime-invalid-completeness/);":
        "assert.throws(()=>conservativeCompleteness(['complete']),(error)=>error?.code==='runtime-invalid-completeness');",
    "assert.throws(()=>bridge.eventToEvidence(event,null,{confidence:'0.9'}),/runtime-invalid-confidence/);":
        "assert.throws(()=>bridge.eventToEvidence(event,null,{confidence:'0.9'}),(error)=>error?.code==='runtime-invalid-confidence');",
    "assert.throws(()=>bridge.eventToEvidence(event,null,{confidence:true}),/runtime-invalid-confidence/);":
        "assert.throws(()=>bridge.eventToEvidence(event,null,{confidence:true}),(error)=>error?.code==='runtime-invalid-confidence');",
    "assert.throws(()=>bridge.linkClaim('c','e',['supports']),/runtime-invalid-evidence-relation/);":
        "assert.throws(()=>bridge.linkClaim('c','e',['supports']),(error)=>error?.code==='runtime-invalid-evidence-relation');",
}
for old,new in repls.items():
    if old not in s:
        raise SystemExit(f'runtime proof anchor drift: {old}')
    s = s.replace(old,new,1)
p.write_text(s)

# #2809 follow-up explicitly includes BTI through shared textOperand(). A valid
# BTI is exact only when mapped-page guard state is known; unknown page state is
# intentionally partial. Supply guarded-page authority so this test isolates
# selector typing rather than testing the separate BTI page-state contract.
p = Path('tests/machine-effects/arm64-barrier-authority-2866.test.mjs')
s = p.read_text()
needle = "console.log('ARM64 barrier/maintenance/CLREX authority #2866: PASS');"
if needle not in s:
    raise SystemExit('BTI proof anchor drift')
bti = r'''// #2809 shared system selector helper also owns BTI landing selectors.
{
  const liftBti=(text)=>{const instructionId=`barrier2866:bti:${++seq}`;return liftArm64MachineEffects({instructionId,mnemonic:'bti',mode:'a64',ops:[{k:'other',text}],origin:{instructionIds:[instructionId]}},{btiGuardedPage:true});};
  const valid=liftBti('c');
  assert.ok(valid);assert.notEqual(valid.completeness,'partial');
  assert.ok(valid.operations.some((op)=>op.intrinsicId==='arm64.system.bti'));
  for (const bad of [['c'],{toString(){return 'c';}},true,1]) {
    const malformed=liftBti(bad);
    assert.ok(malformed);assert.equal(malformed.completeness,'partial');
    assert.equal(malformed.operations.some((op)=>op.intrinsicId==='arm64.system.bti'),false);
  }
}

'''
s = s.replace(needle,bti+needle,1)
p.write_text(s)
