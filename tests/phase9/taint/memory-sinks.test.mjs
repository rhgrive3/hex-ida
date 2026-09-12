import test from 'node:test';
import assert from 'node:assert/strict';
import { queryTaint,createTaintModels,projectTaint } from '../../../js/symbolic/index.js';
import { EvidenceGraph } from '../../../js/core/evidence/index.js';
import { identity,integrationFixture } from './fixtures.mjs';
const models=extra=>createTaintModels({id:'observations',version:'1',provenance:'test:owned',
  sources:[{id:'pointer',valueId:'ptr'},{id:'old',valueId:'word'},{id:'new',valueId:'byte'}],
  memorySinks:[{id:'out-byte',observationId:'new-byte'},{id:'out-word',observationId:'word'}],...extra});
const run=(extra={})=>queryTaint(integrationFixture(),{identity,models:models(),memory:{addressBits:8,wrapping:'modular'},
  memoryObservations:[{id:'new-byte',addressValueId:'ptr',displacement:1n,size:1},{id:'word',addressValueId:'ptr',size:2}],...extra});
test('source -> symbolic partial store -> terminal memory sink -> evidence uses one byte lattice',()=>{
  const r=run();assert.equal(r.status,'complete',r.reason);
  assert.equal(r.sinks.length,2);
  assert.deepEqual(r.sinks[0].taint.sources,['new','pointer']);
  assert.deepEqual(r.sinks[1].taint.sources,['new','old','pointer']);
  const graph=EvidenceGraph.fromJSON(r.graph);assert.deepEqual(graph.unresolvedReferences(),[]);
  assert.ok(r.edges.some(x=>x.kind==='terminal-memory'));
  assert.equal(r.evidence.proofAuthority,'none');
});
test('memory sink IDs and scalar IDs occupy distinct namespaces',()=>{
  const r=run({models:models({sinks:[{id:'scalar',valueId:'word'}],memorySinks:[{id:'mem',observationId:'word'}]})});
  assert.equal(r.status,'complete',r.reason);
  assert.deepEqual(r.sinks[0].taint.sources,['old']);
  assert.deepEqual(r.sinks[1].taint.sources,['new','old','pointer']);
});
test('missing observations remain TOP, never untainted',()=>{
  const r=run({memoryObservations:[]});assert.equal(r.status,'complete',r.reason);
  assert.equal(r.sinks.length,2);assert.ok(r.sinks.every(s=>s.taint.kind==='top'));
});
test('memory sinks share the source/sink and emitted-record budgets',()=>{
  for(const extra of [{limits:{sinks:1}},{limits:{emittedRecords:1}}]) {
    const r=run(extra);assert.equal(r.status,'partial');assert.equal(r.evidence,null);assert.deepEqual(r.sinks,[]);
  }
  assert.throws(()=>models({sinks:[{id:'same',valueId:'word'}],memorySinks:[{id:'same',observationId:'word'}]}),/duplicate/);
});
test('terminal memory evidence replay is deterministic and stale model publication is refused',()=>{
  const a=run(),b=run();assert.equal(a.evidence?.id,b.evidence?.id);assert.ok(a.evidence);
  assert.equal(projectTaint(a,{modelIdentity:'stale'}).evidence,null);
});
