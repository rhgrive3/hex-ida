import assert from 'node:assert/strict';
import { createArtifactDescriptor } from '../../js/core/artifacts/contracts.js';
import { AnalysisScheduler } from '../../js/core/scheduler/analysis-scheduler.js';

function descriptor(label) {
  return createArtifactDescriptor({
    binaryId: `binary-4595-${label}`,
    artifactKind: 'analysis',
    producerId: 'producer-4595',
    producerVersion: '1',
    loaderVersion: '1',
    architectureSemanticVersion: '1',
    abiSemanticVersion: '1',
    semanticSchemaVersion: '1',
    upstreamArtifactIds: [],
  });
}

async function waitForIdle(scheduler) {
  for (let i = 0; i < 32; i++) {
    if (scheduler.stats().inflight === 0) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('scheduler-did-not-settle');
}

{
  const currentDescriptor = descriptor('committed');
  const controller = new AbortController();
  const events = [];
  let persisted = false;
  const store = {
    async get() { return { status:'miss' }; },
    async publish(descriptorValue, payload) {
      persisted = true;
      controller.abort(new DOMException('cancelled after durable commit', 'AbortError'));
      return { record:{ artifactId:descriptorValue.artifactId }, payload };
    },
  };
  const scheduler = new AnalysisScheduler({
    store,
    onEvent(event) { events.push(event); },
  });

  await assert.rejects(
    scheduler.request({
      descriptor: currentDescriptor,
      dependencies: [],
      signal: controller.signal,
      produce: async () => ({ committed:true }),
    }),
    (error) => error?.name === 'AbortError',
  );
  await waitForIdle(scheduler);

  assert.equal(persisted, true);
  assert.equal(scheduler.state(currentDescriptor.artifactId), 'completed');
  assert.equal(scheduler.stats().completedJobs, 1);
  assert.equal(scheduler.stats().cancelledJobs, 0);
  assert.equal(events.filter((event) => event.type === 'job.completed').length, 1);
  assert.equal(events.filter((event) => event.type === 'job.cancelled').length, 0);
}

{
  const currentDescriptor = descriptor('before-publish');
  const controller = new AbortController();
  let publishCalls = 0;
  const store = {
    async get() { return { status:'miss' }; },
    async publish() {
      publishCalls++;
      return { record:{ artifactId:currentDescriptor.artifactId }, payload:{} };
    },
  };
  const scheduler = new AnalysisScheduler({ store });

  await assert.rejects(
    scheduler.request({
      descriptor: currentDescriptor,
      dependencies: [],
      signal: controller.signal,
      produce: async () => {
        controller.abort(new DOMException('cancelled before publish', 'AbortError'));
        return { shouldNotPublish:true };
      },
    }),
    (error) => error?.name === 'AbortError',
  );
  await waitForIdle(scheduler);

  assert.equal(publishCalls, 0);
  assert.equal(scheduler.state(currentDescriptor.artifactId), 'cancelled');
  assert.equal(scheduler.stats().completedJobs, 0);
  assert.equal(scheduler.stats().cancelledJobs, 1);
}

{
  const currentDescriptor = descriptor('publish-failure');
  const controller = new AbortController();
  let publishCalls = 0;
  const store = {
    async get() { return { status:'miss' }; },
    async publish() {
      publishCalls++;
      controller.abort(new DOMException('cancelled while publish failed', 'AbortError'));
      throw new DOMException('publish did not commit', 'AbortError');
    },
  };
  const scheduler = new AnalysisScheduler({ store });

  await assert.rejects(
    scheduler.request({
      descriptor: currentDescriptor,
      dependencies: [],
      signal: controller.signal,
      produce: async () => ({ attempted:true }),
    }),
    (error) => error?.name === 'AbortError',
  );
  await waitForIdle(scheduler);

  assert.equal(publishCalls, 1);
  assert.equal(scheduler.state(currentDescriptor.artifactId), 'cancelled');
  assert.equal(scheduler.stats().completedJobs, 0);
  assert.equal(scheduler.stats().cancelledJobs, 1);
}

console.log('issue-4595 scheduler post-publish cancellation: ok');
