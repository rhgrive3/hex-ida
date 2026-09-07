import test from 'node:test';
import assert from 'node:assert/strict';
import { symbolicExecute } from '../../../js/symbolic/index.js';
import { OP } from '../../../js/ir-base.js';
import { identity } from '../taint/fixtures.mjs';
function fixture(executed = true) {
  const input={id:'input',kind:'arg',index:0,reg:'x0',bits:8},zero={id:'zero',const:0n,bits:8},flags={id:'flags',bits:1};
  const compare={id:'cmp',op:OP.CMP,cond:'eq',args:[{value:input},{value:zero}],dst:flags,row:0,address:0n};flags.def=compare;
  const branch={id:'branch',op:OP.CBR,cond:'eq',args:[{value:flags}],extra:{target:8n},row:1,address:4n};
  const yes={id:'yes',op:OP.RET,args:[{value:{id:'one',const:1n,bits:8}}],row:2,address:8n};
  const no={id:'no',op:OP.RET,args:[{value:zero}],row:3,address:12n};
  const ir={entry:0,blocks:[{index:0,insts:executed?[compare,branch]:[branch],succ:[1,2]},{index:1,insts:[yes],succ:[]},{index:2,insts:[no],succ:[]}]};
  return {ir,branch,input,compare};
}
const run=(ir,extra={})=>symbolicExecute(ir,{byteMemory:{identity},...extra});
test('a branch cannot re-evaluate a flags definition which never executed',()=>{
  const {ir}=fixture(false),result=run(ir);
  assert.equal(result.status,'partial');assert.deepEqual(result.paths,[]);
  assert.equal(result.reason,'value-definition-not-executed');
});
test('branch operands and flags carriers are not silently dropped or chosen by first-match',()=>{
  for(const kind of ['cbz','cbnz','tbz','tbnz',null]) {
    const {ir,branch,input}=fixture();
    if(kind){branch.extra.kind=kind;branch.extra.bit=0;branch.args=[{value:input}];}
    branch.args.push({value:input});
    const result=run(ir);assert.equal(result.status,'partial',kind);assert.equal(result.reason,'branch-operand-arity');
  }
});
test('executed comparison carriers retain signed and equality branch behavior',()=>{
  for(const value of [0n,1n,255n]) {
    const {ir}=fixture(),result=run(ir,{symbolicArgs:{0:value}});
    assert.equal(result.status,'complete',result.reason);
    assert.equal(result.paths[0].returnValue.value,value===0n?1n:0n);
  }
});
