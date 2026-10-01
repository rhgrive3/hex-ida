import test from 'node:test';
import assert from 'node:assert/strict';
import {createCxxQueryPlanner,recoverCxxQueryMembers,cxxRecoveryMadeProgress,cxxQueryTokens,cxxRecoveryTokens} from '../../../js/analysis/cxx/query-recovery.js';

test('query plans use release symbol evidence, reject static/ambiguous owners, and bound matching functions',()=>{
  const symbols={funcs:[1n,2n,3n,4n,5n],addrs:[1n,2n,3n,4n,5n],names:[
    '_ZNK6Widget8GetCountEv','_ZN6Widget6StaticEv','_ZNK5Other8GetCountEv','_ZN6WidgetD1Ev','_ZThn8_NK6Widget8GetCountEv']};
  const classEvidence={classes:[{className:'Widget',slots:[{address:3n}]},{className:'Other',slots:[{address:3n}]}]};
  const planner=createCxxQueryPlanner({symbols,classEvidence,isExecutable:()=>true});
  assert.deepEqual(planner.plan('widget count',{maxFunctions:2}).map(r=>r.address),[1n,4n]);
  assert.deepEqual(planner.plan('unrelated musical tune'),[]);
  assert.throws(()=>planner.plan('widget',{maxFunctions:33}),/budget/);
});

test('explicit recovery preserves scoped snapshot, disables by default, deduplicates and respects budgets/cancellation',async()=>{
  const snapshot={snapshotId:'bound'};const plan=[{address:1n,className:'Widget'},{address:1n,className:'Widget'},{address:2n,className:'Widget'}];
  let calls=0;const decompile=async(s,a,o)=>{assert.equal(s,snapshot);assert.equal(o.profile,'fast');calls++;return {value:{pseudocode:'body'}};};
  assert.equal((await recoverCxxQueryMembers({plan,snapshot,decompile})).status,'disabled');assert.equal(calls,0);
  const result=await recoverCxxQueryMembers({enabled:true,plan,snapshot,decompile,maxFunctions:1});
  assert.equal(result.status,'budget-exhausted');assert.equal(calls,1);
  const c=new AbortController();c.abort();await assert.rejects(recoverCxxQueryMembers({enabled:true,plan,snapshot,decompile,signal:c.signal}),/abort/i);
  await assert.rejects(recoverCxxQueryMembers({enabled:true,plan,snapshot,decompile:async()=>{throw new Error('stale snapshot');}}),/stale snapshot/);
});

test('constructor class words cannot outrank a matching value method by counting the object twice',()=>{
  const symbols={funcs:[0n,1n,2n],addrs:[0n,1n,2n],names:['_ZN10WidgetListC1Ev','_ZNK6Widget8GetCountEv','_ZN6WidgetC1Ev']};
  const planner=createCxxQueryPlanner({symbols,isExecutable:()=>true});
  assert.deepEqual(planner.plan('widget count',{maxFunctions:3}).map(r=>r.address),[1n,2n,0n]);
});

test('no-progress results do not reopen the result view; elapsed overruns remain explicit',async()=>{
  const noGrowth={attempted:[{pseudocode:true}],beforeRevision:1,afterRevision:1};
  assert.equal(cxxRecoveryMadeProgress(noGrowth),false);
  assert.equal(cxxRecoveryMadeProgress({...noGrowth,afterRevision:2}),true);
  assert.equal(cxxRecoveryMadeProgress({...noGrowth,attempted:[{pseudocode:false}],afterRevision:2}),false);
  let time=0;const result=await recoverCxxQueryMembers({enabled:true,snapshot:{},plan:[{address:1n}],
    maxElapsedMs:10,now:()=>time,decompile:async()=>{time=20;return {value:{pseudocode:'body'}};}});
  assert.equal(result.status,'budget-exhausted');assert.equal(result.elapsedMs,20);
});


