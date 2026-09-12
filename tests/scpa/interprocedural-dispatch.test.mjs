import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,workFor} from './helpers.mjs';
import {pipelineResult} from './pipeline-fixture.mjs';
import {buildCanonicalQueryProjection,composeCanonicalQueryProjections} from '../../js/analysis/query/semantic/projection.js';
import {compileSemanticQuery} from '../../js/analysis/query/semantic/plan.js';
import {SemanticQueryExecution} from '../../js/analysis/query/semantic/execute.js';
import {ScopedInterproceduralProjectionBuilder} from '../../js/analysis/query/semantic/interprocedural.js';
import {DispatchResolverRegistry,normalizeDispatchQuery,resolveUnifiedDispatch} from '../../js/analysis/dispatch/unified.js';
const project=async(t,f,base)=>buildCanonicalQueryProjection(pipelineResult({base}).pipeline,{...f,work:workFor(t),snapshotId:'snap'});
function builder(t,f,options={}) {
  const b=new ScopedInterproceduralProjectionBuilder({...f,snapshotId:'snap',functionIds:['a','b'],isCurrent:()=>true,
    loadProjection:async id=>({projection:await project(t,f,id==='a'?0x1000n:0x2000n)}),...options});
  t.after(()=>b.close()); return b;
}
test('interprocedural builder loads one explicit function per advance and releases borrowed owners',async t=>{
  const f=fixture(),b=builder(t,f),work=workFor(t);
  assert.equal((await b.advance({work})).loadedFunctions,1);
  assert.equal((await b.advance({work})).loadedFunctions,2);
  const result=await b.advance({work});assert.equal(result.composite,true);assert.equal(result.members.length,2);
  assert.ok(result.projection.size>60);assert.equal(b.seen.length,2);
  assert.ok(result.projection.frontier.some(x=>x.reason==='interprocedural-context-and-boundary-qualification-pending'));
  assert.equal((await b.advance({work})).projection,result.projection);
  b.close();await assert.rejects(b.advance({work}),/stale/);
});
test('interprocedural scope has a hard sixteen-function bound',t=>{
  const f=fixture();assert.throws(()=>builder(t,f,{functionIds:Array.from({length:17},(_,i)=>'f'+i)}));
});
test('a missing function stays an explicit gap, not a silently closed scope',async t=>{
  const f=fixture(),b=builder(t,f,{loadProjection:async id=>id==='a'?{projection:await project(t,f,0x1000n)}:{reason:'owner-missing'}}),work=workFor(t);
  await b.advance({work});await b.advance({work});const r=await b.advance({work});
  assert.equal(r.members.length,1);assert.ok(r.projection.frontier.some(x=>x.reason==='owner-missing'));
});
test('duplicate canonical identities under different locators are rejected',async t=>{
  const f=fixture(),b=builder(t,f,{loadProjection:async()=>({projection:await project(t,f,0x1000n)})}),work=workFor(t);
  await b.advance({work});await assert.rejects(b.advance({work}),/duplicate-function-identity/);
});
test('world invalidation between continuation steps cannot produce a mixed graph',async t=>{
  const f=fixture();let current=true;const b=builder(t,f,{isCurrent:()=>current}),work=workFor(t);
  await b.advance({work});current=false;await assert.rejects(b.advance({work}),/stale/);
});
test('serialized ABI port claims are rejected without a current source-bound owner',async t=>{
  const f=fixture(),b=builder(t,f,{getFunctionFlowInterface:()=>({data:{parameters:[],returns:[]},isCurrent:()=>true})});
  await assert.rejects(b.advance({work:workFor(t)}),/source-binding/);
});
// Edges below are synthetic test navigation links between REAL canonical rows.
// They test call-stack matching, not ABI correctness or feasible execution.
async function contextGraph(t) {
  const f=fixture(),a=await project(t,f,0x1000n),b=await project(t,f,0x2000n),callee=await project(t,f,0x3000n);
  const ids={a:a.recordAt(0).id,returned:a.recordAt(1).id,b:b.recordAt(0).id,c:callee.recordAt(0).id};
  const bridge=(id,from,to,direction,callSite,caller)=>({id,from,to,kind:'call-summary',relation:'possible-dependence',executablePathProven:false,
    boundary:{direction,callSite,callerFunctionId:caller.functionId,calleeFunctionId:callee.functionId},obligations:['test-link-unqualified']});
  const p=await composeCanonicalQueryProjections([a,b,callee],[
    bridge('enter-a',ids.a,ids.c,'enter','call-A',a),
    bridge('return-a',ids.c,ids.returned,'return','call-A',a),
    bridge('return-b',ids.c,ids.b,'return','call-B',b),
  ],[],{...f,snapshotId:'snap',work:workFor(t)});
  t.after(()=>{p.release();a.release();b.release();callee.release();});return{f,p,ids};
}
async function flow(t,g,source,target,options={}) {
  const plan=compileSemanticQuery({scope:{functionIds:['scope']},select:{op:'eq',field:'id',value:source},
    flow:{to:{op:'eq',field:'id',value:target},edgeKinds:['call-summary'],maxDepth:8,...options}},g.f);
  const e=new SemanticQueryExecution({...g.f,plan,isCurrent:()=>true,loadProjection:()=>({projection:g.p})});t.after(()=>e.close());
  return e.step({limits:{deadlineMs:10000}});
}
test('matching callsite permits return to its caller without asserting executable feasibility',async t=>{
  const g=await contextGraph(t),r=await flow(t,g,g.ids.a,g.ids.returned);
  assert.equal(r.results.length,1);assert.equal(r.results[0].executablePathProven,false);
});
test('one callee cannot return into another callsite sharing that same callee',async t=>{
  const g=await contextGraph(t),r=await flow(t,g,g.ids.a,g.ids.b);assert.equal(r.results.length,0);assert.equal(r.existence,'UNKNOWN');
});
test('backward traversal obeys the same matched callsite discipline',async t=>{
  const g=await contextGraph(t),r=await flow(t,g,g.ids.returned,g.ids.a,{direction:'backward'});assert.equal(r.results.length,1);
});
test('a source beginning in a callee does not guess its unknown initial caller',async t=>{
  const g=await contextGraph(t),r=await flow(t,g,g.ids.c,g.ids.returned);assert.equal(r.results.length,0);
  assert.match(JSON.stringify(r.frontier),/unmatched-initial-caller-context/);
});
test('zero call depth is an observable cut rather than a spurious no-flow proof',async t=>{
  const g=await contextGraph(t),r=await flow(t,g,g.ids.a,g.ids.returned,{maxCallDepth:0});assert.equal(r.results.length,0);
  assert.match(JSON.stringify(r.frontier),/call-context-depth-cut/);
});
const descriptor=(id='test')=>({id,version:'1',families:['register'],resolve:()=>null});
test('dispatch invalidation is ordered before membership mutation and can veto it',()=>{
  let r;const states=[];r=new DispatchResolverRegistry({onMembershipChange:e=>{states.push([e.kind,r.descriptors().length]);}});
  const remove=r.register(descriptor());remove();remove();assert.deepEqual(states,[['add',0],['remove',1]]);assert.equal(r.revision,2);
  const denied=new DispatchResolverRegistry({onMembershipChange:()=>{throw Error('deny');}});
  assert.throws(()=>denied.register(descriptor()),/deny/);assert.equal(denied.revision,0);assert.equal(denied.descriptors().length,0);
});
test('dispatch registry refuses duplicate IDs and unbounded provider inventories',()=>{
  const r=new DispatchResolverRegistry();r.register(descriptor());assert.throws(()=>r.register(descriptor()),/capacity/);
  for(let i=1;i<32;i++)r.register(descriptor('test'+i));assert.throws(()=>r.register(descriptor('overflow')),/capacity/);
});
test('dispatch membership change during resolver await discards all stale candidates',async t=>{
  const f=fixture(),r=new DispatchResolverRegistry();let remove;
  remove=r.register({...descriptor(),resolve:async()=>{remove();return{candidates:[{targetEntityId:'never-published'}]};}});
  const answer=await r.resolve(r.descriptors()[0],{callSiteId:'c'}, {...f,projection:{id:'p'}},workFor(t));
  assert.equal(answer.status,'stale');assert.equal(answer.candidates,undefined);
});
test('dispatch resolver outputs are detached and scope-bound',async t=>{
  const f=fixture(),r=new DispatchResolverRegistry(),response={status:'partial',worldId:f.world.id,assumptionsId:f.assumptions.id,projectionId:'p',callSiteId:'c',candidates:[],requirements:['open']};
  r.register({...descriptor(),resolve:()=>response});const d=r.descriptors()[0],q={callSiteId:'c',maxTargets:2,maxHops:2},ctx={...f,projection:{id:'p'}};
  const answer=await r.resolve(d,q,ctx,workFor(t));response.requirements.push('late');assert.deepEqual(answer.requirements,['open']);
  response.worldId='foreign';await assert.rejects(r.resolve(d,q,ctx,workFor(t)),/unbound/);
});
for(const change of [q=>q.families=[],q=>q.families=['imaginary'],q=>q.maxHops=65,q=>q.maxTargets=4097])
  test('dispatch query budgets and registered families are finite',()=>{const q={functionId:'f',callSiteId:'c'};change(q);assert.throws(()=>normalizeDispatchQuery(q));});
test('a non-call IR row never becomes a callsite by supplying an address or target',async t=>{
  const f=fixture(),p=await project(t,f,0x1000n);t.after(()=>p.release());
  const r=await resolveUnifiedDispatch(p,{functionId:p.functionId,callSiteId:'not-a-call'},{...f,work:workFor(t)});
  assert.equal(r.status,'unsupported');assert.equal(r.exact,false);assert.deepEqual(r.candidates,[]);
});
