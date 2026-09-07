import test from 'node:test';
import assert from 'node:assert/strict';
import { symbolicExecute, translate, queryTaint, createTaintModels, projectTaint } from '../../../js/symbolic/index.js';
import { partialStoreFixture, identity } from './main-fixtures.mjs';
import { integrationFixture, identity as taintIdentity } from '../taint/fixtures.mjs';

function run(ir=partialStoreFixture(),options={}) {
  return {ir,result:symbolicExecute(ir,{captureValues:true,byteMemory:{identity},...options})};
}
test('production translation consumes the issued load value with explicit bounded scope',()=>{
  const {ir,result}=run();
  const translated=translate.translateSemanticIR(ir.instructions[2],{ir,identity,executionSnapshot:result.paths[0].snapshot});
  assert.equal(translated.expression.value,0x1122aa44n);
  assert.equal(translated.status,'exact_with_assumptions');
  assert.equal(translated.completeness.pathCoverage,'partial');
  assert.ok(translated.assumptions.length>0);
});
test('snapshot rejects forged, foreign IR/target, stale identity, width mismatch, and mutated IR',()=>{
  const {ir,result}=run();const snapshot=result.paths[0].snapshot,target=ir.instructions[2];
  assert.ok(snapshot);
  for(const options of [{executionSnapshot:{...snapshot}},{ir:partialStoreFixture()},{identity:{...identity,snapshotId:'stale'}},{bitWidth:8}]) {
    const r=translate.translateSemanticIR(target,{ir,identity,executionSnapshot:snapshot,...options});assert.equal(r.status,'unsupported');
  }
  assert.equal(translate.translateSemanticIR({...target},{ir,identity,executionSnapshot:snapshot}).status,'unsupported');
  ir.instructions[0].args[0].value.const=0n;
  assert.equal(translate.translateSemanticIR(target,{ir,identity,executionSnapshot:snapshot}).status,'unsupported');
});
test('path snapshots preserve path-specific phi values and constraints, not a merged fiction',()=>{
  const ir=integrationFixture();
  const result=symbolicExecute(ir,{captureValues:true,byteMemory:{identity:taintIdentity,addressBits:8,wrapping:'modular'}});
  assert.equal(result.status,'complete',result.reason);
  const expressions=result.paths.map(path=>translate.translateSemanticIR(ir.blocks[3].phis[0],{ir,identity:taintIdentity,executionSnapshot:path.snapshot}));
  assert.equal(expressions.length,2);assert.ok(expressions.every(r=>r.status==='exact_with_assumptions'));
  assert.notDeepEqual(expressions[0].expression,expressions[1].expression);
  assert.ok(expressions.every(r=>r.pathConstraints.length===1));
});
test('snapshot publication is withheld on cancellation/budget; issued snapshots become stale on cancellation',()=>{
  const ac=new AbortController();const {ir,result}=run(partialStoreFixture(),{signal:ac.signal});
  const snapshot=result.paths[0].snapshot;assert.ok(snapshot);ac.abort();
  assert.equal(translate.translateSemanticIR(ir.instructions[2],{ir,identity,executionSnapshot:snapshot}).status,'unsupported');
  const budget=run(partialStoreFixture(),{byteMemory:{identity,limits:{workItems:1}}}).result;
  assert.equal(budget.status,'partial');assert.equal(budget.paths.length,0);
});
test('taint evidence capability is invalidated when the executed source IR changes',()=>{
  const ir=partialStoreFixture();const models=createTaintModels({id:'snapshot-taint',version:'1',provenance:'test',sources:[{id:'external',valueId:'byte'}],sinks:[{id:'sink',valueId:'loaded'}]});
  const r=queryTaint(ir,{identity,models});assert.equal(r.status,'complete',r.reason);
  assert.ok(projectTaint(r).evidence);ir.instructions[1].loc.address=0x102n;
  assert.equal(projectTaint(r).evidence,null);
});
test('snapshot cannot be silently combined with another argument or predecessor scope',()=>{
  const {ir,result}=run();const snapshot=result.paths[0].snapshot;
  for(const conflicting of [{symbolicArgs:{0:42n}},{fromBlock:99}]) {
    const r=translate.translateSemanticIR(ir.instructions[2],{ir,identity,executionSnapshot:snapshot,...conflicting});
    assert.equal(r.status,'unsupported');
    assert.equal(r.reason,'execution-options-conflict');
  }
});