test('owner words repeated in method names cannot crowd out the requested object',()=>{
  const symbols={funcs:[1n,2n,3n,4n],addrs:[1n,2n,3n,4n],names:[
    '_ZNK8Registry17getWidgetPasswordEv','_ZNK6Widget14getWidgetCacheEv',
    '_ZN6WidgetC1Ev','_ZNK6Engine8getSpeedEv']};
  const planner=createCxxQueryPlanner({symbols,classEvidence:{classes:[]},isExecutable:()=>true});
  const rows=planner.plan('current widget speed');
  assert.deepEqual(rows.map(r=>r.address),[2n,3n,1n,4n]);
  assert.deepEqual(rows.find(r=>r.address===2n).methodHits,[]);
});


test('folded positive member symbols from different owners fail closed',()=>{
  const symbols={funcs:[1n],addrs:[1n,1n],names:['_ZNK6Widget8GetCountEv','_ZNK5Other8GetCountEv']};
  const planner=createCxxQueryPlanner({symbols,classEvidence:{classes:[]},isExecutable:()=>true});
  assert.deepEqual(planner.plan('widget count'),[]);
});

test('V3 scheduling prioritizes requested accessors and declared extent without changing eligibility or legacy replay',()=>{
  const symbols={funcs:[1n,2n,3n,4n,5n],addrs:[1n,2n,3n,4n,5n],names:[
    '_ZNK6Person5beginEv','_ZNK9UserStats10getCreditsEv','_ZNK9UserStats11readCreditsEv',
    '_ZNK9UserStats12countCreditsEv','_ZNK9UserStats12checkCreditsEv'],
    declaredFunctionEnd:a=>a===2n?1002n:a===3n?13n:a===5n?25n:null};
  const legacy=createCxxQueryPlanner({symbols,isExecutable:()=>true});
  const v3=createCxxQueryPlanner({symbols,isExecutable:()=>true,planningPolicy:'value-accessor-v3'});
  const phrase='person credits';
  assert.deepEqual(legacy.plan(phrase).map(r=>r.address),[1n,2n,3n,4n,5n]);
  assert.deepEqual(v3.plan(phrase).map(r=>r.address),[3n,5n,2n,4n,1n]);
  assert.deepEqual(new Set(v3.plan(phrase).map(r=>r.address)),new Set(legacy.plan(phrase).map(r=>r.address)));
  assert.equal(v3.plan(phrase).find(r=>r.address===2n).declaredSizeBytes,1000n);
  assert.throws(()=>createCxxQueryPlanner({planningPolicy:'oracle'}),/unknown/);
  assert.deepEqual(cxxQueryTokens('SDLDeviceManager'),['sdldevice','manager']);
  assert.deepEqual(cxxRecoveryTokens('SDLDeviceManager'),['sdl','device','manager']);
});

test('V4 recovery prioritizes the requested class over a helper with matching action words',()=>{
  const symbols={funcs:[1n,2n,3n,4n],addrs:[1n,2n,3n,4n],names:[
    '_ZN6PersonC1Ev','_ZNK9UserStats10getCreditsEv','_ZN12PersonConfigC1Eb','_ZNK6Person6getAgeEv']};
  const plan=policy=>createCxxQueryPlanner({symbols,isExecutable:()=>true,planningPolicy:policy}).plan('person credits');
  assert.equal(plan('value-accessor-v3')[0].className,'UserStats');
  assert.equal(plan('object-context-v4')[0].className,'Person');
  assert.equal(plan('object-context-v4')[1].className,'PersonConfig','a related constructor cannot be starved by unrelated short methods');
  const accessor=createCxxQueryPlanner({symbols,isExecutable:()=>true,planningPolicy:'object-context-v4'}).plan('person age');
  assert.equal(accessor[0].address,4n,'a requested accessor stays ahead of constructor scheduling');
  assert.deepEqual(new Set(plan('object-context-v4').map(row=>row.address)),new Set(plan('value-accessor-v3').map(row=>row.address)));
});
