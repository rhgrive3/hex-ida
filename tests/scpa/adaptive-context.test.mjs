import test from 'node:test';
import assert from 'node:assert/strict';
import { workFor } from './helpers.mjs';
import { captured, callee, scope } from './native-owner-fixture.mjs';
import { nativeWorkerFixture, NATIVE_ROWS } from './native-worker-fixture.mjs';
import { buildCanonicalQueryProjection } from '../../js/analysis/query/semantic/projection.js';
import { projectScopedDemandOwners } from '../../js/analysis/scoped-demand-projection.js';
import { specializeDemandSummary } from '../../js/analysis/summary/specialization.js';
import { AdaptiveContextPolicy, normalizeAdaptiveContextPolicy } from '../../js/analysis/refinement/adaptive-context.js';

async function owned(t) {
  const f=scope(),work=workFor(t,{residentBytes:64*1024*1024});
  const make=async x=>{
    const projection=await buildCanonicalQueryProjection(x.result.pipeline,{...f,snapshotId:'snap',work,
      sourceLocation:{start:x.base,end:x.base+BigInt(x.rows.length*4),snapshotId:'snap'},producerArtifactId:`artifact-${x.base}`});
    t.after(()=>projection.release());
    const demand=await projectScopedDemandOwners(x.owner,x.result,{kind:'demand',...f,worldId:f.world.id,snapshotId:'snap',precision:{maximumValues:64}},
      {limits:{deadlineMs:10000,residentBytes:64*1024*1024}});
    assert.equal(demand.status,'completed');return {projection,demand};
  };
  const a=await make(captured()),b=await make(captured(0x2000n,callee));
  const callSiteId=a.demand.nativeFlowInputs.calls[0].callSiteId;
  const create=(sccRevision='revision-a',reason=null)=>specializeDemandSummary({caller:a,callee:b,callSiteId,summary:b.demand.summary,
    sccRevision,targetBinding:{callerFunctionId:a.projection.functionId,callSiteId,targetFunctionId:b.projection.functionId,inSelectedScope:true,reason},
    ...f,snapshotId:'snap',work});
  return {view:await create(),create,work,baseline:b.demand.ranges};
}
const baseline={values:[{localId:1,fact:{constant:null,range:{kind:'full'}}}]};
const result=(v,improved=true)=>({contextId:v.id,worldId:v.worldId,snapshotId:v.snapshotId,status:'completed',exact:false,
  values:[{localId:1,fact:{constant:improved?{value:'1'}:null,range:{kind:improved?'interval':'full'}}}]});
const policy=(p={})=>new AdaptiveContextPolicy({enabled:true,...p});

test('adaptive policy is opt-in, uses finite defaults and cannot accept extra authority',()=>{
  assert.equal(normalizeAdaptiveContextPolicy(undefined),null);
  assert.equal(normalizeAdaptiveContextPolicy({enabled:true}).maximumRefinements,16);
  assert.throws(()=>normalizeAdaptiveContextPolicy({enabled:false}));assert.throws(()=>normalizeAdaptiveContextPolicy({enabled:true,solver:()=>1}));
});
for(const [field,value] of [['maximumRefinements',33],['maximumRefinements',-1],['maximumFamilies',0],['maximumFamilies',33],
  ['warmupSamples',0],['minimumGain',257],['maximumMeasuredWork',Infinity],['maximumMeasuredWork','1']])
  test(`adaptive policy rejects ${field}=${value}`,()=>assert.throws(()=>policy({[field]:value})));
