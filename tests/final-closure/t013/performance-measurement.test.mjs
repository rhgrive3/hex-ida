import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';
import { performanceMetrics, phase8PerformanceFailures } from '../../../tools/validation/phase8/metrics.mjs';
const profile=JSON.parse(fs.readFileSync(new URL('../../../tools/validation/phase8/profile.json',import.meta.url)));

test('150 ms optimizer acceptance still requires separate interactive and whole-function measurements',()=>{
  const metrics={coldActiveFunctionMs:{medianMs:250},phase8InteractiveStageMs:{medianMs:5},phase8OptimizeStageMs:{medianMs:150},unpublishedOptimizerCount:0};
  assert.deepEqual(phase8PerformanceFailures(metrics,profile),[]);
  for(const [key,value] of [
    ['phase8OptimizeStageMs',{medianMs:151}],['phase8InteractiveStageMs',{medianMs:6}],
    ['coldActiveFunctionMs',{medianMs:251}],['phase8OptimizeStageMs',undefined],
    ['phase8OptimizeStageMs',{medianMs:NaN}],['unpublishedOptimizerCount',1],
  ]) assert.ok(phase8PerformanceFailures({...metrics,[key]:value},profile).length>0,key);
});

test('performance collection records both production modes and the exact supplied denominator',()=>{
  const corpus=loadCorpus();const selected={...corpus,functions:[corpus.functions.find(entry=>entry.id==='quality.loop_nested.O2')]};
  const metrics=performanceMetrics({corpus:selected,repetitions:1});
  assert.equal(metrics.procedureVersion,2);
  assert.deepEqual(metrics.denominator,[selected.functions[0].id]);
  assert.equal(metrics.samples.length,1);
  for(const key of ['coldActiveFunctionMs','phase8InteractiveStageMs','phase8OptimizeStageMs']) {
    assert.equal(typeof metrics[key].medianMs,'number',key);
    assert.ok(Number.isFinite(metrics[key].medianMs)&&metrics[key].medianMs>=0,key);
  }
  assert.ok(metrics.runs[0][0].phase8.enabledStages.includes('scalar-optimization'));
  assert.throws(()=>performanceMetrics({corpus:{functions:[]},repetitions:1}),/denominator/);
});
