from pathlib import Path


def edit(path, replacements):
    p = Path(path)
    s = p.read_text()
    for old, new, label in replacements:
        if old not in s:
            raise SystemExit(f'{path}: anchor drift: {label}')
        s = s.replace(old, new, 1)
    p.write_text(s)


# #2866 scope was expanded by issue comments: textOperand also owns maintenance
# selectors, and atomic.js is the production-first owner for DMB/DSB/ISB + CLREX.
edit('js/targets/architecture/arm64/effects/system.js', [
    ("""function textOperand(op) {
  if (!hasNoOperandModifier(op)) return null;
  const text = String(op?.text || '').trim().toLowerCase();
  return text || null;
}""",
     """function textOperand(op) {
  if (!hasNoOperandModifier(op) || typeof op?.text !== 'string') return null;
  const text = op.text.trim().toLowerCase();
  return text || null;
}""", 'system textOperand string authority'),
    ("""  const allowed = mnemonic === 'dsb'
    ? new Set([...DATA_BARRIER_OPTIONS, ...DSB_NXS_OPTIONS])
    : DATA_BARRIER_OPTIONS;""",
     """  const allowed = mnemonic === 'dsb'
    ? new Set([...DATA_BARRIER_OPTIONS, ...DSB_NXS_OPTIONS])
    : mnemonic === 'dmb' ? DATA_BARRIER_OPTIONS : new Set(['sy']);""", 'ISB finite selector domain'),
])

edit('js/targets/architecture/arm64/effects/atomic.js', [
    ("""function immediateValue(operand) {
  if (operand?.shift != null || operand?.extend != null) return null;
  const raw = operand?.value;
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number' && Number.isSafeInteger(raw)) return BigInt(raw);
  const text = typeof raw === 'string' ? raw : operand?.text;
  const normalized = String(text || '').trim().replace(/^#/, '');
  if (/^(?:0x[0-9a-f]+|\\d+)$/i.test(normalized)) return BigInt(normalized);
  return null;
}""",
     """function immediateValue(operand) {
  if (operand?.shift != null || operand?.extend != null) return null;
  return typeof operand?.value === 'bigint' ? operand.value : null;
}""", 'atomic canonical immediate'),
    ("""function barrierOption(decoded) {
  const op = operands(decoded)[0];
  if (op && (op.shift != null || op.extend != null)) return null;
  const raw = String(op?.text || op?.value || decoded?.barrierOption || decoded?.operandsText || '').trim().toLowerCase();
  return raw.replace(/^#/, '') || 'sy';
}""",
     """function barrierOption(decoded) {
  const op = operands(decoded)[0];
  if (!op || op.shift != null || op.extend != null || typeof op.text !== 'string') return null;
  const option = op.text.trim().toLowerCase().replace(/^#/, '');
  if (!option) return null;
  for (const fallback of [decoded?.barrierOption, decoded?.operandsText]) {
    if (fallback == null) continue;
    if (typeof fallback !== 'string') return null;
    const normalized = fallback.trim().toLowerCase().replace(/^#/, '');
    if (normalized && normalized !== option) return null;
  }
  return option;
}""", 'atomic barrier selector'),
])

