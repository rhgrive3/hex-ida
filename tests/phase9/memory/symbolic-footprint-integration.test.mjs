import test from 'node:test';
import assert from 'node:assert/strict';
import {OP} from '../../../js/ir-base.js';
import { createByteMemory,joinByteMemory,queryMemoryEquivalence,queryTaint,createTaintModels,projectTaint,expr as E } from '../../../js/symbolic/index.js';
import {symbolicMemoryWriteFootprint} from '../../../js/symbolic/memory/byte-memory.js';
import {isExecutionSnapshot} from '../../../js/symbolic/memory/execution-snapshot.js';
import {EvidenceGraph} from '../../../js/core/evidence/index.js';
import {identity,argument,literal,store,program} from '../verify/symbolic-footprint-fixtures.mjs';
import {integrationFixture} from '../taint/fixtures.mjs';

test('both immutable join parents contribute symbolic writes and later parent writes do not leak',()=>{
 const root=createByteMemory({identity,addressBits:64,wrapping:'modular'});
 const p=E.createFreshSymbol(E.bvSort(64),'p'),q=E.createFreshSymbol(E.bvSort(64),'q'),c=E.createFreshSymbol(E.boolSort(),'branch');
 const yes=root.fork(),no=root.fork();yes.store(p,1,1n);no.store(q,1,2n);
 const joined=joinByteMemory(c,yes,no),cover=symbolicMemoryWriteFootprint(joined);
 assert.equal(cover.length,2);assert.ok(cover.includes(p));assert.ok(cover.includes(q));assert.ok(Object.isFrozen(cover));
 yes.store(9n,1,3n);assert.equal(symbolicMemoryWriteFootprint(joined).length,2);
 for(const [choice,address,expected]of [[true,p,1n],[false,q,2n]]) {
  const r=joined.load(address,1);assert.ok(r.expression,r.reason);
  const value=E.evaluateExpr(r.expression,{[p.symbolId]:10n,[q.symbolId]:20n,[c.symbolId]:choice});
  assert.equal(value.value,expected);
 }
});
test('issued trace cover is bounded, stale and clobbered state cannot publish addresses',()=>{
 let current=identity;const mem=createByteMemory({identity,addressBits:64,getCurrentIdentity:()=>current});
 const p=E.createFreshSymbol(E.bvSort(64),'p');mem.store(p,1,1n);
 current={...identity,snapshotId:'new'};assert.throws(()=>symbolicMemoryWriteFootprint(mem),/stale/);
 const invalid=createByteMemory({identity,addressBits:64});invalid.barrier('unknown-call');
 assert.throws(()=>symbolicMemoryWriteFootprint(invalid),/unknown-call/);
 assert.throws(()=>symbolicMemoryWriteFootprint({identity}),/unissued/);
});
function branched(value=2) {
 const p=argument('p',64),q=argument('q',64),c=argument('c',1);
 const branch={id:'b',row:0,address:0n,op:OP.CBR,args:[{value:c}],extra:{kind:'cbnz',target:8n}};
 const ys=store(p,literal('yes',8,1)),ns=store(q,literal('no',8,value));
 const yr={op:OP.RET,args:[{value:literal('ry',8,0)}]},nr={op:OP.RET,args:[{value:literal('rn',8,0)}]};
 for(const [i,inst]of [ys,yr,ns,nr].entries())Object.assign(inst,{id:`a${i}`,row:i+1,address:8n+BigInt(i*4)});
 return {p,q,c,ir:{entry:0,instructions:[branch,ys,yr,ns,nr],blocks:[{index:0,insts:[branch],succ:[1,2]},{index:1,insts:[ys,yr],succ:[]},{index:2,insts:[ns,nr],succ:[]}]}};
}
test('every terminal path contributes its write addresses, including writes from the other branch',async()=>{
 for(const value of [2,3]) {
  const b=branched(),a=branched(value);
  const r=await queryMemoryEquivalence({identity,beforeIr:b.ir,afterIr:a.ir,inputs:['p','q','c'].map(k=>({before:b[k],after:a[k]})),
   memory:{addressBits:64,wrapping:'modular',proofMode:'symbolic-writes'},backendTier:'tiered',preconditions:[],timeoutMs:2000});
  assert.equal(r.verdict,value===2?'proved':'refuted',r.reason);assert.equal(r.metrics.proofPairs,4);
  if(value===3)assert.equal(r.firstDivergence.kind,'memory-byte');
 }
});
test('64-bit symbolic pointer -> partial store -> control/phi -> memory sink -> evidence uses production taint',()=>{
 const ir=integrationFixture();ir.blocks[0].insts[0].addr.base.bits=64;
 const models=createTaintModels({id:'wide-pointer-flow',version:'1',provenance:'owned:integration',
  sources:[{id:'pointer',valueId:'ptr'},{id:'word',valueId:'word'},{id:'byte',valueId:'byte'}],
  sinks:[{id:'scalar',valueId:'final'}],memorySinks:[{id:'memory',observationId:'tail'}]});
 const r=queryTaint(ir,{identity,models,memory:{addressBits:64,wrapping:'modular'},memoryObservations:[{id:'tail',addressValueId:'ptr',displacement:1n,size:1}]});
 assert.equal(r.status,'complete',r.reason);assert.equal(r.execution.paths.length,2);assert.ok(r.evidence);
 assert.ok(r.execution.paths.every(path=>isExecutionSnapshot(path.snapshot,identity,ir)));
 assert.ok(r.sinks.every(sink=>sink.taint.sources.includes('pointer')&&sink.taint.sources.includes('byte')));
 const graph=EvidenceGraph.fromJSON(r.graph);assert.deepEqual(graph.unresolvedReferences(),[]);
 assert.equal(r.evidence.proofAuthority,'none');
 assert.equal(projectTaint(r,{identity:{...identity,snapshotId:'stale'}}).evidence,null);
});
test('64-bit memory select/store expression round-trips through existing canonical serialization',()=>{
 const m=createByteMemory({identity,addressBits:64,wrapping:'modular'}),p=E.createFreshSymbol(E.bvSort(64),'p'),q=E.createFreshSymbol(E.bvSort(64),'q');
 m.store(p,2,0xbbaan);const original=m.load(q,1).expression;assert.ok(original);
 const serialized=E.serializeExprDag(original),restored=E.deserializeExprDag(serialized);
 assert.equal(E.computeStructuralHash(restored),E.computeStructuralHash(original));
 for(const pointer of [0n,0x8000000000000001n,(1n<<64n)-1n]) {
  const model={[p.symbolId]:pointer,[q.symbolId]:pointer};
  assert.equal(E.evaluateExpr(restored,model).value,0xaan);
 }
});
