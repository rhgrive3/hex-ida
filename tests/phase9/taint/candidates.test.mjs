import test from 'node:test';
import assert from 'node:assert/strict';
import * as symbolic from '../../../js/symbolic/index.js';
import { identity } from './fixtures.mjs';
const E=symbolic.expr;
const query=(expression,extra={})=>symbolic.queryDeobfuscationCandidates({expression,valueId:'value',identity,memoryObservables:[],effectObservables:[],...extra});
test('bounded candidate generation invokes the real verifier before offering a pure rewrite',async()=>{
  const x=E.createFreshSymbol(E.bvSort(4),'candidate-x');
  const result=await query(E.createBinary('xor',x,x));
  assert.equal(result.status,'complete',result.reason);assert.ok(result.candidates.length);
  const rewrite=result.candidates.find(c=>c.rule==='xor-self');assert.ok(rewrite);
  assert.equal(rewrite.eligible,true);assert.equal(rewrite.after.value,0n);
  assert.equal(symbolic.isAdoptableCandidate(rewrite.verification),true);
  assert.ok(result.metrics.workItems>0);assert.equal(result.metrics.verificationQueries,result.candidates.length);
});
test('nested DAG and MBA rules produce solver-checked candidates without rewriting IR',async()=>{
  const x=E.createFreshSymbol(E.bvSort(3),'mba-x'),y=E.createFreshSymbol(E.bvSort(3),'mba-y');
  const before=E.createBinary('add',E.createBinary('xor',x,y),E.createBinary('shl',E.createBinary('and',x,y),E.createBv(3,1)));
  const result=await query(before);
  const rewrite=result.candidates.find(c=>c.rule==='mba-add');assert.ok(rewrite);
  assert.equal(rewrite.eligible,true,rewrite.verification.reason);assert.equal(rewrite.before,before);
  const nested=E.createBinary('add',E.createBinary('xor',x,x),y);
  const lowered=await query(nested);assert.ok(lowered.candidates.some(c=>c.eligible));
  assert.equal(nested.left.kind,'binary');
});
test('taint, false preconditions, memory reads, absent observables and unsupported widths cannot grant adoption',async()=>{
  const x=E.createFreshSymbol(E.bvSort(4),'candidate-negative');const before=E.createBinary('xor',x,x);
  const vacuous=await query(before,{preconditions:[E.createBool(false)]});assert.ok(vacuous.candidates.every(c=>!c.eligible));
  assert.equal((await query(before,{memoryObservables:undefined})).candidates.length,0);
  assert.equal((await query(before,{effectObservables:['call']})).candidates.length,0);
  const byte=E.createFreshSymbol(E.bvSort(8),'memory-byte',{source:'initial-byte'});
  assert.ok((await query(E.createBinary('xor',byte,byte))).candidates.every(c=>!c.eligible));
  const wide=E.createFreshSymbol(E.bvSort(32),'unsupported-32');
  assert.ok((await query(E.createBinary('xor',wide,wide))).candidates.every(c=>!c.eligible));
});
test('candidate bounds N-1/N/N+1, cancellation and stale state do not publish partial proof batches',async()=>{
  const x=E.createFreshSymbol(E.bvSort(4),'budget-x');const before=E.createBinary('add',E.createBinary('xor',x,x),E.createBv(4,0));
  const base=await query(before);assert.equal(base.status,'complete');
  const n=base.metrics.candidates;assert.ok(n>0);
  for(const limit of [n-1,n,n+1]) {
    const result=await query(before,{limits:{candidates:limit}});
    assert.equal(result.status,limit<n?'partial':'complete',result.reason);
    if(limit<n)assert.equal(result.candidates.length,0);
  }
  const controller=new AbortController();controller.abort();assert.equal((await query(before,{signal:controller.signal})).candidates.length,0);
  let current=identity;const pending=query(before,{getCurrentIdentity:()=>current});current={...identity,snapshotId:'new'};
  const stale=await pending;assert.equal(stale.status,'partial');assert.equal(stale.candidates.length,0);
});
