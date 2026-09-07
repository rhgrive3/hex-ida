/** Independent finite byte oracle: these reference transitions use integers and
 * JS arrays only, never production memory, Expr lowering or solver operations.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as S from '../../../js/symbolic/index.js';
import { OP, MK } from '../../../js/ir-base.js';
import { identity } from '../memory/main-fixtures.mjs';
function bytesAfter(stores, endian) {
  const out=[19,29,39,49];
  for(const {address,size,value}of stores)for(let byte=0;byte<size;byte++) {
    const position=endian==='little'?byte:size-1-byte;
    out[(address+byte)%4]=Number((BigInt(value)>>(8n*BigInt(position)))&255n);
  }
  return out;
}
function program(stores) {
  const instructions=stores.map(({address,size,value},i)=>({id:`store:${i}`,op:OP.STORE,args:[{value:{id:`value:${i}`,bits:size*8,const:BigInt(value)}}],
    loc:{kind:MK.GLOBAL,address:BigInt(address),size},row:i,address:BigInt(i*4)}));
  instructions.push({id:'ret',op:OP.RET,args:[{value:{id:'return',bits:8,const:0n}}],row:instructions.length,address:BigInt(instructions.length*4)});
  return {entry:0,instructions,blocks:[{index:0,insts:instructions,succ:[]}]};
}
test('all-byte proof agrees with independent LE/BE wrapping and partial-store enumeration',async()=>{
  const started=performance.now();let queries=0,proved=0,refuted=0,byteComparisons=0,solverCalls=0,solverNodesEvaluated=0;
  for(const endian of ['little','big'])for(let address=0;address<4;address++)for(const word of [0,0x1280,0xfffe])for(const mutate of [false,true]){
    const before=[{address,size:2,value:word},{address:(address+1)%4,size:1,value:0xab}];
    const expected=bytesAfter(before,endian);
    const after=expected.map((value,offset)=>({address:offset,size:1,value:value^(mutate&&offset===address?1:0)}));
    const oracle=bytesAfter(after,endian);const equivalent=expected.every((v,i)=>v===oracle[i]);byteComparisons+=4;
    const result=await S.queryMemoryEquivalence({identity,beforeIr:program(before),afterIr:program(after),inputs:[],
      memory:{addressBits:2,wrapping:'modular',endian,initialBytes:[[0n,19],[1n,29],[2n,39],[3n,49]]}});
    assert.equal(result.verdict,equivalent?'proved':'refuted',result.reason);
    if(equivalent)proved++;else{refuted++;assert.equal(Number(result.firstDivergence.address),address);}
    solverCalls+=result.metrics.solverCalls;solverNodesEvaluated+=result.metrics.solverNodesEvaluated;queries++;
  }
  assert.equal(queries,48);assert.equal(proved,24);assert.equal(refuted,24);
  const measurement={queries,proved,refuted,byteComparisons,solverCalls,solverNodesEvaluated,milliseconds:performance.now()-started,oracle:'independent-integer-byte-array'};
  if(process.env.HEX_002_METRICS_DIR){fs.mkdirSync(process.env.HEX_002_METRICS_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.HEX_002_METRICS_DIR,'finite-memory-oracle.json'),JSON.stringify(measurement,null,2)+'\n');}
  console.log(`FINITE_MEMORY_ORACLE ${JSON.stringify(measurement)}`);
});
test('64-bit footprint proofs agree with an independent sparse-byte oracle',async()=>{
  const base=0x8000000000000000n,mask=(1n<<64n)-1n;let queries=0,comparedBytes=0;
  const run=stores=>{const m=new Map();for(const {address,size,value}of stores)for(let lane=0;lane<size;lane++)m.set((address+BigInt(lane))&mask,Number((BigInt(value)>>BigInt(lane*8))&255n));return m;};
  for(const address of [base,base+3n,mask-1n,mask])for(const value of [0x1234,0x80ff])for(const changed of [false,true]) {
    const before=[{address,size:2,value}];
    const bytes=run(before);const after=[...bytes].map(([address,value])=>({address,size:1,value}));
    if(changed)after[0].value^=1;
    const actual=run(after),equivalent=[...bytes].every(([a,v])=>actual.get(a)===v);comparedBytes+=bytes.size;
    const r=await S.queryMemoryEquivalence({identity,beforeIr:program(before),afterIr:program(after),inputs:[],memory:{addressBits:64,wrapping:'modular'}});
    assert.equal(r.verdict,equivalent?'proved':'refuted',r.reason);queries++;
  }
  assert.equal(queries,16);assert.equal(comparedBytes,32);
  console.log(`SPARSE_MEMORY_ORACLE ${JSON.stringify({queries,comparedBytes})}`);
});
