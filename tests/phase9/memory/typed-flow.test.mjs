import test from 'node:test';
import assert from 'node:assert/strict';
import { OP, MK } from '../../../js/ir-base.js';
import { symbolicExecute, queryTaint, createTaintModels, semanticValueIdentity } from '../../../js/symbolic/index.js';
import { identity } from '../taint/fixtures.mjs';
import { machineIR } from './main-fixtures.mjs';
const val=(id,bits,constValue)=>({id,bits,...(constValue!=null?{const:constValue}:{kind:'arg',reg:`x${id}`,index:id})});
function seq(insts,out,values=[]) {for(const i of insts)if(i.dst)i.dst.def=i;const ret={id:'ret',op:OP.RET,args:[{value:out}],address:100n};const all=[...insts,ret];return{values,instructions:all,entry:0,blocks:[{index:0,insts:all,succ:[]}]};}
const run=(ir,extra={})=>symbolicExecute(ir,{byteMemory:{identity,addressBits:8,wrapping:'modular'},...extra});
test('select consumes an explicit canonical Bool and conservatively carries both data inputs',()=>{
  const input=val(0,8),condition={id:1,bits:1},out={id:2,bits:8};
  const compare={op:OP.CMP,cond:'eq',args:[{value:input},{value:val(3,8,0n)}],dst:condition};
  const select={op:OP.SEL,conditionValue:condition,args:[{value:val(4,8,7n)},{value:val(5,8,9n)}],dst:out};
  const ir=seq([compare,select],out);
  for(const [n,expected]of [[0n,7n],[1n,9n],[255n,9n]])assert.equal(run(ir,{symbolicArgs:{0:n}}).paths[0]?.returnValue.value,expected);
  const result=queryTaint(ir,{identity,models:createTaintModels({id:'sel',version:'1',provenance:'test',sources:[{id:'control-source',valueId:semanticValueIdentity(input)}],sinks:[{id:'sink',valueId:semanticValueIdentity(out)}]}),memory:{addressBits:8}});
  assert.equal(result.status,'complete',result.reason);assert.deepEqual(result.sinks[0].taint.sources,['control-source']);
});
test('byte executor handles explicit tbz/tbnz bit tests through canonical extraction',()=>{
  for(const kind of ['tbz','tbnz'])for(const n of [0n,4n,255n]){
    const branch={op:OP.CBR,args:[{value:val(0,8)}],extra:{kind,bit:2,target:4n},address:0n};
    const a={op:OP.RET,args:[{value:val(1,8,1n)}],address:4n};const b={op:OP.RET,args:[{value:val(2,8,0n)}],address:8n};
    const ir={entry:0,blocks:[{index:0,insts:[branch],succ:[1,2]},{index:1,insts:[a],succ:[]},{index:2,insts:[b],succ:[]}]};
    const result=run(ir,{symbolicArgs:{0:n}});assert.equal(result.status,'complete',result.reason);
    const set=(n&4n)!==0n;assert.equal(result.paths[0].returnValue.value,(kind==='tbnz'?set:!set)?1n:0n);
    branch.extra.bit=8;assert.equal(run(ir).status,'partial');
  }
});
test('canonical indexed address expression is consumed instead of re-decoding the index field',()=>{
  const base=val(0,8),index=val(1,8),address={id:2,bits:8,semanticValueId:'address-semantic'};
  const calc={op:OP.BIN,subOp:'add',args:[{value:base},{value:index}],dst:address};address.def=calc;
  const byte=val(3,8),out={id:4,bits:8};
  const extra={completeness:'complete',memoryAccess:{widthBits:8,addressSpace:'data',endian:'little',atomic:false,volatility:false,ordering:'none',addressExpr:{valueId:'address-semantic'}}};
  const location={kind:MK.UNKNOWN,size:1};const addr={base,index,disp:0n,size:1,precise:false};
  const store={op:OP.STORE,args:[{value:byte}],addr,loc:location,extra};
  const load={op:OP.LOAD,args:[],dst:out,addr,loc:location,extra};
  const ir=seq([calc,store,load],out,[base,index,address,byte,out]);
  const result=queryTaint(ir,{identity,memory:{addressBits:8,wrapping:'modular'},models:createTaintModels({id:'index',version:'1',provenance:'canonical-fixture',sources:[{id:'index',valueId:semanticValueIdentity(index)},{id:'byte',valueId:semanticValueIdentity(byte)}],sinks:[{id:'sink',valueId:semanticValueIdentity(out)}]})});
  assert.equal(result.status,'complete',result.reason);assert.deepEqual(result.sinks[0].taint.sources,['byte','index']);
  extra.memoryAccess.addressExpr.valueId='unresolved';assert.equal(run(ir).status,'partial');
});
test('actual main numeric and canonical SSA identity feeds first-class taint through state writes',()=>{
  const ir=machineIR(['mov w2, w1','ret']);
  const input=ir.values.find(v=>v.kind==='arg' && v.reg==='x1');assert.ok(input);
  const out=ir.instructions.find(i=>i.extra?.stateWrite?.register==='x2')?.dst ?? ir.values.find(v=>v.reg==='x2' && v.def?.extra?.stateWrite);
  assert.ok(out);
  const result=queryTaint(ir,{identity:{...identity,addressSpace:'memory'},memory:{addressBits:64},models:createTaintModels({id:'real-main',version:'1',provenance:'buildSemanticModel/buildIR',sources:[{id:'external',valueId:semanticValueIdentity(input)}],sinks:[{id:'state-write',valueId:semanticValueIdentity(out)}]})});
  assert.equal(result.status,'complete',result.reason);assert.deepEqual(result.sinks[0].taint.sources,['external']);
});
