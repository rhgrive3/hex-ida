import assert from 'node:assert/strict';
import { deferred, descriptor, scheduler, waitState } from './helpers.mjs';

// Ready/queued task: a foreground consumer must upgrade an incumbent
// background task before the next dispatch decision.
{
  const { scheduler: s } = scheduler({ maxConcurrency: 1, starvationInterval: 8 });
  const gate = deferred();
  const blocker = descriptor('issue-5043-ready-blocker');
  const target = descriptor('issue-5043-ready-target');
  const other = descriptor('issue-5043-ready-other');
  const order = [];

  const blockerPromise = s.request({
    descriptor: blocker,
    priority: 'foreground',
    produce: async () => {
      order.push('blocker');
      await gate.promise;
      return {};
    },
  });
  await waitState(s, blocker.artifactId, 'running');

  let targetProduces = 0;
  const background = s.request({
    descriptor: target,
    priority: 'background',
    produce: async () => {
      targetProduces++;
      order.push('target');
      return { source: 'background' };
    },
  });
  await waitState(s, target.artifactId, 'ready');

  const current = s.request({
    descriptor: other,
    priority: 'current',
    produce: async () => {
      order.push('other');
      return {};
    },
  });
  await waitState(s, other.artifactId, 'ready');

  const foreground = s.request({
    descriptor: target,
    priority: 'foreground',
    produce: async () => {
      throw new Error('coalesced producer must not run');
    },
  });

  gate.resolve({});
  const [, backgroundResult, , foregroundResult] = await Promise.all([
    blockerPromise,
    background,
    current,
    foreground,
  ]);

  assert.deepEqual(order, ['blocker', 'target', 'other']);
  assert.equal(targetProduces, 1);
  assert.deepEqual(foregroundResult.payload, backgroundResult.payload);
  assert.equal(s.stats().coalescedRequests, 1);
}

// Prefetch -> current upgrade uses the same effective-priority rule.
{
  const { scheduler: s } = scheduler({ maxConcurrency: 1, starvationInterval: 8 });
  const gate = deferred();
  const blocker = descriptor('issue-5043-prefetch-blocker');
  const target = descriptor('issue-5043-prefetch-target');
  const backgroundOther = descriptor('issue-5043-prefetch-background-other');
  const order = [];

  const blockerPromise = s.request({ descriptor: blocker, produce: () => gate.promise });
  await waitState(s, blocker.artifactId, 'running');
  const prefetch = s.request({
    descriptor: target,
    priority: 'prefetch',
    produce: async () => { order.push('target'); return {}; },
  });
  await waitState(s, target.artifactId, 'ready');
  const background = s.request({
    descriptor: backgroundOther,
    priority: 'background',
    produce: async () => { order.push('background'); return {}; },
  });
  await waitState(s, backgroundOther.artifactId, 'ready');
  const current = s.request({ descriptor: target, priority: 'current', produce: async () => ({}) });

  gate.resolve({});
  await Promise.all([blockerPromise, prefetch, background, current]);
  assert.deepEqual(order, ['target', 'background']);
}

// A lower-priority coalesced consumer never downgrades a queued task.
{
  const events = [];
  const { scheduler: s } = scheduler({
    maxConcurrency: 1,
    starvationInterval: 8,
    onEvent: (event) => events.push(event),
  });
  const gate = deferred();
  const blocker = descriptor('issue-5043-no-downgrade-blocker');
  const target = descriptor('issue-5043-no-downgrade-target');
  const other = descriptor('issue-5043-no-downgrade-other');
  const order = [];

  const blockerPromise = s.request({ descriptor: blocker, produce: () => gate.promise });
  await waitState(s, blocker.artifactId, 'running');
  const current = s.request({
    descriptor: target,
    priority: 'current',
    produce: async () => { order.push('target'); return {}; },
  });
  await waitState(s, target.artifactId, 'ready');
  const prefetch = s.request({
    descriptor: other,
    priority: 'prefetch',
    produce: async () => { order.push('other'); return {}; },
  });
  await waitState(s, other.artifactId, 'ready');
  const lower = s.request({ descriptor: target, priority: 'maintenance', produce: async () => ({}) });

  gate.resolve({});
  await Promise.all([blockerPromise, current, prefetch, lower]);
  assert.deepEqual(order, ['target', 'other']);
  const started = events.find((event) => event.type === 'job.started' && event.artifactId === target.artifactId);
  assert.equal(started?.details.priority, 'current');
}

// While a task is waiting on dependencies, a higher-priority consumer updates
// the priority that will be used when that task eventually enters the heap.
{
  const events = [];
  const { scheduler: s } = scheduler({
    maxConcurrency: 1,
    starvationInterval: 8,
    onEvent: (event) => events.push(event),
  });
  const dependencyGate = deferred();
  const dependency = descriptor('issue-5043-dependency');
  const target = descriptor('issue-5043-dependency-target', [dependency]);

  const background = s.request({
    descriptor: target,
    priority: 'background',
    dependencies: [{
      descriptor: dependency,
      priority: 'foreground',
      produce: () => dependencyGate.promise,
    }],
    produce: async () => ({ target: true }),
  });
  await waitState(s, dependency.artifactId, 'running');
  assert.equal(s.state(target.artifactId), 'waiting-dependency');

  const foreground = s.request({
    descriptor: target,
    priority: 'foreground',
    dependencies: [{ descriptor: dependency, produce: async () => ({}) }],
    produce: async () => {
      throw new Error('coalesced producer must not run');
    },
  });

  dependencyGate.resolve({ dependency: true });
  await Promise.all([background, foreground]);
  const enqueued = events.find((event) => event.type === 'queue.enqueued' && event.artifactId === target.artifactId);
  const started = events.find((event) => event.type === 'job.started' && event.artifactId === target.artifactId);
  assert.equal(enqueued?.details.priority, 'foreground');
  assert.equal(started?.details.priority, 'foreground');
}

