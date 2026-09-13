import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, workFor } from './helpers.mjs';
import { projectSwiftGenericEnvironment, SWIFT_GENERIC_ENVIRONMENT_SCHEMA } from '../../js/analysis/apple/scoped-swift-generic.js';
import { createSwiftScopedDispatchResolver } from '../../js/analysis/apple/scoped-swift.js';
import { buildSwiftRuntimeIndex } from '../../js/swift.js';
import { DispatchResolverRegistry } from '../../js/analysis/dispatch/unified.js';
const P = index => ({ depth:0,index });
const T = index => ({kind:'parameter',parameter:P(index)});
const N = address => ({kind:'nominal',binaryId:'binary-scpa-test',sliceId:'slice-arm64',address});
function setup(t) {
  const f=fixture(), binding={worldId:f.world.id,assumptionsId:f.assumptions.id,snapshotId:'snap',projectionId:'projection',callSiteId:'call',
    binaryId:'binary-scpa-test',sliceId:'slice-arm64',artifactId:'swift-current-source',ownerRevision:'1',byteBinding:'host-read-current-source',evidenceIds:['source']};
  const index=buildSwiftRuntimeIndex({complete:false,types:[{address:4096n,name:'A',generic:false},{address:4100n,name:'B',generic:false},{address:4104n,name:'Generic',generic:true}],
    protocols:[{address:8192n,name:'P',requirementsComplete:true,requirements:[{index:0,witnessCallable:true}]}],
    conformances:[{address:8200n,typeReferenceKind:0,typeRef:4096n,protocol:8192n,witnessTable:12288n,conditionalRequirements:0,resilientWitnesses:false}],
    witnessTables:[{address:12288n,typeAddress:4096n,protocolAddress:8192n,entries:[{index:0,address:12296n,rawTarget:16384n,target:16384n,resolved:true}]}],
    vtables:[{typeAddress:4096n,methods:[{index:0,impl:16384n}]}]});
  const env={schema:SWIFT_GENERIC_ENVIRONMENT_SCHEMA,id:'generic-env',binding:structuredClone(binding),parameters:[P(0),P(1)],
    substitutions:[{parameter:P(0),value:T(1)},{parameter:P(1),value:N('0x1000')}],
    requirements:[{id:'same',kind:'same-type',left:T(0),right:N('0x1000')},{id:'protocol',kind:'conformance',left:T(0),protocolAddress:'0x2000'}],complete:true};
  return {...f,binding,index,env,project:(value=env)=>projectSwiftGenericEnvironment(value,{expectedId:'generic-env',binding,index,work:workFor(t)})};
}
test('explicit chained generic bindings reuse nominal/conformance owners but never prove instantiation',t=>{
  const f=setup(t),r=f.project(); assert.equal(r.status,'declaration-consistent');assert.equal(r.exact,false);assert.equal(r.semantic,'unknown');
  assert.ok(r.constraints.every(c=>c.status==='declaration-consistent'));assert.equal(r.substitutions[0].term.address,'0x1000');
  assert.ok(r.remaining.includes('swift-runtime-generic-instantiation-not-proved'));assert.equal(f.env.substitutions[0].value.kind,'parameter');
});
test('a missing explicit environment stays unknown rather than an empty success',t=>{
  const f=setup(t),r=f.project(null);assert.equal(r.status,'partial');assert.equal(r.exact,false);assert.match(r.remaining.join(','),/unavailable/);
});
for(const [label,change] of [
  ['binding',e=>e.binding.ownerRevision='2'],['world',e=>e.binding.worldId='foreign'],['callsite',e=>e.binding.callSiteId='other'],
  ['id',e=>e.id='other'],['schema',e=>e.schema='other'],['unknown authority',e=>e.proved=true],['complete',e=>e.complete=1],
  ['duplicate parameter',e=>e.parameters.push(P(0))],['undeclared parameter',e=>e.substitutions[0].parameter=P(2)],
  ['duplicate requirement',e=>e.requirements.push(e.requirements[0])],['oversized parameter list',e=>e.parameters=Array.from({length:33},(_,i)=>P(i))],
  ['unsupported term',e=>e.substitutions[0].value={kind:'application'}],['coercible address',e=>e.substitutions[1].value.address=['0x1000']],
])test(`generic declarations reject ${label}`,t=>{const f=setup(t);change(f.env);assert.throws(()=>f.project());});
test('same-type mismatch preserves both declarations and all candidates as conflicting, not a closed exclusion',t=>{
  const f=setup(t);f.env.requirements[0].right=N('0x1004');const r=f.project();
  assert.equal(r.status,'declaration-conflict');assert.equal(r.conflicts.length,1);assert.equal(r.constraints.length,2);assert.equal(r.exact,false);
});
test('ambiguous substitutions do not choose the first or last nominal type',t=>{
  const f=setup(t);f.env.substitutions.push({parameter:P(1),value:N('0x1004')});const r=f.project();
  assert.equal(r.status,'declaration-conflict');assert.equal(r.substitutions[1].declaredAlternatives.length,2);
  assert.equal(r.constraints[0].status,'UNKNOWN');assert.match(r.remaining.join(','),/ambiguous/);
});
test('duplicate identical substitutions coalesce without changing the logical view',t=>{
  const f=setup(t),before=f.project();f.env.substitutions.push(structuredClone(f.env.substitutions[1]));assert.equal(f.project().id,before.id);
});
for(const [label,change,reason] of [
  ['cycle',e=>e.substitutions[1].value=T(0),'cycle'],['unbound',e=>e.substitutions.pop(),'unbound'],
  ['generic nominal',e=>e.substitutions[1].value=N('0x1008'),'instantiation-unavailable'],
  ['foreign binary',e=>e.substitutions[1].value.binaryId='other','not-in-bound-owner'],
  ['foreign slice',e=>e.substitutions[1].value.sliceId='other','not-in-bound-owner'],
  ['unknown nominal',e=>e.substitutions[1].value=N('0x1100'),'not-in-bound-owner'],
  ['associated type',e=>e.substitutions[1].value={kind:'dependent-member',base:N('0x1000'),protocolAddress:'0x2000',name:'Element'},'associated-type'],
  ['superclass',e=>e.requirements[0].kind='superclass','superclass-owner'],
  ['layout',e=>e.requirements[0]={id:'layout',kind:'layout',left:T(0),layout:'class'},'layout-owner'],
])test(`unsupported ${label} retains a visible unknown obligation`,t=>{
  const f=setup(t);change(f.env);const r=f.project();assert.equal(r.status,'partial');assert.match(r.remaining.join(','),new RegExp(reason));assert.equal(r.exact,false);
});
for(const mutation of ['conditional','resilient','collision','missing'])test(`${mutation} conformance cannot be a declared exact substitution`,t=>{
  const f=setup(t),rows=f.index.conformancesByType.get('type@4096');
  if(mutation==='conditional')rows[0].conditionalRequirements=1;else if(mutation==='resilient')rows[0].resilientWitnesses=true;
  else if(mutation==='collision')rows.push({...rows[0]});else rows.length=0;
  const r=f.project();assert.equal(r.constraints[1].status,'UNKNOWN');assert.equal(r.exact,false);
});
test('stopped work, recursive data and accessors do not reach the generic owner',t=>{
  const f=setup(t),w=workFor(t);w.dispose();assert.throws(()=>projectSwiftGenericEnvironment(f.env,{expectedId:'generic-env',binding:f.binding,index:f.index,work:w}));
  let accesses=0;assert.throws(()=>f.project({get schema(){accesses++;return'unsafe';}}));assert.equal(accesses,0);
  f.env.substitutions[1].value={kind:'dependent-member',base:null,name:'E',protocolAddress:'0x2000'};f.env.substitutions[1].value.base=f.env.substitutions[1].value;
  assert.throws(()=>f.project(),/cycle/);
});
async function resolve(t,kind='witness',change=()=>{}){
  const f=setup(t);let current=true;const context={binding:f.binding,index:f.index,genericEnvironment:f.env,
    call:{kind,typeAddress:'0x1000',...(kind==='vtable'?{}:{protocolAddress:'0x2000'}),slot:0,genericEnvironmentId:'generic-env'},isCurrent:()=>current};
  change(context,()=>{current=false;});
  const resolver=createSwiftScopedDispatchResolver({snapshotId:'snap',getContext:()=>context,
    resolveFunctionIdentity:async request=>{context.afterLookup?.();return {...request,worldId:f.world.id,snapshotId:'snap',entityId:'canonical-existing-function'};}});
  const registry=new DispatchResolverRegistry();registry.register(resolver);
  const result=await registry.resolve(registry.descriptors()[0],{callSiteId:'call',families:['swift-witness','swift-metadata'],maxTargets:8,maxHops:4},
    {...f,projection:{id:'projection'},nodeReference:'canonical-call'},workFor(t));
  return result;
}
for(const kind of ['witness','existential','vtable'])test(`${kind} sends bound generic declarations through the same dispatch schema`,async t=>{
  const r=await resolve(t,kind);assert.equal(r.status,'partial');assert.equal(r.candidates.length,1);
  const view=r.candidates[0].provenance.declaration.genericEnvironment;assert.equal(view.status,'declaration-consistent');assert.equal(view.exact,false);
  assert.ok(r.requirements.includes('swift-generic-environment-substitution-not-proved'));assert.ok(r.requirements.includes('swift-dynamic-conformance-world-open'));
});
test('generic contradictions never erase an otherwise visible witness alternative',async t=>{
  const r=await resolve(t,'witness',c=>c.genericEnvironment.requirements[0].right=N('0x1004'));
  assert.equal(r.candidates.length,1);assert.equal(r.candidates[0].provenance.declaration.genericEnvironment.status,'declaration-conflict');
});
test('metadata mutation during canonical function lookup rejects all generic provenance',async t=>{
  await assert.rejects(resolve(t,'witness',(c,retire)=>{c.afterLookup=retire;}),/stale-after-function-lookup/);
});
test('generic binding annotations cannot bypass conditional or resilient witness layout gates',async t=>{
  const r=await resolve(t,'witness',c=>{c.index.conformancesByType.get('type@4096')[0].conditionalRequirements=1;});
  assert.equal(r.status,'unsupported');assert.deepEqual(r.candidates,[]);assert.match(r.requirements.join(','),/conditional-or-resilient/);
});
