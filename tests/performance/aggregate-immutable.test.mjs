import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonSafe, stableStringify, stableDigest, deepFreeze } from '../../js/core/identity/index.js';
import { fnv64Text, fnv64TextDigest } from '../../js/core/identity/fnv64.js';
import { isDeeplyFrozenPlainData, isKnownImmutableData, isKnownCanonicalJsonData,
  ordinaryJsonBehavior, ordinaryDataPrototypes } from '../../js/core/identity/immutable-data.js';
import { serializable, serializableForFrozenOutput } from '../../js/semantics/ir/common.js';
import * as original from '../helpers/aggregate-speed-baseline/js/core/identity/index.js';

function outcome(fn) {
  try { return { value: fn() }; } catch (e) { return { error: e.name, message: e.message }; }
}
function certify(value) { deepFreeze(value); isDeeplyFrozenPlainData(value); return value; }
function compare(value) {
  for (let i=0;i<3;i++) assert.deepEqual(outcome(()=>stableDigest(value)),outcome(()=>original.stableDigest(value)));
  assert.deepEqual(jsonSafe(value), original.jsonSafe(value));
  assert.equal(stableStringify(value), original.stableStringify(value));
}

test('paired FNV traversal preserves both full 64-bit lanes and all UTF-16 units', () => {
  const allUnits = Array.from({length:65536}, (_,i)=>String.fromCharCode(i)).join('');
  let rng=0x7583925f; const random=()=>{rng^=rng<<13;rng^=rng>>>17;rng^=rng<<5;return rng>>>0;};
  for (const text of ['', 'abc\0日本語😀\ud800\udfff', allUnits,
    ...Array.from({length:600},()=>Array.from({length:random()%300},()=>String.fromCharCode(random()&65535)).join(''))]) {
    assert.equal(fnv64TextDigest(text), fnv64Text(text)+fnv64Text(text,0xcbf29ce4,0x84222325));
  }
});

test('immutable eligibility accepts only acyclic own plain data and never a shallow freeze', () => {
  for (const value of [certify({a:[1,'2',null,true],b:{x:4n}}), certify(Object.assign(Object.create(null),{n:-0}))]) {
    assert.equal(isKnownImmutableData(value),true); compare(value);
  }
  const shallow=Object.freeze({child:{n:1}}); assert.equal(isDeeplyFrozenPlainData(shallow),false);
  const before=stableDigest(shallow);shallow.child.n=2;assert.notEqual(stableDigest(shallow),before);compare(shallow);
  Object.freeze(shallow.child);assert.equal(isDeeplyFrozenPlainData(shallow),true);compare(shallow);
  for (const bad of [Object.freeze(new Map([['a',1]])),Object.freeze(new Set([1])),Object.freeze(new Date(0)),
    Object.freeze([1,,3]),Object.freeze({n:NaN}),Object.freeze({n:Infinity}),
    Object.freeze({[Symbol('x')]:1}),Object.freeze(Object.create({custom:true})),
    Object.freeze(Object.defineProperty({},'hidden',{value:1}))]) {
    assert.equal(isDeeplyFrozenPlainData(bad),false);assert.equal(isKnownImmutableData(bad),false);
  }
  const cycle={};cycle.self=cycle;Object.freeze(cycle);assert.equal(isDeeplyFrozenPlainData(cycle),false);
  let gets=0; const getter=Object.freeze(Object.defineProperty({},'a',{enumerable:true,get(){gets++;return 1;}}));
  assert.equal(isDeeplyFrozenPlainData(getter),false);assert.equal(gets,0);
});

test('frozen-output reuse is restricted to exact JSON normalization and public copying remains fresh', () => {
  const value=certify(jsonSafe({z:1,a:{m:2},list:[-0,null,'日本語']}));
  assert.equal(isKnownCanonicalJsonData(value),true);
  assert.equal(serializableForFrozenOutput(value,'invalid'),value);
  const copied=serializable(value,'invalid');assert.notEqual(copied,value);assert.equal(Object.isFrozen(copied),false);
  copied.a.m=42;assert.equal(value.a.m,2);compare(value);
  for (const raw of [{z:1,a:2},{b:1n},Object.assign(Object.create(null),{x:1})]) {
    const input=certify(raw);assert.equal(isKnownCanonicalJsonData(input),false);
    const output=serializableForFrozenOutput(input,'invalid');assert.notEqual(output,input);
    assert.deepEqual(output,original.jsonSafe(input));
  }
  const numeric=certify(original.jsonSafe({'10':10,'2':2,'4294967295':1,'01':1,'a':1}));
  assert.equal(isKnownCanonicalJsonData(numeric),true);
});

