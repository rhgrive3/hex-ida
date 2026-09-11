import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAnalysisIdentity as current } from '../../js/decompiler/phase8/analysis-identity.js';
import { canonicalAnalysisIdentity as original } from '../helpers/aggregate-speed-baseline/js/decompiler/phase8/analysis-identity.js';
import { createOriginSet } from '../../js/core/identity/origin.js';
import { fixture } from '../phase8/helpers/ir-fixtures.mjs';
function graph(origins){const f=fixture('aggregate-origins');f.block(0);const a=f.constant(1n,32),b=f.constant(2n,32);f.binary('add',a,b,32);f.ret();const ir=f.build();
  ir.origin=origins[0];let n=1;for(const block of ir.blocks){block.origin=origins[n++%origins.length];for(const inst of block.insts)inst.origin=origins[n++%origins.length];}
  for(const value of ir.values)value.origin=origins[n++%origins.length];return ir;}
function compare(ir){for(let i=0;i<5;i++)assert.deepEqual(current({ir}),original({ir}));return current({ir});}

test('ordered origin-table reuse preserves exact identity for sequence changes, prefixes and duplicates',()=>{
  const origins=Array.from({length:4},(_,i)=>createOriginSet({instructionIds:[`instruction:${i}`],sourceLocations:[{file:'日本語',line:i}]}));
  for(const sequence of [origins,[...origins].reverse(),origins.slice(0,1),origins.slice(0,2),[origins[0],origins[0],origins[1]]]) {
    const ir=graph(sequence);assert.equal(compare(ir).valid,true);const before=compare(ir);
    ir.origin=createOriginSet({instructionIds:['changed']});assert.notDeepEqual(compare(ir).identity,before.identity);
  }
});

test('origin table caching never hides mutable descendants or metadata edits between calls',()=>{
  const raw={nested:{text:'before'}};const ir=graph([Object.freeze(raw)]),before=compare(ir);
  raw.nested.text='after';assert.notDeepEqual(compare(ir).identity,before.identity);
  const canonical=graph([createOriginSet({instructionIds:['instruction:immutable']})]);
  const first=compare(canonical);canonical.values[0].def.extra.value=100n;
  assert.notDeepEqual(compare(canonical).identity,first.identity);
});

test('long, sparse and null-prototype immutable origins keep their full typed spelling',()=>{
  for(const origin of [Object.freeze({text:'あ😀'.repeat(24000)}),Object.freeze([1,,3]),
    Object.freeze(Object.assign(Object.create(null),{large:18446744073709551617n}))])assert.equal(compare(graph([origin])).valid,true);
});

test('failed typed encodings never poison a later complete table',()=>{
  for(const origin of [Object.freeze({n:NaN}),Object.freeze({n:Infinity}),Object.freeze({bad:Symbol('x')}),
    Object.freeze(Object.defineProperty({},'hidden',{value:1}))]) compare(graph([origin]));
  assert.equal(compare(graph([createOriginSet({instructionIds:['valid:after-failure']})])).valid,true);
});

test('private projections retain sparse/custom metadata, __proto__, and shared typed subgraphs',()=>{
  const ir=graph([createOriginSet({instructionIds:['typed:shared']})]);
  const special=Object.assign([1,,3],{extra:'custom'});
  const metadata=Object.create(null);metadata.__proto__={x:1};metadata.array=special;
  metadata.large=18446744073709551617n;metadata.zero=-0;
  for(const value of ir.values)value.def.extra.metadata=metadata;
  assert.equal(compare(ir).valid,true);
  metadata.array[1]=undefined;assert.equal(compare(ir).valid,true);
  metadata.array.extra='changed';assert.equal(compare(ir).valid,true);
});

test('object-valued scalar handles with get traps stay on the descriptor-based typed path',()=>{
  for(const field of ['const','bits','kind','signed']) {
    const ir=graph([createOriginSet({instructionIds:['typed:raw-scalar']})]);
    ir.values[0][field]=new Proxy({nested:1},{get(target,key,receiver){return key==='nested'?999:Reflect.get(target,key,receiver);}});
    assert.deepEqual(current({ir}),original({ir}),field);
  }
});

test('Proxy-provided array map methods cannot confer private projection ownership',()=>{
  const ir=graph([createOriginSet({instructionIds:['typed:proxy-map']})]);let reads=0;
  ir.values=new Proxy(ir.values,{get(target,key,receiver){if(key==='map'){
    reads++;return callback=>target.map(value=>new Proxy(callback(value),{get(record,name,receiver){
      return name==='kind'?'getter-value':Reflect.get(record,name,receiver);
    }}));
  }return Reflect.get(target,key,receiver);}});
  function capture(fn) {reads=0;return {result:fn({ir}),reads};}
  assert.deepEqual(capture(current),capture(original));
});
