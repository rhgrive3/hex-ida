import assert from 'node:assert/strict';
import { AnalysisScheduler } from '../../../js/core/scheduler/analysis-scheduler.js';
import { deferred, descriptor } from './helpers.mjs';

console.log('Testing #4607 publish cancellation lifecycle phase...');

const publishEntered = deferred();
const publishRelease = deferred();
const events = [];
const external = new AbortController();

const store = {
  async get(desc, { signal } = {}) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    return { status:'miss', source:'memory', artifactId:desc.artifactId };
  },
  async publish(desc, payload, { signal } = {}) {
    publishEntered.resolve();
    await publishRelease.promise;
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    return { status:'published', artifactId:desc.artifactId, payload };
  },
};

const scheduler = new AnalysisScheduler({
  store,
  maxConcurrency:1,
  onEvent:(event) => events.push(event),
});
const desc = descriptor('issue-4607-publish-cancel');
const request = scheduler.request({
  descriptor:desc,
  signal:external.signal,
  produce:async () => ({ ok:true }),
});

await publishEntered.promise;
external.abort(new DOMException('cancelled in publish', 'AbortError'));
publishRelease.resolve();

await assert.rejects(request, (error) => error?.name === 'AbortError');

const ownEvents = events.filter((event) => event.artifactId === desc.artifactId);
const cancelled = ownEvents.filter((event) => event.type === 'job.cancelled');
const startedIndex = ownEvents.findIndex((event) => event.type === 'job.started');
const cancelledIndex = ownEvents.findIndex((event) => event.type === 'job.cancelled');

assert.equal(cancelled.length, 1, 'publish cancellation must emit one terminal cancellation event');
assert.equal(cancelled[0].details.phase, 'running', 'publish occupies the scheduler running slot');
assert.ok(startedIndex >= 0, 'publish cancellation must follow job.started');
assert.ok(cancelledIndex > startedIndex, 'a started job cannot later report waiting-dependency cancellation');
assert.equal(ownEvents.some((event) => event.type === 'job.completed'), false);
assert.equal(scheduler.state(desc.artifactId), 'cancelled');
assert.equal(scheduler.stats().cancelledJobs, 1);
assert.equal(scheduler.stats().completedJobs, 0);

console.log('  ok publish cancellation reports running exactly once');
