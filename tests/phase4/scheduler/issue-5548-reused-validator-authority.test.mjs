import assert from 'node:assert/strict';
import {
  ArtifactStore,
  MemoryArtifactBackend,
  createArtifactDescriptor,
} from '../../../js/core/artifacts/index.js';
import { AnalysisScheduler } from '../../../js/core/scheduler/analysis-scheduler.js';

function descriptor(name) {
  return createArtifactDescriptor({
    binaryId:'bin_phase4_scheduler_5548_reused',
    artifactKind:'phase4-scheduler-validator-fixture',
    producerId:'issue-5548-reused-regression',
    producerVersion:'1',
    versions:{ loader:'fixture-1' },
    relevance:{ architectureSemantic:false, abiSemantic:false, semanticSchema:false },
    config:{ name },
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise=new Promise((yes,no)=>{ resolve=yes; reject=no; });
  return { promise,resolve,reject };
}

async function waitState(scheduler, artifactId, state, turns=1000) {
  for (let i=0;i<turns;i++) {
    if (scheduler.state(artifactId)===state) return;
    await Promise.resolve();
  }
  assert.fail(`state ${state} not reached for ${artifactId}; got ${scheduler.state(artifactId)}`);
}

function scheduler() {
  return new AnalysisScheduler({
    store:new ArtifactStore({ backend:new MemoryArtifactBackend() }),
    maxConcurrency:1,
  });
}

// A request-specific validator is still authoritative when the producer has
// already settled and the scheduler serves the result from the ArtifactStore.
{
  const s=scheduler();
  const d=descriptor('sequential-cache-hit');
  let producerCalls=0;
  let rejectingValidatorCalls=0;
  let acceptingValidatorCalls=0;

  const first=await s.request({
    descriptor:d,
    produce:async()=>{
      producerCalls++;
      return { route:'first', nested:{ stable:true } };
    },
  });
  assert.equal(first.payload.route,'first');

  await assert.rejects(
    s.request({
      descriptor:d,
      validate:(payload)=>{
        rejectingValidatorCalls++;
        assert.equal(payload.route,'first');
        payload.route='validator-local-mutation';
        return false;
      },
      produce:async()=>{
        producerCalls++;
        return { route:'second' };
      },
    }),
    (error)=>error?.name==='ArtifactStorageError'&&error?.code==='artifact-validation-not-passed',
  );

  const third=await s.request({
    descriptor:d,
    validate:(payload)=>{
      acceptingValidatorCalls++;
      return payload.route==='first'&&payload.nested.stable===true;
    },
    produce:async()=>{
      producerCalls++;
      return { route:'third' };
    },
  });

  assert.equal(third.payload.route,'first');
  assert.equal(producerCalls,1,'cache reuse must not invoke a replacement producer');
  assert.equal(rejectingValidatorCalls,1,'cache-hit validator must run exactly once');
  assert.equal(acceptingValidatorCalls,1,'later cache-hit validator must still see canonical cached data');
  assert.equal(s.stats().cacheHits,2);
}

// A coalesced consumer validates a detached canonical snapshot. Mutating the
// validator arguments must not rewrite the shared result seen by any waiter.
{
  const s=scheduler();
  const d=descriptor('coalesced-mutation-isolation');
  const gate=deferred();
  let producerCalls=0;
  let validatorCalls=0;

  const first=s.request({
    descriptor:d,
    produce:async()=>{
      producerCalls++;
      await gate.promise;
      return { ok:true, nested:{ owner:'producer' } };
    },
  });
  await waitState(s,d.artifactId,'running');

  const mutating=s.request({
    descriptor:d,
    validate:(payload,record)=>{
      validatorCalls++;
      payload.ok=false;
      payload.nested.owner='validator';
      record.completeness='partial';
      record.versions.loader='validator';
      return true;
    },
    produce:async()=>{
      producerCalls++;
      return { ok:false };
    },
  });

  const observer=s.request({
    descriptor:d,
    produce:async()=>{
      producerCalls++;
      return { ok:false };
    },
  });

  gate.resolve();
  const [firstResult,mutatingResult,observerResult]=await Promise.all([first,mutating,observer]);

  for (const result of [firstResult,mutatingResult,observerResult]) {
    assert.equal(result.payload.ok,true);
    assert.equal(result.payload.nested.owner,'producer');
    assert.equal(result.record.completeness,'complete');
    assert.equal(result.record.versions.loader,'fixture-1');
  }
  assert.equal(producerCalls,1,'all compatible consumers must retain one producer');
  assert.equal(validatorCalls,1);
  assert.equal(s.stats().coalescedRequests,2);
}

console.log('issue #5548 reused validator authority: PASS');
