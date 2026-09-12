import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, workFor, selector } from './helpers.mjs';
import { rows } from './pipeline-fixture.mjs';
import { ArtifactStore } from '../../js/core/artifacts/store.js';
import { MemoryArtifactBackend } from '../../js/core/artifacts/backends.js';
import { createArtifactDescriptor } from '../../js/core/artifacts/contracts.js';
import { DependencyEpochRegistry } from '../../js/core/artifacts/dependencies.js';
import { ArtifactAnalysisOrchestrator } from '../../js/cache/artifact-orchestration.js';
import { createSliceId } from '../../js/core/identity/index.js';
import { analyzeSemanticFunction } from '../../js/analysis/semantic-function.js';
import { produceScopedArm64Pipeline } from '../../js/analysis/scoped-arm64-producer.js';
import { projectScopedLocalOwners } from '../../js/analysis/scoped-local-projection.js';
const descriptor=(f,dependencyScope=null,extra={})=>createArtifactDescriptor({binaryId:f.world.binarySet[0].binaryId,artifactKind:'scpa-test',producerId:'test-owner',producerVersion:'1',loaderVersion:'1',architectureSemanticVersion:'1',abiSemanticVersion:'1',semanticSchemaVersion:'1',...(dependencyScope?{dependencyScope}:{}),...extra});
function storeFixture(t,backend=new MemoryArtifactBackend()) {const f=fixture(),registry=new DependencyEpochRegistry({world:f.world}),store=new ArtifactStore({backend});store.registerDependencyRegistry(registry);t.after(async()=>{registry.close();await store.close();});return {...f,registry,store,backend};}
test('legacy records remain readable with no dependency registry or schema migration',async t=>{const f=storeFixture(t),d=descriptor(f);await f.store.publish(d,{value:7n});const r=await f.store.get(d);assert.equal(r.status,'hit');assert.equal(r.payload.value,'7');assert.equal(Object.hasOwn(r.record,'dependencyScope'),false);});
test('negative membership invalidates both hot and persistent scoped artifacts',async t=>{const f=storeFixture(t),scope=f.registry.capture([{selector:selector(),polarity:'negative-membership'}]),d=descriptor(f,scope);await f.store.publish(d,{value:'no-targets'});assert.equal((await f.store.get(d)).status,'hit');f.registry.advance([selector()]);assert.equal((await f.store.get(d)).status,'miss');f.store.hotCache.clear();assert.equal((await f.store.get(d)).status,'miss');});
test('unrelated membership changes preserve selective-scoped cache reuse',async t=>{const f=storeFixture(t),scope=f.registry.capture([{selector:selector('a'),polarity:'negative-membership'}]),d=descriptor(f,scope);await f.store.publish(d,{value:1});f.registry.advance([selector('b')]);assert.equal((await f.store.get(d)).status,'hit');});
test('foreign/restarted registries cannot replay persistent scoped authority',async t=>{const f=storeFixture(t),d=descriptor(f,f.registry.capture([],{snapshotOnly:true}));await f.store.publish(d,{value:1});const newStore=new ArtifactStore({backend:f.backend});t.after(()=>newStore.close());assert.equal((await newStore.get(d)).status,'miss');});
test('scope token requires every positive artifact dependency in the key',()=>{const f=fixture(),r=new DependencyEpochRegistry({world:f.world});try{const token=r.capture([],{positiveArtifactIds:['art_missing']});assert.throws(()=>descriptor(f,token),/upstream-missing/);}finally{r.close();}});
test('positive artifact removal invalidates scoped consumer even with unchanged membership',async t=>{const f=storeFixture(t),up=descriptor(f,null,{artifactKind:'upstream'});await f.store.publish(up,{value:1});const scope=f.registry.capture([],{positiveArtifactIds:[up.artifactId]}),down=descriptor(f,scope,{upstreamArtifactIds:[up.artifactId]});await f.store.publish(down,{value:2});await f.store.delete(up.artifactId);assert.equal((await f.store.get(down)).status,'miss');});
test('scope invalidated during async validation is never written',async t=>{const f=storeFixture(t),d=descriptor(f,f.registry.capture([],{snapshotOnly:true}));await assert.rejects(f.store.publish(d,{value:1},{validate:async()=>{f.registry.reset('race');return true;}}),/not-current/);assert.equal(f.backend.entries.size,0);assert.equal(f.store.metrics.publishes,0);});
test('scope invalidated DURING atomic write rolls back persistent bytes and hot publication',async t=>{
 let mutate=()=>{};class RacingBackend extends MemoryArtifactBackend{async putAtomic(...args){const r=await super.putAtomic(...args);mutate();return r;}}
 const f=storeFixture(t,new RacingBackend()),d=descriptor(f,f.registry.capture([],{snapshotOnly:true}));mutate=()=>f.registry.reset('write-race');await assert.rejects(f.store.publish(d,{value:1}),/changed-during-publish/);assert.equal(f.backend.entries.size,0);assert.equal(f.store.metrics.publishes,0);assert.equal((await f.store.get(d)).status,'miss');
});
test('registry retirement is irreversible within the same store',async t=>{const f=fixture(),r=new DependencyEpochRegistry({world:f.world}),s=new ArtifactStore({backend:new MemoryArtifactBackend()});t.after(()=>s.close());const off=s.registerDependencyRegistry(r);off();off();assert.throws(()=>s.registerDependencyRegistry(r),/retired/);r.close();});
function producerFixture(t){
 const binaryId='bin_sha256_'+'ab'.repeat(32),sliceId=createSliceId({binaryId,index:0,architecture:'arm64'}),f=fixture(d=>{d.binarySet[0].binaryId=binaryId;d.binarySet[0].sliceId=sliceId;});
 const bytes=new Uint8Array(rows.length*4),dv=new DataView(bytes.buffer);rows.forEach((r,i)=>dv.setUint32(i*4,r.word,true));
 const store=new ArtifactStore({backend:new MemoryArtifactBackend()}),runtime=new ArtifactAnalysisOrchestrator({store});t.after(()=>runtime.close());const calls={read:0,chunk:0,worker:0};
 const backend={gen:1,transportEpoch:1,file:new Blob([bytes]),_artifactRuntime:()=>runtime,readAt:async()=>{calls.read++;return{found:true,bytes:bytes.slice(),fileOffset:64n};},fetchChunk:async()=>{calls.chunk++;return{bytes:bytes.slice(),mn:rows.map(r=>r.mn),ops:rows.map(r=>r.ops)};},_callTo:async(_route,_method,msg)=>{calls.worker++;const result=analyzeSemanticFunction(msg.input,{canonicalProjectionOnly:msg.scopedCanonicalProjection});return msg.scopedLocalProjection?{...result,scopedLocal:projectScopedLocalOwners(result,msg.scopedLocalProjection)}:result;}};
 const options={...f,binaryId,sliceIndex:0,snapshotId:'snap',architecture:'arm64',abiId:'aapcs64',platform:'unknown',dataEndianness:'little',region:{id:'text',exec:true,vmAddr:0x1000n,size:bytes.length},address:0x1000n,length:bytes.length,isCurrent:()=>true};
 return{...f,options,backend,calls,bytes,run:(extra={})=>produceScopedArm64Pipeline(backend,{...options,work:workFor(t),...extra})};
}
test('native bytes -> real owners -> canonical ArtifactStore round-trip preserves conservative partial-cache policy',async t=>{
 const f=producerFixture(t),cold=await f.run();assert.equal(cold.status,'completed');assert.equal(cold.reused,false);assert.equal(cold.pipeline.instrumentation.v2Executed,true);assert.equal(cold.pipeline.memorySsa.snapshotId,'snap');assert.equal(cold.pipeline.semanticIr.nodes.length>0,true);
 // The canonical scheduler deliberately refuses incomplete cache entries.
 // Do not relabel a partial semantic result as complete to force a cache hit.
 const warm=await f.run();assert.equal(warm.reused,false);assert.equal(f.calls.worker,2);assert.equal(f.calls.chunk,2);assert.equal(f.calls.read,2);assert.equal(warm.artifactId,cold.artifactId);assert.equal(cold.completeness,'partial');
 // Exact file offsets from readAt, not a guessed region/display offset.
 assert.ok(cold.pipeline.semanticIr.nodes.some(n=>n.origin?.byteRanges?.some(r=>r.start==='64')));
});
test('different source snapshot produces a distinct artifact identity and bound MemorySSA',async t=>{const f=producerFixture(t),a=await f.run(),b=await f.run({snapshotId:'snap-2'});assert.notEqual(a.artifactId,b.artifactId);assert.equal(b.pipeline.memorySsa.snapshotId,'snap-2');assert.equal(f.calls.worker,2);});
for(const kind of ['summary','types'])test(`native ${kind} projection executes on canonical worker route`,async t=>{const f=producerFixture(t),localProjection=kind==='types'?{kind,entityIds:['missing']}:{kind};const r=await f.run({localProjection});assert.equal(r.localProjection.kind,kind);assert.equal(r.localProjection.worldId,f.world.id);assert.equal(r.localProjection.exact,false);});
test('arm64e does not silently borrow A64 semantics or ABI',async t=>{const f=producerFixture(t),r=await f.run({architecture:'arm64e'});assert.equal(r.status,'unsupported');assert.equal(f.calls.worker,0);assert.equal(f.calls.read,0);});
for(const override of [{length:3},{length:16388},{address:0x1001n},{region:{id:'text',exec:false,vmAddr:0x1000n,size:20}},{sliceIndex:-1}])test('native producer rejects invalid range geometry before decoding',async t=>{const f=producerFixture(t);await assert.rejects(f.run(override));assert.equal(f.calls.worker,0);});
test('decoder/source byte disagreement fails before semantic analysis and cache publication',async t=>{const f=producerFixture(t),fetch=f.backend.fetchChunk;f.backend.fetchChunk=async()=>{const chunk=await fetch();chunk.bytes[0]^=1;return chunk;};await assert.rejects(f.run(),/decode-byte-mismatch/);assert.equal(f.calls.worker,0);assert.equal(f.backend._artifactRuntime().store.metrics.publishes,0);});
test('file epoch change during read blocks mixed-generation pipeline',async t=>{const f=producerFixture(t),read=f.backend.readAt;f.backend.readAt=async()=>{const r=await read();f.backend.gen++;return r;};await assert.rejects(f.run(),/stale/);assert.equal(f.calls.worker,0);});
test('incomplete source byte read returns unsupported and never fills gaps with zero',async t=>{const f=producerFixture(t);f.backend.readAt=async()=>({found:true,bytes:new Uint8Array(4),fileOffset:0});assert.equal((await f.run()).reason,'scoped-arm64-byte-source-incomplete');assert.equal(f.calls.worker,0);});
test('invalid worker payload fails strict publication validation',async t=>{const f=producerFixture(t);f.backend._callTo=async()=>({pipeline:{},projection:'canonical-only',abiId:'aapcs64'});await assert.rejects(f.run(),/validation-not-passed/);assert.equal(f.backend._artifactRuntime().store.metrics.publishes,0);});

