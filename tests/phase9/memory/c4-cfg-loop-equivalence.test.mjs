import assert from 'node:assert/strict';
import test from 'node:test';
import { OP } from '../../../js/ir-base.js';
import { queryMemoryEquivalence, isAdoptableMemoryEquivalence } from '../../../js/symbolic/query/memory-equivalence.js';
import { identity } from './main-fixtures.mjs';

const c = (id, value, bits=8) => ({ id, kind:'const', const:BigInt(value), bits });
const ret = (id, value, row, address) => ({ id, op:OP.RET, args:[{value}], row, address:BigInt(address) });
function ir(blocks) {
  const instructions=blocks.flatMap(block=>[...(block.phis??[]),...block.insts]);
  return { entry:0, blocks, instructions };
}
function flatReturn(value=7) {
  return ir([{index:0,phis:[],insts:[ret('flat-ret',c('flat-value',value),0,0)],succ:[]}]);
}
function diamond({left=7,right=7}={}) {
  const cond={id:'diamond-cond',kind:'arg',reg:'x0',index:0,bits:8};
  const branch={id:'diamond-branch',op:OP.CBR,args:[{value:cond}],extra:{kind:'cbz',target:8n},row:0,address:0n};
  return { cond, program:ir([
    {index:0,phis:[],insts:[branch],succ:[2,1]},
    {index:1,phis:[],insts:[ret('diamond-left',c('diamond-left-value',left),1,4)],succ:[]},
    {index:2,phis:[],insts:[ret('diamond-right',c('diamond-right-value',right),2,8)],succ:[]},
  ]) };
}
function countedLoop(iterations=2) {
  const initial=c('loop-initial',iterations), one=c('loop-one',1), out=c('loop-out',7);
  const counter={id:'loop-counter',bits:8};
  const next={id:'loop-next',bits:8};
  const phi={id:'loop-phi',op:OP.PHI,dst:counter,args:[],incoming:[{from:-1,value:initial},{from:0,value:next}]};counter.def=phi;
  const dec={id:'loop-dec',op:OP.BIN,sub:'sub',dst:next,args:[{value:counter},{value:one}],row:0,address:0n};next.def=dec;
  const branch={id:'loop-branch',op:OP.CBR,args:[{value:next}],extra:{kind:'cbnz',target:0n},row:1,address:4n};
  const program=ir([
    {index:0,phis:[phi],insts:[dec,branch],succ:[0,1]},
    {index:1,phis:[],insts:[ret('loop-ret',out,2,8)],succ:[]},
  ]);
  return program;
}
const request=(beforeIr,afterIr,extra={})=>({identity,beforeIr,afterIr,inputs:[],preconditions:[],
  memory:{addressBits:8,endian:'little',wrapping:'modular',alignment:'unaligned'},backendTier:'tiered',timeoutMs:5000,...extra});

test('C4-04B proves a CFG diamond rewrite when every terminal observable is equal',async()=>{
  const before=diamond().program,after=flatReturn();
  const q=request(before,after),result=await queryMemoryEquivalence(q);
  assert.equal(result.verdict,'proved',result.reason);
  assert.equal(result.eligible,true);
  assert.equal(result.scope.kind,'finite-byte-execution');
  assert.equal(result.scope.beforePathCount,2);
  assert.equal(result.scope.afterPathCount,1);
  assert.equal(isAdoptableMemoryEquivalence(result,q),true);
});

test('C4-04B refutes a CFG rewrite when one branch changes the return observable',async()=>{
  const result=await queryMemoryEquivalence(request(diamond({right:8}).program,flatReturn()));
  assert.equal(result.verdict,'refuted',result.reason);
  assert.equal(result.eligible,false);
  assert.ok(result.firstDivergence);
});

test('C4-04B proves a fully explored bounded loop against its flat semantic equivalent',async()=>{
  const before=countedLoop(2),after=flatReturn(),q=request(before,after,{execution:{maxBlockVisits:3,maxSteps:32,maxBranches:16,maxPaths:16}});
  const result=await queryMemoryEquivalence(q);
  assert.equal(result.verdict,'proved',result.reason);
  assert.equal(result.eligible,true);
  assert.equal(result.scope.beforePathCount,1);
  assert.equal(isAdoptableMemoryEquivalence(result,q),true);
});

test('C4-04B refuses loop equivalence when exploration exceeds the declared bound',async()=>{
  const result=await queryMemoryEquivalence(request(countedLoop(4),flatReturn(),{execution:{maxBlockVisits:3,maxSteps:32,maxBranches:16,maxPaths:16}}));
  assert.equal(result.eligible,false);
  assert.equal(result.verdict,'unknown');
  assert.match(result.reason,/before:loop-budget|before:incomplete-execution|budget/);
});
