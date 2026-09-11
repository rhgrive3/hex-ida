import test from 'node:test';
import assert from 'node:assert/strict';
import { createSemanticIrFunction as current } from '../../js/semantics/ir/function.js';
import { SEMANTIC_SETS } from '../../js/semantics/ir/common.js';
import { createSemanticIrFunction as original } from '../helpers/aggregate-speed-baseline/js/semantics/ir/function.js';
import { SEMANTIC_SETS as originalSets } from '../helpers/aggregate-speed-baseline/js/semantics/ir/common.js';
import { semanticFunction } from '../helpers/aggregate-speed-fixtures.mjs';
import { isKnownImmutableData } from '../../js/core/identity/immutable-data.js';
function outcome(fn) {try{return {value:fn()};}catch(e){return {error:e.name,message:e.message};}}

test('re-normalizing producer-owned IR preserves complete output and only reuses immutable metadata',()=>{
  const first=current(semanticFunction());assert.equal(isKnownImmutableData(first),true);
  for(let i=0;i<6;i++) {
    const next=current(first);assert.deepEqual(next,original(first));
    assert.equal(Object.isFrozen(next),true);assert.equal(Object.isFrozen(next.nodes[0].attributes),true);
    assert.notEqual(next,first); // Full field and cross-reference validation still runs.
    assert.equal(next.nodes[0].attributes,first.nodes[0].attributes);
  }
  const raw=semanticFunction(),before=current(raw);raw.nodes[0].attributes.a='changed';
  assert.notDeepEqual(current(raw),before);assert.deepEqual(current(raw),original(raw));
});

test('every work budget, invalid budget type and cancellation boundary matches the baseline',()=>{
  const input=current(semanticFunction());
  for(const key of ['maxBlocks','maxNodes','maxValues','maxReferences']) {
    for(const limit of [-1,0,1,2,3,4,5,8,20,1.5,NaN,Infinity,'1',null,undefined]) {
      const options={budget:{[key]:limit}};
      assert.deepEqual(outcome(()=>current(input,options)),outcome(()=>original(input,options)),`${key}:${limit}`);
    }
  }
  for(let cutoff=1;cutoff<24;cutoff++) {
    function capture(fn) {let reads=0;const options={signal:{get aborted(){return ++reads>=cutoff;}}};
      return {outcome:outcome(()=>fn(input,options)),reads};}
    assert.deepEqual(capture(current),capture(original),`cancellation at read ${cutoff}`);
  }
  function capture(fn){let reads=0;const options={budget:{get maxReferences(){return ++reads<3?100:1;}}};
    return {outcome:outcome(()=>fn(input,options)),reads};}
  assert.deepEqual(capture(current),capture(original));
});

test('known IR still checks current enum authority, dangling references, schema and raw cardinality',()=>{
  const input=current(semanticFunction());
  try {
    SEMANTIC_SETS.operations.delete('call');originalSets.operations.delete('call');
    assert.deepEqual(outcome(()=>current(input)),outcome(()=>original(input)));
    assert.throws(()=>current(input),/invalid-node-kind/);
  }finally{SEMANTIC_SETS.operations.add('call');originalSets.operations.add('call');}
  for(const mutate of [i=>i.schemaVersion=1,i=>i.entryBlockId='missing',
    i=>i.nodes[0].inputs=['missing'],i=>i.blocks[0].nodeIds.push('missing'),
    i=>i.nodes[0].call.arguments=['address','address']]) {
    const input=semanticFunction();mutate(input);
    assert.deepEqual(outcome(()=>current(input)),outcome(()=>original(input)));
  }
});

test('inherited optional getters keep the original captured-read behavior on canonical inputs',()=>{
  const input=current(semanticFunction());
  const old=Object.getOwnPropertyDescriptor(Object.prototype,'metadata');
  function capture(fn){let reads=0;Object.defineProperty(Object.prototype,'metadata',{
    configurable:true,get(){reads++;return {count:reads};}});
    try{return {outcome:outcome(()=>fn(input)),reads};}finally{delete Object.prototype.metadata;}}
  try {assert.deepEqual(capture(current),capture(original));}
  finally {if(old)Object.defineProperty(Object.prototype,'metadata',old);}
});

test('stateful raw accessors and shallow freezes are not promoted into the immutable read path',()=>{
  function capture(fn){const input=semanticFunction();let reads=0;const originalSummary=input.nodes[0].call;
    Object.defineProperty(input.nodes[0],'call',{enumerable:true,get(){reads++;return reads===1?originalSummary:{...originalSummary,arguments:['missing']};}});
    Object.freeze(input.nodes[0]);return {outcome:outcome(()=>fn(input)),reads};}
  assert.deepEqual(capture(current),capture(original));
});

