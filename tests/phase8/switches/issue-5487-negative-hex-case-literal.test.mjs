import assert from 'node:assert/strict';
import test from 'node:test';
import { structureKnownSwitches } from '../../../js/decompiler/switch.js';
function run(values) {
  const result={lines:[{kind:'stmt',row:5,indent:1,text:'__asm("br x0");'},{kind:'stmt',row:10,indent:1,text:'A();'},{kind:'stmt',row:20,indent:1,text:'B();'},{kind:'ctrl',row:30,indent:0,text:'}'}],ir:{blocks:[]},evidence:[],warnings:[],ctx:{}};
  const model={instructions:[{row:10,address:0x1000n},{row:20,address:0x2000n}]};
  structureKnownSwitches(result,model,{switches:[{row:5,expr:'x0',cases:[{value:values[0],address:0x1000n},{value:values[1],address:0x2000n}]}]});
  return result;
}
test('#5487 signed hexadecimal cases structure like equivalent integers', () => {
  const result=run(['-0x1','0x2']);
  assert.equal(result.ctx.structuredSwitches,1);
  assert.ok(result.lines.some((line)=>line.text==='case -0x1: goto loc_1000;'));
});
test('#5487 malformed signed literals fail closed', () => {
  for (const bad of ['--1','- 0x1','+1','0x-1']) {
    const result=run([bad,'2']);
    assert.equal(result.ctx.structuredSwitches,undefined, bad);
  }
});
test('#5487 numeric identity still deduplicates notation-equivalent cases', () => {
  const result=run(['-0x1','-1']);
  assert.equal(result.ctx.structuredSwitches,undefined);
  assert.ok(result.evidence.some((entry)=>entry.op==='switch-conflict'));
});
