import test from 'node:test';
import assert from 'node:assert/strict';
import { queryMemoryEquivalence, isAdoptableMemoryEquivalence } from '../../../js/symbolic/index.js';
import {pairedStores,E} from './symbolic-footprint-fixtures.mjs';
for (const bits of [32,64]) test(`${bits}-bit symbolic store chain proves every terminal address through public API`,async()=>{
  const {request}=pairedStores(bits);
  const result=await queryMemoryEquivalence(request);
  assert.equal(result.verdict,'proved',result.reason);
  assert.equal(result.scope.proofMode,'symbolic-writes');
  assert.equal(result.scope.addressCoverage,'all-addresses');
  assert.ok(result.scope.observedAddressTerms.every(term=>term.sort.width===bits));
  assert.equal(result.scope.observedAddresses.length,0);
  assert.equal(result.metrics.observedBytes,4);
  assert.ok(result.metrics.solverCalls>0);
  assert.equal(isAdoptableMemoryEquivalence(result,request),true);
});
test('reordered symbolic stores refute when aliasing and prove under a disjoint precondition',async()=>{
  const {request,p,q}=pairedStores(64,true);
  const refuted=await queryMemoryEquivalence(request);
  assert.equal(refuted.verdict,'refuted',refuted.reason);
  assert.equal(refuted.firstDivergence?.kind,'memory-byte');
  assert.equal(typeof refuted.firstDivergence.address,'bigint');
  const preconditions=[E.createCompare('ne',p,q)];
  const proved=await queryMemoryEquivalence({...request,preconditions});
  assert.equal(proved.verdict,'proved',proved.reason);
  assert.equal(isAdoptableMemoryEquivalence(proved,{...request,preconditions}),true);
  assert.equal(isAdoptableMemoryEquivalence(proved,request),false);
});

