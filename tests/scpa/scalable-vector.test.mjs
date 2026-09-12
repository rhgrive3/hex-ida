import test from 'node:test';
import assert from 'node:assert/strict';
import { checkScalableVectorModel, SCALABLE_VECTOR_SCHEMA } from '../../js/core/evidence/scalable-vector.js';
import { workFor } from './helpers.mjs';
const base = (bits = 32, vl = 128) => ({schema: SCALABLE_VECTOR_SCHEMA, family:'integer-lanes', vlBits:vl, elementBits:bits, streaming:false,
  predicate:Array.from({length:vl/8}, (_,i)=>i % 2 === 0), operation:'add', inactive:'merge',
  lhs:Array(vl/bits).fill(((1n<<BigInt(bits))-1n).toString()), rhs:Array(vl/bits).fill('1'), previous:Array(vl/bits).fill('7')});
const load = () => ({schema:SCALABLE_VECTOR_SCHEMA,family:'first-fault-load',vlBits:128,elementBits:32,streaming:false,
  predicate:Array(16).fill(true), ffr:Array(16).fill(true), accesses:[1,2,3,4].map(v=>({kind:'loaded',value:String(v)}))});
for (const vl of [128,256,2048]) for (const bits of [8,16,32,64]) for (const op of ['add','sub','and','orr','eor']) for (const inactive of ['merge','zero']) {
  test(`VL=${vl} E=${bits} ${op} ${inactive}: unsigned lane and byte-predicate reference`, t=>{
    const m=base(bits,vl); m.operation=op; m.inactive=inactive; m.predicate[0]=false;
    const w=workFor(t), r=checkScalableVectorModel(m,null,{work:w}), mask=(1n<<BigInt(bits))-1n;
    const expected=m.lhs.map((x,i)=> { const a=BigInt(x),b=1n; if(!m.predicate[i*bits/8])return inactive==='merge'?'7':'0';
      return ({add:()=> (a+b)&mask, sub:()=> (a-b)&mask, and:()=>a&b,orr:()=>a|b,eor:()=>a^b}[op]()).toString(); });
    assert.deepEqual(r.output,expected); assert.equal(r.semanticProof,false);
    assert.equal(checkScalableVectorModel(m,{output:expected,ffr:null,synchronousFault:null},{work:w}).status,'verified-model');
  });
}
test('suppression invalidates every following lane, including inactive lanes', t=>{
  const m=load(); m.accesses[1]={kind:'suppressed'}; m.accesses[2]={kind:'inactive'}; m.predicate[8]=false;
  const r=checkScalableVectorModel(m,null,{work:workFor(t)}); assert.deepEqual(r.output,['1',null,null,null]);
  assert.deepEqual(r.ffr,[...Array(4).fill(true),...Array(12).fill(false)]);
  assert.equal(checkScalableVectorModel(m,{output:['1','0','0','4']},{work:workFor(t)}).status,'rejected');
});
test('already clear FFR means later successful load is not known data',t=>{
  const m=load(); m.ffr[4]=false; assert.deepEqual(checkScalableVectorModel(m,null,{work:workFor(t)}).output,['1',null,null,null]);
});
test('first active lane faults synchronously, not zero-normal-return',t=>{
  const m=load(); m.predicate[0]=false;m.accesses[0]={kind:'inactive'};m.accesses[1]={kind:'fault'};
  const r=checkScalableVectorModel(m,null,{work:workFor(t)});assert.deepEqual(r.synchronousFault,{lane:1});assert.equal(r.output,null);
});
test('inactive lanes never assert a memory access',t=>{const m=load();m.predicate[0]=false;assert.throws(()=>checkScalableVectorModel(m,null,{work:workFor(t)}),/inactive-access/);});
test('streaming first-fault stays unqualified',t=>{const m=load();m.streaming=true;assert.equal(checkScalableVectorModel(m,null,{work:workFor(t)}).status,'unknown');});
for(const mutation of [m=>m.vlBits=129,m=>m.elementBits=24,m=>m.lhs[0]='-1',m=>m.lhs[0]='4294967296',m=>m.predicate[0]=1,m=>m.lhs.length=0,m=>m.extra=true]) {
  test('reject malformed lane contract '+mutation.toString(),t=>{const m=base();mutation(m);assert.throws(()=>checkScalableVectorModel(m,null,{work:workFor(t)}));});
}
test('strict accessors are not executed',t=>{const m=base();let calls=0;Object.defineProperty(m,'operation',{get(){calls++;return 'add'},enumerable:true});assert.throws(()=>checkScalableVectorModel(m,null,{work:workFor(t)}));assert.equal(calls,0);});
test('work budget cannot be bypassed by largest vector',t=>assert.throws(()=>checkScalableVectorModel(base(8,2048),null,{work:workFor(t,{workUnits:5})})));
