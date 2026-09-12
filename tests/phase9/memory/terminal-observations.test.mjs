import test from 'node:test';
import assert from 'node:assert/strict';
import { symbolicExecute, expr as E, isExecutionSnapshot } from '../../../js/symbolic/index.js';
import { partialStoreFixture, identity } from './main-fixtures.mjs';
import { integrationFixture, identity as flowIdentity } from '../taint/fixtures.mjs';

const observations = [{id:'word',address:0x100n,size:4},{id:'byte',address:0x101n,size:1}];
const run = (ir=partialStoreFixture(),extra={}) => symbolicExecute(ir,{captureValues:true,byteMemory:{identity},memoryObservations:observations,...extra});
test('terminal byte observations are read from the actual path memory after partial stores', () => {
  const r=run(); assert.equal(r.status,'complete',r.reason);
  assert.deepEqual(r.paths[0].memoryObservations.map(x=>[x.id,x.expression.value]),[['word',0x1122aa44n],['byte',0xaan]]);
  assert.deepEqual(r.paths[0].snapshot.memoryObservations,r.paths[0].memoryObservations);
  assert.ok(Object.isFrozen(r.paths[0].memoryObservations));
  assert.ok(Object.isFrozen(r.paths[0].memoryObservations[0]));
  assert.equal(r.metrics.memoryObservationRecords,2);
});
test('symbolic SSA address observations preserve both fork states and byte overwrite order', () => {
  const ir=integrationFixture();
  const r=run(ir,{byteMemory:{identity:flowIdentity,addressBits:8,wrapping:'modular'},memoryObservations:[{id:'at-ptr',addressValueId:'ptr',displacement:1n,size:1}]});
  assert.equal(r.status,'complete',r.reason);assert.equal(r.paths.length,2);
  for(const p of r.paths) {
    const item=p.memoryObservations[0];
    assert.equal(item.expression.sort.width,8);assert.equal(item.address.sort.width,8);
    assert.equal(E.evaluateExpr(item.expression,{arg_x2:0x7bn}).value,0x7bn);
  }
});
test('unknown holes in terminal observations stay symbolic and alias consistent', () => {
  const r=run(partialStoreFixture(),{memoryObservations:[{id:'a',address:0x200n,size:1},{id:'b',address:0x200n,size:1}]});
  assert.equal(r.status,'complete',r.reason);
  const [a,b]=r.paths[0].memoryObservations;
  assert.equal(a.expression,b.expression);assert.notEqual(a.expression.kind,'const');
});
test('bad observation requests withhold all earlier complete paths', () => {
  for(const request of [
    {id:'bad',address:Number.MAX_SAFE_INTEGER+1,size:1},
    {id:'bad',address:0n,size:3},
    {id:'bad',address:0n,addressValueId:'ptr',size:1},
    {id:'bad',addressValueId:'missing',size:1},
  ]) {
    const r=run(partialStoreFixture(),{memoryObservations:[observations[0],request]});
    assert.equal(r.status,'partial');assert.deepEqual(r.paths,[]);
  }
});
test('terminal observation limits N-1/N/N+1 reserve before publication', () => {
  for(const limit of [1,2,3]) {
    const r=run(partialStoreFixture(),{byteMemory:{identity,limits:{memoryObservationRecords:limit}}});
    assert.equal(r.status,limit<2?'partial':'complete',r.reason);
    if(limit<2) assert.deepEqual(r.paths,[]);
  }
});
test('request data is captured immutably; cancelling still revokes its execution snapshot', () => {
  const requests=structuredClone(observations),ac=new AbortController();
  const r=run(partialStoreFixture(),{memoryObservations:requests,signal:ac.signal});
  requests[0].address=0n;
  assert.equal(r.paths[0].memoryObservations[0].request.address,0x100n);
  assert.ok(isExecutionSnapshot(r.paths[0].snapshot));
  ac.abort();assert.equal(isExecutionSnapshot(r.paths[0].snapshot),false);
});
test('fork-specific writes remain different in terminal observations',()=>{
 const ir=integrationFixture(),partial=ir.blocks[0].insts[1];
 const write={...partial,id:'branch-only-write',args:[{value:{id:'branch-constant',const:0x5an,bits:8}}],row:5,address:20n};
 ir.blocks[1].insts.splice(1,0,write);ir.instructions.splice(5,0,write);
 const r=run(ir,{byteMemory:{identity:flowIdentity,addressBits:8,wrapping:'modular'},memoryObservations:[{id:'branch-byte',addressValueId:'ptr',displacement:1n,size:1}]});
 assert.equal(r.status,'complete',r.reason);assert.equal(r.paths.length,2);
 const values=r.paths.map(path=>E.evaluateExpr(path.memoryObservations[0].expression,{arg_x2:3n}).value).sort();
 assert.deepEqual(values,[3n,0x5an]);
});
test('observation request accessors and duplicate IDs fail before any value is published',()=>{
 let invoked=0;const request={id:'get',size:1,get address(){invoked++;return 0n;}};
 const r=run(partialStoreFixture(),{memoryObservations:[request]});
 assert.equal(r.status,'partial');assert.deepEqual(r.paths,[]);assert.equal(invoked,0);
 const duplicate=run(partialStoreFixture(),{memoryObservations:[observations[0],observations[0]]});
 assert.equal(duplicate.status,'partial');assert.equal(duplicate.reason,'invalid-observation-id');
});
