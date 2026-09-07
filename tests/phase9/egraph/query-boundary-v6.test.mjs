import test from 'node:test';
import assert from 'node:assert/strict';
import { queryEqualitySaturation, expr as E } from '../../../js/symbolic/index.js';
import { identity } from '../taint/fixtures.mjs';
const x=E.createFreshSymbol(E.bvSort(4),'eqs_boundary');
const before=E.createBinary('sub',x,x);
const run=extra=>queryEqualitySaturation({identity,expression:before,valueId:'v',memoryObservables:[],effectObservables:[],timeoutMs:2000,...extra});
test('C4-05 boundary: malformed identity is partial and never invokes its getter',async()=>{
 let reads=0;const bad={...identity};Object.defineProperty(bad,'snapshotId',{enumerable:true,get(){reads++;return identity.snapshotId;}});
 const result=await run({identity:bad});assert.equal(result.status,'partial');assert.deepEqual(result.candidates,[]);assert.equal(reads,0);
});
test('C4-05 boundary: invalid setup clock and resource options publish no candidate',async()=>{
 for(const extra of [{now:()=>NaN},{timeoutMs:-1},{limits:{enodes:Infinity}},{identity:null}]){
  const result=await run(extra);assert.equal(result.status,'partial');assert.deepEqual(result.candidates,[]);
 }
});
test('C4-05 boundary: observed work and allocation bounds replay exactly at N and fail at N-1',async()=>{
 const complete=await run({});assert.equal(complete.status,'complete',complete.reason);
 for(const name of ['workItems','allocationUnits']){
  const n=complete.metrics[name];assert.ok(Number.isSafeInteger(n)&&n>0);
  for(const delta of [-1,0,1]){const r=await run({limits:{[name]:n+delta}});assert.equal(r.status,delta<0?'partial':'complete',`${name}/${delta}: ${r.reason}`);assert.ok(r.metrics[name]<=n+delta);if(delta<0)assert.deepEqual(r.candidates,[]);}
 }
});
