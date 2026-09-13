import test from 'node:test';
import assert from 'node:assert/strict';

import { PlatformPluginRegistry } from '../js/platform/plugin-api.js';

// #4743: settleWithin() read `signal.aborted` and only then subscribed the
// abort listener. An abort landing inside that window is never replayed by an
// AbortSignal, so the wrapper kept waiting for the plugin or the timeout even
// though the caller had already cancelled.

function hostContext() {
  return {
    pluginPolicy: { binaryRead: true },
    resourceBudget: { scope() { return this; }, consume() {} },
    async read(_address, length) { return new Uint8Array(length); },
    reportProgress() {},
  };
}

// Deterministic stand-in for a real signal that fires between the pre-
// registration `aborted` read and `addEventListener()`: the transition happens
// during subscription and the event itself was already dispatched.
function signalAbortedDuringSubscribe() {
  let aborted = false;
  return {
    get aborted() { return aborted; },
    reason: Object.assign(new Error('cancelled during subscribe'), { name: 'AbortError' }),
    addEventListener(type) { if (type === 'abort') aborted = true; },
    removeEventListener() {},
  };
}

function registryWithHangingAnalyzer(timeoutMs) {
  const registry = new PlatformPluginRegistry({ timeoutMs });
  let released = null;
  registry.registerAnalyzer('race.hanging', {
    async analyze() {
      return new Promise((resolve) => { released = () => resolve({ done: true }); });
    },
  });
  return { registry, release: () => released?.() };
}

async function settlesWithin(promise, ms) {
  let timer = null;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve('pending'), ms); });
  try {
    return await Promise.race([promise.then(() => 'settled', () => 'settled'), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

test('#4743 an abort that lands during listener registration is observed', async () => {
  const { registry, release } = registryWithHangingAnalyzer(60_000);
  try {
    const result = await registry.invoke(
      'analyzer', 'race.hanging', 'analyze', hostContext(),
      { timeoutMs: 60_000, signal: signalAbortedDuringSubscribe() },
    );
    assert.equal(result.ok, false, 'a cancelled invocation must never report success');
    assert.match(result.error, /cancelled during subscribe|aborted/i);
  } finally {
    release();
  }
});

test('#4743 the registration race settles as a failure without waiting for the timeout', async () => {
  const { registry, release } = registryWithHangingAnalyzer(60_000);
  try {
    const invocation = registry.invoke(
      'analyzer', 'race.hanging', 'analyze', hostContext(),
      { timeoutMs: 60_000, signal: signalAbortedDuringSubscribe() },
    );
    assert.equal(await settlesWithin(invocation, 1_000), 'settled',
      'the wrapper must not fall through to plugin completion or the 60s timeout');
    await invocation;
  } finally {
    release();
  }
});

test('#4743 an already-aborted signal still rejects immediately', async () => {
  const { registry, release } = registryWithHangingAnalyzer(60_000);
  const controller = new AbortController();
  controller.abort(new Error('pre-aborted'));
  try {
    const result = await registry.invoke(
      'analyzer', 'race.hanging', 'analyze', hostContext(),
      { timeoutMs: 60_000, signal: controller.signal },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /pre-aborted/);
  } finally {
    release();
  }
});

test('#4743 normal completion and abort-during-execution semantics are preserved', async () => {
  const registry = new PlatformPluginRegistry({ timeoutMs: 1_000 });
  registry.registerAnalyzer('ok.completes', { async analyze() { return { done: true }; } });
  const completed = await registry.invoke('analyzer', 'ok.completes', 'analyze', hostContext(), { timeoutMs: 1_000 });
  assert.equal(completed.ok, true);
  assert.deepEqual(completed.value, { done: true });

  const { registry: hanging, release } = registryWithHangingAnalyzer(10);
  try {
    const timedOut = await hanging.invoke('analyzer', 'race.hanging', 'analyze', hostContext(), { timeoutMs: 10 });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.timeout, true);
  } finally {
    release();
  }

  const controller = new AbortController();
  const late = new PlatformPluginRegistry({ timeoutMs: 60_000 });
  let finishPlugin = null;
  late.registerAnalyzer('late.abort', {
    async analyze() { return new Promise((resolve) => { finishPlugin = () => resolve({ done: true }); }); },
  });
  try {
    const pending = late.invoke('analyzer', 'late.abort', 'analyze', hostContext(), { timeoutMs: 60_000, signal: controller.signal });
    const outcome = await settlesWithin(pending, 1_000);
    assert.equal(outcome, 'pending', 'a live signal must not cancel an uncancelled invocation');
    controller.abort(new Error('mid-flight abort'));
    const aborted = await pending;
    assert.equal(aborted.ok, false);
    assert.match(aborted.error, /mid-flight abort/);
  } finally {
    finishPlugin?.();
  }
});