// Reprioritizing a non-root heap entry must keep heap indices coherent. A
// subsequent queued cancellation exercises remove() after refresh()/swaps.
{
  const { scheduler: s } = scheduler({ maxConcurrency: 1, starvationInterval: 16 });
  const gate = deferred();
  const blocker = descriptor('issue-5043-heap-blocker');
  const items = Array.from({ length: 12 }, (_, index) => descriptor(`issue-5043-heap-${String(index).padStart(2, '0')}`));
  const order = [];
  const controllers = items.map(() => new AbortController());

  const blockerPromise = s.request({ descriptor: blocker, produce: () => gate.promise });
  await waitState(s, blocker.artifactId, 'running');
  const queued = items.map((item, index) => s.request({
    descriptor: item,
    priority: index % 2 ? 'background' : 'maintenance',
    signal: controllers[index].signal,
    produce: async () => { order.push(index); return { index }; },
  }));
  for (const item of items) await waitState(s, item.artifactId, 'ready');

  const upgraded = s.request({ descriptor: items[10], priority: 'foreground', produce: async () => ({}) });
  controllers[4].abort(new DOMException('cancel queued heap entry', 'AbortError'));
  await assert.rejects(queued[4], (error) => error?.name === 'AbortError');

  gate.resolve({});
  await Promise.all([blockerPromise, ...queued.filter((_, index) => index !== 4), upgraded]);
  assert.equal(order[0], 10);
  assert.equal(order.includes(4), false);
  assert.equal(new Set(order).size, items.length - 1);
  assert.equal(s.stats().queued, 0);
}

// Cancelling the consumer that caused the upgrade must not downgrade or abort
// the shared producer while another consumer remains attached.
{
  const { scheduler: s } = scheduler({ maxConcurrency: 1, starvationInterval: 8 });
  const gate = deferred();
  const blocker = descriptor('issue-5043-cancel-blocker');
  const target = descriptor('issue-5043-cancel-target');
  const other = descriptor('issue-5043-cancel-other');
  const order = [];
  const controller = new AbortController();

  const blockerPromise = s.request({ descriptor: blocker, produce: () => gate.promise });
  await waitState(s, blocker.artifactId, 'running');
  let targetProduces = 0;
  const background = s.request({
    descriptor: target,
    priority: 'background',
    produce: async () => { targetProduces++; order.push('target'); return {}; },
  });
  await waitState(s, target.artifactId, 'ready');
  const currentOther = s.request({
    descriptor: other,
    priority: 'current',
    produce: async () => { order.push('other'); return {}; },
  });
  await waitState(s, other.artifactId, 'ready');

  const foreground = s.request({
    descriptor: target,
    priority: 'foreground',
    signal: controller.signal,
    produce: async () => ({ unexpected: true }),
  });
  controller.abort(new DOMException('foreground consumer left', 'AbortError'));
  await assert.rejects(foreground, (error) => error?.name === 'AbortError');

  gate.resolve({});
  await Promise.all([blockerPromise, background, currentOther]);
  assert.deepEqual(order, ['target', 'other']);
  assert.equal(targetProduces, 1);
  assert.equal(s.stats().orphanCancellations, 0);
}

// A consumer that fails during listener registration must not mutate the shared
// task's effective priority. The failed attach is not scheduling authority.
{
  const { scheduler: s } = scheduler({ maxConcurrency: 1, starvationInterval: 8 });
  const gate = deferred();
  const blocker = descriptor('issue-5043-attach-fail-blocker');
  const target = descriptor('issue-5043-attach-fail-target');
  const other = descriptor('issue-5043-attach-fail-other');
  const order = [];

  const blockerPromise = s.request({ descriptor: blocker, produce: () => gate.promise });
  await waitState(s, blocker.artifactId, 'running');
  const background = s.request({
    descriptor: target,
    priority: 'background',
    produce: async () => { order.push('target'); return {}; },
  });
  await waitState(s, target.artifactId, 'ready');
  const current = s.request({
    descriptor: other,
    priority: 'current',
    produce: async () => { order.push('other'); return {}; },
  });
  await waitState(s, other.artifactId, 'ready');

  const hostileSignal = {
    aborted: false,
    addEventListener() { throw new Error('listener-registration-failed'); },
    removeEventListener() {},
  };
  await assert.rejects(
    s.request({ descriptor: target, priority: 'foreground', signal: hostileSignal, produce: async () => ({}) }),
    /listener-registration-failed/,
  );

  gate.resolve({});
  await Promise.all([blockerPromise, background, current]);
  assert.deepEqual(order, ['other', 'target']);
}

// Coalescing onto an already running task remains single-flight. Running work
// is not rescheduled or restarted just because a stronger consumer arrived.
{
  const { scheduler: s } = scheduler({ maxConcurrency: 1 });
  const gate = deferred();
  const target = descriptor('issue-5043-running-target');
  let produces = 0;
  const background = s.request({
    descriptor: target,
    priority: 'background',
    produce: async () => { produces++; await gate.promise; return { ok: true }; },
  });
  await waitState(s, target.artifactId, 'running');
  const foreground = s.request({
    descriptor: target,
    priority: 'foreground',
    produce: async () => { produces++; return { wrong: true }; },
  });
  gate.resolve();
  const [first, second] = await Promise.all([background, foreground]);
  assert.equal(produces, 1);
  assert.deepEqual(second.payload, first.payload);
}

console.log('issue-5043 coalesced priority upgrade: PASS');
