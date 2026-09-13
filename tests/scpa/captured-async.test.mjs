import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,workFor} from './helpers.mjs';
import {createRuntimeEvent} from '../../js/runtime/events.js';
import {RuntimeModuleBindingTable} from '../../js/runtime/provider-identity.js';
import {CAPTURED_ASYNC_SOURCE_SCHEMA,CAPTURED_ASYNC_EVENT_SCHEMA,capturedAsyncBuildIdentity} from '../../js/runtime/captured-async.js';
import {queryAsyncEventOrder} from '../../js/analysis/apple/scoped-async.js';
import {ScopedAnalysisService} from '../../js/analysis/query/scoped-service.js';
function setup(t){
 const f=fixture(),runtimeSessionId='session',snapshotId='snap',scope={objectId:'block-object',objectGeneration:'allocation-2'};
 const source={schema:'scpa-async-events/v1',events:['allocate','use','dispose'].map((kind,sequence)=>({id:`ev-${sequence}`,kind,strandId:'strand',sequence,...scope,sourceReferences:[`capture-${sequence}`]})),
 contracts:[{id:'seq',version:'1',rule:'sequenced-before',sourceReferences:['library-v1']}],
 relations:[0,1].map(i=>({id:`edge-${i}`,from:`ev-${i}`,to:`ev-${i+1}`,contractId:'seq',contractVersion:'1',sourceReferences:[`edge-source-${i}`]})),remaining:[]};
 const modules=new RuntimeModuleBindingTable(runtimeSessionId),moduleInput={bindingKey:'image',runtimeBase:4096n,runtimeSize:1024n,staticBase:8192n,binaryId:'binary-scpa-test',sliceId:'slice-arm64',identityState:'exact',identityEvidenceIds:['build-id'],buildIdentity:{kind:'sha256',hash:'ab'.repeat(32)}};
 modules.load(moduleInput);
 const events=new Map(source.events.map(e=>[e.id,createRuntimeEvent({eventId:e.id,runtimeSessionId,providerId:'fixture-capture',providerVersion:'1',sessionEpoch:1,
 kind:'trace-marker',moduleBindingKey:'image',moduleGeneration:1,observationMode:'observed',completeness:'complete',
 payload:{scpaAsync:{schema:CAPTURED_ASYNC_EVENT_SCHEMA,event:e},unrelated:'do-not-export-private-payload'}})]));
 const runtime={modules,binding:{worldId:f.world.id,assumptionsId:f.assumptions.id,snapshotId,runtimeSessionId,providerId:'fixture-capture',providerVersion:'1',sessionEpoch:1},
 isCurrent:()=>true,getObservation:id=>events.has(id)?{event:events.get(id),address:null}:null};
 const context={source,binding:{worldId:f.world.id,assumptionsId:f.assumptions.id,snapshotId,runtimeSessionId,epoch:1,moduleGeneration:'1',ownerRevision:'capture-model-v1'},
 runtimeCapture:{schema:CAPTURED_ASYNC_SOURCE_SCHEMA,moduleBindingKey:'image',moduleGeneration:1,providerSchemaVersion:CAPTURED_ASYNC_EVENT_SCHEMA},isCurrent:()=>true};
 const query={runtimeSessionId,fromEventId:'ev-0',toEventId:'ev-2',lifetime:{...scope,useEventId:'ev-1'}};
 const run=(extra={})=>queryAsyncEventOrder(query,{...f,snapshotId,work:workFor(t),getContext:()=>context,getRuntimeContext:()=>runtime,isCurrent:()=>true,...extra});
 return {f,query,context,events,runtime,modules,moduleInput,run};
}
test('canonical captured event bridge binds all lifetime records but does not prove static safety',async t=>{
 const f=setup(t),r=await f.run();assert.equal(r.relation,'before-in-model');assert.equal(r.captured.status,'bound');
 assert.deepEqual(r.captured.counts,{declared:3,bound:3,missing:0});assert.equal(r.lifetime.relation,'between-captured-boundaries-in-model');
 assert.equal(r.lifetime.lifetimeProven,false);assert.equal(r.semanticProof,false);assert.equal(r.runtimeExecutionRequested,false);
 assert.equal(JSON.stringify(r).includes('do-not-export-private-payload'),false);
});
for(const [name,change,reason] of [
 ['synthetic',e=>({...e,observationMode:'synthetic'}),'not-natural-mode'],
 ['intervened',e=>({...e,interventionIds:['tool-action']}),'not-natural-mode'],
 ['old generation',e=>({...e,moduleGeneration:2}),'historical-module'],
 ['gap',e=>({...e,kind:'gap'}),'record-incomplete'],
 ['partial record',e=>({...e,completeness:'partial'}),'record-incomplete'],
 ['payload model',e=>({...e,payload:{...e.payload,scpaAsync:{...e.payload.scpaAsync,event:{...e.payload.scpaAsync.event,kind:'dispose'}}}}),'payload-mismatch'],
 ['future schema',e=>({...e,payload:{...e.payload,scpaAsync:{...e.payload.scpaAsync,schema:'v99'}}}),'payload-mismatch'],
])test(`one ${name} record cannot be dropped to produce a complete order`,async t=>{
 const f=setup(t);f.events.set('ev-1',createRuntimeEvent(change(f.events.get('ev-1'))));const r=await f.run();
 assert.equal(r.relation,'unknown');assert.equal(r.witness,null);assert.deepEqual(r.captured.counts,{declared:3,bound:2,missing:1});
 assert.ok(r.captured.missing[0].reason.includes(reason));assert.equal(r.lifetime,null);
});
test('missing records and absent runtime owners preserve an explicit unknown',async t=>{
 const f=setup(t);f.events.delete('ev-2');assert.equal((await f.run()).captured.counts.missing,1);
 const r=await f.run({getRuntimeContext:null});assert.equal(r.relation,'unknown');assert.equal(r.captured.status,'unsupported');
});
test('captured source binding rejects a contradictory hash even through the explicit host owner',async t=>{
 const f=setup(t),modules=new RuntimeModuleBindingTable('session');
 modules.load({...f.moduleInput,buildIdentity:{kind:'sha256',hash:'cd'.repeat(32)}});f.runtime.modules=modules;
 const r=await f.run();assert.equal(r.relation,'unknown');assert.equal(r.captured.reason,'captured-async-build-identity-mismatch');
});
test('only comparable content identities bind and canonical binary hashes must agree with world hashes',()=>{
 const hash='ab'.repeat(32),module={binaryId:'bin_sha256_'+hash,sliceId:'slice-arm64',buildIdentity:{kind:'sha256',hash}};
 const local=fixture(d=>{d.binarySet[0].binaryId=module.binaryId;d.binarySet[0].sourceIdentity={kind:'local-immutable',sourceInstance:'source',generation:'1'};});
 assert.equal(capturedAsyncBuildIdentity(module,local.world).status,'matched');
 const conflict=fixture(d=>{d.binarySet[0].binaryId=module.binaryId;d.binarySet[0].sourceIdentity.sha256='cd'.repeat(32);});
 assert.equal(capturedAsyncBuildIdentity(module,conflict.world).reason,'captured-async-build-identity-mismatch');
 const unbound=fixture(d=>{d.binarySet[0].sourceIdentity={kind:'local-immutable',sourceInstance:'source',generation:'1'};});
 assert.equal(capturedAsyncBuildIdentity({...module,binaryId:'binary-scpa-test'},unbound.world).reason,'captured-async-build-identity-incomparable');
});
for(const key of ['providerId','providerVersion','runtimeSessionId','sessionEpoch','eventId'])test(`foreign captured ${key} is rejected`,async t=>{
 const f=setup(t),e=f.events.get('ev-1');f.events.set('ev-1',createRuntimeEvent({...e,[key]:key==='sessionEpoch'?2:'foreign'}));await assert.rejects(f.run(),/event-binding/);
});
test('noncanonical runtime JSON is not repaired into current source evidence',async t=>{
 const f=setup(t),e={...f.events.get('ev-1')};delete e.interventionIds;f.events.set('ev-1',e);await assert.rejects(f.run(),/event-binding/);
});
test('reload of the same module key while records are read rejects the entire answer',async t=>{
 const f=setup(t),get=f.runtime.getObservation;f.runtime.getObservation=id=>{const r=get(id);if(id==='ev-1'){f.modules.unload('image');f.modules.load(f.moduleInput);}return r;};
 await assert.rejects(f.run(),/module-generation-changed/);
});
test('runtime epoch, selected module, and static world remain independently checked',async t=>{
 const f=setup(t);f.runtime.binding.sessionEpoch=2;await assert.rejects(f.run(),/scope-mismatch/);
 f.runtime.binding.sessionEpoch=1;f.modules.unload('image');const r=await f.run();assert.equal(r.captured.reason,'captured-async-current-image-unqualified');
});
test('no array filtering can hide a contradiction in the captured event graph',async t=>{
 const f=setup(t);f.context.source.relations[0].contractVersion='foreign';const r=await f.run();
 assert.equal(r.captured.status,'bound');assert.equal(r.relation,'unknown');assert.ok(r.remaining.some(x=>x.includes('contract-version')));
});
test('owner retirement, source mutation and budget exhaustion cannot publish a captured binding',async t=>{
 const f=setup(t),get=f.runtime.getObservation;f.runtime.getObservation=id=>{f.context.isCurrent=()=>false;return get(id);};await assert.rejects(f.run(),/stale/);
 const g=setup(t);await assert.rejects(g.run({work:workFor(t,{workUnits:0})}));
});
test('scoped service uses both existing private owners without starting a pipeline or provider',async t=>{
 const f=setup(t);let calls=0;const host={configuration:{maximumSessions:2,sessionTtlMs:10000,getAsyncEventContext:()=>f.context,getRuntimeEvidenceContext:()=>f.runtime},
 isCurrent:()=>true,loadPipeline:async()=>{calls++;throw Error('must not execute');}};
 const service=new ScopedAnalysisService({host,snapshot:{snapshotId:'snap'},worldInput:f.f.world});t.after(()=>service.close());
 const r=(await service.invoke('asyncEventOrder',f.query)).value;assert.equal(r.captured.status,'bound');assert.equal(calls,0);
});
