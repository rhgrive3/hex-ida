import test from 'node:test';
import assert from 'node:assert/strict';
import { symbolicExecute, createByteMemory, expr as E } from '../../../js/symbolic/index.js';
import { OP } from '../../../js/ir-base.js';
import { identity } from './main-fixtures.mjs';
function fixture(values) {
 const out={id:'out',bits:8};const inst={op:OP.BIN,sub:'add',dst:out,args:values.map(value=>({value}))};out.def=inst;
 return {entry:0,blocks:[{index:0,insts:[inst,{op:OP.RET,args:[{value:out}]}],succ:[]}]};
}
test('duplicate raw or canonical value identities cannot bind unrelated argument objects',()=>{
 const a={id:'a',bits:8,kind:'arg',reg:'x0'},b={id:'a',bits:8,kind:'arg',reg:'x1'};
 for(const values of [[a,b],[{...a,semanticSsaValueId:'same'},{...b,id:'b',semanticSsaValueId:'same'}]]) {
  const r=symbolicExecute(fixture(values),{byteMemory:{identity}});assert.equal(r.status,'partial');assert.equal(r.paths.length,0);
 }
});
test('scalar operations do not ignore extra operands',()=>{
 const values=[1,2,3].map(i=>({id:`v${i}`,bits:8,const:BigInt(i)}));
 const r=symbolicExecute(fixture(values),{byteMemory:{identity}});assert.equal(r.status,'partial');assert.equal(r.paths.length,0);
});
test('immutable-looking getter expressions are rejected without reading the accessor',()=>{
 let reads=0;const bad=Object.freeze({kind:'const',get sort(){reads++;return E.bvSort(8);},value:1n});
 const r=createByteMemory({identity}).store(0n,1,bad);assert.equal(r.status,'unknown');assert.equal(reads,0);
});
test('unsupported partial taint results also lose authority when source IR changes',async()=>{
 const {queryTaint,createTaintModels,projectTaint}=await import('../../../js/symbolic/index.js');
 const ir={entry:0,blocks:[{index:0,insts:[{op:OP.CALL,args:[]}],succ:[]}]};
 const models=createTaintModels({id:'partial',version:'1',provenance:'test',sinks:[{id:'sink',valueId:'unknown'}]});
 const r=queryTaint(ir,{identity,models});assert.equal(r.status,'partial');assert.ok(r.evidence);
 ir.blocks[0].insts[0].op=OP.CLOBBER;assert.equal(projectTaint(r).evidence,null);
});
test('floating-point declarations are not silently interpreted as BV arithmetic',()=>{
 const a={id:'float',bits:32,kind:'arg',reg:'x0',machineType:{kind:'float',widthBits:32}};
 const out={id:'copied',bits:32};const mov={op:OP.MOV,args:[{value:a}],dst:out};out.def=mov;
 const ir={entry:0,blocks:[{index:0,insts:[mov,{op:OP.RET,args:[{value:out}]}],succ:[]}]};
 assert.equal(symbolicExecute(ir,{byteMemory:{identity}}).status,'partial');
});
test('comparison consumes explicit compatibility signedness, not an unsigned default',()=>{
 const out={id:'compared',bits:1};const compare={op:OP.CMP,cond:'lt',extra:{signed:true},args:[{value:{id:'negative',bits:8,const:255n}},{value:{id:'zero',bits:8,const:0n}}],dst:out};out.def=compare;
 const ir={entry:0,blocks:[{index:0,insts:[compare,{op:OP.RET,args:[{value:out}]}],succ:[]}]};
 const result=symbolicExecute(ir,{byteMemory:{identity}});assert.equal(result.status,'complete',result.reason);assert.equal(result.paths[0].returnValue.value,true);
 compare.extra.float=true;assert.equal(symbolicExecute(ir,{byteMemory:{identity}}).status,'partial');
});