Path('tests/machine-effects/arm64-barrier-authority-2866.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { liftArm64AtomicEffects } from '../../js/targets/architecture/arm64/effects/atomic.js';
import { liftArm64SystemEffects } from '../../js/targets/architecture/arm64/effects/system.js';

let seq=0;
const ctx=()=>({instructionId:`barrier2866:${++seq}`,architectureId:'arm64',mode:'a64',origin:{instructionIds:[`barrier2866:${seq}`]}});
const decoded=(mnemonic,ops,extra={})=>({instructionId:`barrier2866:${seq+1}`,mnemonic,mode:'a64',ops,...extra});
const publicLift=(mnemonic,ops,extra={})=>{const instructionId=`barrier2866:public:${++seq}`;return liftArm64MachineEffects({instructionId,mnemonic,mode:'a64',ops,...extra,origin:{instructionIds:[instructionId]}});};
const definiteBarrier=(bundle)=>bundle?.operations?.filter((op)=>op.kind==='barrier')||[];
const definiteMonitorClear=(bundle)=>bundle?.operations?.filter((op)=>op.intrinsicId==='arm64.exclusive-monitor-clear')||[];
const failBarrier=(bundle,label)=>{assert.ok(bundle,label);assert.equal(bundle.completeness,'partial',label);assert.equal(definiteBarrier(bundle).length,0,label);};

for (const [mnemonic,text] of [['dmb','sy'],['dmb','ish'],['dmb','ishst'],['dsb','ish'],['isb','sy']]) {
  const bundle=publicLift(mnemonic,[{k:'other',text}]);
  assert.notEqual(bundle.completeness,'partial',`${mnemonic} ${text}`);
  assert.equal(definiteBarrier(bundle).length,1,`${mnemonic} ${text}`);
}
for (const value of [0n,1n,14n,15n]) {
  const bundle=publicLift('dmb',[{k:'imm',value,text:`#${value}`}]);
  assert.notEqual(bundle.completeness,'partial',`DMB crm ${value}`);
  assert.equal(definiteBarrier(bundle).length,1,`DMB crm ${value}`);
}
for (const bad of [['sy'],{toString(){return 'ish';}},true,1]) {
  for (const mnemonic of ['dmb','dsb','isb']) failBarrier(publicLift(mnemonic,[{k:'other',text:bad}]),`${mnemonic} malformed text`);
}
for (const bad of [['15'],{toString(){return '15';}},true,15,'15']) {
  failBarrier(publicLift('dmb',[{k:'imm',value:bad,text:Array.isArray(bad)?bad:['15']}]),'DMB malformed immediate authority');
}
failBarrier(publicLift('dmb',[{k:'other',text:'ish'}],{operandsText:'sy'}),'structured/fallback contradiction');
failBarrier(publicLift('isb',[{k:'other',text:'ish'}]),'ISB only accepts sy');
failBarrier(publicLift('dmb',[{k:'other',text:'bogus'}]),'unknown selector');
failBarrier(publicLift('dmb',[{k:'other',text:'sy',shift:{op:'lsl',amount:0}}]),'modifier selector');

// Explicit owner probes: system text authority (barrier + maintenance) and atomic owner.
for (const owner of [liftArm64AtomicEffects,liftArm64SystemEffects]) {
  const instructionId=`barrier2866:owner:${++seq}`;
  const bundle=owner({instructionId,mnemonic:'dmb',mode:'a64',ops:[{k:'other',text:['sy']}],origin:{instructionIds:[instructionId]}},{instructionId,architectureId:'arm64',mode:'a64',origin:{instructionIds:[instructionId]}});
  failBarrier(bundle,'owner malformed barrier text');
}
{
  const instructionId=`barrier2866:maint:${++seq}`;
  const bundle=liftArm64SystemEffects({instructionId,mnemonic:'dc',mode:'a64',ops:[{k:'other',text:['cvau']},{k:'reg',cls:'gp',num:0,bits:64,text:'x0'}],origin:{instructionIds:[instructionId]}},{instructionId,architectureId:'arm64',mode:'a64',origin:{instructionIds:[instructionId]}});
  assert.ok(bundle);assert.equal(bundle.completeness,'partial');assert.equal(bundle.operations.some((op)=>op.kind==='intrinsic'&&String(op.intrinsicId||'').includes('maintenance')),false);
}

// CLREX is dispatched through atomic.js first. Only canonical bigint imm4 or no operand is authoritative.
for (const ops of [[],[{k:'imm',value:0n,text:'#0'}],[{k:'imm',value:15n,text:'#15'}]]) {
  const bundle=publicLift('clrex',ops);
  assert.notEqual(bundle.completeness,'partial');
  assert.equal(definiteMonitorClear(bundle).length,1);
}
for (const bad of ['15',15,true,['15'],{valueOf(){return 15;}}]) {
  const bundle=publicLift('clrex',[{k:'imm',value:bad,text:typeof bad==='string'?bad:'#15'}]);
  assert.ok(bundle);assert.equal(bundle.completeness,'partial');assert.equal(definiteMonitorClear(bundle).length,0);
}

console.log('ARM64 barrier/maintenance/CLREX authority #2866: PASS');
''')
