import test from 'node:test';
import assert from 'node:assert/strict';
import { symbolicExecute, expr } from '../../../js/symbolic/index.js';
import { OP, MK } from '../../../js/ir-base.js';
import { identity } from '../taint/fixtures.mjs';
// The oracle uses only integer arithmetic and a plain byte array. It does not
// import production memory, address lowering, endian or taint helpers.
test('terminal observations match independent enumeration of two aliased 3-bit pointers',()=>{
 let observations=0;
 for(const endian of ['little','big']) {
  const arg=(id,index,bits)=>({id,kind:'arg',index,reg:`x${index}`,bits});
  const p=arg('p',0,3),q=arg('q',1,3),word=arg('word',2,16),byte=arg('byte',3,8);
  const descriptors=[[p,0n,2,word],[q,0n,1,byte],[q,1n,2,word],[p,1n,1,byte]];
  const insts=descriptors.map(([base,disp,size,value],index)=>({id:`store-${index}`,op:OP.STORE,
   addr:{base,disp,size},loc:{kind:MK.UNKNOWN,size},args:[{value}],row:index,address:BigInt(index*4)}));
  insts.push({id:'ret',op:OP.RET,args:[],row:4,address:16n});
  const ir={entry:0,blocks:[{index:0,insts,succ:[]}],instructions:insts};
  const initial=Array.from({length:8},(_,a)=>(a*31+7)&255);
  const r=symbolicExecute(ir,{byteMemory:{identity,addressBits:3,wrapping:'modular',endian,initialBytes:initial.map((v,a)=>[BigInt(a),BigInt(v)])},
   memoryObservations:initial.map((_,a)=>({id:`at-${a}`,address:BigInt(a),size:1}))});
  assert.equal(r.status,'complete',r.reason);
  for(let pi=0;pi<8;pi++) for(let qi=0;qi<8;qi++) for(const wi of [0,1,0x1234,0xffff]) {
   const bi=(pi*17+qi*29)&255,expected=initial.slice();
   const stores=[[pi,2,wi],[qi,1,bi],[(qi+1)%8,2,wi],[(pi+1)%8,1,bi]];
   for(const [address,size,value] of stores) for(let lane=0;lane<size;lane++) {
    const shift=endian==='little'?lane:size-1-lane;
    expected[(address+lane)%8]=Math.floor(value/(256**shift))%256;
   }
   const environment={arg_x0:BigInt(pi),arg_x1:BigInt(qi),arg_x2:BigInt(wi),arg_x3:BigInt(bi)};
   for(let a=0;a<8;a++) {
    const actual=expr.evaluateExpr(r.paths[0].memoryObservations[a].expression,environment);
    assert.equal(actual.status,'value');assert.equal(actual.value,BigInt(expected[a]),`${endian}/${pi}/${qi}/${wi}/${a}`);observations++;
   }
  }
 }
 assert.equal(observations,4096);
});