test('budget accessors that change an inherited reference keep the original preflight snapshot',()=>{
  const input=current(semanticFunction());
  function capture(fn){let installed=false,reads=0;const options={budget:{get maxReferences(){
    if(!installed){installed=true;Object.defineProperty(Object.prototype,'accesses',{configurable:true,get(){reads++;return [{malformed:true}];}});}return 100;
  }}};
  try{return {outcome:outcome(()=>fn(input,options)),reads};}finally{delete Object.prototype.accesses;}}
  assert.deepEqual(capture(current),capture(original));
});

test('raw input copies remain detached and match sparse, custom, and getter fallbacks',()=>{
  for (const mutate of [()=>{}, i=>i.nodes[0].attributes.extra=undefined,
    i=>i.nodes[0].attributes.number=-0,i=>i.nodes[0].attributes.number=Infinity,
    i=>i.nodes[0].attributes.nested=Object.assign(Object.create(null),{x:1}),
    i=>i.nodes[0].attributes.array=[1,,3],i=>i.nodes[0].attributes.host=new Map([['x',1]]),
    i=>Object.setPrototypeOf(i.nodes[0].attributes,{inherited:true}),
    i=>i.nodes[0].attributes.array=Object.assign([1,2],{custom:true})]) {
    const input=semanticFunction();mutate(input);
    const before=structuredClone(input);assert.deepEqual(outcome(()=>current(input)),outcome(()=>original(input)));
    assert.deepEqual(structuredClone(input),before);assert.equal(Object.isFrozen(input),false);
  }
  function capture(fn) {const input=semanticFunction();let reads=0;
    Object.defineProperty(input.nodes[0].attributes,'state',{enumerable:true,get(){return ++reads;}});
    return {outcome:outcome(()=>fn(input)),reads};}
  assert.deepEqual(capture(current),capture(original));
});

test('reference and collection budget rejection precedes nested metadata reads',()=>{
  for (const budget of [{maxBlocks:1},{maxNodes:1},{maxValues:1},{maxReferences:1}]) {
    function capture(fn) {const input=semanticFunction();let reads=0;
      input.blocks.push({id:'extra',nodeIds:[],origin:input.origin});
      input.values.push({...input.values[0],id:'extra-value'});
      Object.defineProperty(input.nodes[0].attributes,'expensive',{enumerable:true,get(){reads++;throw new Error('must-not-read');}});
      return {outcome:outcome(()=>fn(input,{budget})),reads};}
    const expected=capture(original);assert.deepEqual(capture(current),expected);assert.equal(expected.reads,0);
  }
});

test('transparent and stateful Proxies preserve the one-read preflight snapshot',()=>{
  for(const field of ['inputs','call','kind','attributes']) for(const stateful of [false,true]) {
    function capture(fn) {let reads=0;const input=semanticFunction();
      input.nodes[0]=new Proxy(input.nodes[0],{get(target,key,receiver){
        if(key===field){reads++;if(stateful&&reads>1){if(field==='inputs')return ['missing'];if(field==='kind')return 'bad-op';}}
        return Reflect.get(target,key,receiver);
      }});
      return {outcome:outcome(()=>fn(input)),reads};
    }
    assert.deepEqual(capture(current),capture(original),`${field}:${stateful}`);
  }
});

test('normalization reuse cannot be issued under relaxed enums and reused under restored enums',()=>{
  let input;const raw=semanticFunction();raw.nodes[1].kind='temporary-test-operation';
  try {SEMANTIC_SETS.operations.add('temporary-test-operation');originalSets.operations.add('temporary-test-operation');
    input=current(raw);assert.deepEqual(input,original(raw));}
  finally{SEMANTIC_SETS.operations.delete('temporary-test-operation');originalSets.operations.delete('temporary-test-operation');}
  assert.deepEqual(outcome(()=>current(input)),outcome(()=>original(input)));
  assert.throws(()=>current(input),/invalid-node-kind/);
});

test('canonical normalization falls back when trim, enum methods, or transport identity changes',()=>{
  const input=current(semanticFunction()),trim=String.prototype.trim;
  try {String.prototype.trim=function(){return trim.call(this)+'!';};
    assert.deepEqual(outcome(()=>current(input)),outcome(()=>original(input)));}
  finally{String.prototype.trim=trim;}
  const currentHas=SEMANTIC_SETS.operations.has,oldHas=originalSets.operations.has;
  try {SEMANTIC_SETS.operations.has=()=>false;originalSets.operations.has=()=>false;
    assert.deepEqual(outcome(()=>current(input)),outcome(()=>original(input)));}
  finally{delete SEMANTIC_SETS.operations.has;delete originalSets.operations.has;}
  assert.equal(SEMANTIC_SETS.operations.has,currentHas);assert.equal(originalSets.operations.has,oldHas);
  function wrapped(fn){let reads=0;const transport=new Proxy(input,{get(target,key,receiver){reads++;return Reflect.get(target,key,receiver);}});
    return {outcome:outcome(()=>fn(transport)),reads};}
  assert.deepEqual(wrapped(current),wrapped(original));
});
