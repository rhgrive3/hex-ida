import test from 'node:test';
import assert from 'node:assert/strict';
import { threadedNativeFixture } from './threaded-native-fixture.mjs';
import { INTEGER_FRAGMENT_KIND } from '../../js/core/evidence/arm64-integer-fragment.js';
async function publish(f) {
 let result=await f.invoke('demandQuery',{query:{scope:{functionIds:['0x1000']},select:{op:'all'},resultLimit:32},precision:{maximumValues:64}});
 for(let n=0;result.continuation&&n<32;n++)result=await f.invoke('resumeDemandQuery',{cursor:result.continuation.cursor});
 assert.equal(result.continuation,null);assert.ok(result.publication?.artifactId,JSON.stringify(result));return result;
}
test('test-owned assembled ELF > deployed decoder > actual thread > public query > fresh byte replay', {timeout:25000},async t=>{
 const f=await threadedNativeFixture(t);assert.ok(f.workerThreadId>0);assert.equal(f.info.formatId,'elf');
 assert.equal(f.symbols.functionAt(0x1000n).end,0x1010n);
 const result=await publish(f),artifactId=result.publication.artifactId;
 assert.equal(result.answer.exact,false);assert.ok(f.counters.decodes>0);assert.ok(f.counters.semantic>0);
 const graph=await f.invoke('explainDemandResult',{artifactId,view:'graph'});
 const proofs=graph.graph.nodes.filter(n=>n.semanticKind===INTEGER_FRAGMENT_KIND);
 assert.ok(proofs.some(n=>n.payload.fragment.conclusion.constant==='8192'));
 const replay=await f.invoke('replayDemandResult',{artifactId});
 assert.equal(replay.integrity,'verified');assert.equal(replay.byteBinding,'verified');
 assert.equal(replay.derivation.status,'partially-checked');assert.equal(replay.ownerReplay.counters.integerDerivations,1);
 assert.equal(replay.semantic,'unknown');assert.equal(replay.exact,false);assert.equal(replay.quarantine,null);
 const portable=await f.invoke('portableIntegerChecks',{functionId:'0x1000'});
 assert.doesNotThrow(()=>structuredClone(portable.replay));
 assert.equal(portable.replay.counts.verified,1);assert.equal(portable.semanticProof,false);
 assert.equal(portable.sourceBinding,'current-native-owner-and-source-bytes');
 const rebound=await f.invoke('portableIntegerChecks',{functionId:'0x1000',capsule:portable.capsule});
 assert.equal(rebound.capsuleRebound,true);assert.equal(rebound.releaseQualified,false);
});
test('symbol revision and binary epoch invalidate publication through the public app binding', {timeout:25000},async t=>{
 const f=await threadedNativeFixture(t),result=await publish(f),artifactId=result.publication.artifactId;
 f.app.symbols.revision=(f.app.symbols.revision??0)+1;
 const retired=await f.invoke('replayDemandResult',{artifactId});assert.notEqual(retired.integrity,'verified');
 f.backend.gen++;
 await assert.rejects(f.invoke('demandQuery',{query:{scope:{functionIds:['0x1000']},resultLimit:1}}),/stale/i);
});
test('pre-aborted query does not start native analysis or publish a result', {timeout:25000},async t=>{
 const f=await threadedNativeFixture(t),controller=new AbortController();controller.abort(new Error('test-explicit-cancel'));
 const before={...f.counters};
 await assert.rejects(f.invoke('demandQuery',{query:{scope:{functionIds:['0x1000']},resultLimit:1}},{signal:controller.signal}));
 assert.deepEqual(f.counters,before);
});


test('real decoder text/byte divergence is independently rejected and quarantined', {timeout:25000},async t=>{
 const f=await threadedNativeFixture(t),decode=f.backend.fetchChunk;
 f.backend.fetchChunk=async(...args)=>{const chunk=await decode(...args);return {...chunk,ops:chunk.ops.map((s,i)=>i===1?s.replace('#0x10','#0x11'):s)};};
 const result=await publish(f),replay=await f.invoke('replayDemandResult',{artifactId:result.publication.artifactId});
 assert.equal(replay.semantic,'rejected');assert.equal(replay.derivation.status,'rejected');assert.equal(replay.quarantine.status,'quarantined');
 assert.ok(replay.nodeResults.some(n=>n.reason==='independent-integer-singleton-contradicts-conclusion'));
 const retired=await f.invoke('explainDemandResult',{artifactId:result.publication.artifactId,view:'graph'});assert.notEqual(retired.status,'completed');
});
test('cancellation after actual thread dispatch cannot return a late publication', {timeout:25000},async t=>{
 const f=await threadedNativeFixture(t),controller=new AbortController(),original=f.backend._callTo;
 let cancelled=false;
 f.backend._callTo=(route,method,data)=>{const pending=original(route,method,data);
   if(method==='semanticFunction'&&!cancelled){cancelled=true;controller.abort(new Error('test-inflight-cancel'));}
   return pending;
 };
 await assert.rejects(f.invoke('demandQuery',{query:{scope:{functionIds:['0x1000']},resultLimit:32}},{signal:controller.signal}));
 assert.equal(cancelled,true);assert.ok(f.counters.semantic>0);
 f.backend._callTo=original;
 const recovered=await publish(f);assert.ok(recovered.publication.artifactId);assert.equal(recovered.answer.exact,false);
});
