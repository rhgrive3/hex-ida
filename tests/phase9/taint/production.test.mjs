import test from 'node:test';
import assert from 'node:assert/strict';
import { queryTaint,createTaintModels,projectTaint } from '../../../js/symbolic/index.js';
import { EvidenceGraph } from '../../../js/core/evidence/index.js';
import { OP } from '../../../js/ir.js';
import { identity,scalarFixture,integrationFixture } from './fixtures.mjs';
export const scalarModels=(extras={})=>createTaintModels({id:'m',version:'1',provenance:'fixture:reviewed',sources:[{id:'external',valueId:'input'}],sinks:[{id:'sink',valueId:'out'}],...extras});
const run=(extra={})=>queryTaint(scalarFixture(),{identity,models:scalarModels(),memory:{addressBits:8},...extra});
test('production source→symbolic address/partial store→load→control/data→phi→sink→evidence',()=>{
  const models=createTaintModels({id:'integration',version:'1',provenance:'fixture:semantic-values',
    sources:[{id:'pointer',valueId:'ptr'},{id:'old-word',valueId:'word'},{id:'new-byte',valueId:'byte'}],sinks:[{id:'result',valueId:'final'},{id:'control-only',valueId:'no'}]});
  const result=queryTaint(integrationFixture(),{identity,models,memory:{addressBits:8,wrapping:'modular'}});
  assert.equal(result.status,'complete',result.reason);assert.equal(result.execution.paths.length,2);
  assert.deepEqual(result.sinks[0].taint.sources,['new-byte','pointer']);
  assert.deepEqual(result.sinks[1].taint.sources,['new-byte','pointer']);
  assert.ok(result.edges.some(e=>e.kind==='memory-load'));assert.ok(result.edges.some(e=>e.kind==='control'));assert.ok(result.edges.some(e=>e.kind==='phi'));
  assert.equal(result.evidence.proofAuthority,'none');assert.equal(result.evidence.verdict,'unknown');
  const graph=EvidenceGraph.fromJSON(result.graph);assert.deepEqual(graph.unresolvedReferences(),[]);
  assert.equal(result.evidence.proofScope.identity.snapshotId,identity.snapshotId);
  assert.equal(Object.isFrozen(result.sinks[0].taint.sources),true);
});
test('direct explicit flow and replay use one stable model/query identity',()=>{
  const a=run(),b=run();assert.equal(a.status,'complete',a.reason);assert.deepEqual(a.sinks[0].taint.sources,['external']);
  assert.equal(a.evidence.id,b.evidence.id);assert.deepEqual(a.edges,b.edges);assert.equal(a.modelIdentity,b.modelIdentity);
});
test('known value-scoped sanitizer filters only declared sources; unknown/clean flags do not',()=>{
  const good=scalarModels({sanitizers:[{id:'declared',valueId:'out',scope:'value',removeSources:['external']}]});
  assert.equal(run({models:good}).sinks[0].taint.kind,'untainted');
  const unrelated=scalarModels({sanitizers:[{id:'declared',valueId:'out',scope:'value',removeSources:['other']}]});
  assert.deepEqual(run({models:unrelated}).sinks[0].taint.sources,['external']);
  const unknown=scalarModels({sanitizers:[{id:'sanitize_everything',valueId:'out',clean:true}]});
  const r=run({models:unknown});assert.deepEqual(r.sinks[0].taint.sources,['external']);assert.deepEqual(r.unknownSanitizers,['sanitize_everything']);
});
test('unknown call, missing value and loop exhaustion remain TOP/partial, not untainted',()=>{
  const ir=scalarFixture();ir.blocks[0].insts.splice(1,0,{id:'call',op:OP.CALL,args:[]});
  const r=queryTaint(ir,{identity,models:scalarModels(),memory:{addressBits:8}});
  assert.equal(r.status,'partial');assert.equal(r.sinks[0].taint.kind,'top');
  const missing=run({models:scalarModels({sinks:[{id:'lost',valueId:'missing'}]})});assert.equal(missing.sinks[0].taint.kind,'top');
  const loop=scalarFixture();loop.blocks[0].insts.pop();loop.blocks[0].succ=[0];
  const l=queryTaint(loop,{identity,models:scalarModels(),memory:{addressBits:8}});assert.equal(l.status,'partial');assert.equal(l.evidence,null);assert.equal(l.sinks.length,0);
});
test('may-alias store retains both candidate labels and unknown initial TOP',()=>{
  const ir=integrationFixture();
  const other={id:'other',kind:'arg',reg:'x3',index:3,bits:8};
  ir.blocks[0].insts[1].addr.base=other;
  const r=queryTaint(ir,{identity,models:createTaintModels({id:'may',version:'1',provenance:'fixture',sources:[{id:'secret',valueId:'byte'}],sinks:[{id:'out',valueId:'final'}]}),memory:{addressBits:8,wrapping:'modular'}});
  assert.equal(r.status,'complete',r.reason);assert.ok(r.sinks[0].taint.kind==='top'||r.sinks[0].taint.sources.includes('secret'));
});
test('stale query/model identity and copied records are not projection authority',()=>{
  let current=identity;const r=run({getCurrentIdentity:()=>current});
  assert.equal(projectTaint({...r}).evidence,null);
  assert.equal(projectTaint(r,{modelIdentity:'different'}).evidence,null);
  current={...identity,snapshotId:'new'};assert.equal(projectTaint(r).evidence,null);
});
test('source/sink/work/allocation/emission limits and cancellation withhold publication',()=>{
  for(const key of ['sources','sinks','workItems','latticeValues','flowEdges','emittedRecords']) {
    const r=run({limits:{[key]:0}});assert.equal(r.status,'partial',key);assert.equal(r.evidence,null,key);assert.equal(r.sinks.length,0,key);
  }
  const ac=new AbortController();ac.abort();const cancelled=run({signal:ac.signal});assert.equal(cancelled.evidence,null);assert.equal(cancelled.reason,'cancelled');
  let now=0;const d=run({now:()=>++now,timeoutMs:1});assert.equal(d.evidence,null);assert.equal(d.reason,'deadline');
});
test('measured N-1/N/N+1 graph limits are prechecked, not clipped to clean',()=>{
  const base=run();
  for(const key of ['latticeValues','flowEdges','emittedRecords','sources','sinks']) {
    const n=base.metrics[key];
    assert.equal(run({limits:{[key]:n-1}}).evidence,null,key);
    assert.equal(run({limits:{[key]:n}}).status,'complete',key);
    assert.equal(run({limits:{[key]:n+1}}).status,'complete',key);
  }
});

