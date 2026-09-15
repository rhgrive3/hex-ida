import test from 'node:test';
import assert from 'node:assert/strict';
import {queryMemoryEquivalence,isAdoptableMemoryEquivalence,symbolicExecute} from '../../../js/symbolic/index.js';
import {observeExecutionBytes} from '../../../js/symbolic/memory/execution-snapshot.js';
import {pairedStores,program,argument,store,literal,identity,E} from './symbolic-footprint-fixtures.mjs';
const stopped=result=>{assert.equal(result.eligible,false);assert.equal(result.verdict,'unknown');assert.equal(result.evidence,null);assert.equal(result.firstDivergence,null);};

test('a caller-created initial-byte tag does not grant memory-symbol authority',async()=>{
 const ir=program([]),forged=E.createFreshSymbol(E.bvSort(8),'forged_memory',{source:'initial-byte'});
 const result=await queryMemoryEquivalence({identity,beforeIr:ir,afterIr:ir,inputs:[],backendTier:'tiered',
   memory:{addressBits:64,proofMode:'symbolic-writes'},preconditions:[E.createCompare('eq',forged,E.createBv(8,0))]});
 stopped(result);assert.match(result.reason,/unbound-input-or-precondition/);
});
test('identity and query/memory limit getters are rejected without invocation',async()=>{
 for(const field of ['identity','limits','memoryLimits']) {
  const {request}=pairedStores();let invoked=0;
  const bad={};Object.defineProperty(bad,field==='identity'?'queryId':'workItems',{get(){invoked++;return 1;},enumerable:true});
  if(field==='identity')request.identity=bad;
  else if(field==='limits')request.limits=bad;
  else request.memory={...request.memory,limits:bad};
  const result=await queryMemoryEquivalence(request);
  stopped(result);assert.equal(invoked,0,field);
 }
});
test('terminal observations do not execute array iterator or element getters',()=>{
 const ir=program([]),result=symbolicExecute(ir,{captureValues:true,byteMemory:{identity,addressBits:64,wrapping:'modular'}});
 assert.equal(result.status,'complete',result.reason);
 let reads=0;const array=[0n];array[Symbol.iterator]=function*(){reads++;yield 0n;};
 const observations=observeExecutionBytes(result.paths[0].snapshot,array,identity,ir);
 assert.equal(observations.length,1);assert.equal(reads,0);
 const getter=[];Object.defineProperty(getter,'0',{get(){reads++;return 0n;},enumerable:true});
 assert.throws(()=>observeExecutionBytes(result.paths[0].snapshot,getter,identity,ir));assert.equal(reads,0);
});

