import test from 'node:test';
import assert from 'node:assert/strict';
import {baselineSummaries} from '../../../scripts/rescore-jev-default-v3.mjs';
import {DEFAULT_V3_ARMS} from '../../../scripts/evaluate-jev-default-v3.mjs';
import {execFileSync} from 'node:child_process';
import {v4Summaries} from '../../../scripts/evaluate-jev-default-v4.mjs';
import {V4_ARMS} from '../../../scripts/jev-default-v4-contract.mjs';
test('V4 keeps recovery drift and remote destruction separate from the best comparator',()=>{
  const rows=[[true,false,false,true],[false,true,true,false]].map(([prior,hex,local,remote],index)=>({
    id:String(index),binary:index?'openmw':'openttd',status:'verified',verdict:'ambiguous',hexLatencyMs:1,
    funnel:{verified:true,recovered:true,lattice:true,shortlist:true},
    arms:Object.fromEntries(V4_ARMS.map(arm=>[arm,{key:String(index),correct:arm==='A0'?prior:arm==='A'?hex:arm==='O4'?local:remote,
      calls:[],repeatedKeys:[String(index)],repeatedCorrect:[arm==='A0'?prior:arm==='A'?hex:arm==='O4'?local:remote]}]))}));
  const s=v4Summaries(rows);
  assert.equal(s.vsBeforeExtension.A.regression,1);assert.equal(s.vsBeforeExtension.A.rescue,1);
  assert.equal(s.summaries.S4.regression,1);assert.equal(s.summaries.S4.rescue,1);
  assert.equal(s.vsBeforeExtension.S4.regression,0);assert.equal(s.vsBeforeExtension.S4.rescue,0);
  assert.equal(s.vsBestDeterministic.S4.baselineDestructionRate,1);
  assert.equal(s.perGame.openttd.A.S4.rescue,1);assert.equal(s.perGame.openmw.A.S4.regression,1);
});
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

test('Actions artifact names cannot merge distinct IDs and unsafe archives fail closed',()=>{
  execFileSync('python',['-c',`
import importlib.util, io, zipfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('artifact_downloader','scripts/download-jev-action-evidence.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
root=Path('/mnt/workspace/.dev-state/agent-work/evidence/jev-realgame-final')
assert module.artifact_destination(root,1,2)!=module.artifact_destination(root,1,3)
assert module.artifact_destination(root,1,2)!=module.artifact_destination(root,2,2)
for names in [['../escape'],['/absolute'],['same','./same']]:
 stream=io.BytesIO()
 with zipfile.ZipFile(stream,'w') as archive:
  for name in names: archive.writestr(name,'evidence')
 with zipfile.ZipFile(stream) as archive:
  try: module.validate_archive(archive,root/'artifact')
  except ValueError: pass
  else: raise AssertionError('unsafe artifact accepted')
`],{cwd:new URL('../../../',import.meta.url),env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:'pipe'});
});
