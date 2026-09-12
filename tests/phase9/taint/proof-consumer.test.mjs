import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyDeobfuscationCandidate,isAdoptableCandidate,expr as E } from '../../../js/symbolic/index.js';
import { verifyBoundedEquivalence } from '../../../js/symbolic/verify/equivalence.js';
import { ExhaustiveBvBackend } from '../../../js/symbolic/solver/exhaustive-backend.js';
import { identity } from './fixtures.mjs';
export function candidate(extra={}) {
  const x=E.createFreshSymbol(E.bvSort(4),'proof-input');
  return {candidateId:'mba',beforeValueId:'before',afterValueId:'after',identity,
    before:E.createBinary('add',x,x),after:E.createBinary('shl',x,E.createBv(4,1)),
    memoryObservables:[],effectObservables:[],...extra};
}
test('real backend proved/refuted candidates differ at the public adoption boundary',async()=>{
  const c=candidate(),proved=await verifyDeobfuscationCandidate(c);
  assert.equal(proved.eligible,true,proved.reason);assert.equal(proved.evidence.proofAuthority,'exact');assert.equal(isAdoptableCandidate(proved),true);
  const refuted=await verifyDeobfuscationCandidate({...c,after:E.createBv(4,1)});
  assert.equal(refuted.eligible,false);assert.equal(refuted.verdict,'refuted');assert.ok(refuted.counterexample);
});
test('fake proof, memory/effect omission, stale receipts and same-name symbol collision fail closed',async()=>{
  const c=candidate();assert.equal((await verifyDeobfuscationCandidate({...c,verified:true})).eligible,false);
  const missing={...c};delete missing.memoryObservables;assert.equal((await verifyDeobfuscationCandidate(missing)).reason,'missing-memory-effect-observables');
  assert.equal((await verifyDeobfuscationCandidate({...c,effectObservables:['call']})).eligible,false);
  const proved=await verifyDeobfuscationCandidate(c);assert.equal(isAdoptableCandidate({...proved}),false);
  assert.equal(isAdoptableCandidate(proved,{identity:{...identity,snapshotId:'new'}}),false);
  assert.equal(isAdoptableCandidate(proved,{after:E.createBv(4,0)}),false);
  const x=E.createFreshSymbol(E.bvSort(4),'collision'),y=E.createFreshSymbol(E.bvSort(4),'collision');
  assert.equal((await verifyDeobfuscationCandidate({...c,before:x,after:y})).reason,'ambiguous-symbol-name-handoff');
});
test('contradictory preconditions, timeout, cancellation and late snapshot change cannot adopt',async()=>{
  const c=candidate();assert.equal((await verifyDeobfuscationCandidate({...c,preconditions:[E.createBool(false)]})).eligible,false);
  assert.equal((await verifyDeobfuscationCandidate({...c,timeoutMs:0})).eligible,false);
  const ac=new AbortController();ac.abort();assert.equal((await verifyDeobfuscationCandidate({...c,signal:ac.signal})).eligible,false);
  let current=identity;const promise=verifyDeobfuscationCandidate({...c,getCurrentIdentity:()=>current});current={...identity,snapshotId:'new'};
  assert.equal((await promise).eligible,false);
});
test('the existing judge memory-observable counterexample stays outside adoption',async()=>{
  // Independent byte observation: before[0]=1, after[0]=2, even though return values agree.
  const memoryRegions=[{id:'byte-zero',before:1,after:2}];
  const existing=await verifyBoundedEquivalence({beforeTarget:E.createBv(4,0),afterTarget:E.createBv(4,0),memoryRegions,backend:new ExhaustiveBvBackend()});
  console.log(`READ_ONLY_JUDGE_MEMORY_COUNTEREXAMPLE=${existing.verdict}`);
  assert.notEqual(memoryRegions[0].before,memoryRegions[0].after);
  const guarded=await verifyDeobfuscationCandidate(candidate({before:E.createBv(4,0),after:E.createBv(4,0),memoryObservables:memoryRegions}));
  assert.equal(guarded.eligible,false);assert.equal(guarded.reason,'memory-effect-judge-handoff');
});
test('unregistered backend remains explicitly unsupported',async()=>{
  const x=E.createFreshSymbol(E.bvSort(32),'wide');
  const r=await verifyDeobfuscationCandidate(candidate({before:E.createBinary('xor',x,x),after:E.createBv(32,0),backendTier:'unregistered-tier'}));
  assert.equal(r.eligible,false);assert.equal(r.reason,'unsupported-backend');
});

test('taint query/model scope is bound and stale/unknown taint cannot redeem a receipt',async()=>{
  const {queryTaint,createTaintModels}=await import('../../../js/symbolic/index.js');
  const {scalarFixture}=await import('./fixtures.mjs');
  const models=createTaintModels({id:'proof-model',version:'1',provenance:'test',sources:[{id:'src',valueId:'input'}],sinks:[{id:'sink',valueId:'out'}]});
  let currentModel=models.modelIdentity;
  const taintResult=queryTaint(scalarFixture(),{identity,models,getCurrentModelIdentity:()=>currentModel,memory:{addressBits:8}});
  const r=await verifyDeobfuscationCandidate(candidate({taintResult}));
  assert.equal(r.eligible,true,r.reason);assert.equal(r.binding.taint.modelIdentity,models.modelIdentity);
  assert.equal(r.binding.taint.queryHash,taintResult.evidence.queryHash);
  currentModel='new-model';assert.equal(isAdoptableCandidate(r),false);
  assert.equal((await verifyDeobfuscationCandidate(candidate({taintResult}))).eligible,false);
  const top=queryTaint(scalarFixture(),{identity,models:createTaintModels({id:'unknown',version:'1',provenance:'test',sinks:[{id:'sink',valueId:'missing'}]}),memory:{addressBits:8}});
  assert.equal((await verifyDeobfuscationCandidate(candidate({taintResult:top}))).eligible,false);
});

test('actual Bool proofs, nontrivial vacuity and unsupported widths fail closed',async()=>{
  const flag=E.createFreshSymbol(E.boolSort(),'boolean-input');
  const c=candidate({before:E.createConnective('not',E.createConnective('not',flag)),after:flag});
  assert.equal((await verifyDeobfuscationCandidate(c)).eligible,true);
  assert.equal((await verifyDeobfuscationCandidate({...c,after:E.createBool(false)})).verdict,'refuted');
  const bv=candidate(),x=bv.before.left;
  const impossible=[E.createCompare('eq',x,E.createBv(4,0)),E.createCompare('eq',x,E.createBv(4,1))];
  assert.equal((await verifyDeobfuscationCandidate({...bv,preconditions:impossible})).eligible,false);
  const wide=E.createFreshSymbol(E.bvSort(65),'unsupported-width');
  assert.equal((await verifyDeobfuscationCandidate(candidate({before:wide,after:wide}))).eligible,false);
});