test('symbolic-address, observation, pair, formula, and solver budgets obey N-1/N/N+1',async()=>{
 const {request}=pairedStores();const reference=await queryMemoryEquivalence(request);assert.equal(reference.eligible,true,reference.reason);
 for(const key of ['symbolicAddresses','observedBytes','proofPairs','obligationNodes','solverCalls','workItems','reservedEvaluations']) {
  const n=reference.metrics[key];assert.ok(n>0,key);
  const failed=await queryMemoryEquivalence({...request,limits:{[key]:n-1}});stopped(failed);assert.match(failed.reason,/budget/,key);
  for(const cap of [n,n+1]) {
   const r=await queryMemoryEquivalence({...request,limits:{[key]:cap}});assert.equal(r.eligible,true,`${key}=${cap}: ${r.reason}`);assert.equal(r.metrics[key],n,key);
  }
 }
});
test('store history and alias forks are reserved before crossing memory limits',async()=>{
 const {request}=pairedStores();const reference=await queryMemoryEquivalence(request);assert.equal(reference.eligible,true,reference.reason);
 for(const key of ['storeHistoryEntries','aliasForks','symbolicMemoryCells']) {
  const n=reference.metrics.memory[key];assert.ok(n>0,key);
  const run=cap=>queryMemoryEquivalence({...request,memory:{...request.memory,limits:{[key]:cap}}});
  stopped(await run(n-1));
  for(const cap of [n,n+1]){const r=await run(cap);assert.equal(r.eligible,true,`${key}=${cap}: ${r.reason}`);assert.equal(r.metrics.memory[key],n);}
 }
});
test('cancel or identity/deadline changes across the solver await suppress publication',async()=>{
 for(const kind of ['cancel','identity','deadline','source']) {
  const {request}=pairedStores();let current=identity,clock=0;
  const controller=new AbortController();request.signal=controller.signal;request.getCurrentIdentity=()=>current;request.now=()=>clock;
  const pending=queryMemoryEquivalence(request);
  queueMicrotask(()=>{
   if(kind==='cancel')controller.abort();
   if(kind==='identity')current={...identity,snapshotId:'after-await'};
   if(kind==='deadline')clock=3000;
   if(kind==='source')request.afterIr.instructions[0].args[0].value.const=77n;
  });
  stopped(await pending);
 }
});
test('entry cancellation, expiry, contradictions, and unsupported geometry stay no-adoption',async()=>{
 for(const extra of [{signal:AbortSignal.abort()},{timeoutMs:0},{preconditions:[E.createBool(false)]},
   {backendTier:'unknown'},{memory:{addressBits:65,proofMode:'symbolic-writes'}},
   {memory:{addressBits:64,proofMode:'unrecognized'}}]) {
  const {request}=pairedStores();stopped(await queryMemoryEquivalence({...request,...extra}));
 }
});
test('a failed proof cannot be replaced by a fake result, digest, or selected address list',async()=>{
 const {request}=pairedStores();const result=await queryMemoryEquivalence(request);assert.equal(result.eligible,true,result.reason);
 assert.equal(isAdoptableMemoryEquivalence({...result},request),false);
 assert.equal(isAdoptableMemoryEquivalence({eligible:true,bindingDigest:result.bindingDigest,evidence:result.evidence},request),false);
 for(const extra of [{memoryObservables:[]},{effectObservables:[]},{verified:true},{proof:result},{session:{}}]) stopped(await queryMemoryEquivalence({...request,...extra}));
});
test('adoption binds current architecture, semantics, inputs, preconditions, memory and source',async()=>{
 const {request}=pairedStores();const result=await queryMemoryEquivalence(request);assert.equal(result.eligible,true,result.reason);
 for(const key of ['snapshotId','architecture','semanticsVersion','binaryId','functionId','addressSpace','queryId']) {
  assert.equal(isAdoptableMemoryEquivalence(result,{...request,identity:{...identity,[key]:'changed'}}),false,key);
 }
 for(const change of [{proofMode:'concrete-writes'},{endian:'big'},{wrapping:'reject'},{addressBits:32},{initialBytes:[[0n,1]]}]) {
  assert.equal(isAdoptableMemoryEquivalence(result,{...request,memory:{...request.memory,...change}}),false);
 }
 assert.equal(isAdoptableMemoryEquivalence(result,{...request,inputs:[]}),false);
 assert.equal(isAdoptableMemoryEquivalence(result,{...request,preconditions:[E.createBool(true)]}),false);
 request.afterIr.instructions[0].args[0].value.const=17n;
 assert.equal(isAdoptableMemoryEquivalence(result,request),false);
});
test('volatile, atomic, fault and call boundaries never acquire write-cover proof authority',async()=>{
 for(const mutate of [ir=>ir.instructions[0].volatile=true,ir=>ir.instructions[0].atomic=true,
  ir=>ir.instructions[0].extra={stateWrite:{register:'flags'}},
  ir=>ir.instructions[0].extra={memoryAccess:{faults:['data-abort']}},
  ir=>ir.instructions[0].op='call']) {
  const {request}=pairedStores();mutate(request.beforeIr);stopped(await queryMemoryEquivalence(request));
 }
});
test('ordinary concrete footprint keeps its old fail-closed symbolic-write boundary',async()=>{
 const {request}=pairedStores();const r=await queryMemoryEquivalence({...request,memory:{...request.memory,proofMode:'concrete-writes'}});
 stopped(r);assert.match(r.reason,/symbolic-write-footprint/);
});
test('unsafe/sparse/cyclic request values fail closed without fabricated evidence',async()=>{
 const proxy=Proxy.revocable({},{});proxy.revoke();
 for(const extra of [{memory:proxy.proxy},{memory:{addressBits:[64]}},{memory:{addressBits:NaN}},
  {memory:{addressBits:Infinity}},{memory:{addressBits:-0}},{inputs:new Array(2)},
  {preconditions:[Symbol('bad')]},{memory:{initialBytes:[[Number.MAX_SAFE_INTEGER+1,0]]}}]) {
  const {request}=pairedStores();stopped(await queryMemoryEquivalence({...request,...extra}));
 }
});

