import test from 'node:test';
import assert from 'node:assert/strict';
import { deepFreeze, jsonSafe } from '../../js/core/identity/index.js';
import { isDeeplyFrozenPlainData, isKnownImmutableData } from '../../js/core/identity/immutable-data.js';
import { canonicalMemorySsaDigest as current, canonicalMemorySsaPayload } from '../../js/semantics/memoryssa/proof.js';
import { canonicalMemorySsaDigest as original } from '../helpers/aggregate-speed-baseline/js/semantics/memoryssa/proof.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { buildMemorySsa, isCanonicalMemorySsaProducerArtifact } from '../../js/semantics/memoryssa/build.js';
import { semanticFunction } from '../helpers/aggregate-speed-fixtures.mjs';
function certify(value){deepFreeze(value);isDeeplyFrozenPlainData(value);return value;}
function completePayload(){return {...canonicalMemorySsaPayload(null),definitions:[{id:'d1',value:42}],snapshotId:'snapshot:one'};}

test('MemorySSA producer publications retain exact digest and independent authority',()=>{
  const ir=createSemanticIrFunction(semanticFunction());
  const cfg=createSemanticCfg({functionId:ir.functionId,entryBlockId:ir.entryBlockId,blocks:[{id:'entry',successors:[]}]});
  const artifact=buildMemorySsa(ir,cfg,{snapshotId:'snapshot:aggregate'});
  assert.equal(isCanonicalMemorySsaProducerArtifact(artifact),true);
  assert.equal(isKnownImmutableData(artifact),true);
  for(let i=0;i<8;i++){assert.equal(current(artifact),original(artifact));assert.equal(current(artifact),artifact.canonicalDigest);}
  const transported=certify(jsonSafe(artifact));
  assert.equal(current(transported),original(transported));
  assert.equal(isCanonicalMemorySsaProducerArtifact(transported),false);
});

test('immutable data certification cannot conceal changed mutable MemorySSA payloads',()=>{
  const payload=completePayload();Object.freeze(payload);
  assert.equal(isDeeplyFrozenPlainData(payload),false);
  const before=current(payload);payload.definitions[0].value=43;
  assert.notEqual(current(payload),before);assert.equal(current(payload),original(payload));
  const cloned=certify({...payload,definitions:payload.definitions.map(d=>({...d}))});
  assert.equal(current(cloned),original(cloned));
});

test('missing payload properties never cache mutable inherited defaults',()=>{
  for(const missing of Object.keys(canonicalMemorySsaPayload(null))){
    const payload=completePayload();delete payload[missing];certify(payload);
    const before=current(payload);assert.equal(before,original(payload));
    const descriptor=Object.getOwnPropertyDescriptor(Object.prototype,missing);
    try {
      Object.defineProperty(Object.prototype,missing,{configurable:true,value:'inherited-change'});
      assert.notEqual(current(payload),before,missing);assert.equal(current(payload),original(payload),missing);
    }finally{if(descriptor)Object.defineProperty(Object.prototype,missing,descriptor);else delete Object.prototype[missing];}
    assert.equal(current(payload),before);
  }
});

test('complete own payload caches remain independent from prototypes, toJSON falls back',()=>{
  const payload=certify(completePayload()),before=current(payload);
  try {
    Object.defineProperty(Object.prototype,'snapshotId',{value:'inherited',configurable:true});
    assert.equal(current(payload),before);assert.equal(current(payload),original(payload));
    Object.defineProperty(Object.prototype,'toJSON',{configurable:true,value(){return 'hook';}});
    assert.equal(current(payload),original(payload));assert.notEqual(current(payload),before);
  }finally{delete Object.prototype.snapshotId;delete Object.prototype.toJSON;}
  assert.equal(current(payload),before);
});

test('accessor-backed MemorySSA transport is not cached and preserves field read counts',()=>{
  function capture(fn){let reads=0;const value=completePayload();
    Object.defineProperty(value,'snapshotId',{enumerable:true,get(){return `snapshot:${++reads}`;}});Object.freeze(value);
    assert.equal(isDeeplyFrozenPlainData(value),false);
    return {digests:[fn(value),fn(value),fn(value)],reads};}
  assert.deepEqual(capture(current),capture(original));
});
