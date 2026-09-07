import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePhase8RewritePlan,isPhase8RewritePlan,runPhase8Stage,runPassTransaction,seedAnalysisState,createPassResult } from '../../../js/decompiler/phase8/index.js';
import { PROOF_REWRITE_PASS,runProofRewritePass } from '../../../js/decompiler/phase8/pass-validation.js';
import {proofFixture,identity} from '../helpers/proof-fixtures.mjs';
const context=(f,plan,extra={})=>({ir:f.ir,proofIdentity:identity,abiId:f.options.abiId,proofRewritePlan:plan,...extra});
const stage=(f,plan,extra={})=>runPhase8Stage(context(f,plan,extra),{stages:['canonical-facts','rendering'],timeBudgetMs:120});

test('v8 issued immutable solver plan reaches the actual pass transaction',async()=>{
 const f=proofFixture(),plan=await preparePhase8RewritePlan(f.ir,f.options);
 assert.equal(plan.status,'complete',plan.reason);assert.equal(plan.entries.length,1);
 assert.equal(isPhase8RewritePlan(plan,context(f,plan)),true);
 const r=stage(f,plan);assert.equal(r.ledger.published,true,JSON.stringify(r.ledger.diagnostics));
 assert.equal(r.analysis.get('provedRewrites').entries[0].value,0n);
 assert.equal(r.ledger.passes.at(-1).transforms[0].validation.queryHash,plan.entries[0].queryHash);
 assert.equal(f.ir.instructions[0].sub,'xor');assert.equal(Object.isFrozen(plan.entries[0]),true);
});
for(const kind of ['copy','hash-only','serialized','missing']) test(`v8 forged plan refused: ${kind}`,async()=>{
 const f=proofFixture(),p=await preparePhase8RewritePlan(f.ir,f.options);
 const plan=kind==='copy'?{...p}:kind==='hash-only'?{planId:p.planId,status:'complete'}:kind==='serialized'?JSON.parse(JSON.stringify(p,(_,v)=>typeof v==='bigint'?String(v):v)):{};
 const r=stage(f,plan);assert.equal(r.ledger.published,false);assert.equal(r.analysis.version('provedRewrites'),0);
});
for(const field of ['queryId','binaryId','snapshotId','functionId','architecture','addressSpace','semanticsVersion']) test(`v8 changed ${field} revokes admission`,async()=>{
 const f=proofFixture(),p=await preparePhase8RewritePlan(f.ir,f.options);
 assert.equal(stage(f,p,{proofIdentity:{...identity,[field]:'changed'}}).ledger.published,false);
});
test('v8 changed ABI, conditions, correspondence and IR revoke admission',async()=>{
 const f=proofFixture(),p=await preparePhase8RewritePlan(f.ir,f.options);
 for(const extra of [{abiId:'other'},{preconditions:[true]},{correspondence:{inputs:[{before:'x',after:'x'}]}}]) assert.equal(stage(f,p,extra).ledger.published,false);
 f.target.def.sub='or';assert.equal(stage(f,p).ledger.published,false);
});
test('v8 a forged transform cannot launder a valid plan or staged artifact',async()=>{
 const f=proofFixture(),p=await preparePhase8RewritePlan(f.ir,f.options);
 for(const mutate of [t=>({...t,validation:{...t.validation}}),t=>({...t,targets:['other']}),t=>({...t,rewrite:{...t.rewrite,afterHash:'forged'}})]) {
  const state=seedAnalysisState(f.ir),before=state.snapshot();
  const pass={descriptor:PROOF_REWRITE_PASS,run(c,b,a){const r=runProofRewritePass(c,b,a);return createPassResult({...r,descriptor:PROOF_REWRITE_PASS,transforms:r.transforms.map(mutate)});}};
  const r=runPassTransaction(state,pass,context(f,p),{});
  assert.equal(r.committed,false,r.stopReason);assert.deepEqual(state.snapshot(),before);
 }
});
test('v8 cancelled preparation and revoked model publish no usable plan',async()=>{
 const f=proofFixture(),ac=new AbortController();ac.abort();
 const p=await preparePhase8RewritePlan(f.ir,{...f.options,signal:ac.signal});assert.equal(p.status,'partial');assert.equal(p.entries.length,0);
 const ac2=new AbortController(),p2=await preparePhase8RewritePlan(f.ir,{...f.options,signal:ac2.signal});ac2.abort();assert.equal(stage(f,p2).ledger.published,false);
});
for(const n of [0,1,2]) test(`v8 target limit N-1/N/N+1: ${n}`,async()=>{
 const f=proofFixture();const p=await preparePhase8RewritePlan(f.ir,{...f.options,limits:{targets:n}});
 assert.equal(p.status,n===0?'partial':'complete');
});
for(const n of [0,1,2]) test(`v8 rewrite limit N-1/N/N+1: ${n}`,async()=>{
 const f=proofFixture();const p=await preparePhase8RewritePlan(f.ir,{...f.options,limits:{rewrites:n}});
 assert.equal(p.status,n===0?'partial':'complete');
});
test('v8 deterministic plan and ledger replay',async()=>{
 const f=proofFixture(),a=await preparePhase8RewritePlan(f.ir,f.options),b=await preparePhase8RewritePlan(f.ir,f.options);
 assert.equal(a.planId,b.planId);assert.equal(stage(f,a).ledger.publicationDigest,stage(f,b).ledger.publicationDigest);
});
test('v8 final transaction budget callback cannot mutate IR after proof admission',async()=>{
 const f=proofFixture(),plan=await preparePhase8RewritePlan(f.ir,f.options),state=seedAnalysisState(f.ir),before=state.snapshot();let calls=0;
 const result=runPassTransaction(state,{descriptor:PROOF_REWRITE_PASS,run:runProofRewritePass},context(f,plan),{shouldAbort(){if(++calls===4)f.target.def.sub='or';return false;}});
 assert.equal(calls,4);assert.equal(result.committed,false);assert.deepEqual(state.snapshot(),before);
});
