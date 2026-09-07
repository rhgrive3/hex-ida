import test from 'node:test';
import assert from 'node:assert/strict';
import * as symbolic from '../../../js/symbolic/index.js';
test('T034 first counterexample: first-class taint is a production export',()=>{
  assert.equal(typeof symbolic.queryTaint,'function');
});
import { UNTAINTED,TAINT_TOP,sourceTaint,joinTaint,sameTaint } from '../../../js/symbolic/taint/lattice.js';
import { createTaintFlow } from '../../../js/symbolic/taint/flow.js';
import { createTaintModels } from '../../../js/symbolic/taint/models.js';
import { identity } from './fixtures.mjs';
const models=()=>createTaintModels({id:'models',version:'1',provenance:'fixture:reviewed',sources:[{id:'a',valueId:'a'}],sinks:[{id:'out',valueId:'c'}]});
test('lattice laws: bottom/TOP, commutativity, associativity, idempotence and overflow',()=>{
  const all=[UNTAINTED,TAINT_TOP,sourceTaint('a'),sourceTaint('b'),joinTaint(sourceTaint('a'),sourceTaint('b'))];
  for(const a of all)for(const b of all)for(const c of all) {
    assert.ok(sameTaint(joinTaint(a,a),a));
    assert.ok(sameTaint(joinTaint(a,b),joinTaint(b,a)));
    assert.ok(sameTaint(joinTaint(joinTaint(a,b),c),joinTaint(a,joinTaint(b,c))));
    assert.equal(joinTaint(a,TAINT_TOP).kind,'top');
  }
  assert.equal(joinTaint(sourceTaint('a'),sourceTaint('b'),1).kind,'top');
  assert.notDeepEqual(UNTAINTED,TAINT_TOP);
});
test('phi/loop joins converge and bounded widening never drops sources',()=>{
  const f=createTaintFlow({identity,models:models()});
  f.value('b',['a','c'],'phi');f.value('c',['b'],'data');
  assert.deepEqual(f.solve().sinks[0].taint.sources,['a']);
  const bounded=createTaintFlow({identity,models:models(),maxUpdates:1});
  bounded.value('b',['a','c'],'phi');bounded.value('c',['b'],'data');
  const result=bounded.solve();assert.equal(result.sinks[0].taint.kind,'top');assert.equal(result.widened,true);assert.ok(bounded.metrics().updatesPerValue<=1);
});
test('model ID/version/provenance required; cloned model handles are not authority',()=>{
  assert.throws(()=>createTaintModels({id:'x',version:'1'}),/provenance/);
  const m=models();assert.throws(()=>createTaintFlow({identity,models:{...m}}),/registered/);
});
