import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,workFor} from './helpers.mjs';
import {EvidenceStore} from '../../js/ai/evidence.js';
import {HypothesisStore} from '../../js/ai/hypothesis.js';
import {createScopedJobContextProvider} from '../../js/ai/investigation/scoped-job-context.js';
import {describeInvestigationFrontier,InvestigationViewCache} from '../../js/ai/investigation/scoped-frontier.js';
function setup(t,withObligations=false) {
  const f=fixture(),evidenceStore=new EvidenceStore(),hypothesisStore=new HypothesisStore(evidenceStore);
  hypothesisStore.upsert({id:'h',claim:'test claim',status:'open'});
  const job={id:'job',executionScopeId:'scope',sessionId:'session',goal:'inspect existing evidence',status:'paused',effectiveScope:{},
    hypothesisIds:['h'],evidenceIds:[],unresolvedWork:[],completedTools:[],budgetUsage:{},limits:{},updatedAt:'2026-09-10T00:00:00Z'};
  const stores={evidenceStore,hypothesisStore},runtime={jobs:{jobs:new Map([['job',job]]),runningJobIds:new Set(),loadingPromises:new Map(),pendingCheckpoints:new Map()},
    storeNamespaces:new Map([['binary-scpa-test::session',stores]]),storeNamespaceOwners:new Map([['binary-scpa-test::session','session']])};
  const obligations=['root','dependent'].map((id,i)=>({id,propositionId:'proposition-'+id,producerArtifactId:'owner',ownerRevision:'1',hypothesisIds:['h'],
    dependencies:i?['root']:[],evidenceIds:[],requiredCapability:'inspect-canonical-evidence',declaredImpact:1,costEstimate:{workUnits:1,bytesRead:0,residentBytes:1,toolCalls:1}}));
  const data={schema:'canonical-investigation-obligations/v1',worldId:f.world.id,assumptionsId:f.assumptions.id,snapshotId:'snap',jobId:'job',executionScopeId:'scope',ownerRevision:'1',obligations};
  const getContext=createScopedJobContextProvider(runtime,{binaryId:'binary-scpa-test',...(withObligations?{getObligations:()=>({data,isCurrent:()=>true})}:{})});
  const view=(request={},options={})=>describeInvestigationFrontier({jobId:'job',...request},{...f,snapshotId:'snap',work:workFor(t),getContext,...options});
  return{f,job,runtime,stores,getContext,view,obligations};
}
test('native idle-job inspection neither starts tools nor mutates canonical truth or job state',async t=>{
  const x=setup(t),before=structuredClone(x.job);
  Object.defineProperty(x.job,'lastResult',{get(){throw Error('whole transcript must not be read');}});
  const r=await x.view();assert.equal(r.status,'completed');assert.equal(r.goal.automatedActionsStarted,0);assert.equal(r.goal.goalCompleted,false);
  assert.equal(r.canonicalTruthChanged,false);assert.equal(r.jobStateChanged,false);assert.equal(r.coverage.wholeGoalPercentage,null);
  assert.equal(r.goal.goal,undefined);assert.equal(r.hypotheses.length,1);assert.deepEqual({...x.job},before);
});
test('native job namespace identity is checked without loading missing stores',async t=>{
  const x=setup(t);x.runtime.storeNamespaceOwners.set('binary-scpa-test::session','foreign');
  assert.equal((await x.view()).status,'unsupported');assert.equal(x.runtime.storeNamespaces.size,1);
});
for(const change of [x=>x.job.status='running',x=>x.runtime.jobs.runningJobIds.add('job'),x=>x.runtime.jobs.pendingCheckpoints.set('job',{})])
  test('active or checkpointing investigations cannot supply a stable read-only snapshot',async t=>{
    const x=setup(t);change(x);await assert.rejects(x.view(),/not-idle/);
  });
test('job data mutation invalidates the retained owner lease',async t=>{
  const x=setup(t),ctx=await x.getContext('job',{...x.f,snapshotId:'snap',work:workFor(t)});
  assert.equal(ctx.isCurrent(),true);x.job.goal='changed';assert.equal(ctx.isCurrent(),false);
});
test('dependency frontier exposes only inspectable prerequisites and never executable actions',async t=>{
  const x=setup(t,true),r=await x.view();
  assert.equal(r.obligations.find(o=>o.id==='root').readiness,'inspectable');
  assert.equal(r.obligations.find(o=>o.id==='dependent').readiness,'blocked');
  assert.ok(r.frontier.actions.length>0);
  assert.ok(r.frontier.actions.every(a=>a.executable===false&&a.automaticDispatch===false));
  assert.equal(r.goal.goalCompleted,false);assert.equal(r.coverage.proofAdmittedObligations,0);
});
test('cyclic obligation inventories terminate with an explicit blocked frontier',async t=>{
  const x=setup(t,true);x.obligations[0].dependencies=['dependent'];const r=await x.view();
  assert.ok(r.obligations.every(o=>o.readiness==='blocked'));
  assert.ok(r.remaining.includes('obligation-dependency-cycle-or-dependent-cut'));
});
test('foreign hypothesis requests do not escape the bound job',async t=>{
  const x=setup(t);await assert.rejects(x.view({hypothesisIds:['foreign']}),/outside-job/);
});
test('fingerprint delta cache never accepts a serialized view as canonical authority',async t=>{
  const x=setup(t,true),r=await x.view(),cache=new InvestigationViewCache({maximumJobs:1});
  assert.equal(cache.project(r,null,{work:workFor(t)}).transfer.mode,'full');
  const delta=cache.project(r,r.id,{work:workFor(t)});assert.equal(delta.transfer.mode,'delta');
  assert.equal(delta.records.obligations.length,0);assert.equal(delta.goal.goalCompleted,false);
  assert.throws(()=>cache.project({...r},r.id,{work:workFor(t)}),/view-cache-input/);
  cache.clear();assert.equal(cache.project(r,r.id,{work:workFor(t)}).transfer.mode,'full');
});
