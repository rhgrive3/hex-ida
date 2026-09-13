import { captureProjectionIrData, createProjectionIrObserver } from '../../../js/core/identity/live-data.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {captureProjectionData,PROJECTION_LIMITS} from '../../../js/decompiler/phase8/projection-origin.js';
import {isProducerProjection,optimizeSemanticDecompilation} from '../../../js/decompiler/pipeline.js';
import {projectionFixture} from '../helpers/proof-fixtures.mjs';

test('v8 projection data: exact typed tokens preserve origins and primitive domains',()=>{
 const a={kind:'var',name:'same',source:{ssaDefs:[1]},value:1n},b=structuredClone(a),c={...a,source:{ssaDefs:[2]}};
 const roots=[{a,b,c,string:{...a,value:'1'},number:{...a,value:1},minusZero:-0,zero:0}];
 const cap=captureProjectionData(roots);assert.equal(cap.tokenOf(a),cap.tokenOf(b));assert.notEqual(cap.tokenOf(a),cap.tokenOf(c));
 assert.notEqual(cap.tokenOf(a),cap.tokenOf(roots[0].string));assert.notEqual(cap.tokenOf(a),cap.tokenOf(roots[0].number));
 assert.equal(cap.matches(),true);b.source.ssaDefs[0]=3;assert.equal(cap.matches(),false);
});
test('v8 projection data: getters, sparse arrays, cycles and custom iterators cannot execute',()=>{
 let calls=0;const getter={get expression(){calls++;return 0;}};const cycle={};cycle.self=cycle;
 for(const root of [getter,cycle,Array(1),new Map(),Symbol('x'),Infinity,1n<<2000n])assert.throws(()=>captureProjectionData([root]));
 assert.throws(()=>captureProjectionData({*[Symbol.iterator](){calls++;while(true)yield null;}}));
 assert.equal(calls,0);
});
test('v8 projection data: string bound N-1/N/N+1 and shared-DAG expansion',()=>{
 for(const n of [PROJECTION_LIMITS.string-1,PROJECTION_LIMITS.string,PROJECTION_LIMITS.string+1]) {
  if(n<=PROJECTION_LIMITS.string)assert.equal(captureProjectionData(['x'.repeat(n)]).matches(),true);
  else assert.throws(()=>captureProjectionData(['x'.repeat(n)]),/string-budget/);
 }
 let node={value:1};for(let i=0;i<25;i++)node={left:node,right:node};
 assert.throws(()=>captureProjectionData([node]),/expansion-budget/);
});
test('v8 producer observation rejects post-production AST/source changes',async()=>{
 for(const change of [f=>{f.result.cAst.body[0].text='return 999;';},f=>{f.result.semanticAst.values[0].source.ssaDefs.push(999);},f=>{f.result.semanticAst={...f.result.semanticAst};}]) {
  const f=projectionFixture();assert.equal(isProducerProjection(f.result),true);change(f);
  assert.equal(isProducerProjection(f.result),false);const r=await optimizeSemanticDecompilation(f.result,f.options);
  assert.equal(r.proofOptimization.status,'partial');assert.equal(r.proofOptimization.adopted,0);
 }
});
test('v8 producer observation rejects changed IR accessors without evaluation',async()=>{
 const f=projectionFixture();let calls=0;Object.defineProperty(f.target,'const',{get(){calls++;return null;},configurable:true});
 const r=await optimizeSemanticDecompilation(f.result,f.options);assert.equal(r.proofOptimization.status,'partial');assert.equal(calls,0);
});
test('v8 public optimizer retains an issued projection after successful replay',async()=>{
 const f=projectionFixture();const first=await optimizeSemanticDecompilation(f.result,f.options);
 assert.equal(first.proofOptimization.status,'complete');assert.equal(isProducerProjection(first),true);
 const accepted=first.phase8Projection.transforms.filter(t=>t.kind==='solver-constant');
 assert.ok(accepted.length>0,'fixture must perform a real proof-backed projection');
 const replay=await optimizeSemanticDecompilation(first,f.options);assert.equal(replay.proofOptimization.status,'complete');
 assert.equal(replay.proofOptimization.adopted,0);assert.equal(replay.pseudocode,first.pseudocode);
 assert.equal(replay.renderProvenance.completeness,'complete');
 for(const record of accepted) {
  assert.ok(replay.phase8Projection.history.transforms.includes(record),'retain the earlier applied record without readopting it');
  assert.ok(replay.renderProvenance.ledger.some(t=>t.kind==='solver-constant' && t.queryHash===record.queryHash && t.planId===record.planId));
 }
});
test('v8 public optimizer cancellation at the last observer does not publish',async()=>{
 const f=projectionFixture();let calls=0;const completed=await optimizeSemanticDecompilation(f.result,{...f.options,isCancelled:()=>{calls++;return false;}});
 assert.equal(completed.proofOptimization.status,'complete');let count=0;const ac=new AbortController();
 const stopped=await optimizeSemanticDecompilation(f.result,{...f.options,signal:ac.signal,isCancelled:()=>{if(++count===calls)ac.abort();return false;}});
 assert.equal(ac.signal.aborted,true);assert.equal(stopped.proofOptimization.status,'partial');assert.equal(stopped.proofOptimization.adopted,0);
});