test('cached digest and normalization follow inherited toJSON changes without poisoning later reuse', () => {
  const value=certify(jsonSafe({a:[1,2],b:{x:'old'}}));compare(value);
  const descriptor=Object.getOwnPropertyDescriptor(Object.prototype,'toJSON');
  try {
    Object.defineProperty(Object.prototype,'toJSON',{configurable:true,value(){return Object.hasOwn(this,'x')?'replacement':this;}});
    assert.equal(ordinaryJsonBehavior(),false);compare(value);
    assert.notEqual(serializableForFrozenOutput(value,'invalid'),value);
  } finally { if(descriptor)Object.defineProperty(Object.prototype,'toJSON',descriptor);else delete Object.prototype.toJSON; }
  assert.equal(ordinaryJsonBehavior(),true);compare(value);
});

test('eligibility guards do not invoke replaced map or stringify accessors', () => {
  const value=certify(jsonSafe({a:[1,2]}));compare(value);
  for (const [target,key] of [[Array.prototype,'map'],[JSON,'stringify']]) {
    const descriptor=Object.getOwnPropertyDescriptor(target,key);let reads=0;
    try {
      Object.defineProperty(target,key,{configurable:true,get(){reads++;return descriptor.value;}});
      assert.equal(ordinaryJsonBehavior(),false);assert.equal(reads,0);
      reads=0;const expected=original.stableDigest(value), oldReads=reads;
      reads=0;const actual=stableDigest(value);assert.equal(actual,expected);assert.equal(reads,oldReads);
    } finally { Object.defineProperty(target,key,descriptor); }
  }
});

test('normalization replays custom array methods and species, without trusting a freeze', () => {
  const value=certify(jsonSafe({a:[1,2]}));
  const map=Array.prototype.map;
  try {
    Array.prototype.map=function(fn,...rest){return map.call(this,fn,...rest).concat('extra');};
    assert.equal(ordinaryJsonBehavior(),false);
    assert.deepEqual(serializableForFrozenOutput(value,'invalid'),serializable(value,'invalid'));
    assert.equal(stableDigest(value),original.stableDigest(value));
  } finally {Array.prototype.map=map;}
  const species=Object.getOwnPropertyDescriptor(Array,Symbol.species);
  try {
    Object.defineProperty(Array,Symbol.species,{configurable:true,get(){return class extends Array {};}});
    assert.equal(ordinaryJsonBehavior(),false);
    assert.equal(stableDigest(value),original.stableDigest(value));
  } finally {Object.defineProperty(Array,Symbol.species,species);}
});

test('prototype snapshot detects added, replaced and non-enumerable inherited properties', () => {
  assert.equal(ordinaryDataPrototypes(),true);
  for (const [target,key] of [[Object.prototype,'__aggregateOptional__'],[Array.prototype,'__aggregateOptional__']]) {
    let reads=0;
    try {
      Object.defineProperty(target,key,{configurable:true,get(){reads++;return null;}});
      assert.equal(ordinaryDataPrototypes(),false);assert.equal(reads,0);
    } finally {delete target[key];}
  }
  assert.equal(ordinaryDataPrototypes(),true);
});

test('mutable host containers remain on the original digest path even when their shells are frozen', () => {
  for (const [host,mutate] of [[new Map([['x',1]]),v=>v.set('x',2)],
    [new Set([1]),v=>v.add(2)],[new Date(0),v=>v.setTime(1000)]]) {
    Object.freeze(host);const value=Object.freeze({host});assert.equal(isDeeplyFrozenPlainData(value),false);
    const before=stableDigest(value);mutate(host);assert.notEqual(stableDigest(value),before);compare(value);
  }
});

test('JSON normalization returns fresh mutable trees, exact key descriptors and preserves signed zero',()=>{
  const inputs=[{z:1,a:{x:[1,2]}},JSON.parse('{"__proto__":{"x":1},"constructor":2,"10":10,"2":2}'),
    {zero:-0,nested:[-0]},Object.assign(Object.create(null),{z:1,a:2}),{big:123456789123456789n}];
  for(const raw of inputs){const value=certify(raw),expected=original.jsonSafe(value);
    for(let i=0;i<4;i++){const actual=jsonSafe(value);assert.deepEqual(actual,expected);
      assert.deepEqual(Object.getOwnPropertyDescriptors(actual),Object.getOwnPropertyDescriptors(expected));
      assert.notEqual(actual,value);assert.equal(Object.isFrozen(actual),false);actual.extra='changed';}
    compare(value);
  }
});

test('explicit JSON traversal state keeps its read/add/delete and cycle behavior',()=>{
  const value=certify({a:[1,2]});jsonSafe(value);jsonSafe(value);
  function capture(fn){const events=[],real=new WeakSet(),seen={
    has(v){events.push('has');return real.has(v);},add(v){events.push('add');real.add(v);},delete(v){events.push('delete');real.delete(v);}};
    return {value:fn(value,seen),events};}
  assert.deepEqual(capture(jsonSafe),capture(original.jsonSafe));
  assert.throws(()=>jsonSafe(value,new WeakSet([value])),/identity-cyclic-value/);
});