import { identity,argument,literal,store,load,program } from './symbolic-footprint-fixtures.mjs';
function requestFor(before,after,bits=64,extra={}) {
  const inputs=before.inputs.map((value,i)=>({before:value,after:after.inputs[i]}));
  return {identity,beforeIr:before.ir,afterIr:after.ir,inputs,preconditions:[],backendTier:'tiered',timeoutMs:2000,
    memory:{addressBits:bits,wrapping:'modular',proofMode:'symbolic-writes'},...extra};
}
for(const endian of ['little','big'])for(const size of [1,2,4,8])test(`${endian} ${size}-byte overlapping symbolic writes preserve the full memory`,async()=>{
  const p=argument('p',64),q=argument('p',64);
  const value=BigInt.asUintN(size*8,0x0123456789abcdefn),lane=endian==='little'?size-1:0;
  const shifted=BigInt(lane*8),mask=255n<<shifted;
  const combined=(value&~mask)|(0xabn<<shifted);
  const b={inputs:[p],ir:program([store(p,literal('word',size*8,value),size),store(p,literal('byte',8,0xab),1,BigInt(size-1))])};
  const a={inputs:[q],ir:program([store(q,literal('combined',size*8,combined),size)])};
  const request=requestFor(b,a);request.memory={...request.memory,endian};
  const result=await queryMemoryEquivalence(request);
  assert.equal(result.verdict,'proved',result.reason);
  assert.equal(isAdoptableMemoryEquivalence(result,request),true);
});
test('same symbolic address repeated stores use last write, not initial byte',async()=>{
  const p=argument('p',64),q=argument('p',64);
  const before={inputs:[p],ir:program([store(p,literal('x',8,1)),store(p,literal('y',8,2))])};
  const after={inputs:[q],ir:program([store(q,literal('y',8,2))])};
  const result=await queryMemoryEquivalence(requestFor(before,after));
  assert.equal(result.verdict,'proved',result.reason);
});
test('read-over-write is proved with canonical expressions and real backend',async()=>{
  const p=argument('p',64),q=argument('p',64),out={id:'read',bits:8};
  const before={inputs:[p],ir:program([store(p,literal('x',8,0xe1)),load(p,out)],out)};
  const after={inputs:[q],ir:program([store(q,literal('x',8,0xe1))],literal('out',8,0xe1))};
  const result=await queryMemoryEquivalence(requestFor(before,after));
  assert.equal(result.verdict,'proved',result.reason);
});
test('read before/after a different symbolic store needs the actual inequality assumption',async()=>{
  const make=early=>{const p=argument('p',64),q=argument('q',64),out={id:'out',bits:8};
    const read=load(q,out),write=store(p,literal('value',8,99));
    return {inputs:[p,q],ir:program(early?[read,write]:[write,read],out)};};
  const before=make(false),after=make(true),request=requestFor(before,after);
  const [p,q]=['p','q'].map(n=>E.createFreshSymbol(E.bvSort(64),n));
  request.inputs=request.inputs.map((pair,i)=>({...pair,expression:[p,q][i]}));
  assert.equal((await queryMemoryEquivalence(request)).verdict,'refuted');
  const result=await queryMemoryEquivalence({...request,preconditions:[E.createCompare('ne',p,q)]});
  assert.equal(result.verdict,'proved',result.reason);
});
test('alias equality constrains store order through solver, never pointer names',async()=>{
  const {request,p,q}=pairedStores(64,true);
  const result=await queryMemoryEquivalence({...request,preconditions:[E.createCompare('eq',p,q)]});
  assert.equal(result.verdict,'refuted',result.reason);
  assert.notEqual(result.firstDivergence.before,result.firstDivergence.after);
});
test('read-only unknown initial bytes alias under equality without any write cover',async()=>{
  const p=argument('p',64),q=argument('p',64),x={id:'x',bits:8},y={id:'y',bits:8};
  const before={inputs:[p],ir:program([load(p,x)],x)},after={inputs:[q],ir:program([load(q,y)],y)};
  const result=await queryMemoryEquivalence(requestFor(before,after));
  assert.equal(result.verdict,'proved',result.reason);
  assert.equal(result.scope.observedAddressTerms.length,0);
  assert.ok(result.metrics.memory.symbolicMemoryCells>0);
});
test('an uninitialized byte is not zero; a write unique to one side is observed',async()=>{
  const p=argument('p',64),q=argument('p',64);
  const before={inputs:[p],ir:program([])},after={inputs:[q],ir:program([store(q,literal('zero',8,0))])};
  const request=requestFor(before,after),result=await queryMemoryEquivalence(request);
  assert.equal(result.verdict,'refuted',result.reason);
  assert.equal(result.firstDivergence.kind,'memory-byte');
  assert.notEqual(result.firstDivergence.before,result.firstDivergence.after);
});
test('symbolic boundary wrap is compared modulo 2^64, including byte zero',async()=>{
  const p=argument('p',64),q=argument('p',64),pointer=E.createFreshSymbol(E.bvSort(64),'boundary');
  const before={inputs:[p],ir:program([store(p,literal('word',16,0x1234),2)])};
  const after={inputs:[q],ir:program([store(q,literal('low',8,0x34)),store(q,literal('high',8,0x12),1,1n)])};
  const request=requestFor(before,after);
  request.inputs[0].expression=pointer;
  request.preconditions=[E.createCompare('eq',pointer,E.createBv(64,(1n<<64n)-1n))];
  const result=await queryMemoryEquivalence(request);assert.equal(result.verdict,'proved',result.reason);
  after.ir.instructions[1].args[0].value.const=0x13n;
  const changed=await queryMemoryEquivalence(request);assert.equal(changed.verdict,'refuted',changed.reason);
  assert.equal(changed.firstDivergence.address,0n);
});
test('a high non-sampled address is returned from the validated refutation model',async()=>{
  const p=argument('p',64),q=argument('p',64),pointer=E.createFreshSymbol(E.bvSort(64),'high');
  const before={inputs:[p],ir:program([store(p,literal('one',8,1))])},after={inputs:[q],ir:program([store(q,literal('two',8,2))])};
  const request=requestFor(before,after);request.inputs[0].expression=pointer;
  const high=0xfedcba9876543210n;request.preconditions=[E.createCompare('eq',pointer,E.createBv(64,high))];
  const result=await queryMemoryEquivalence(request);assert.equal(result.verdict,'refuted',result.reason);
  assert.equal(result.firstDivergence.address,high);
});
