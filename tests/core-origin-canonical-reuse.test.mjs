import assert from 'node:assert/strict';
import test from 'node:test';
import * as candidate from '../js/core/identity/origin.js';
import * as oracle from './helpers/origin-normalization-oracle.mjs';
import { stableStringify, stableDigest } from '../js/core/identity/index.js';

const transform = (preconditions = []) => ({
  passId:' fold ', passVersion:' 1 ', ruleId:' add-zero ', proofKind:' algebraic ',
  consumedEntityIds:['é','e\u0301','z',' ä ','e1','e1'], producedEntityIds:['e2'],
  preconditions, timestampOrBuildId:'',
});
function same(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message);
  assert.equal(stableStringify(actual), stableStringify(expected), message);
  assert.equal(stableDigest(actual), stableDigest(expected), message);
}
function deeplyFrozen(value) {
  if(value == null || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for(const child of Object.values(value)) deeplyFrozen(child);
}
function resultOf(fn) {
  try { return {ok:true, value:fn()}; }
  catch(error) { return {ok:false, name:error.name, message:error.message}; }
}

test('canonical origin merges preserve content, digest, locale order, and deep immutability', () => {
  const inputs = [
    {byteRanges:[{binaryId:' bin ',offset:16n,length:4n},{start:0,end:'4'}],virtualRanges:[{imageId:' img ',sliceId:' slice ',address:'0x20',length:4}],instructionIds:['z','ä','é','e\u0301','A','a',' a ','"','\\'],bytecodeOperationIds:['op2','op1'],sourceLocations:[{file:'a.c',line:7n}],transforms:[transform([{bound:9n}])]},
    {byteRanges:[{start:2,length:1},{start:0,end:4}],virtualRanges:[{address:32n,end:36n}],operationIds:['op1'],sourceLocations:[{line:7n,file:'a.c'}],parentEntityIds:['p2','p1']},
  ];
  const branded = inputs.map(candidate.createOriginSet);
  const reference = inputs.map(oracle.createOriginSet);
  for(const sequence of [[0],[0,1],[1,0],[0,1,0],[1,0,1],[0,0,1]]) {
    const actual = candidate.mergeOriginSets(...sequence.map(i=>branded[i]));
    same(actual,oracle.mergeOriginSets(...sequence.map(i=>reference[i])),String(sequence));
    assert.ok(candidate.isCanonicalOriginSet(actual));
    deeplyFrozen(actual);
  }
  same(candidate.mergeOriginSets(),oracle.mergeOriginSets());
  same(candidate.mergeOriginSets(null,undefined),oracle.mergeOriginSets(null,undefined));
  same(candidate.appendTransform(branded[0],transform()),oracle.appendTransform(reference[0],transform()));
});

test('equal serialization keys keep the last value, not the first or a cached peer', () => {
  for(const pair of [[-0,0],[0,-0]]) {
    const inputs = pair.map(zero=>({sourceLocations:[{zero}],transforms:[transform([{zero}])]}));
    const merged=candidate.mergeOriginSets(...inputs.map(candidate.createOriginSet));
    same(merged,oracle.mergeOriginSets(...inputs.map(oracle.createOriginSet)));
    assert.ok(Object.is(merged.sourceLocations[0].zero,pair[1]));
    assert.ok(Object.is(merged.transforms[0].preconditions[0].zero,pair[1]));
  }
});

test('unbranded, shallow-frozen, cloned and proxy inputs still cross normalization', () => {
  const location={line:1}, proof={bound:2};
  const raw=Object.freeze({sourceLocations:[location],transforms:[Object.freeze(transform([proof]))]});
  const first=candidate.createOriginSet(raw);
  location.line=3; proof.bound=4;
  const second=candidate.createOriginSet(raw);
  assert.equal(first.sourceLocations[0].line,1);
  assert.equal(first.transforms[0].preconditions[0].bound,2);
  same(second,oracle.createOriginSet(raw));
  assert.equal(second.sourceLocations[0].line,3);
  for(const copy of [structuredClone(first),{...first},new Proxy(first,{})]) {
    assert.equal(candidate.isCanonicalOriginSet(copy),false);
    assert.notEqual(candidate.createOriginSet(copy),copy);
    same(candidate.createOriginSet(copy),oracle.createOriginSet(copy));
  }
  location.line=Infinity;
  assert.throws(()=>candidate.createOriginSet(raw),/identity-non-finite-number/);
  assert.throws(()=>candidate.mergeOriginSets(first,raw),/identity-non-finite-number/);
});

test('branded transform reuse does not confer trust on frozen transform-shaped objects', () => {
  const value=candidate.createTransformRecord(transform([{bound:7n}]));
  assert.equal(candidate.createTransformRecord(value),value);
  deeplyFrozen(value);
  for(const copy of [{...value},structuredClone(value),new Proxy(value,{})]) {
    const normalized=candidate.createTransformRecord(copy);
    assert.notEqual(normalized,copy);
    same(normalized,oracle.createTransformRecord(copy));
  }
  const proof={bound:1};
  const shallow=Object.freeze(transform([proof]));
  candidate.createTransformRecord(shallow);
  proof.bound=Infinity;
  assert.throws(()=>candidate.createTransformRecord(shallow),/identity-non-finite-number/);
});

test('invalid types, numbers, cycles and range identities retain exact errors', () => {
  const cycle={}; cycle.self=cycle;
  const values = [false,1,'set',[],{byteRanges:1},{byteRanges:[null]},{byteRanges:[{start:0,length:-1}]},
    {byteRanges:[{start:0,length:1,binaryId:7}]},{virtualRanges:[{start:'0x1',end:'0x0'}]},
    {virtualRanges:[{start:1,length:2,sliceId:' '}]},{instructionIds:[7]},{operationIds:[' ']},
    {parentEntityIds:{}},{sourceLocations:[{line:Infinity}]},{sourceLocations:[{line:NaN}]},
    {sourceLocations:[{line:2**53}]},{sourceLocations:[cycle]},{sourceLocations:[new Date(NaN)]},
    {transforms:[{}]},{transforms:[transform([Infinity])]},{transforms:[transform([cycle])]},
    {transforms:[{...transform(),consumedEntityIds:[null]}]},
    {sourceLocations:new Array(2)},
  ];
  for(const value of values) {
    assert.deepEqual(resultOf(()=>candidate.createOriginSet(value)),resultOf(()=>oracle.createOriginSet(value)));
    assert.deepEqual(resultOf(()=>candidate.mergeOriginSets(candidate.createOriginSet(),value)),resultOf(()=>oracle.mergeOriginSets(oracle.createOriginSet(),value)));
  }
});

test('getter evaluation order and mutable input reads are unchanged', () => {
  function input(log) {
    const range={get start(){log.push('range.start');return 1n;},get length(){log.push('range.length');return 2n;}};
    const location={get z(){log.push('location.z');return 9;},get a(){log.push('location.a');return 1;}};
    const record={...transform(),get preconditions(){log.push('preconditions');return [location];}};
    return {
      get byteRanges(){log.push('byteRanges');return [range];},
      get virtualRanges(){log.push('virtualRanges');return [];},
      get transforms(){log.push('transforms');return [record];},
      get instructionIds(){log.push('instructionIds');return ['i'];},
      get operationIds(){log.push('operationIds');return ['op'];},
      get sourceLocations(){log.push('sourceLocations');return [location];},
      get parentEntityIds(){log.push('parentEntityIds');return ['p'];},
    };
  }
  for(const operation of ['createOriginSet','mergeOriginSets']) {
    const actualReads=[], expectedReads=[];
    same(candidate[operation](input(actualReads)),oracle[operation](input(expectedReads)));
    assert.deepEqual(actualReads,expectedReads);
  }
});

test('__proto__ and inherited setter/read-only keys remain safe after repeated merges', () => {
  for(const descriptor of [{set(){throw new Error('inherited setter invoked');},configurable:true},{value:99,writable:false,configurable:true}]) {
    const key='originCanonicalReuseHostile';
    const prior=Object.getOwnPropertyDescriptor(Object.prototype,key);
    Object.defineProperty(Object.prototype,key,descriptor);
    try {
      const raw=JSON.parse(`{"__proto__":{"polluted":true},"${key}":7}`);
      const input={sourceLocations:[raw],transforms:[transform([raw])]};
      const original=candidate.createOriginSet(input);
      same(candidate.mergeOriginSets(original,original),oracle.mergeOriginSets(input,input));
      assert.equal(Object.getPrototypeOf(original.sourceLocations[0]),Object.prototype);
      assert.equal(Object.hasOwn(original.sourceLocations[0],'__proto__'),true);
      assert.equal(Object.hasOwn(original.sourceLocations[0],key),true);
      assert.equal({}.polluted,undefined);
    } finally {
      if(prior) Object.defineProperty(Object.prototype,key,prior); else delete Object.prototype[key];
    }
  }
});

test('Map, Set, Date, bytes and nested mutable payloads are captured, not trusted', () => {
  const map=new Map([['ä',1],['z',2]]), set=new Set(['é','e\u0301']), bytes=new Uint8Array([1,2]);
  const source={map,set,bytes,date:new Date('2020-01-01T00:00:00Z'),nested:[{zero:-0,exact:2n}]};
  const input={sourceLocations:[source],transforms:[transform([source])]};
  const initial=candidate.createOriginSet(input);
  same(initial,oracle.createOriginSet(input));
  bytes[0]=8; map.set('z',9); set.add('added'); source.nested[0].exact=4n;
  const later=candidate.createOriginSet(input);
  same(later,oracle.createOriginSet(input));
  assert.notEqual(stableStringify(initial),stableStringify(later));
  same(candidate.mergeOriginSets(initial,later,initial),oracle.mergeOriginSets(initial,later,initial));
});

test('seeded differential merges preserve every field and digest', () => {
  let seed=0x5eed1234;
  const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  const names=['z','ä','é','e\u0301','a','A','i10','i2','日本','\\','"'];
  const pick=()=>names[next()%names.length];
  for(let iteration=0;iteration<120;iteration++) {
    const inputs=[];
    for(let n=0;n<3;n++) {
      const start=next()%20;
      inputs.push({
        byteRanges:[{start,length:next()%5},{start:BigInt(start),length:1n}],
        virtualRanges:[{address:BigInt(start),length:4n}],
        instructionIds:[pick(),pick(),pick()],operationIds:[pick(),pick()],parentEntityIds:[pick()],
        sourceLocations:[{file:pick(),line:next()%20},{zero:next()%2?-0:0,exact:BigInt(next())}],
        transforms:[transform([{file:pick(),line:next()%20}])],
      });
    }
    const actual=inputs.map(candidate.createOriginSet), expected=inputs.map(oracle.createOriginSet);
    let a=candidate.mergeOriginSets(...actual), b=oracle.mergeOriginSets(...expected);
    for(let n=0;n<3;n++) {
      a=candidate.mergeOriginSets(a,actual[n]); b=oracle.mergeOriginSets(b,expected[n]);
      same(a,b,`seeded case ${iteration}/${n}`);
    }
  }
});

test('inherited JSON hooks cannot leave stale keys, including after the hook is removed', () => {
  for(const prototype of [Object.prototype,Array.prototype]) {
    const prior=Object.getOwnPropertyDescriptor(prototype,'toJSON');
    const input={sourceLocations:prototype===Object.prototype?[{x:1},{x:2}]:[[1],[2]]};
    const original=candidate.createOriginSet(input), reference=oracle.createOriginSet(input);
    let underHook,referenceUnderHook;
    Object.defineProperty(prototype,'toJSON',{configurable:true,get(){return function(){return 'same-key';};}});
    try {
      same(candidate.mergeOriginSets(original,original),oracle.mergeOriginSets(reference,reference));
      underHook=candidate.createOriginSet(input);
      referenceUnderHook=oracle.createOriginSet(input);
    } finally {
      if(prior) Object.defineProperty(prototype,'toJSON',prior); else delete prototype.toJSON;
    }
    same(candidate.mergeOriginSets(underHook,original),oracle.mergeOriginSets(referenceUnderHook,reference));
  }
});

test('custom array mappers cannot brand shallow-frozen proof payloads as reusable', () => {
  function input() {
    const nested={line:1}, external=Object.freeze({nested}), preconditions=[];
    Object.defineProperty(preconditions,'map',{value:()=>external});
    return {nested,record:transform(preconditions)};
  }
  const actualInput=input(), expectedInput=input();
  const actual=candidate.createTransformRecord(actualInput.record);
  const expected=oracle.createTransformRecord(expectedInput.record);
  same(actual,expected);
  assert.notEqual(candidate.createTransformRecord(actual),actual);
  actualInput.nested.line=Infinity; expectedInput.nested.line=Infinity;
  assert.deepEqual(resultOf(()=>candidate.createTransformRecord(actual)),resultOf(()=>oracle.createTransformRecord(expected)));
  assert.throws(()=>candidate.createOriginSet({transforms:[actual]}),/identity-non-finite-number/);
});

test('custom field mappers still revalidate invalid ranges and numbers during a merge', () => {
  for(const [field,value] of [['byteRanges',{}],['virtualRanges',{}],['sourceLocations',{line:Infinity}],['transforms',{}]]) {
    const values=[];
    Object.defineProperty(values,'map',{value:()=>[Object.freeze(value)]});
    const actual=candidate.createOriginSet({[field]:values}), expected=oracle.createOriginSet({[field]:values});
    assert.deepEqual(resultOf(()=>candidate.mergeOriginSets(actual)),resultOf(()=>oracle.mergeOriginSets(expected)));
    assert.equal(resultOf(()=>candidate.mergeOriginSets(actual)).ok,false);
  }
});

test('accessor-bearing normalized payloads replay getter reads instead of caching them', () => {
  function input(log) {
    const external=Object.freeze({get line(){log.push('line');return log.length;}});
    const location=[];
    Object.defineProperty(location,'map',{value:()=>external});
    return {sourceLocations:[location]};
  }
  const actualReads=[],expectedReads=[];
  const actual=candidate.createOriginSet(input(actualReads)), expected=oracle.createOriginSet(input(expectedReads));
  const merged=candidate.mergeOriginSets(actual), reference=oracle.mergeOriginSets(expected);
  same(merged,reference);
  assert.deepEqual(actualReads,expectedReads);
  assert.equal(Object.getOwnPropertyDescriptor(merged.sourceLocations[0],'line').get,undefined);
});

test('noncanonical mapper output is re-normalized, including key order and array extras', () => {
  const objects=[Object.freeze({z:1,a:2}),Object.freeze({a:undefined}),Object.freeze([undefined]),Object.freeze(Object.assign([1],{extra:2}))];
  for(const value of objects) {
    const location=[];
    Object.defineProperty(location,'map',{value:()=>value});
    const input={sourceLocations:[location]};
    const actual=candidate.mergeOriginSets(candidate.createOriginSet(input));
    const expected=oracle.mergeOriginSets(oracle.createOriginSet(input));
    same(actual,expected);
    assert.equal(JSON.stringify(actual),JSON.stringify(expected));
  }
});


test('sparse frozen payloads still validate subsequently inherited numeric values', () => {
  const actual=candidate.createTransformRecord(transform(new Array(32)));
  const expected=oracle.createTransformRecord(transform(new Array(32)));
  Object.defineProperty(Array.prototype,'31',{value:Infinity,writable:true,configurable:true});
  try {
    assert.deepEqual(resultOf(()=>candidate.createTransformRecord(actual)),resultOf(()=>oracle.createTransformRecord(expected)));
    assert.throws(()=>candidate.createTransformRecord(actual),/identity-non-finite-number/);
  } finally {
    delete Array.prototype[31];
  }
});
