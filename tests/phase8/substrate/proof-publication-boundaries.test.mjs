import test from 'node:test';
import assert from 'node:assert/strict';
import { runPhase8Vertical, runPhase8Stage, createAnalysisState } from '../../../js/decompiler/phase8/index.js';
const context = () => ({ ir: { values:[{id:1,origin:{instructionIds:['i']}}], blocks:[{index:0}], entry:0, origin:{instructionIds:['i']} }, enabledStages:['canonical-facts'] });

test('v8: cancellation at the vertical commit boundary withholds the ledger', () => {
  let checks = 0;
  const normal = runPhase8Vertical(context(), {shouldAbort:() => {checks++;return false;}});
  assert.equal(normal.ledger.published,true);
  // The last budget check is the publication boundary, after observation and
  // ledger assembly. Reaching it with cancellation must publish nothing.
  let replay=0;
  const cancelled=runPhase8Vertical(context(),{shouldAbort:()=>++replay===checks});
  assert.equal(cancelled.ledger.published,false);
  assert.deepEqual(cancelled.ledger.analysisVersions.before,cancelled.ledger.analysisVersions.after);
});
test('v8: explicit time allowance does not disable the deterministic work ceiling', () => {
  const r=runPhase8Stage(context(),{timeBudgetMs:1000,maxWorkItems:0});
  assert.equal(r.ledger.published,false);
});
test('v8: structured budget values are not coerced into authority', () => {
  let calls=0;
  for(const timeBudgetMs of [[1000],{valueOf(){calls++;return 1000;}},true,'1000']) {
    assert.equal(runPhase8Stage(context(),{timeBudgetMs}).ledger.published,false);
  }
  assert.equal(calls,0);
});
test('v8: required solver rewrite admission API is present', async () => {
  const surface = await import('../../../js/decompiler/phase8/index.js');
  assert.equal(typeof surface.preparePhase8RewritePlan,'function');
});

test('v8: cancellation from the post-pass observation cannot commit', () => {
 let reads=0,abort=false;
 const state=createAnalysisState({cfg:{blocks:[{index:0}]},origins:{},ssa:{get values(){reads++;if(reads>=3)abort=true;return [{id:1}];}}});
 const before=state.snapshot();
 const r=runPhase8Vertical({analysis:state,enabledStages:['canonical-facts'],ir:{}},{shouldAbort:()=>abort});
 assert.ok(reads>=3);assert.equal(r.ledger.published,false);assert.deepEqual(state.snapshot(),before);
});
import {preparePhase8RewritePlan} from '../../../js/decompiler/phase8/pass-validation.js';
import {proofFixture,identity} from '../helpers/proof-fixtures.mjs';
test('v8: deadline expiring inside the final identity observer withholds publication',async()=>{
 const f=proofFixture();let armed=false,calls=0,delayAt=Infinity;
 const plan=await preparePhase8RewritePlan(f.ir,{...f.options,getCurrentIdentity(){
  if(armed && ++calls===delayAt){const until=performance.now()+150;while(performance.now()<until){/* Controlled finite observer delay. */}}
  return identity;
 }});
 assert.equal(plan.status,'complete',plan.reason);
 const ctx={ir:f.ir,proofIdentity:identity,abiId:f.options.abiId,proofRewritePlan:plan};
 armed=true;const first=runPhase8Stage(ctx,{stages:['canonical-facts','rendering'],timeBudgetMs:120});
 assert.equal(first.ledger.published,true);assert.ok(calls>0);delayAt=calls;calls=0;
 const delayed=runPhase8Stage(ctx,{stages:['canonical-facts','rendering'],timeBudgetMs:120});
 assert.equal(delayed.ledger.published,false);assert.deepEqual(delayed.ledger.analysisVersions.before,delayed.ledger.analysisVersions.after);
});
