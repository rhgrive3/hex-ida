import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,workFor,qualified} from './helpers.mjs';
import {pipelineResult} from './pipeline-fixture.mjs';
import {createObjectContext,createObjectPartition,assertObjectPartition,compareSubobjectGeometry,objectObligationProposition,strongUpdateEligibility,isQualifiedStrongUpdateEligibility,partitionPointsToObjects} from '../../js/analysis/pointsto/objects.js';
import {projectCanonicalPhysicalTypes} from '../../js/analysis/types/scoped-physical.js';
import {queryScopedAbiPlacement} from '../../js/analysis/types/scoped-abi.js';
import {normalizeDemandRangeRequest,requestDemandRanges} from '../../js/decompiler/phase8/demand-range.js';
import {queryMachOPointerView,createObjcScopedDispatchResolver} from '../../js/analysis/apple/scoped-metadata.js';
import {createSwiftScopedDispatchResolver} from '../../js/analysis/apple/scoped-swift.js';
import {machOPointerMetadataRevision} from '../../js/binary/macho-dyld.js';
import {scopedStaticAddress,scopedStaticAddressMemberId,scopedCallTargetDomain,queryRuntimeReconciliation} from '../../js/runtime/scoped-reconciliation.js';
import {describeInvestigationFrontier,InvestigationViewCache} from '../../js/ai/investigation/scoped-frontier.js';
import {queryScopedRecognition} from '../../js/recognition/scoped-evidence.js';
const root={rootKey:'heap-root',rootKind:'heap',addressSpace:'memory',evidenceIds:['owner-evidence']};
const partition=(f,description={})=>createObjectPartition(root,{...f,context:createObjectContext(),description});
test('allocation annotations never manufacture singleton, lifetime, alias or write authority',()=>{
  const f=fixture(),p=partition(f,{kind:'heap',allocationSite:'a',lifetimeGeneration:'generation1'});
  assert.equal(p.cardinality,'unknown');assert.equal(p.lifetime,'unknown');assert.equal(p.layoutAuthority,'unqualified');
  assert.throws(()=>assertObjectPartition(structuredClone(p)),/unbound/);
  const r=strongUpdateEligibility(p,{accessId:'write'});assert.equal(r.eligible,false);assert.equal(r.missing.length,5);
});
for(const [name,description] of [
  ['inverted extent',{extent:{minimumBytes:9,maximumBytes:8}}],['negative extent',{extent:{minimumBytes:-1}}],
  ['bit range beyond subobject',{subobject:{size:1,bitRange:{lsb:7,width:2}}}],['empty bit range',{subobject:{size:1,bitRange:{lsb:0,width:0}}}],
  ['unknown field',{singleton:true}],['unknown kind',{kind:'magic'}],
])test(`object partition rejects ${name}`,()=>assert.throws(()=>partition(fixture(),description)));
for(const value of [
  {kind:'call-string',callSites:[],receiverPartition:null},
  {kind:'call-string',callSites:['1','2','3','4','5'],receiverPartition:null},
  {kind:'context-insensitive',callSites:['x'],receiverPartition:null},
  {kind:'object-sensitive',callSites:[],receiverPartition:null},
])test('object context remains explicit and finitely bounded',()=>assert.throws(()=>createObjectContext(value)));
test('same root bit geometry distinguishes overlap and empty without claiming alias',()=>{
  const f=fixture();const p=(offset,size,bitRange)=>partition(f,{subobject:{offset,size,...(bitRange?{bitRange}:{})}});
  const a=p(0,4),b=p(4,4),c=p(1,4),empty=p(2,0);
  assert.equal(compareSubobjectGeometry(a,b).relation,'disjoint-described-bits');
  assert.equal(compareSubobjectGeometry(a,c).relation,'overlapping-described-bits');
  assert.equal(compareSubobjectGeometry(a,empty).relation,'empty-described-range');
  assert.equal(compareSubobjectGeometry(a,a).relation,'same-described-bits');
  assert.equal(compareSubobjectGeometry(p(0,1,{lsb:0,width:4}),p(0,1,{lsb:4,width:4})).aliasAuthority,false);
});
test('object instance and world changes prevent cross-generation geometric deductions',()=>{
  const f=fixture(),a=partition(f,{lifetimeGeneration:'g1'}),b=partition(f,{lifetimeGeneration:'g2'});
  assert.equal(compareSubobjectGeometry(a,b).relation,'unknown');
  assert.equal(compareSubobjectGeometry(a,partition(fixture(d=>d.generation='g2'))).reason,'object-world-mismatch');
});
test('all five bound proof preconditions are necessary and the result is privately branded',async()=>{
  const f=fixture(),p=partition(f,{lifetimeGeneration:'g1'}),accessId='write1';
  const proofs=await Promise.all(['singleton','live','exclusive','layout','in-bounds-access'].map(kind=>qualified(f,{
    subject:p.id,value:objectObligationProposition(p,kind,kind==='in-bounds-access'?accessId:null)})));
  const r=strongUpdateEligibility(p,{accessId,proofs});assert.equal(r.eligible,true);
  const binding={partitionId:p.id,accessId,worldId:f.world.id,assumptionsId:f.assumptions.id};
  assert.equal(isQualifiedStrongUpdateEligibility(r,binding),true);
  assert.equal(isQualifiedStrongUpdateEligibility({...r},binding),false);
  assert.equal(strongUpdateEligibility(p,{accessId:'write2',proofs}).eligible,false);
  assert.throws(()=>strongUpdateEligibility(p,{accessId,proofs:proofs.map(x=>({...x}))}),/unbound|qualified/);
});
for(const top of [true,false])test(`points-to ${top?'TOP':'bottom'} does not prove absent memory`,async t=>{
  const f=fixture(),r=await partitionPointsToObjects({top,targets:[],lossReasons:[]},{...f,context:createObjectContext(),work:workFor(t)});
  assert.equal(r.completeness,'partial');assert.equal(r.partitions.length,0);assert.equal(r.aliasAuthority,false);assert.equal(r.unknowns.length,1);
});
test('cancelled target description never publishes partial object partitions',async t=>{
  const f=fixture(),w=workFor(t);
  await assert.rejects(partitionPointsToObjects({top:false,targets:[root]}, {...f,context:createObjectContext(),work:w,
    describeTarget:async()=>{w.dispose();return{};}}));
});
test('physical type owner preserves load access width rather than inventing pointee size',()=>{
  const f=fixture(),p=pipelineResult().pipeline,n=p.semanticIr.nodes.find(n=>n.memory);
  const r=projectCanonicalPhysicalTypes(p,[n.id,'missing'],{worldId:f.world.id,snapshotId:'snap'});
  assert.equal(r.status,'completed');assert.equal(r.exact,false);assert.equal(r.missing.some(x=>x.entityId==='missing'),true);
  assert.ok(r.evidence.some(x=>x.interpretation==='access-width-not-pointee-size'));
  assert.ok(r.results.every(x=>x.staticExact===false));
});
test('physical types remain bounded, cancellable and duplicate-owner-intolerant',()=>{
  const f=fixture(),p=pipelineResult().pipeline,ctx={worldId:f.world.id,snapshotId:'snap'};
  assert.throws(()=>projectCanonicalPhysicalTypes(p,[],ctx));
  assert.throws(()=>projectCanonicalPhysicalTypes(p,Array.from({length:65},(_,i)=>'v'+i),ctx));
  const duplicate=structuredClone(p);duplicate.semanticIr.values.push(duplicate.semanticIr.values[0]);
  assert.throws(()=>projectCanonicalPhysicalTypes(duplicate,['x'],ctx),/duplicate/);
  const c=new AbortController();c.abort(new Error('stopped'));
  assert.throws(()=>projectCanonicalPhysicalTypes(p,['x'],{...ctx,signal:c.signal}),/stopped/);
});
test('physical type owner digest changes with snapshot and declaration identity',()=>{
  const f=fixture(),p=pipelineResult().pipeline,id=p.semanticIr.values[0].id;
  const a=projectCanonicalPhysicalTypes(p,[id],{worldId:f.world.id,snapshotId:'one'});
  const b=projectCanonicalPhysicalTypes(p,[id],{worldId:f.world.id,snapshotId:'two'});
  assert.notEqual(a.ownerDigest,b.ownerDigest);
});
for(const bad of [{valueIds:[]},{valueIds:['1']},{valueIds:[-1]},{valueIds:[1],mode:'global-solve'},
  {valueIds:[1],constraints:[{valueId:2,operator:'eq',constant:0,bits:64,truth:true,assumptionId:'a'}]},
  {valueIds:[1],constraints:[{valueId:1,operator:'eq',constant:0,bits:65,truth:true,assumptionId:'a'}]}])
  test('demand range requests cannot broaden into unbounded or unbound predicates',()=>assert.throws(()=>normalizeDemandRangeRequest(bad)));
