import assert from 'node:assert/strict';
import { createArtifactDescriptor } from '../../js/core/artifacts/contracts.js';
import { AnalysisScheduler } from '../../js/core/scheduler/analysis-scheduler.js';

function descriptor() {
  return createArtifactDescriptor({
    binaryId: 'binary-4490',
    artifactKind: 'analysis',
    producerId: 'producer-4490',
    producerVersion: '1',
    loaderVersion: '1',
    architectureSemanticVersion: '1',
    abiSemanticVersion: '1',
    semanticSchemaVersion: '1',
    upstreamArtifactIds: [],
  });
}

function store() {
  return {
    async get() { return { status:'miss' }; },
    async publish(currentDescriptor, payload) {
      return { record:{ artifactId:currentDescriptor.artifactId }, payload };
    },
  };
}

{
  const canonical = descriptor();
  const scheduler = new AnalysisScheduler({ store:store(), maxConcurrency:1 });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let canonicalRuns = 0;
  let forgedRuns = 0;

  const canonicalRequest = scheduler.request({
    descriptor: canonical,
    dependencies: [],
    produce: async () => {
      canonicalRuns++;
      await gate;
      return { from:'canonical' };
    },
  });

  const forged = {
    ...canonical,
    producerId: 'forged-producer',
    upstreamArtifactIds: ['different-upstream'],
  };
  await assert.rejects(
    scheduler.request({
      descriptor: forged,
      dependencies: [],
      produce: async () => {
        forgedRuns++;
        return { from:'forged' };
      },
    }),
    (error) => error?.code === 'artifact-descriptor-noncanonical',
  );

  assert.equal(scheduler.stats().coalescedRequests, 0);
  assert.equal(forgedRuns, 0);
  release();
  const result = await canonicalRequest;
  assert.equal(result.payload.from, 'canonical');
  assert.equal(canonicalRuns, 1);
}

{
  const canonical = descriptor();
  const scheduler = new AnalysisScheduler({ store:store(), maxConcurrency:1 });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let firstRuns = 0;
  let secondRuns = 0;

  const first = scheduler.request({
    descriptor: canonical,
    dependencies: [],
    produce: async () => {
      firstRuns++;
      await gate;
      return { from:'first' };
    },
  });
  const second = scheduler.request({
    descriptor: canonical,
    dependencies: [],
    produce: async () => {
      secondRuns++;
      return { from:'second' };
    },
  });

  assert.equal(scheduler.stats().coalescedRequests, 1);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstRuns, 1);
  assert.equal(secondRuns, 0);
  assert.equal(firstResult.payload.from, 'first');
  assert.equal(secondResult.payload.from, 'first');
}

{
  const canonical = descriptor();
  const scheduler = new AnalysisScheduler({ store:store() });
  await assert.rejects(
    scheduler.request({
      descriptor: { ...canonical },
      dependencies: [],
      produce: async () => ({ ok:true }),
    }),
    (error) => error?.code === 'artifact-descriptor-noncanonical',
  );
  assert.equal(scheduler.stats().requests, 0);
  assert.equal(scheduler.stats().inflight, 0);
}

console.log('issue-4490 scheduler canonical descriptor: ok');
