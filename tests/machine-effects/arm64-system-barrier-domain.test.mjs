import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64SystemEffects } from '../../js/targets/architecture/arm64/effects/system.js';
let sequence=0;
function lift(mnemonic,operands=''){const instructionId=`arm64-system-barrier-domain-${++sequence}`;return liftArm64SystemEffects({instructionId,mnemonic,operands,ops:parseOperands(operands),mode:'a64',origin:{instructionIds:[instructionId]}});}
for(const [m,o] of [['dmb',''],['dmb','sy'],['dmb','ish'],['dmb','#0'],['dmb','#15'],['dsb',''],['dsb','sy'],['dsb','oshnxs'],['dsb','nshnxs'],['dsb','ishnxs'],['dsb','synxs'],['dsb','#0'],['dsb','#4'],['dsb','#15'],['isb',''],['isb','sy'],['isb','#0'],['isb','#15']]){const e=lift(m,o);assert.ok(e);assert.notEqual(e.completeness,'partial');assert.equal(e.operations.some(x=>x.kind==='barrier'),true);}
for(const [m,o] of [['dmb','foo'],['dsb','foo'],['isb','foo'],['dmb','oshnxs'],['isb','synxs'],['dmb','#-1'],['dsb','#16'],['isb','#999'],['dmb','sy, lsl #1'],['dsb','#1, lsl #1'],['isb','sy, uxtw'],['dmb','x0'],['isb','sy, x0']]){const e=lift(m,o);assert.ok(e);assert.equal(e.completeness,'partial');assert.equal(e.operations.some(x=>x.kind==='barrier'),false);}
console.log('arm64 system barrier domain: PASS');
