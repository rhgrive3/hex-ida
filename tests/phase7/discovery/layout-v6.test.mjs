import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../../../js/analysis/index.js';
import {MemoryByteSource} from '../../../js/binary/source.js';
const identity={snapshotId:'layout-v6',binaryId:'binary-layout',architectureId:'arm64',semanticsVersion:'1',sourceRevision:'r1'};
const bytes=Uint8Array.from({length:32},(_,i)=>i);
const maps=[{start:0x1000n,end:0x1020n,fileOffset:0n}];
const input={image:{functionStarts:[{address:0x1000n,sizeBytes:16},{address:0x1008n,sizeBytes:16}]}};
const run=(extra={})=>A.queryDiscoveryLayout({identity,source:new MemoryByteSource(bytes),mappedRegions:maps,input,...extra});
test('X3 production discovery retains rejected overlapping extents and their provenance',async()=>{
 const r=await run();assert.equal(r.status.completeness,'complete',r.reason);assert.equal(r.byteCoverage,'complete');assert.equal(r.canRewrite,false);
 const middle=r.segments.find(s=>s.start==='4104');assert.ok(middle);assert.ok(middle.interpretations.length>=2);
 assert.equal(r.candidates.every(c=>c.extentState==='unknown'),true);assert.equal(middle.ambiguous,true);
 assert.ok(r.evidence.nodes.length);assert.ok(r.evidence.edges.length);
});
test('X3 code/data/jump-table alternatives remain candidates, not a winning exact interpretation',async()=>{
 const r=await run({hints:[{id:'table',kind:'jump-table',start:0x1008n,end:0x1010n,evidenceIds:['jt:1']},{id:'data',kind:'data',start:0x1018n,end:0x1020n,evidenceIds:['data:1']}]});
 assert.equal(r.status.completeness,'complete',r.reason);assert.ok(r.segments.some(s=>s.interpretations.some(i=>i.kind==='jump-table')));
 assert.ok(r.segments.some(s=>s.interpretations.some(i=>i.kind==='data')));
 assert.equal(r.segments.some(s=>s.classification==='exact-code'),false);
});
test('X3 source bytes round-trip without dropping gaps or mutating caller storage',async()=>{
 const r=await run({input:{image:{functionStarts:[{address:0x1000n,sizeBytes:4}]}}});
 const restored=A.restoreDiscoveryBytes(r,{identity});assert.deepEqual(restored[0].bytes,bytes);assert.equal(restored[0].fileOffset,0n);
 restored[0].bytes[0]=255;assert.equal(A.restoreDiscoveryBytes(r,{identity})[0].bytes[0],0);
 assert.ok(r.segments.some(s=>s.classification==='unclassified'));assert.equal(Object.isFrozen(r.segments),true);
});
test('X3 original mappings and relocations preserve high addresses, pairs and addends',async()=>{
 const high=0xffffffffffffffe0n;
 const r=await run({mappedRegions:[{start:high,end:high+32n,fileOffset:0n}],input:{image:{}},relocations:[
 {id:'adrp',start:high,end:high+4n,producerId:'binary-relocs',expression:{kind:'page-relative',symbolId:'s',addend:-4096n,pairId:'pair'}},
 {id:'add',start:high+4n,end:high+8n,producerId:'binary-relocs',expression:{kind:'page-offset',symbolId:'s',addend:-4096n,pairId:'pair'}}]});
 assert.equal(r.status.completeness,'complete',r.reason);assert.equal(r.relocations.length,2);assert.equal(r.relocations[0].expression.addend,'-4096');
 assert.equal(r.segments[0].start,high.toString());assert.deepEqual(A.restoreDiscoveryBytes(r,{identity})[0].bytes,bytes);
});
test('X3 mapping gaps stay absent; outside candidates and relocation spans are not silently deleted',async()=>{
 const r=await run({mappedRegions:[{start:0x1000n,end:0x1008n,fileOffset:0n},{start:0x1010n,end:0x1018n,fileOffset:16n}],hints:[{id:'outside',kind:'code',start:0x3000n,end:0x3004n}],relocations:[{id:'gap',start:0x1004n,end:0x1014n,producerId:'p',expression:{symbol:'x'}}]});
 assert.equal(r.byteCoverage,'complete');assert.ok(r.unmapped.length>0);assert.ok(r.relocations.find(x=>x.id==='gap').mappingIncomplete);
 assert.equal(r.segments.some(s=>BigInt(s.start)>=0x1008n&&BigInt(s.end)<=0x1010n),false);
});
test('X3 candidate/hint input permutation produces identical materialized layout',async()=>{
 const hints=[{id:'b',kind:'data',start:0x1018n,end:0x1020n},{id:'a',kind:'code',start:0x1000n,end:0x1010n}];
 const a=await run({hints}),b=await run({input:{image:{functionStarts:[...input.image.functionStarts].reverse()}},hints:[...hints].reverse()});
 assert.equal(a.digest,b.digest);assert.deepEqual(a.segments,b.segments);
});
test('X3 N-1/N/N+1 byte reservations happen before reads and partial work never publishes',async()=>{
 for(const maxBytes of [31,32,33]){let reads=0;const source={size:32n,async read(o,n){reads++;return bytes.slice(Number(o),Number(o)+n);}};
 const r=await run({source,limits:{maxBytes}});assert.equal(r.status.completeness==='complete',maxBytes>=32,r.reason);
 if(maxBytes<32){assert.equal(reads,0);assert.equal(r.segments.length,0);assert.equal(r.evidence.nodes.length,0);}
 }
 const stopped=await run({limits:{maxSegments:1}});assert.equal(stopped.status.completeness,'partial');assert.equal(stopped.segments.length,0);
});
test('X3 cancelled, stale and never-resolving I/O cannot publish delayed layouts',async()=>{
 for(const extra of [{signal:AbortSignal.abort()},{getCurrentIdentity:()=>({...identity,sourceRevision:'r2'})},{timeoutMs:0},{source:{size:32n,read:()=>new Promise(()=>{})},timeoutMs:10}]){
 const r=await run(extra);assert.equal(r.status.completeness,'partial');assert.equal(r.segments.length,0);assert.equal(r.canRewrite,false);
 }
});
test('X3 forged and stale materializations cannot obtain an authenticated original-byte copy',async()=>{
 const r=await run();assert.throws(()=>A.restoreDiscoveryBytes({...r},{identity}),/unissued|stale/);
 assert.throws(()=>A.restoreDiscoveryBytes(r,{identity:{...identity,sourceRevision:'r2'}}),/stale/);
});
test('X3 malformed ranges, input accessors and short reads are rejected without invented bytes',async()=>{
 let invoked=0;const malformed={get image(){invoked++;return {};}};
 for(const extra of [{input:malformed},{mappedRegions:[{start:[4096],end:4128,fileOffset:0}]},{source:{size:32n,read:async()=>new Uint8Array(1)}},{mappedRegions:[...maps,...maps]}]){
 const r=await run(extra);assert.equal(r.status.completeness,'partial');assert.equal(r.segments.length,0);
 }assert.equal(invoked,0);
});
test('X3 empty mappings do not masquerade as a byte-complete materialization',async()=>{
 const r=await run({mappedRegions:[]});assert.equal(r.status.completeness,'partial');assert.equal(r.byteCoverage,'unknown');
});
test('X3 fusion worst-case work is reserved before expensive collection and any I/O',async()=>{
 let reads=0;const functions=Array.from({length:30},(_,i)=>({address:0x1000n+BigInt(i),sizeBytes:1}));
 const r=await run({source:{size:32n,async read(o,n){reads++;return bytes.slice(Number(o),Number(o)+n);}},input:{image:{functionStarts:functions}},limits:{maxWork:1000}});
 assert.equal(r.status.completeness,'partial');assert.equal(reads,0);assert.equal(r.evidence.nodes.length,0);
});
test('X3 currentness is separate from immutable captured-byte coverage',async()=>{
 const historical=await run();assert.equal(historical.currentness,'unverified');
 const current=await run({getCurrentIdentity:()=>identity});assert.equal(current.currentness,'host-revision-checked');
});
test('X3 independent byte grid agrees on code/data interval membership',async()=>{
 let comparisons=0;
 for(let mask=0;mask<16;mask++){
  const hints=Array.from({length:4},(_,i)=>({id:`h${i}`,kind:mask&(1<<i)?'code':'data',start:0x1000n+BigInt(i*3),end:0x1000n+BigInt(i*3+8)}));
  const r=await run({input:{image:{}},hints});assert.equal(r.status.completeness,'complete',r.reason);
  for(let offset=0;offset<32;offset++){
   const address=0x1000n+BigInt(offset),part=r.segments.find(s=>BigInt(s.start)<=address&&address<BigInt(s.end));assert.ok(part);
   assert.deepEqual(part.interpretations.map(v=>v.id).sort(),hints.filter(h=>h.start<=address&&address<h.end).map(h=>h.id).sort());comparisons++;
  }
 }
 console.log(`X3 independent byte grid: ${comparisons} comparisons`);
});