test('quarantine requires the exact store-issued read receipt and rejects serialized or foreign authority', async t => {
  const f = storeFixture(t), d = descriptor(f); await f.store.publish(d, { value: 1 });
  const observed = await f.store.get(d, { observeForQuarantine: true });
  await assert.rejects(f.store.quarantineObserved(structuredClone(observed), { reason: 'source-byte-rejection' }), /observation-required/);
  const other = storeFixture(t);
  await assert.rejects(other.store.quarantineObserved(observed, { reason: 'integrity-rejection' }), /observation-required/);
  await assert.rejects(f.store.quarantineObserved(observed, { reason: 'unknown' }), /observation-required/);
  assert.equal((await f.store.get(d)).status, 'hit');
  const verdict = await f.store.quarantineObserved(observed, { reason: 'source-byte-rejection' });
  assert.equal(verdict.status, 'quarantined'); assert.equal(verdict.persistentWithdrawal, true);
  assert.equal((await f.store.get(d)).status, 'quarantined');
});
test('quarantine of a superseded observation leaves a newer atomic publication readable', async t => {
  const f = storeFixture(t), d = descriptor(f); await f.store.publish(d, { value: 1 });
  const old = await f.store.get(d, { observeForQuarantine: true });
  await f.store.delete(d.artifactId);
  await f.store.publish(d, { value: 2 });
  const verdict = await f.store.quarantineObserved(old, { reason: 'semantic-contradiction' });
  assert.equal(verdict.status, 'stale'); assert.equal((await f.store.get(d)).payload.value, 2);
});