test('range request normalizes selected values without enabling publication',async t=>{
  assert.deepEqual(normalizeDemandRangeRequest({valueIds:[3,1,3]}).valueIds,[1,3]);
  const r=await requestDemandRanges({}, {valueIds:[1]}, {...fixture(),work:workFor(t)});
  assert.equal(r.status,'unsupported');assert.deepEqual(r.values,[]);
});
test('pointer metadata stays a declaration even with a current source-bound loader',async t=>{
  const f=fixture(),image={},context={worldId:f.world.id,snapshotId:'snap',binaryId:'binary-scpa-test',sliceId:'slice-arm64',
    storageAddress:'0x1000',rawValue:'0x2000',image,loaderRevision:machOPointerMetadataRevision(image),artifactId:'loader-artifact',
    evidenceIds:['source-bytes'],byteBinding:'host-read-current-source',isCurrent:()=>true};
  const r=await queryMachOPointerView({storageAddress:'0x1000'},{...f,snapshotId:'snap',work:workFor(t),getContext:()=>context});
  assert.equal(r.status,'completed');assert.equal(r.exact,false);assert.equal(r.pointer.authenticationVerified,false);
  assert.equal(r.pointer.executionTargetExact,false);assert.ok(r.remaining.includes('no-recorded-fixup'));
});
for(const [name,change] of [['stale loader',c=>c.loaderRevision='9'],['missing source',c=>c.evidenceIds=[]],
  ['wrong world',c=>c.worldId='wrong'],['changed owner',c=>c.isCurrent=()=>false]])test(`pointer view rejects ${name}`,async t=>{
  const f=fixture(),context={worldId:f.world.id,snapshotId:'snap',binaryId:'binary-scpa-test',sliceId:'slice-arm64',storageAddress:'0x1000',rawValue:'0x2000',
    image:{},loaderRevision:'0',artifactId:'loader',evidenceIds:['e'],byteBinding:'host-read-current-source',isCurrent:()=>true};change(context);
  await assert.rejects(queryMachOPointerView({storageAddress:'0x1000'},{...f,snapshotId:'snap',work:workFor(t),getContext:()=>context}));
});
test('runtime addresses preserve full 64-bit identity and exact image/slice binding',()=>{
  const {world:w}=fixture(),a={binaryId:'binary-scpa-test',sliceId:'slice-arm64',address:'0xffffffffffffffff'};
  assert.equal(scopedStaticAddress(a,w).address,'0xffffffffffffffff');
  assert.equal(scopedStaticAddressMemberId(a,w),scopedStaticAddressMemberId({...a,address:18446744073709551615n},w));
  assert.throws(()=>scopedStaticAddress({...a,address:1n<<64n},w));assert.throws(()=>scopedStaticAddress({...a,sliceId:'other'},w));
});
test('runtime target domains cannot transfer evidence between callsites or world generations',()=>{
  const f=fixture(),s={binaryId:'binary-scpa-test',sliceId:'slice-arm64',functionId:'f',callSiteId:'call1'};
  assert.notEqual(scopedCallTargetDomain(s,f.world),scopedCallTargetDomain({...s,callSiteId:'call2'},f.world));
  assert.notEqual(scopedCallTargetDomain(s,f.world),scopedCallTargetDomain(s,fixture(d=>d.generation='g2').world));
});
for(const [name,fn,request] of [
  ['ABI',queryScopedAbiPlacement,{functionId:'f',kind:'arguments'}],
  ['runtime',queryRuntimeReconciliation,{runtimeSessionId:'session',eventIds:['e'],role:'instruction'}],
  ['investigation',describeInvestigationFrontier,{jobId:'job'}],
  ['recognition',queryScopedRecognition,{functionId:'f'}],
])test(`${name} rejects unbound owners without inventing proof or triggering execution`,async t=>{
  const r=await fn(request,{...fixture(),snapshotId:'snap',work:workFor(t)});assert.equal(r.status,'unsupported');assert.equal(r.exact,false);
});
test('runtime non-call observations cannot masquerade as call-target evidence',async t=>{
  await assert.rejects(queryRuntimeReconciliation({runtimeSessionId:'s',eventIds:['e'],role:'instruction',targetEnvelopeId:'target'},
    {...fixture(),snapshotId:'snap',work:workFor(t)}),/requires-call-target/);
});
test('Apple resolvers require both canonical metadata and function identity capabilities',()=>{
  for(const make of [createObjcScopedDispatchResolver,createSwiftScopedDispatchResolver]){
    assert.throws(()=>make({snapshotId:'snap'}));
    const resolver=make({snapshotId:'snap',getContext:()=>null,resolveFunctionIdentity:()=>null});
    assert.ok(resolver.families.length>0);assert.equal(typeof resolver.resolve,'function');
  }
});