test('unknown memory contract fields and accessor-backed adoption identity cannot silently pass',async()=>{
 const {request}=pairedStores();
 for(const field of ['volatile','atomic','addressWitness','observedAddresses','accessSemantics']) {
  stopped(await queryMemoryEquivalence({...request,memory:{...request.memory,[field]:[]}}));
 }
 const r=await queryMemoryEquivalence(request);assert.equal(r.eligible,true,r.reason);
 let invoked=0;const current={...identity};Object.defineProperty(current,'queryId',{get(){invoked++;return identity.queryId;},enumerable:true});
 assert.equal(isAdoptableMemoryEquivalence(r,{...request,identity:current}),false);assert.equal(invoked,0);
});
test('replaying the same bounded program preserves proof scope and work accounting',async()=>{
 const {request}=pairedStores();const a=await queryMemoryEquivalence(request),b=await queryMemoryEquivalence(request);
 assert.equal(a.verdict,'proved',a.reason);assert.equal(b.verdict,a.verdict,b.reason);
 assert.equal(a.scope.obligationHash,b.scope.obligationHash);
 assert.deepEqual(a.scope.observedAddressTerms,b.scope.observedAddressTerms);
 for(const [key,count]of Object.entries(a.metrics))if(key!=='wallClock'&&key!=='memory')assert.equal(b.metrics[key],count,key);
});


test('equality simplification cannot erase the original unknown-memory state budget',async()=>{
 const ir=program([]);
 const request={identity,beforeIr:ir,afterIr:ir,inputs:[],timeoutMs:2000,memory:{addressBits:4,proofMode:'finite-domain'}};
 const limited=await queryMemoryEquivalence(request);
 stopped(limited);assert.equal(limited.reason,'budget:solver-assignments');
 const wide=await queryMemoryEquivalence({...request,backendTier:'tiered'});
 assert.equal(wide.eligible,true,wide.reason);
 assert.equal(wide.metrics.observedBytes,32,'all 16 bytes in both executions still participate');
});


test('cancellation or stale source at final metrics cannot publish an assembled proof',async()=>{
 for(const mode of ['cancelled','identity','ir']) {
  const {request}=pairedStores();let reads=0,cutoff=Infinity,cancelled=false,current=identity;
  const options={...request,now:()=>{
   if(++reads>=cutoff) {
    if(mode==='cancelled')cancelled=true;
    else if(mode==='identity')current={...identity,snapshotId:'after-projection'};
    else request.afterIr.instructions.at(-1).args[0].value.const=99n;
   }
   return 0;
  },isCancelled:()=>cancelled,getCurrentIdentity:()=>current};
  const prior=await queryMemoryEquivalence(options);assert.equal(prior.eligible,true,prior.reason);
  cutoff=reads-2;reads=0; // Last metrics sampling, before the final publication checks.
  const result=await queryMemoryEquivalence(options);stopped(result);
  assert.match(result.reason,/cancelled|stale/,mode);
 }
});
