import test from 'node:test';
import assert from 'node:assert/strict';
import {baselineSummaries} from '../../../scripts/rescore-jev-default-v3.mjs';
import {DEFAULT_V3_ARMS} from '../../../scripts/evaluate-jev-default-v3.mjs';
test('V3 rescue and destruction count the actual Hex and deterministic baselines independently',()=>{
  const rows=[[true,false,true],[false,true,true],[true,true,false]].map(([hex,local,remote],index)=>({
    id:String(index),binary:'openttd',status:'verified',verdict:'ambiguous',hexLatencyMs:1,
    funnel:{verified:true,recovered:true,lattice:true,shortlist:true},
    arms:Object.fromEntries(DEFAULT_V3_ARMS.map(arm=>[arm,{key:String(index),correct:arm==='A'?hex:arm==='R1'?local:remote,
      calls:[],repeatedKeys:[String(index)],repeatedCorrect:[arm==='A'?hex:arm==='R1'?local:remote]}]))}));
  const s=baselineSummaries(rows);
  assert.equal(s.summaries.V3.hexTop1,2);assert.equal(s.summaries.V3.rescue,1);assert.equal(s.summaries.V3.regression,1);
  assert.equal(s.summaries.V3.baselineDestructionRate,0.5);
  assert.equal(s.vsR1.V3.hexTop1,2);assert.equal(s.vsR1.V3.rescue,1);assert.equal(s.vsR1.V3.regression,1);
  assert.equal(s.summaries.A.rescue,0);assert.equal(s.summaries.A.regression,0);
  assert.equal(s.vsR1.R1.net,0);
});
