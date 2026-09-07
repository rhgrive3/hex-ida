import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalysisScheduler } from '../../js/core/scheduler/analysis-scheduler.js';

test('issue-6141: unknown accepted numeric priority is preserved in lifecycle events', async () => {
  const entries = new Map();
  const events = [];
  const store = {
    async get(descriptor) {
      return entries.has(descriptor.artifactId)
        ? { status: 'hit', artifactId: descriptor.artifactId, payload: entries.get(descriptor.artifactId) }
        : { status: 'miss', artifactId: descriptor.artifactId };
    },
    async publish(descriptor, payload) {
      entries.set(descriptor.artifactId, payload);
      return { status: 'published', artifactId: descriptor.artifactId, payload };
    },
  };
  const scheduler = new AnalysisScheduler({
    store,
    maxConcurrency: 1,
    onEvent: (event) => events.push(event),
  });

  const result = await scheduler.request({
    descriptor: { artifactId: 'artifact-6141-numeric-99', upstreamArtifactIds: [] },
    priority: 99,
    produce: async () => ({ complete: true }),
  });

  assert.equal(result.status, 'published');
  assert.deepEqual(
    events
      .filter((event) => ['request.received', 'queue.enqueued', 'job.started'].includes(event.type))
      .map((event) => event.details.priority),
    [99, 99, 99],
  );
});
