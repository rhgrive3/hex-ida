import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../../../js/symbolic/index.js';
import {OP,MK} from '../../../js/ir-base.js';
import {identity} from '../memory/main-fixtures.mjs';
function program(width,delta=0n) {
  const x={id:'input',kind:'arg',reg:'input',bits:width},y={id:'sum',bits:width};
  const sum={id:'add',op:OP.BIN,dst:y,sub:'add',args:[{value:x},{value:{id:'zero',bits:width,const:delta}}]};y.def=sum;
  const store={id:'store',op:OP.STORE,loc:{kind:MK.GLOBAL,address:0xfffffffffffffff0n,size:width/8},args:[{value:y}]};
  const ret={id:'ret',op:OP.RET,args:[{value:{id:'return',bits:8,const:0n}}]};
  const instructions=[sum,store,ret];for(const [i,inst]of instructions.entries()){inst.row=i;inst.address=BigInt(i*4);}
  return {x,ir:{entry:0,instructions,blocks:[{index:0,insts:instructions,succ:[]}]}};
}
const memory={addressBits:64,wrapping:'modular'};
for(const width of [32,64])test(`wide ${width}-bit values feed full concrete byte-footprint equivalence`,async()=>{
 const a=program(width),b=program(width),inputs=[{before:a.x,after:b.x}];
 const r=await S.queryMemoryEquivalence({identity,beforeIr:a.ir,afterIr:b.ir,memory,inputs,backendTier:'tiered',timeoutMs:2000});
 assert.equal(r.verdict,'proved',r.reason);assert.equal(r.eligible,true);assert.ok(r.metrics.solverCalls>0);
 assert.equal(S.isAdoptableMemoryEquivalence(r,{identity,beforeIr:a.ir,afterIr:b.ir,memory,inputs,preconditions:[]}),true);
});
for(const width of [32,64])test(`wide ${width}-bit store difference is refuted despite equal return`,async()=>{
 const a=program(width),b=program(width,1n),inputs=[{before:a.x,after:b.x}];
 const r=await S.queryMemoryEquivalence({identity,beforeIr:a.ir,afterIr:b.ir,memory,inputs,backendTier:'tiered',timeoutMs:2000});
 assert.equal(r.verdict,'refuted',r.reason);assert.equal(r.eligible,false);assert.equal(r.firstDivergence?.kind,'memory-byte');
 assert.ok(r.firstDivergence.address>=0xfffffffffffffff0n);
});
test('wide memory is opt-in, unknown tiers and >64-bit values fail closed',async()=>{
 for(const [width,backendTier]of [[32,undefined],[32,'unknown'],[65,'tiered']]){
  const a=program(width),b=program(width);const r=await S.queryMemoryEquivalence({identity,beforeIr:a.ir,afterIr:b.ir,memory,inputs:[{before:a.x,after:b.x}],backendTier});
  assert.equal(r.eligible,false);assert.equal(r.verdict,'unknown');assert.equal(r.evidence,null);
 }
});
test('vacuous and cancelled wide memory obligations never publish adoption',async()=>{
 const a=program(64),b=program(64),base={identity,beforeIr:a.ir,afterIr:b.ir,memory,inputs:[{before:a.x,after:b.x}],backendTier:'tiered'};
 for(const extra of [{preconditions:[S.expr.createBool(false)]},{signal:AbortSignal.abort()},{timeoutMs:0},{limits:{observedBytes:1}}]){
  const r=await S.queryMemoryEquivalence({...base,...extra});assert.equal(r.eligible,false);assert.equal(r.evidence,null);
 }
});
