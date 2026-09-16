import test from 'node:test';
import assert from 'node:assert/strict';
import { runDiffInWorker } from '../../../js/diff/runtime.js';
import { buildManagedMethodSummary } from '../../../js/managed/shared/bridge.js';
import { resolveModelTexts } from '../../../js/analyze.js';
import { memoryOrigins } from '../../../js/slice.js';

test('#4811 matcher options cross worker boundary', async () => {
  let posted;
  class W { postMessage(v){posted=v;} terminate(){} addEventListener(){} removeEventListener(){} }
  runDiffInWorker([], [], {workerFactory:()=>new W(), ambiguityWindow:0.08, neighborhoodIterations:4, maxCandidates:64, maxBucketScan:256, allowSimilar:false});
  assert.equal(posted.options.ambiguityWindow,0.08);
  assert.equal(posted.options.neighborhoodIterations,4);
  assert.equal(posted.options.maxCandidates,64);
  assert.equal(posted.options.maxBucketScan,256);
  assert.equal(posted.options.allowSimilar,false);
});

test('#4786 managed load/store summaries use conservative canonical source', () => {
  const semanticIr={nodes:[{id:'l',kind:'load',memory:{addressSpace:'heap-a'}},{id:'s',kind:'store',memory:{addressSpace:'heap-b'}}],values:[]};
  const cfg={blocks:[]};
  const out=buildManagedMethodSummary({methodId:'m',semanticIr,cfg});
  const r=out.summary.memoryReadRegions[0], w=out.summary.memoryWriteRegions[0];
  for (const e of [r,w]) { assert.equal(e.regionKind,'unknown'); assert.equal(e.broad,true); assert.equal(e.source,'proven-summary'); }
  assert.deepEqual(r.addressSpaces,['heap-a']);
  assert.deepEqual(w.addressSpaces,['heap-b']);
});

test('#4973 declared structured architecture cannot confer pointer width', async () => {
  const model={addressRefs:[{row:0,addr:0x4000n}],semantic:[],calls:[],facts:{stringRefs:[]}};
  const reads=[];
  const backend={readAt:async (addr)=>{reads.push(addr); if(addr===0x4000n) return {found:true,terminated:false,text:null,bytes:new Uint8Array([0x78,0x56,0x34,0x12,0xef,0xbe,0xad,0xde])}; return {found:false};}};
  await resolveModelTexts(backend, model, 96, {architecture:['arm64_32']});
  assert.deepEqual(reads,[0x4000n]);
});

test('#4973 arm64_32 ignores adjacent 4 bytes', async () => {
  const model={addressRefs:[{row:0,addr:0x4000n}],semantic:[],calls:[],facts:{stringRefs:[]}};
  const reads=[];
  const backend={readAt:async (addr)=>{reads.push(addr); if(addr===0x4000n) return {found:true,terminated:false,text:null,bytes:new Uint8Array([0x78,0x56,0x34,0x12,0xef,0xbe,0xad,0xde])}; if(addr===0x12345678n) return {found:true,terminated:true,text:'ok',bytes:new Uint8Array([111,107,0])}; return {found:false};}};
  const out=await resolveModelTexts(backend, model, 96, {architecture:'arm64_32'});
  assert.deepEqual(reads,[0x4000n,0x12345678n]);
  assert.equal(out.addressRefs[0].text,'ok');
});

test('#4971 ARM64 PAC/TBI lower 48 bits survive', async () => {
  const model={addressRefs:[{row:0,addr:0x2000n}],semantic:[],calls:[],facts:{stringRefs:[]}};
  const target=0x123456789abcn; const reads=[];
  const backend={readAt:async (addr)=>{reads.push(addr); if(addr===0x2000n) return {found:true,terminated:false,text:null,bytes:new Uint8Array([0xbc,0x9a,0x78,0x56,0x34,0x12,0x00,0x7f])}; if(addr===target) return {found:true,terminated:true,text:'pac',bytes:new Uint8Array([112,97,99,0])}; return {found:false};}};
  const out=await resolveModelTexts(backend,model,96,{architecture:'arm64e'});
  assert.deepEqual(reads,[0x2000n,target]); assert.equal(out.addressRefs[0].text,'pac');
});

test('#5000 fractional and unsafe memory budgets cannot control traversal', () => {
  const a={id:'a'},b={id:'b'}; const phi={kind:'phi',incoming:[{node:{kind:'store',inst:a}},{node:{kind:'store',inst:b}}]};
  for (const bad of [1.9, Number.MAX_SAFE_INTEGER+1, 1e30]) { const r=memoryOrigins(phi,{maxNodes:bad,maxEdges:bad}); assert.equal(r.truncated,false,String(bad)); assert.equal(r.stores.length,2); }
});
