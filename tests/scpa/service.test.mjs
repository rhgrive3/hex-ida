import test from 'node:test';import assert from 'node:assert/strict';
import {worldInput,fixture,workFor}from'./helpers.mjs';import{pipelineResult}from'./pipeline-fixture.mjs';
import{ScopedAnalysisService}from'../../js/analysis/query/scoped-service.js';
import{configureScopedAnalysisHost,scopedAnalysisHost,disableScopedAnalysisHost,invalidateScopedAnalysis,scopedImmutableSourceIdentity}from'../../js/analysis/query/scoped-host.js';
import{dispatchScopedAppQuery}from'../../js/analysis/query/scoped-app.js';
function service(t,extra={}){let current=true;const configuration={maximumSessions:2,sessionTtlMs:120000,...extra.configuration};const host={configuration,isCurrent:()=>current,loadPipeline:async()=>({reason:'unavailable'}),canonicalArchitecture:'arm64',...extra};host.configuration=configuration;const s=new ScopedAnalysisService({host,snapshot:{snapshotId:'snap',binaryId:'binary-scpa-test'},worldInput:worldInput()});t.after(()=>s.close());return{s,host,retire:()=>{current=false;}};}
test('scoped app APIs are default-off and do not even inspect the backend',async()=>{let reads=0;const app={get backend(){reads++;throw Error('must not touch');}};const r=await dispatchScopedAppQuery(app,null,'scopedCapabilities',{},null,null);assert.equal(r.value.reason,'scoped-analysis-disabled');assert.equal(reads,0);});
test('explicit host reconfiguration closes old sessions before capability replacement',()=>{const app={};const first=configureScopedAnalysisHost(app,{enabled:true});let closed=0;scopedAnalysisHost(app).service={close:()=>{closed++;}};const second=disableScopedAnalysisHost(app);assert.equal(closed,1);assert.equal(second.enabled,false);assert.ok(second.revision>first.revision);});
test('owner invalidation retires dependencies and cached service binding',()=>{const app={};configureScopedAnalysisHost(app,{enabled:true});const entry=scopedAnalysisHost(app);let reset=0,closed=0;entry.binding='old';entry.service={dependencies:{reset:()=>reset++},close:()=>closed++};invalidateScopedAnalysis(app);assert.equal(reset,1);assert.equal(closed,1);assert.equal(entry.service,null);assert.equal(entry.binding,null);});
test('host capabilities reject accessors without invoking them',()=>{let hits=0;assert.throws(()=>configureScopedAnalysisHost({}, {get enabled(){hits++;return true;}}),/data-fields/);assert.equal(hits,0);for(const config of [{enabled:'yes'},{maximumSessions:0},{loadPipeline:{}},{unknown:true}])assert.throws(()=>configureScopedAnalysisHost({},config));});
test('immutable source identity is opt-in and per Blob, never a fabricated complete hash',()=>{const app={},blob=new Blob(['a']);assert.equal(scopedImmutableSourceIdentity(app,blob),null);configureScopedAnalysisHost(app,{enabled:true});const id=scopedImmutableSourceIdentity(app,blob);assert.match(id,/^local_immutable_[0-9a-f]{32}$/);assert.equal(scopedImmutableSourceIdentity(app,blob),id);assert.notEqual(scopedImmutableSourceIdentity(app,new Blob(['a'])),id);assert.equal(scopedImmutableSourceIdentity(app,{}),null);});
test('capabilities distinguish availability from semantic qualification', async t => {
  const {s} = service(t);
  const r = await s.invoke('scopedCapabilities', {});
  assert.equal(r.value.status, 'available-experimental');
  assert.equal(r.value.producerQualification, 'current-arm64-owner-unverified');
  assert.equal(r.value.modes.proofReplay, 'integrity-only');
  assert.ok(r.value.unknowns.includes('world-closure'));
  assert.equal(r.value.exact, false);
  assert.equal(r.value.releaseQualified, false);
});
test('pre-cancelled service invokes no publication, including synchronous capabilities', async t => {
  const {s} = service(t), c = new AbortController(); c.abort();
  const r = await s.invoke('scopedCapabilities', {}, {signal:c.signal});
  assert.equal(r.value.status, 'cancelled');
  assert.equal(r.value.modes, undefined);
});
test('unsupported method is explicit rather than silently claiming completion', async t => {
  const {s} = service(t);
  const r = await s.invoke('noSuchMethod', {});
  assert.equal(r.value.status, 'unsupported');
  assert.equal(r.value.reason, 'scoped-api-method-unavailable');
});
test('stale service closes and cannot replay prior world results', async t => {
  const {s,retire} = service(t); retire();
  await assert.rejects(s.invoke('scopedCapabilities', {}), /scoped-service-stale/);
  assert.equal(s.closed, true);
});
test('capability discovery does not execute canonical pipelines', async t => {
  let loads=0;
  const {s}=service(t,{loadPipeline:()=>{loads++;throw Error('unexpected');}});
  await s.invoke('scopedCapabilities', {});
  assert.equal(loads,0);
});
test('service executes canonical owners and does not retain completed sessions', async t => {
  let loads=0; const raw=pipelineResult().pipeline;
  const {s}=service(t,{loadPipeline:()=>{loads++;return{pipeline:raw};}});
  const r=await s.invoke('semanticQuery', {scope:{functionIds:['f']},resultLimit:1024}, {limits:{deadlineMs:10000}});
  assert.equal(r.value.executionStatus,'completed');
  assert.ok(r.value.results.length>0);
  assert.equal(r.value.exact,false);
  assert.equal(r.value.continuation,null);
  assert.equal(loads,1);
  await assert.rejects(s.invoke('resumeSemanticQuery',{cursor:'unknown'}), /scoped-session-unavailable-or-wrong-kind/);
});
test('single-flight guard rejects concurrent service access without cancelling first', async t => {
  let release;
  const {s}=service(t,{loadPipeline:()=>new Promise(r=>{release=r;})});
  const first=s.invoke('semanticQuery',{scope:{functionIds:['f']}},{limits:{deadlineMs:10000}});
  await new Promise(r=>setImmediate(r));
  const busy=await s.invoke('scopedCapabilities',{});
  assert.equal(busy.value.reason,'scoped-service-busy');
  release({reason:'unavailable'});
  assert.equal((await first).value.executionStatus,'completed');
});
test('continuation cursors are single-use; cancellation retires the remaining scope', async t => {
  const raw=pipelineResult().pipeline;
  const {s}=service(t,{loadPipeline:()=>({pipeline:raw})});
  const options={limits:{deadlineMs:10000,results:3}};
  const first=await s.invoke('semanticQuery',{scope:{functionIds:['f']},resultLimit:1024},options);
  assert.equal(first.value.resumable,true);
  const cursor=first.value.continuation.cursor;
  const next=await s.invoke('resumeSemanticQuery',{cursor},options);
  assert.notEqual(next.value.continuation.cursor,cursor);
  await assert.rejects(s.invoke('resumeSemanticQuery',{cursor}),/scoped-session-unavailable-or-wrong-kind/);
  const remaining=next.value.continuation.cursor;
  assert.equal((await s.invoke('cancelScopedQuery',{cursor:remaining})).value.status,'cancelled');
  await assert.rejects(s.invoke('resumeSemanticQuery',{cursor:remaining}),/scoped-session-unavailable-or-wrong-kind/);
});
