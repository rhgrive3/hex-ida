import test from 'node:test';
import assert from 'node:assert/strict';
import { queryTaint,createTaintModels } from '../../../js/symbolic/index.js';
import { EvidenceGraph } from '../../../js/core/evidence/index.js';
import { identity,integrationFixture } from './fixtures.mjs';
import { TAINT_TOP,UNTAINTED,sourceTaint,joinTaint,filterTaint } from '../../../js/symbolic/taint/lattice.js';
test('evidence contains explicit model source/sink nodes and a traversable derivation path',()=>{
  const models=createTaintModels({id:'explanation',version:'2',provenance:'fixture-contract',sources:[{id:'incoming-byte',valueId:'byte'}],sinks:[{id:'output',valueId:'final'}]});
  const result=queryTaint(integrationFixture(),{identity,models,memory:{addressBits:8,wrapping:'modular'}});
  assert.equal(result.status,'complete',result.reason);
  const graph=result.graph;
  const source=graph.nodes.find(n=>n.semanticKind==='taint-source');const sink=graph.nodes.find(n=>n.semanticKind==='taint-sink');
  assert.ok(source);assert.ok(sink);assert.equal(source.payload.model.version,'2');
  const seen=new Set(),pending=[sink.id];
  while(pending.length){const id=pending.pop();if(seen.has(id))continue;seen.add(id);for(const edge of graph.edges)if(edge.from===id)pending.push(edge.to);}
  assert.ok(seen.has(source.id));assert.deepEqual(EvidenceGraph.fromJSON(graph).unresolvedReferences(),[]);
  assert.equal(result.metrics.emittedRecords,result.values.length+result.edges.length+result.sinks.length+1+2*(models.sources.length+models.sinks.length+models.sanitizers.length));
});
test('untrusted or malformed lattice states cannot be laundered into untainted',()=>{
  for(const bad of [{kind:'mystery',sources:[]},{kind:'sources',sources:[]},{...UNTAINTED},Object.freeze({kind:'untainted',sources:Object.freeze([])})]) {
    assert.equal(joinTaint(bad,UNTAINTED),TAINT_TOP);assert.equal(filterTaint(bad,[]),TAINT_TOP);
  }
  assert.throws(()=>sourceTaint('x'.repeat(1025)),/source/);
  assert.equal(joinTaint(sourceTaint('a'),sourceTaint('b'),1),TAINT_TOP);
});
