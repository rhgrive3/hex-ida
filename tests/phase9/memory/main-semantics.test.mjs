import test from 'node:test';
import assert from 'node:assert/strict';
import { OP } from '../../../js/ir.js';
import { symbolicExecute, queryTaint, createTaintModels } from '../../../js/symbolic/index.js';
import { identity, machineIR } from './main-fixtures.mjs';

export const opts = {byteMemory:{identity:{...identity,addressSpace:'memory'},addressBits:64}};
function sequence(insts,result) {
  for(const i of insts) if(i.dst) i.dst.def=i;
  const ret={op:OP.RET,args:[{value:result}],row:100,address:100n};
  return {entry:0,instructions:[...insts,ret],blocks:[{index:0,insts:[...insts,ret],succ:[]}]};
}
test('main buildSemanticModel -> buildIR -> byte executor handles numeric SSA IDs and trunc/zext',()=>{
  const ir=machineIR(['mov w1, #0xaa','mov x2, x1','ret']);
  assert.equal(ir.compat.projection,'semantic-ir-v2-to-v1');
  const result=symbolicExecute(ir,opts);
  assert.equal(result.status,'complete',result.reason);
});
test('real main memory qualifiers stay conservative rather than being inferred from mnemonics',()=>{
  const result=symbolicExecute(machineIR(['mov w1, #0xaa','strb w1, [x0]','ldrsb x2, [x0]','ret']),opts);
  assert.equal(result.status,'partial');
  assert.equal(result.reason,'unknown-memory-qualifiers');
  assert.equal(result.paths.length,0);
});
test('numeric scalar SSA IDs support explicit truncation and signed extension',()=>{
  const input={id:1,kind:'arg',reg:'x0',bits:64};
  const byte={id:2,bits:8},wide={id:3,bits:64};
  const ir=sequence([{op:OP.MOV,sub:'trunc',args:[{value:input}],dst:byte},{op:OP.UN,sub:'sext',args:[{value:byte}],dst:wide}],wide);
  const result=symbolicExecute(ir,{...opts,symbolicArgs:{0:0x80n}});
  assert.equal(result.status,'complete',result.reason);
  assert.equal(result.paths[0].returnValue.value,0xffffffffffffff80n);
});
test('derived const metadata does not bypass executed data dependencies',()=>{
  const input={id:'input',kind:'arg',reg:'x0',index:0,bits:8};
  const out={id:'out',bits:8,const:99n};
  const ir=sequence([{op:OP.MOV,args:[{value:input}],dst:out}],out);
  const result=symbolicExecute(ir,{...opts,symbolicArgs:{0:7n}});
  assert.equal(result.paths[0].returnValue.value,7n);
  const taint=queryTaint(ir,{identity:opts.byteMemory.identity,memory:{addressBits:64},models:createTaintModels({id:'main-semantics',version:'1',provenance:'regression',sources:[{id:'s',valueId:'input'}],sinks:[{id:'k',valueId:'out'}]})});
  assert.equal(taint.sinks[0].taint.kind,'sources');
});
test('ordinary MOV with multiple operands is not silently interpreted as its first operand',()=>{
  const out={id:'out',bits:8};
  const ir=sequence([{op:OP.MOV,args:[{value:{id:'a',bits:8,const:1n}},{value:{id:'b',bits:8,const:2n}}],dst:out}],out);
  const result=symbolicExecute(ir,opts);
  assert.equal(result.status,'partial');
  assert.equal(result.paths.length,0);
});
