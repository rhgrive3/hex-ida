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
 const replay=await optimizeSemanticDecompilation(first,f.options);assert.equal(replay.proofOptimization.status,'complete');
 assert.equal(replay.proofOptimization.adopted,0);assert.equal(replay.pseudocode,first.pseudocode);
});
test('v8 public optimizer cancellation at the last observer does not publish',async()=>{
 const f=projectionFixture();let calls=0;const completed=await optimizeSemanticDecompilation(f.result,{...f.options,isCancelled:()=>{calls++;return false;}});
 assert.equal(completed.proofOptimization.status,'complete');let count=0;const ac=new AbortController();
 const stopped=await optimizeSemanticDecompilation(f.result,{...f.options,signal:ac.signal,isCancelled:()=>{if(++count===calls)ac.abort();return false;}});
 assert.equal(ac.signal.aborted,true);assert.equal(stopped.proofOptimization.status,'partial');assert.equal(stopped.proofOptimization.adopted,0);
});
