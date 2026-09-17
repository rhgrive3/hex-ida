import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaintFlow } from '../../../js/symbolic/taint/flow.js';
import { queryTaint, createTaintModels } from '../../../js/symbolic/index.js';
import { OP } from '../../../js/ir-base.js';
import { identity, integrationFixture } from './fixtures.mjs';
test('revisited widened nodes stay TOP and do not consume a ninth update or narrow',()=>{
 const models=createTaintModels({id:'widen',version:'1',provenance:'owned:test',sources:['a','b','c'].map(id=>({id,valueId:id})),sinks:[{id:'out',valueId:'out'}]});
 const flow=createTaintFlow({identity,models,maxUpdates:2});
 flow.value('out',['a','b2','c4'],'join');
 flow.value('c4',['c3'],'data');flow.value('c3',['c2'],'data');flow.value('c2',['c1'],'data');flow.value('c1',['c'],'data');
 flow.value('b2',['b1'],'data');flow.value('b1',['b'],'data');
 const r=flow.solve();assert.equal(r.sinks[0].taint.kind,'top');assert.equal(r.widened,true);assert.equal(flow.metrics().updatesPerValue,2);
});
test('a declared byte sanitizer cannot erase the other byte or address taint of a memory sink',()=>{
 const ir=integrationFixture(),partial=ir.blocks[0].insts[1],input=partial.args[0].value;
 const clean={id:'clean',bits:8};const inst={id:'sanitize-byte',op:OP.MOV,dst:clean,args:[{value:input}],row:0,address:0n};clean.def=inst;
 ir.blocks[0].insts.splice(1,0,inst);ir.instructions.splice(1,0,inst);partial.args[0]={value:clean};
 const models=createTaintModels({id:'partial-sanitizer',version:'1',provenance:'owned:test',
  sources:[{id:'old',valueId:'word'},{id:'new',valueId:'byte'},{id:'pointer',valueId:'ptr'}],
  sanitizers:[{id:'byte-only',valueId:'clean',scope:'value',removeSources:['new']}],
  memorySinks:[{id:'memory-out',observationId:'word'}]});
 const r=queryTaint(ir,{identity,models,memory:{addressBits:8,wrapping:'modular'},memoryObservations:[{id:'word',addressValueId:'ptr',size:2}]});
 assert.equal(r.status,'complete',r.reason);assert.deepEqual(r.sinks[0].taint.sources,['old','pointer']);
});
