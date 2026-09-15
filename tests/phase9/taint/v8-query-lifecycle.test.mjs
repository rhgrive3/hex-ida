import test from 'node:test';
import assert from 'node:assert/strict';
import {createQueryGuard,memoryIdentity,sameMemoryIdentity} from '../../../js/symbolic/memory/query-state.js';
import {identity} from './fixtures.mjs';
test('v8: clock callback cancellation cannot pass the final guard check',()=>{
 const ac=new AbortController();let calls=0;
 const g=createQueryGuard({identity,signal:ac.signal,timeoutMs:1000,now:()=>{if(++calls===2)ac.abort();return 0;}},{workItems:10});
 assert.throws(()=>g.check(),/cancelled/);
});
test('v8: request mutation cannot replace an in-flight signal or identity observer',()=>{
 const ac=new AbortController();let current=identity;
 const options={identity,signal:ac.signal,getCurrentIdentity:()=>current,timeoutMs:1000};
 const g=createQueryGuard(options,{workItems:10});options.signal=null;options.getCurrentIdentity=()=>identity;
 ac.abort();current={...identity,snapshotId:'stale'};assert.throws(()=>g.check(),/cancelled|stale/);
});
test('v8: identity accessors are rejected without execution even by comparisons',()=>{
 let reads=0;const id={...identity};Object.defineProperty(id,'snapshotId',{get(){reads++;return identity.snapshotId;}});
 assert.throws(()=>memoryIdentity(id));assert.equal(sameMemoryIdentity(identity,id),false);assert.equal(reads,0);
});
test('v8: a throwing cancellation observer fails closed with a structured query failure',()=>{
 const g=createQueryGuard({identity,timeoutMs:1000,isCancelled(){throw new Error('observer');}},{workItems:10});
 assert.throws(()=>g.check(),error=>error.name==='QueryFailure'&&error.reason==='cancelled');
});
test('v8: resource claim admits N-1/N and refuses N+1 without charging it',()=>{
 for(const n of [9,10,11]) {const g=createQueryGuard({identity,timeoutMs:1000},{workItems:10});
  if(n<=10){g.take('workItems',n);assert.equal(g.metrics().workItems,n);}else {assert.throws(()=>g.take('workItems',n),/budget:workItems/);assert.equal(g.metrics().workItems,0);}}
});
test('v8: identity tokens preserve exact fields and reject coercion and revoked proxies',()=>{
 for(const bad of [[],{},Symbol('s'),true,NaN,Infinity,-0,123n,'', ' '.repeat(2), 'x'.repeat(1025)]) {
  assert.throws(()=>memoryIdentity({...identity,queryId:bad}));assert.equal(sameMemoryIdentity(identity,{...identity,queryId:bad}),false);
 }
 const proxy=Proxy.revocable({...identity},{});proxy.revoke();assert.equal(sameMemoryIdentity(identity,proxy.proxy),false);
});
test('v8: clock failure cannot throw again while publishing diagnostic metrics',()=>{
 let calls=0;const g=createQueryGuard({identity,timeoutMs:1000,now:()=>{if(++calls>1)throw Error('clock');return 0;}},{workItems:10});
 assert.throws(()=>g.check(),/invalid-clock/);assert.doesNotThrow(()=>g.metrics());assert.ok(Number.isFinite(g.metrics().wallClock));
});
import {queryTaint,isTaintQueryResult} from '../../../js/symbolic/query/taint.js';
import {createTaintModels} from '../../../js/symbolic/taint/models.js';
import {scalarFixture} from './fixtures.mjs';
const model=()=>createTaintModels({id:'v8-lifecycle',version:'1',provenance:'test:query-lifecycle',sources:[],sinks:[]});
test('v8: taint cancels during final metric sampling without publishing evidence',()=>{
 let calls=0;const models=model();const options={identity,models,memory:{addressBits:8},timeoutMs:1000};
 assert.equal(queryTaint(scalarFixture(),{...options,now:()=>{calls++;return 0;}}).status,'complete');
 let n=0;const ac=new AbortController();const r=queryTaint(scalarFixture(),{...options,signal:ac.signal,now:()=>{if(++n===calls)ac.abort();return 0;}});
 assert.equal(ac.signal.aborted,true);assert.equal(r.status,'partial');assert.equal(r.evidence,null);
});
test('v8: late model observer cancellation cannot retain taint authority',()=>{
 const ac=new AbortController(),models=model();let stop=false;
 const r=queryTaint(scalarFixture(),{identity,models,memory:{addressBits:8},timeoutMs:1000,signal:ac.signal,
  getCurrentModelIdentity:()=>{if(stop)ac.abort();return models.modelIdentity;}});
 assert.equal(r.status,'complete');stop=true;assert.equal(isTaintQueryResult(r),false);
});
import {isSymbolicAnalysisResult} from '../../../js/symbolic/query/analysis.js';
import {isAdoptableCandidate} from '../../../js/symbolic/taint/proof-consumer.js';
import {isExecutionResult,isExecutionSnapshot} from '../../../js/symbolic/memory/execution-snapshot.js';
test('v8: unissued capability predicates do not evaluate fake identity getters',()=>{
 let reads=0;const fake={get identity(){reads++;return identity;},get before(){reads++;return null;}};
 for(const predicate of [isTaintQueryResult,isSymbolicAnalysisResult,isAdoptableCandidate,isExecutionResult,isExecutionSnapshot]) assert.equal(predicate(fake),false);
 assert.equal(reads,0);
});
import {querySymbolicAnalysis} from '../../../js/symbolic/query/analysis.js';
import {verifyDeobfuscationCandidate} from '../../../js/symbolic/taint/proof-consumer.js';
import * as E from '../../../js/symbolic/expr/index.js';
test('v8: explicit null identity/model cannot redeem issued execution and taint capabilities',()=>{
 const ir=scalarFixture(),models=model();const r=queryTaint(ir,{identity,models,memory:{addressBits:8},timeoutMs:1000});
 assert.equal(r.status,'complete',r.reason);assert.equal(isTaintQueryResult(r),true);
 assert.equal(isTaintQueryResult(r,null),false);assert.equal(isTaintQueryResult(r,undefined,null),false);
 assert.equal(isExecutionResult(r.execution),true);assert.equal(isExecutionResult(r.execution,null),false);
 const snapshot=r.execution.paths[0].snapshot;assert.equal(isExecutionSnapshot(snapshot),true);assert.equal(isExecutionSnapshot(snapshot,null),false);
});
test('v8: explicit null analysis identity differs from omitted identity',async()=>{
 const r=await querySymbolicAnalysis(scalarFixture(),{identity,models:model(),memory:{addressBits:8},targets:[],timeoutMs:1000});
 assert.equal(r.status,'complete',r.reason);assert.equal(isSymbolicAnalysisResult(r),true);assert.equal(isSymbolicAnalysisResult(r,null),false);
});
test('v8: explicit null proof scope cannot be normalized into the issued unconditional scope',async()=>{
 const x=E.createFreshSymbol(E.bvSort(4),'v8-null-proof');
 const r=await verifyDeobfuscationCandidate({candidateId:'v8-null',beforeValueId:'before',afterValueId:'after',identity,
  before:E.createBinary('add',x,x),after:E.createBinary('shl',x,E.createBv(4,1)),memoryObservables:[],effectObservables:[],timeoutMs:1000});
 assert.equal(r.eligible,true,r.reason);assert.equal(isAdoptableCandidate(r),true);
 for(const field of ['identity','before','after','preconditions','correspondence'])assert.equal(isAdoptableCandidate(r,{[field]:null}),false,field);
});
test('v8: final execution cancellation observer cannot mutate IR after its freshness check',()=>{
 const ir=scalarFixture();let armed=false,calls=0;
 const r=queryTaint(ir,{identity,models:model(),memory:{addressBits:8},timeoutMs:1000,isCancelled(){
  if(armed && ++calls===2)ir.instructions[0].op='bin';return false;
 }});
 assert.equal(r.status,'complete',r.reason);armed=true;assert.equal(isExecutionResult(r.execution),false);
});
test('v8: final model observer cannot mutate IR and retain taint authority',()=>{
 const ir=scalarFixture(),models=model();let armed=false;
 const r=queryTaint(ir,{identity,models,memory:{addressBits:8},timeoutMs:1000,getCurrentModelIdentity(){
  if(armed)ir.instructions[0].op='bin';return models.modelIdentity;
 }});
 assert.equal(r.status,'complete',r.reason);armed=true;assert.equal(isTaintQueryResult(r),false);
});