test('cached normalization cannot hide changed BigInt conversion or nonstandard text hashing',()=>{
  const value=certify({big:99n});compare(value);
  const bigint=Object.getOwnPropertyDescriptor(BigInt.prototype,'toString');
  try{BigInt.prototype.toString=function(){return 'custom';};assert.equal(ordinaryJsonBehavior(),false);compare(value);}
  finally{Object.defineProperty(BigInt.prototype,'toString',bigint);}
  const descriptor=Object.getOwnPropertyDescriptor(String.prototype,'charCodeAt');
  try {let calls=0;String.prototype.charCodeAt=function(i){calls++;return descriptor.value.call(this,i);};
    const actual=fnv64TextDigest('hello');assert.equal(calls,10);
    calls=0;assert.equal(actual,fnv64Text('hello')+fnv64Text('hello',0xcbf29ce4,0x84222325));assert.equal(calls,10);
  }finally{Object.defineProperty(String.prototype,'charCodeAt',descriptor);}
});

test('digest memoization does not suppress changed number, padding, or multiplication intrinsics',()=>{
  const value=certify({a:[1,2,3]});compare(value);
  const number=Number.prototype.toString,pad=String.prototype.padStart,imul=Math.imul;
  try {Number.prototype.toString=function(radix){return number.call(this,radix)+'x';};compare(value);}
  finally {Number.prototype.toString=number;}
  try {String.prototype.padStart=function(...args){return pad.apply(this,args)+'x';};compare(value);}
  finally {String.prototype.padStart=pad;}
  try {Math.imul=(a,b)=>imul(a,b)^1;compare(value);}
  finally {Math.imul=imul;}
});

test('string-only normalization may share immutable children without changing public copies or getter ordering',()=>{
  const child=certify(jsonSafe({nested:[{a:1,b:2}],signed:-0}));
  for(const root of [child,{z:child,a:child},Object.assign(Object.create(null),{child,large:3n}),[child,child]]) {
    for(let i=0;i<3;i++){assert.equal(stableStringify(root),original.stableStringify(root));compare(root);}
    const actual=jsonSafe(root),expected=original.jsonSafe(root);assert.deepEqual(actual,expected);
    assert.notEqual(Array.isArray(actual)?actual[0]:actual,child);
  }
  function capture(fn) {let reads=0;const input={child};
    Object.defineProperty(input,'late',{enumerable:true,get(){reads++;return reads;}});
    return {value:fn(input),reads};}
  assert.deepEqual(capture(stableStringify),capture(original.stableStringify));
  function altered(fn) {const input={child};Object.defineProperty(input,'late',{enumerable:true,get(){
    Object.defineProperty(Object.prototype,'toJSON',{configurable:true,value(){return Object.hasOwn(this,'nested')?'changed':this;}});return 1;
  }});try{return fn(input);}finally{delete Object.prototype.toJSON;}}
  assert.equal(altered(stableStringify),altered(original.stableStringify));
});

test('whole-root JSON text reuse preserves detached copies and rechecks changed JSON methods',()=>{
  const input=certify(jsonSafe({large:'あ'.repeat(300000),a:{b:1},zero:-0}));
  for(let i=0;i<3;i++)assert.equal(stableStringify(input),original.stableStringify(input));
  const small=certify({a:{b:1}});stableStringify(small);stableStringify(small);
  const stringify=JSON.stringify;
  try {JSON.stringify=(...args)=>stringify(...args)+'changed';
    assert.equal(stableStringify(small),original.stableStringify(small));
  }finally{JSON.stringify=stringify;}
  const copy=jsonSafe(small);assert.notEqual(copy,small);assert.notEqual(copy.a,small.a);
  copy.a.b=9;assert.equal(small.a.b,1);assert.equal(stableStringify(small),original.stableStringify(small));
});

test('fused digest deopts for stateful arithmetic and formatting hooks',()=>{
  const imul=Math.imul,number=Number.prototype.toString,pad=String.prototype.padStart;
  for(const hook of ['imul','number','pad']) {
    function capture(fn) {let calls=0;
      if(hook==='imul')Math.imul=(a,b)=>imul(a,b)^(++calls%2);
      if(hook==='number')Number.prototype.toString=function(...args){calls++;return number.apply(this,args)+calls;};
      if(hook==='pad')String.prototype.padStart=function(...args){calls++;return pad.apply(this,args)+calls;};
      try {return {result:fn('日本語:stateful'),calls};}
      finally {Math.imul=imul;Number.prototype.toString=number;String.prototype.padStart=pad;}
    }
    const old=text=>fnv64Text(text)+fnv64Text(text,0xcbf29ce4,0x84222325);
    assert.deepEqual(capture(fnv64TextDigest),capture(old),hook);
  }
});


test('undefined remains immutable and follows existing JSON object/array behavior',()=>{
  for(const raw of [{a:undefined,b:1},[undefined,null,1],{b:[undefined],a:{u:undefined}}]){
    const value=certify(raw);assert.equal(isKnownImmutableData(value),true);compare(value);
    assert.deepEqual(serializableForFrozenOutput(value,'invalid'),serializable(value,'invalid'));
    const copy=jsonSafe(value);assert.notEqual(copy,value);
  }
});