test('a serialized specialization cannot acquire an adaptive grant',async t=>{
  const {view,work}=await owned(t),p=policy();assert.throws(()=>p.begin(structuredClone(view),baseline,{work}),/not-owned/);
});
test('cost is measured from the actual parent work and improvement counted once per same local value',async t=>{
  const {view,work}=await owned(t),p=policy({warmupSamples:1});const d=p.begin(view,baseline,{work});
  work.charge('workUnits',17);work.charge('bytesRead',4);const r=p.finish(d.grant,result(view));
  assert.equal(r.gain,1);assert.equal(r.comparedValues,1);assert.equal(r.cost.workUnits,17);assert.equal(r.cost.bytesRead,4);
  assert.equal(r.status,'measured');assert.equal(r.proofAuthority,false);assert.equal(p.describe().semanticCacheEntries,0);
  assert.throws(()=>p.finish(d.grant,result(view)),/unavailable/);assert.ok(p.begin(view,baseline,{work}).admitted);p.close();
});
test('measured zero gain stops that family after warmup, without pretending to prove anything',async t=>{
  const {view,work}=await owned(t),p=policy({warmupSamples:1});const d=p.begin(view,baseline,{work});p.finish(d.grant,result(view,false));
  const no=p.begin(view,baseline,{work});assert.equal(no.admitted,false);assert.equal(no.reason,'adaptive-measured-gain-below-threshold');
});
test('a new SCC revision cannot borrow favorable measurements from an older summary family',async t=>{
  const {view,create,work}=await owned(t),p=policy({warmupSamples:1,maximumFamilies:1});const d=p.begin(view,baseline,{work});p.finish(d.grant,result(view));
  const next=await create('revision-b');assert.equal(p.begin(next,baseline,{work}).reason,'adaptive-family-inventory-limit');
});
test('changed context dependencies cannot borrow measurements while the summary and source artifacts stay identical',async t=>{
  const {view,create,work}=await owned(t),p=policy({warmupSamples:1,maximumFamilies:1});
  const first=p.begin(view,baseline,{work});p.finish(first.grant,result(view));
  const next=await create('revision-a','multiple-selected-functions-share-entry');
  assert.equal(next.sourceSummaryDigest,view.sourceSummaryDigest);assert.equal(next.sccRevision,view.sccRevision);
  assert.deepEqual(next.dependencies.positiveArtifactIds,view.dependencies.positiveArtifactIds);
  assert.notEqual(next.contextDependencyKey,view.contextDependencyKey);
  assert.equal(p.begin(next,baseline,{work}).reason,'adaptive-family-inventory-limit');
});
test('count, measured work and in-flight limits survive multiple admissions',async t=>{
  const {view,work}=await owned(t),p=policy({maximumRefinements:1});const d=p.begin(view,baseline,{work});
  assert.throws(()=>p.begin(view,baseline,{work}),/busy/);p.finish(d.grant,result(view));
  assert.equal(p.begin(view,baseline,{work}).reason,'adaptive-refinement-count-limit');
  const q=policy({maximumMeasuredWork:5});const e=q.begin(view,baseline,{work});work.charge('workUnits',6);q.finish(e.grant,result(view));
  assert.equal(q.begin(view,baseline,{work}).reason,'adaptive-measured-work-limit');
  assert.match(q.describe().workLimitSemantics,/parent-budget-is-hard-cap/);
});
test('zero quota refuses refinement before any owner evaluation',async t=>{
  const {view,work}=await owned(t);assert.equal(policy({maximumRefinements:0}).begin(view,baseline,{work}).admitted,false);
  assert.equal(policy({maximumMeasuredWork:0}).begin(view,baseline,{work}).admitted,false);
});
for(const [name,mutate] of [['world',r=>r.worldId='other'],['snapshot',r=>r.snapshotId='later'],['context',r=>r.contextId='other'],
  ['status',r=>r.status='partial'],['authority',r=>r.exact=true],['empty',r=>r.values=[]],
  ['duplicate local ID',r=>r.values.push(structuredClone(r.values[0]))]])
  test(`invalid or unmeasured ${name} does not become a measured zero-benefit sample`,async t=>{
    const {view,work}=await owned(t),p=policy({warmupSamples:1});const d=p.begin(view,baseline,{work}),r=result(view);mutate(r);
    assert.equal(p.finish(d.grant,r).gain,null);assert.equal(p.begin(view,baseline,{work}).admitted,true);p.close();
  });
