import test from 'node:test';
import assert from 'node:assert/strict';
import {createCxxQueryPlanner,recoverCxxQueryMembers} from '../../../js/analysis/cxx/query-recovery.js';

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
