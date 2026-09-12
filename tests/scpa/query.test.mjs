import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, workFor } from './helpers.mjs';
import { pipelineResult } from './pipeline-fixture.mjs';
import { compileSemanticQuery, restoreSemanticQueryPlan, evaluateSemanticSelector, evaluateSemanticQueryPlan, assertSemanticQueryPlan, normalizeSemanticQuery } from '../../js/analysis/query/semantic/plan.js';
import { buildCanonicalQueryProjection, assertCanonicalQueryProjection, composeCanonicalQueryProjections } from '../../js/analysis/query/semantic/projection.js';
import { SemanticQueryExecution } from '../../js/analysis/query/semantic/execute.js';
import { projectScopedLocalOwners } from '../../js/analysis/scoped-local-projection.js';
const basic = (extra = {}) => ({ scope: { functionIds: ['f'] }, resultLimit: 1024, ...extra });
const project = (t, f, pipeline = pipelineResult().pipeline) => buildCanonicalQueryProjection(pipeline, { ...f, snapshotId: 'snap', work: workFor(t), sourceStatus: 'complete' });
const eq = (field, value) => ({ op: 'eq', field, value });
for (const [label, value] of [ ['empty scope', {scope:{functionIds:[]}}], ['unknown key', {...basic(), eval:'x'}], ['executable selector',{...basic(),select:{op:'eval',code:'x'}}], ['unknown field',{...basic(),select:eq('payload','x')}], ['unbounded depth',{...basic(),flow:{to:{op:'all'},maxDepth:513}}], ['null scope',{scope:null}], ['too many sources',{scope:{functionIds:Array.from({length:257},(_,i)=>'f'+i)}}] ]) test(`query compiler rejects ${label}`,()=>assert.throws(()=>normalizeSemanticQuery(value)));
test('query plan round-trip recompiles; tampered bytecode and cross-world bindings reject',()=>{
  const f=fixture(), p=compileSemanticQuery(basic(),f), copy=structuredClone(p);
  assertSemanticQueryPlan(restoreSemanticQueryPlan(copy,f)); assert.throws(()=>assertSemanticQueryPlan(copy));
  copy.selectProgram=[{op:'PREDICATE',predicate:eq('owner','ssa')}]; assert.throws(()=>restoreSemanticQueryPlan(copy,f),/content-mismatch/);
  assert.throws(()=>assertSemanticQueryPlan(p,fixture(d=>{d.generation='g2';}).world),/unbound/);
});
test('three-valued NOT/AND/OR does not launder unknown metadata into absence',()=>{
  const unknown={operator:null,unknownFields:['operator']}, no={operator:'store',unknownFields:[]}; const q=eq('operator','load');
  assert.equal(evaluateSemanticSelector(q,unknown),null); assert.equal(evaluateSemanticSelector({op:'not',term:q},unknown),null);
  assert.equal(evaluateSemanticSelector({op:'and',terms:[q,{op:'all'}]},unknown),null);
  assert.equal(evaluateSemanticSelector({op:'or',terms:[q,{op:'all'}]},unknown),true);
  assert.equal(evaluateSemanticSelector(q,no),false); assert.equal(evaluateSemanticSelector({op:'contains',field:'callTargets',value:'known'}, {callTargets:['known'],unknownFields:['callTargets']}),true);
});
test('compiled finite VM agrees with independent recursive selector on tri-valued cases',()=>{
  const f=fixture(); const leaves=[{op:'all'},eq('operator','load'),{op:'has',field:'kind'},{op:'in',field:'owner',values:['ssa','memoryssa']},{op:'contains',field:'roles',value:'use'}];
  const selectors=[...leaves,...leaves.map(term=>({op:'not',term})),...leaves.flatMap(a=>leaves.map(b=>({op:'and',terms:[a,b]}))),...leaves.flatMap(a=>leaves.map(b=>({op:'or',terms:[a,b]})))];
  const records=[{operator:'load',owner:'ssa',kind:'use',roles:['use'],unknownFields:[]},{operator:null,kind:null,owner:'memoryssa',roles:[],unknownFields:['operator']},{unknownFields:['kind','owner','roles','operator']}];
  for(const select of selectors){const plan=compileSemanticQuery(basic({select}),f);for(const row of records)assert.equal(evaluateSemanticQueryPlan(plan,'select',row),evaluateSemanticSelector(select,row));}
});
test('canonical ARM64 projection retains IR, SSA and memory owner witnesses and open world',async t=>{
  const f=fixture(),p=await project(t,f);t.after(()=>p.release());assert.ok(p.size>31);assert.ok(p.edgeCount>0);
  const owners=new Set(Array.from({length:p.size},(_,i)=>p.recordAt(i).owner));assert.deepEqual([...owners].sort(),['memoryssa','semantic-ir','ssa']);
  assert.ok(p.frontier.some(x=>x.reason==='whole-world-closure-not-qualified'));assert.ok(p.inputIdentity.ownerDigests.ir);assert.ok(p.inputIdentity.ownerDigests.ssa);
  for(let i=0;i<p.edgeCount;i++){const e=p.edgeAt(i);assert.ok(p.record(e.from));assert.ok(p.record(e.to));assert.equal(e.executablePathProven,false);}
  assert.throws(()=>assertCanonicalQueryProjection({...p}),/unbound/);
});
test('projection hashes bind changed content, not just owner version names',async t=>{
  const f=fixture(),raw=structuredClone(pipelineResult().pipeline),a=await project(t,f,raw);t.after(()=>a.release());
  raw.semanticIr.nodes[0].scpaTestMarker='changed';const b=await project(t,f,raw);t.after(()=>b.release());assert.notEqual(a.id,b.id);assert.notEqual(a.inputIdentity.ownerDigests.ir,b.inputIdentity.ownerDigests.ir);
});
test('projection captures before yield; later owner mutations do not create mixed generations',async t=>{
  const f=fixture(),raw=structuredClone(pipelineResult().pipeline),original=await project(t,f,structuredClone(raw));t.after(()=>original.release());
  const pending=buildCanonicalQueryProjection(raw,{...f,snapshotId:'snap',work:workFor(t,{yieldEvery:1})});raw.semanticIr.nodes[0].scpaTestMarker='late';
  const detached=await pending;t.after(()=>detached.release());assert.equal(detached.id,original.id);assert.equal(detached.source(detached.entityReference('semantic-ir',raw.semanticIr.nodes[0].id)).scpaTestMarker,undefined);
});
test('projection rejects stale snapshot and mismatched function owner',async t=>{
  const f=fixture(),raw=structuredClone(pipelineResult().pipeline);raw.snapshotId='old';await assert.rejects(project(t,f,raw),/stale-snapshot/);delete raw.snapshotId;raw.functionId='other';await assert.rejects(project(t,f,raw),/world-binding/);
});
test('missing SSA and MemorySSA remain visible frontier; released references fail closed',async t=>{
  const f=fixture(),raw={...pipelineResult().pipeline,ssa:null,memorySsa:null},p=await project(t,f,raw);assert.ok(p.frontier.some(x=>x.reason.includes('ssa-unavailable')));p.release();assert.throws(()=>p.recordAt(0),/released/);
});
async function execution(t,f,query=basic(),extra={}){
  const e=new SemanticQueryExecution({...f,plan:compileSemanticQuery(query,f),isCurrent:()=>true,loadProjection:async()=>({projection:await project(t,f)}),...extra});t.after(()=>e.close());return e;
}
test('paged execution equals one-shot enumeration without duplicate results or exact promotion',async t=>{
  const f=fixture(),a=await execution(t,f),full=await a.step({limits:{deadlineMs:10000}});assert.equal(full.executionStatus,'completed');assert.equal(full.exact,false);assert.equal(full.existence,'POSSIBLE');assert.equal(full.semanticClosure,'unknown');
  const b=await execution(t,f),all=[];let page;for(let i=0;i<100;i++){page=await b.step({limits:{results:3,deadlineMs:10000}});all.push(...page.results);if(!page.resumable)break;}
  assert.equal(page.resumable,false);assert.equal(all.length,full.results.length);assert.deepEqual(all.map(x=>x.value.id),full.results.map(x=>x.value.id));assert.equal(new Set(all.map(x=>x.value.id)).size,all.length);
});
test('zero matching records cannot prove absence even after complete enumeration',async t=>{
  const f=fixture(),e=await execution(t,f,basic({select:eq('operator','does-not-exist')}));const r=await e.step({limits:{deadlineMs:10000}});assert.equal(r.enumerationComplete,true);assert.equal(r.existence,'UNKNOWN');assert.equal(r.exact,false);
});
test('result cap truncates rather than silently declaring complete',async t=>{
  const e=await execution(t,fixture(),basic({resultLimit:1})),r=await e.step({limits:{deadlineMs:10000}});assert.equal(r.results.length,1);assert.equal(r.completeness,'truncated');assert.equal(r.enumerationComplete,false);assert.equal(r.resumable,false);
});
test('query cancellation closes the session and does not invoke the provider',async t=>{
  let calls=0;const c=new AbortController();c.abort();const e=await execution(t,fixture(),basic(),{loadProjection:()=>{calls++;throw Error('not reached');}});const r=await e.step({signal:c.signal});assert.equal(r.executionStatus,'cancelled');assert.equal(r.resumable,false);assert.equal(calls,0);await assert.rejects(e.step(),/closed/);
});
test('concurrent resume is rejected while first provider is unresolved',async t=>{
  let resolve;const f=fixture();const e=await execution(t,f,basic(),{loadProjection:()=>new Promise(r=>{resolve=r;})});const first=e.step({limits:{deadlineMs:10000}});await new Promise(r=>setImmediate(r));await assert.rejects(e.step(),/concurrent-resume/);resolve({reason:'no fixture'});await first;
});
test('owner invalidation during awaited projection prevents result publication',async t=>{
  let current=true;const f=fixture();const e=await execution(t,f,basic(),{isCurrent:()=>current,loadProjection:async()=>{const p=await project(t,f);current=false;t.after(()=>p.release());return {projection:p};}});const r=await e.step({limits:{deadlineMs:10000}});assert.equal(r.executionStatus,'stale');assert.deepEqual(r.results,[]);assert.equal(r.resumable,false);
});
test('possible dependence traversal never labels a path executable',async t=>{
  const f=fixture(),e=await execution(t,f,basic({select:eq('owner','ssa'),flow:{to:eq('owner','semantic-ir'),edgeKinds:['operation-input'],maxPaths:5}}));const r=await e.step({limits:{deadlineMs:10000}});assert.ok(r.results.length>0);for(const row of r.results){assert.equal(row.kind,'possible-flow');assert.equal(row.executablePathProven,false);assert.ok(row.remaining.includes('path-feasibility'));}
});
test('composite projection rejects duplicate function scope and malformed bridges',async t=>{
  const f=fixture(),a=await project(t,f),b=await project(t,f,pipelineResult({base:0x2000n}).pipeline);t.after(()=>{a.release();b.release();});
  const ctx={...f,snapshotId:'snap',work:workFor(t)};await assert.rejects(composeCanonicalQueryProjections([a,a],[],[],ctx),/member-binding/);
  await assert.rejects(composeCanonicalQueryProjections([a,b],[{kind:'call-summary',boundary:{direction:'invalid'}}],[],ctx),/bridge-contract/);
  const both=await composeCanonicalQueryProjections([a,b],[],[],ctx);assert.equal(both.size,a.size+b.size);both.release();assert.ok(a.recordAt(0));
});
for(const kind of ['summary','points-to','types'])test(`real canonical local ${kind} owner stays bounded and nonauthoritative`,()=>{
  const result=pipelineResult(),f=fixture();const request={kind,worldId:f.world.id,snapshotId:'snap',...(kind==='points-to'?{valueId:'absent'}:{}),...(kind==='types'?{entityIds:[result.pipeline.semanticIr.values[0].id]}:{})};
  const view=projectScopedLocalOwners(result,request);assert.equal(view.exact,false);assert.equal(view.worldId,f.world.id);assert.ok(['completed','unsupported','partial'].includes(view.status));
});
test('local owner projection rejects caller supplied pseudo pipeline and oversized graphs',()=>{
  const f=fixture(),request={kind:'summary',snapshotId:'snap',worldId:f.world.id};assert.equal(projectScopedLocalOwners({pipeline:{}},request).status,'unsupported');
  const result=structuredClone(pipelineResult());result.pipeline.semanticIr.nodes=Array(1025).fill({});assert.equal(projectScopedLocalOwners(result,request).reason,'local-owner-structural-budget');
});