test('sanitized partial byte store never sanitizes untouched neighboring bytes',()=>{
  const ir=integrationFixture(),[wordStore,byteStore,load]=ir.blocks[0].insts;
  const cleanByte={id:'clean-byte',bits:8};
  const sanitize={id:'sanitize-copy',op:OP.MOV,args:byteStore.args,dst:cleanByte};cleanByte.def=sanitize;
  byteStore.args=[{value:cleanByte}];load.addr.disp=0n;load.addr.size=2;load.loc.size=2;load.dst.bits=16;
  const ret={id:'ret-word',op:OP.RET,args:[{value:load.dst}]};
  const insts=[wordStore,sanitize,byteStore,load,ret];ir.blocks=[{index:0,insts,succ:[]}];ir.instructions=insts;
  const models=createTaintModels({id:'byte-scope',version:'1',provenance:'test',sources:[{id:'old',valueId:'word'},{id:'new',valueId:'byte'}],
    sanitizers:[{id:'remove-new',valueId:'clean-byte',scope:'value',removeSources:['new']}],sinks:[{id:'word-sink',valueId:'loaded'}]});
  const result=queryTaint(ir,{identity,models,memory:{addressBits:8,wrapping:'modular'}});
  assert.equal(result.status,'complete',result.reason);assert.deepEqual(result.sinks[0].taint.sources,['old']);
});
