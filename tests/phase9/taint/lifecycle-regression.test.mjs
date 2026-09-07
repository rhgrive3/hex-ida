import test from 'node:test';
import assert from 'node:assert/strict';
import { queryTaint, createTaintModels, projectTaint, symbolicExecute } from '../../../js/symbolic/index.js';
import { OP } from '../../../js/ir.js';
import { identity, scalarFixture, integrationFixture } from './fixtures.mjs';
const models = () => createTaintModels({id:'lifecycle',version:'1',provenance:'regression',sources:[{id:'input',valueId:'input'}],sinks:[{id:'output',valueId:'out'}]});
test('memory and executor resource failures cannot publish taint evidence', () => {
  for (const extra of [
    {memory:{addressBits:8,limits:{workItems:0}}},
    {memory:{addressBits:8,timeoutMs:0}},
    {execution:{maxSteps:0}}, {execution:{maxPaths:0}}, {execution:{maxBlockVisits:0}},
  ]) {
    const result=queryTaint(scalarFixture(),{identity,models:models(),...extra});
    assert.equal(result.status,'partial');assert.equal(result.evidence,null,result.reason);
    assert.equal(result.sinks.length,0);
  }
});
test('unsupported dead scalar instructions do not launder incomplete execution', () => {
  const ir=scalarFixture();
  ir.blocks[0].insts[0].op=OP.SEL;
  ir.blocks[0].insts[1].args=[{value:{id:'constant-return',const:0n,bits:8}}];
  const result=symbolicExecute(ir,{byteMemory:{identity,addressBits:8}});
  assert.equal(result.status,'partial');assert.equal(result.paths.length,0);
});
test('post-query cancel and model replacement invalidate evidence projection', () => {
  const controller=new AbortController(), model=models();let currentModel=model.modelIdentity;
  const options={identity,models:model,signal:controller.signal,getCurrentModelIdentity:()=>currentModel};
  const result=queryTaint(scalarFixture(),options);assert.equal(result.status,'complete');
  currentModel='new-model';assert.equal(projectTaint(result).evidence,null);
  currentModel=model.modelIdentity;controller.abort();assert.equal(projectTaint(result).evidence,null);
});
test('empty byte-memory IR is not an exact function result', () => {
  const result=symbolicExecute({blocks:[]},{byteMemory:{identity,addressBits:8}});
  assert.equal(result.status,'partial');assert.equal(result.paths.length,0);
});
test('ambiguous symbolic effective-address wrap is not exact in reject mode', () => {
  const ir=integrationFixture();ir.blocks[0].insts.shift();
  const result=symbolicExecute(ir,{byteMemory:{identity,addressBits:8,wrapping:'reject'}});
  assert.equal(result.status,'partial');assert.equal(result.paths.length,0);
});
