import assert from 'node:assert/strict';
import { ArtifactStore, MemoryArtifactBackend, createArtifactDescriptor } from '../../../js/core/artifacts/index.js';
import { AnalysisScheduler } from '../../../js/core/scheduler/index.js';

function descriptor(name) {
  return createArtifactDescriptor({
    binaryId:'bin_scheduler_strict', artifactKind:`fixture-${name}`, producerId:`fixture-${name}`, producerVersion:'1',
    versions:{ loader:'fixture-1' }, relevance:{ architectureSemantic:false, abiSemantic:false, semanticSchema:false }, config:{name},
  });
}
function scheduler() { return new AnalysisScheduler({ store:new ArtifactStore({ backend:new MemoryArtifactBackend() }), maxConcurrency:1 }); }
async function waitFor(predicate, message) {
  for (let i=0;i<200;i++) { if (predicate()) return; await Promise.resolve(); }
  throw new Error(message);
}

// #2947: malformed artifactId must fail before inflight coalescing.
{
  const s=scheduler();
  const good=descriptor('good');
  let release;
  const p=s.request({descriptor:good,produce:()=>new Promise((resolve)=>{release=()=>resolve({ok:true});})});
  await waitFor(() => typeof release === 'function', 'producer did not start');
  const malformed={...good, artifactId:[good.artifactId]};
  await assert.rejects(s.request({descriptor:malformed,produce:async()=>({bad:true})}), /artifact-request-descriptor-required/);
  release();
  await p;
}

// #2948: if abort happens in the check->listen window, post-registration recheck rejects.
{
  const s=scheduler();
  const item=descriptor('abort-race');
  let checks=0;
  const signal={
    reason:new DOMException('cancelled','AbortError'),
    get aborted(){ checks++; return checks >= 3; },
    addEventListener(){},
    removeEventListener(){},
  };
  await assert.rejects(
    s.request({descriptor:item,signal,produce:async()=>({ok:true})}),
    (error)=>error?.name==='AbortError',
  );
  assert.ok(checks >= 3);
  await Promise.resolve();
}

// #3336: public scheduler lookups must not coerce structured IDs into the ID
// of a real task. String "abc" keeps its normal lifecycle authority; ["abc"]
// fails before it can read or cancel that task.
{
  const store={
    get:async()=>({status:'miss'}),
    publish:async()=>({status:'stored'}),
  };
  const s=new AnalysisScheduler({store,maxConcurrency:1});
  let producerStarted=false;
  const p=s.request({
    descriptor:{artifactId:'abc',upstreamArtifactIds:[]},
    produce:({signal})=>new Promise((resolve,reject)=>{
      producerStarted=true;
      signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    }),
  });
  await waitFor(()=>producerStarted,'abc producer did not start');

  assert.equal(s.state('abc'),'running');
  assert.deepEqual(s.dependencyIds('abc'),[]);
  assert.throws(()=>s.cancel(['abc']),/artifact-id-required/);
  assert.throws(()=>s.state(['abc']),/artifact-id-required/);
  assert.throws(()=>s.dependencyIds(['abc']),/artifact-id-required/);
  assert.equal(s.state('abc'),'running','structured lookup must not affect the real task');

  assert.equal(s.cancel('abc'),true,'canonical string ID keeps cancellation authority');
  await assert.rejects(p,(error)=>error?.name==='AbortError');
}

console.log('phase4 scheduler strict authority boundaries: PASS');