const captures = [
  ['ordinary', roots=>captureProjectionIrData(roots)],
  ['graph', roots=>createProjectionIrObserver().captureGraph(roots)],
  ['certified', roots=>createProjectionIrObserver().captureCertifiedDataGraph(roots)],
];

for (const [name,capture] of captures) {
  test(`${name}: frozen own fields are stable while mutable descendants remain observed`, () => {
    const child={value:1},parent=Object.freeze({child,rows:Object.freeze([child])});
    const observed=capture([parent]);
    assert.equal(observed.matches(),true);
    child.value=2;
    assert.equal(observed.matches(),false);
  });
  test(`${name}: freezing after capture cannot refresh changed fields`, () => {
    const value={value:1},observed=capture([value]);
    value.value=2;Object.freeze(value);
    assert.equal(observed.matches(),false);
  });
  test(`${name}: a revoked frozen proxy cannot remain current`, () => {
    const {proxy,revoke}=Proxy.revocable(Object.freeze({value:1}),{});
    const observed=capture([proxy]);assert.equal(observed.matches(),true);
    revoke();assert.equal(observed.matches(),false);
  });
  test(`${name}: throwing frozen-proxy descriptor traps fail closed`, () => {
    let fail=false;
    const value=new Proxy(Object.freeze({value:1}),{getOwnPropertyDescriptor(target,key){
      if(fail)throw new Error('unavailable');return Reflect.getOwnPropertyDescriptor(target,key);
    }});
    const observed=capture([value]);assert.equal(observed.matches(),true);
    fail=true;assert.equal(observed.matches(),false);
  });
  test(`${name}: frozen cycles retain mutable leaves and replacement detection`, () => {
    const leaf={value:1},a={leaf},b={a};a.b=b;Object.freeze(a);Object.freeze(b);
    const envelope={a},observed=capture([envelope]);
    assert.equal(observed.matches(),true);
    leaf.value=2;assert.equal(observed.matches(),false);
    leaf.value=1;assert.equal(observed.matches(),true);
    envelope.a={...a};assert.equal(observed.matches(),false);
  });
  test(`${name}: repeated reads do not rescan frozen own descriptors`, () => {
    const child={value:1};
    const frozen=Object.freeze(Object.fromEntries(Array.from({length:256},(_,i)=>['field'+i,i])));
    const parent=Object.freeze({frozen,child}),observed=capture([parent]);
    const original=Object.getOwnPropertyDescriptor;let frozenVisits=0,childVisits=0;
    Object.getOwnPropertyDescriptor=(value,key)=>{
      if(value===frozen||value===parent)frozenVisits++;
      if(value===child)childVisits++;
      return original(value,key);
    };
    try { assert.equal(observed.matches(),true); }
    finally { Object.getOwnPropertyDescriptor=original; }
    assert.equal(frozenVisits,0,'frozen own descriptors cannot change');
    assert.ok(childVisits>0,'mutable descendants still require a live scan');
  });
}

test('frozen accessors remain invalid data and are never evaluated', () => {
  let calls=0;const value=Object.freeze({get value(){calls++;return 1;}});
  for(const [,capture] of captures)assert.throws(()=>capture([value]),/accessor/);
  assert.equal(calls,0);
});
