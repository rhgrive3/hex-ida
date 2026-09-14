import assert from 'node:assert/strict';
import { deferred, descriptor, scheduler, waitState } from './helpers.mjs';

function injectAbortBeforeThirdRegistration(schedulerInstance, artifactId) {
  const addDescriptor = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'addEventListener');
  const removeDescriptor = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'removeEventListener');
  const originalAdd = AbortSignal.prototype.addEventListener;
  const originalRemove = AbortSignal.prototype.removeEventListener;
  let rootSignal = null;
  let registrations = 0;
  let injected = false;
  let cancelResult = null;
  let raceListener = null;
  let raceListenerRemoved = false;

  Object.defineProperty(AbortSignal.prototype, 'addEventListener', {
    configurable: true,
    writable: true,
    value(type, listener, options) {
      if (type === 'abort') {
        if (rootSignal == null) rootSignal = this;
        if (this === rootSignal) {
          registrations++;
          if (!injected && registrations === 3) {
            injected = true;
            raceListener = listener;
            // Re-enter scheduler cancellation before the actual registration.
            // This deterministically models the check -> subscribe gap.
            cancelResult = schedulerInstance.cancel(artifactId, new DOMException('registration-race', 'AbortError'));
          }
        }
      }
      return originalAdd.call(this, type, listener, options);
    },
  });
  Object.defineProperty(AbortSignal.prototype, 'removeEventListener', {
    configurable: true,
    writable: true,
    value(type, listener, options) {
      if (this === rootSignal && type === 'abort' && listener === raceListener) raceListenerRemoved = true;
      return originalRemove.call(this, type, listener, options);
    },
  });

  const restoreProperty = (name, descriptor) => {
    if (descriptor) Object.defineProperty(AbortSignal.prototype, name, descriptor);
    else delete AbortSignal.prototype[name];
  };
  return {
    snapshot() { return { injected, cancelResult, registrations, raceListenerRemoved }; },
    restore() {
      restoreProperty('addEventListener', addDescriptor);
      restoreProperty('removeEventListener', removeDescriptor);
    },
  };
}

async function flushMicrotasks(turns = 30) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

// Minimal #5281 regression: abort lands after the initial `aborted` check but
// before the dependency-wait listener is actually registered. The post-
// registration check must prevent any dependency work from starting.
{
  const { store, scheduler: s } = scheduler({ maxConcurrency: 2 });
  const dep = descriptor('5281-race-dep');
  const root = descriptor('5281-race-root', [dep]);
  let dependencyInvocations = 0;
  let parentInvocations = 0;
  const race = injectAbortBeforeThirdRegistration(s, root.artifactId);
  try {
    const promise = s.request({
      descriptor: root,
      dependencies: [{
        descriptor: dep,
        produce: async () => {
          dependencyInvocations++;
          return { ok: true };
        },
      }],
      produce: async () => {
        parentInvocations++;
        return { ok: true };
      },
    });

    await assert.rejects(promise, (error) => error?.name === 'AbortError');
    await flushMicrotasks();

    assert.deepEqual(race.snapshot(), { injected: true, cancelResult: true, registrations: 3, raceListenerRemoved: true });
    assert.equal(dependencyInvocations, 0, 'dependency must not start after the parent abort registration race');
    assert.equal(parentInvocations, 0);
    assert.equal(store.entries.has(dep.artifactId), false);
    assert.equal(store.entries.has(root.artifactId), false);
    assert.equal(s.state(root.artifactId), 'cancelled');
    assert.equal(s.state(dep.artifactId), 'unknown');
  } finally {
    race.restore();
  }
}

// A pre-aborted parent signal still fails closed before dependency production.
{
  const { store, scheduler: s } = scheduler({ maxConcurrency: 2 });
  const dep = descriptor('5281-preabort-dep');
  const root = descriptor('5281-preabort-root', [dep]);
  const controller = new AbortController();
  controller.abort(new DOMException('pre-aborted', 'AbortError'));
  let dependencyInvocations = 0;
  await assert.rejects(s.request({
    descriptor: root,
    signal: controller.signal,
    dependencies: [{ descriptor: dep, produce: async () => { dependencyInvocations++; return {}; } }],
    produce: async () => assert.fail('pre-aborted parent producer ran'),
  }), (error) => error?.name === 'AbortError');
  await flushMicrotasks();
  assert.equal(dependencyInvocations, 0);
  assert.equal(store.entries.size, 0);
}

// The same registration race must not abort or detach an already-live shared
// dependency that still has another consumer.
{
  const { scheduler: s } = scheduler({ maxConcurrency: 2 });
  const dep = descriptor('5281-shared-dep');
  const root = descriptor('5281-shared-root', [dep]);
  const gate = deferred();
  let sharedInvocations = 0;
  const shared = s.request({
    descriptor: dep,
    produce: async ({ signal }) => {
      sharedInvocations++;
      await gate.promise;
      if (signal.aborted) throw signal.reason;
      return { shared: true };
    },
  });
  await waitState(s, dep.artifactId, 'running');

  const race = injectAbortBeforeThirdRegistration(s, root.artifactId);
  try {
    const rootPromise = s.request({
      descriptor: root,
      dependencies: [{ descriptor: dep, produce: async () => assert.fail('shared dependency producer duplicated') }],
      produce: async () => assert.fail('cancelled parent producer ran'),
    });
    await assert.rejects(rootPromise, (error) => error?.name === 'AbortError');
    await flushMicrotasks();
    assert.equal(race.snapshot().injected, true);
    assert.equal(race.snapshot().raceListenerRemoved, true, 'late parent listener must be removed after dependency wait settles');
    assert.equal(s.stats().activeConsumers, 1, 'only the independent shared dependency consumer should remain');
    gate.resolve();
    const result = await shared;
    assert.equal(result.payload.shared, true);
    assert.equal(sharedInvocations, 1);
  } finally {
    race.restore();
  }
}

console.log('issue-5281 dependency abort registration race: PASS');