test('aborted refinement consumes quota and its actual cost but never a benefit sample',async t=>{
  const {view,work}=await owned(t),p=policy({maximumRefinements:1});const d=p.begin(view,baseline,{work});work.charge('workUnits',9);
  const r=p.finish(d.grant,null,{completed:false});assert.equal(r.gain,null);assert.equal(r.cost.workUnits,9);
  assert.equal(p.describe().issuedRefinements,1);assert.equal(p.begin(view,baseline,{work}).admitted,false);
});
test('closing policy retires grants and no new family can be populated',async t=>{
  const {view,work}=await owned(t),p=policy(),d=p.begin(view,baseline,{work});p.close();
  assert.throws(()=>p.finish(d.grant,result(view)));assert.throws(()=>p.begin(view,baseline,{work}));assert.equal(p.describe().retainedFamilies,0);
});
const query={query:{scope:{functionIds:['0x1000','0x2000']},select:{op:'eq',field:'kind',value:'store'},resultLimit:16}};
async function complete(f,input){let v=await f.invoke('demandQuery',input,{residentBytes:64*1024*1024});let n=0;
  while(v.continuation){assert.ok(++n<64);v=await f.invoke('resumeDemandQuery',{cursor:v.continuation.cursor},{residentBytes:64*1024*1024});}
  assert.equal(v.executionStatus,'completed');assert.equal(v.publication.status,'published');return v;}
test('native opt-in measures existing conditional-range evaluation without changing canonical facts',async t=>{
  const f=await nativeWorkerFixture(t),v=await complete(f,{...query,adaptiveRefinement:{enabled:true}});
  const r=v.adaptiveRefinement;assert.equal(r.issuedRefinements,1);assert.equal(r.receipts.length,1);assert.equal(r.receipts[0].status,'measured');
  assert.ok(r.receipts[0].gain>0);assert.ok(r.receipts[0].cost.workUnits>0);assert.ok(Number.isFinite(r.receipts[0].cost.bytesRead));assert.equal(r.canonicalTruthChanged,false);
  assert.ok(v.answer.precision.summarySpecializations[0].valueProjection);assert.equal(v.answer.exact,false);
  assert.equal(v.answer.precision.summarySpecializations[0].valueProjection.cost,undefined);
});
test('native zero-quota session stays conservative and does not call the conditional owner',async t=>{
  const f=await nativeWorkerFixture(t),v=await complete(f,{...query,adaptiveRefinement:{enabled:true,maximumRefinements:0}});
  assert.equal(v.adaptiveRefinement.issuedRefinements,0);assert.equal(v.answer.precision.summarySpecializations[0].valueProjection,undefined);
  assert.equal(f.counters.workers,2);assert.equal(v.answer.exact,false);
  assert.ok(JSON.stringify(v.frontier).includes('adaptive-refinement-count-limit'));
});
test('native default path has no adaptive policy, retains existing refinement semantics',async t=>{
  const f=await nativeWorkerFixture(t),v=await complete(f,query);assert.equal(v.adaptiveRefinement,null);
  assert.ok(v.answer.precision.summarySpecializations[0].valueProjection);
});
test('native session resume cannot reset a one-refinement quota across two call sites',async t=>{
  const rr=structuredClone(NATIVE_ROWS);rr['0x1000']=[['mov','x0, #1',0xd2800020],['bl','#0x2000',0x940003ff],
    ['mov','x0, #2',0xd2800040],['bl','#0x2000',0x940003fd],['ret','',0xd65f03c0]];
  const f=await nativeWorkerFixture(t,{rowsByLocator:rr}),v=await complete(f,{...query,adaptiveRefinement:{enabled:true,maximumRefinements:1}});
  assert.equal(v.adaptiveRefinement.issuedRefinements,1);assert.equal(v.adaptiveRefinement.receipts.length,1);
  assert.equal(v.answer.precision.summarySpecializations.length,2);
  assert.equal(v.answer.precision.summarySpecializations.filter(x=>x.valueProjection).length,1);assert.equal(f.counters.workers,3);
});
