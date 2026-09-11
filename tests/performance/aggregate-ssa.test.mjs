import test from 'node:test';
import assert from 'node:assert/strict';
import { createSemanticSsaContract as scalar } from '../../js/semantics/ssa/contract.js';
import { createMemorySsaContract as memory } from '../../js/semantics/memoryssa/contract.js';
import { createSemanticSsaContract as oldScalar } from '../helpers/aggregate-speed-baseline/js/semantics/ssa/contract.js';
import { createMemorySsaContract as oldMemory } from '../helpers/aggregate-speed-baseline/js/semantics/memoryssa/contract.js';
import { deepFreeze, stableDigest, jsonSafe } from '../../js/core/identity/index.js';
import { stableDigest as oldDigest } from '../helpers/aggregate-speed-baseline/js/core/identity/index.js';
import { isDeeplyFrozenPlainData, isKnownImmutableData } from '../../js/core/identity/immutable-data.js';
const origin = () => ({ instructionIds:['instruction:ssa'] });
const proof = () => ({ z: [1, { a: '日本語', b: 3n }], a: { nullable:null, omitted:undefined } });
function scalarInput() { return { functionId:'f', definitions:[{definitionId:'d',valueId:'v',kind:'entry',blockId:'entry',origin:origin(),proof:proof()}], uses:[{useId:'u',valueId:'v',blockId:'entry',sourceEntityId:'node',origin:origin(),proof:proof()}] }; }
function memoryInput() { return { functionId:'f', regions:[{id:'r',kind:'stack-fixed',functionId:'f',offset:0,metadata:proof()}], definitions:[{id:'d',kind:'entry',regionId:'r',blockId:'entry',origin:origin(),proof:proof(),effectSummary:proof()}], uses:[{id:'u',regionId:'r',reachingDefinitionId:'d',blockId:'entry',sourceEntityId:'node',origin:origin()}] }; }
function capture(fn,input,options={}) { try { return {value:fn(input,options)}; } catch(error) {return {error:{name:error.name,message:error.message,code:error.code,status:error.status}};} }
for (const [name, current, original, fixture, keys] of [
  ['scalar',scalar,oldScalar,scalarInput,['contractVersion','functionId','definitions','uses']],
  ['memory',memory,oldMemory,memoryInput,['contractVersion','functionId','regions','definitions','uses']],
]) {
  test(`${name} SSA frozen publications retain canonical output and revalidation`,()=>{
    const input=fixture(),result=current(input);assert.deepEqual(result,original(input));
    assert.equal(isKnownImmutableData(result),true);
    assert.equal(stableDigest(result),oldDigest(result));
    const next=Object.fromEntries(keys.map(key=>[key,result[key]]));
    for(let i=0;i<4;i++)assert.deepEqual(current(next),original(next));
    input.definitions[0].proof.z[1].a='changed';assert.notEqual(result.definitions[0].proof.z[1].a,'changed');
    const copy=jsonSafe(result);copy.definitions[0].proof.z[1].a='detached';assert.notEqual(result.definitions[0].proof.z[1].a,'detached');
  });
  test(`${name} SSA frozen proof reuse keeps getter reads and prototype hooks`,()=>{
    function withGetter(fn){let reads=0;const input=fixture();Object.defineProperty(input.definitions[0],'proof',{enumerable:true,get(){reads++;return {count:reads};}});const result=fn(input);return {result,reads};}
    assert.deepEqual(withGetter(current),withGetter(original));
    const input=fixture();input.definitions[0].proof=jsonSafe(proof());deepFreeze(input.definitions[0].proof);isDeeplyFrozenPlainData(input.definitions[0].proof);
    assert.deepEqual(current(input),original(input));
    const previous=Object.getOwnPropertyDescriptor(Object.prototype,'toJSON');
    try { Object.defineProperty(Object.prototype,'toJSON',{configurable:true,value(){return 'hook';}});assert.deepEqual(current(input),original(input)); }
    finally { if(previous)Object.defineProperty(Object.prototype,'toJSON',previous);else delete Object.prototype.toJSON; }
  });
  test(`${name} SSA duplicate, budget, cancellation and CFG checks are unchanged`,()=>{
    const cases=[
      [fixture(),{signal:{aborted:true}}], [fixture(),{cfg:{functionId:'foreign',blocks:[]}}],
      [fixture(),{budget:{maxDefinitions:0}}],
    ];
    const duplicate=fixture();duplicate.definitions.push({...duplicate.definitions[0]});cases.push([duplicate,{}]);
    const excessive=fixture();excessive.uses.push({...excessive.uses[0],useId:'u2',id:'u2'});cases.push([excessive,{budget:{maxUses:1}}]);
    if(name==='memory')cases.push([fixture(),{budget:{maxWorkItems:1}}],[fixture(),{deadline:1}]);
    else cases.push([fixture(),{budget:{maxLinks:0}}]);
    for(const [input,options]of cases){const got=capture(current,input,options);assert.ok(got.error);assert.deepEqual(got,capture(original,input,options));}
    function cancellation(fn){let reads=0;return {...capture(fn,fixture(),{signal:{get aborted(){return ++reads>8;}}}),reads};}
    assert.deepEqual(cancellation(current),cancellation(original));
  });
}
