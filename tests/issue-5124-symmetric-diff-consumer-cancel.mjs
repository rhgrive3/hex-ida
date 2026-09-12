// Regression for #5124: workspace.diff() shares one producer via workspace.busy
// but must never share cancel authority between consumers. A caller's abort may
// only settle that caller's own wait; the shared producer follows its own
// lifecycle policy (cancel once no consumer is waiting).
import assert from 'node:assert/strict';
import { ProductWorkspace } from '../js/workspace.js';
import { installSymmetricWorkspaceDiff } from '../js/diff/symmetric-workspace-runtime.js';

class Storage { constructor() { this.m = new Map(); } getItem(k) { return this.m.get(k) || null; } setItem(k, v) { this.m.set(k, String(v)); } }

const region = { id: 'text', exec: true, vmAddr: 0x1000n, size: 0x1000n };

function makeWorkspace({ honourAbort = true } = {}) {
  const app = {
    backend: { readAt: () => Promise.resolve({ found: true, bytes: new Uint8Array([0]) }) },
    symbols: { funcs: [0n], functionStartsComplete: true, nameAt() { return null; } },
    programRegions: () => [region],
    codeRegion: () => region,
  };
  app.store = { values: {}, get(k) { return this.values[k] ?? null; } };
  const calls = { ensure: 0 };
  const producer = { signal: null };
  const releases = [];
  const release = () => { for (const resolve of releases) resolve(); };
  app.ensureFunctions = (_region, options) => {
    const gate = new Promise((resolve) => { releases.push(resolve); });
    calls.ensure++;
    producer.signal = options.signal ?? null;
    const signal = options.signal ?? null;
    // Real ensureFunctions honours the signal it is handed; the fake must too,
    // otherwise a consumer abort has no observable path into the producer.
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const reason = signal?.reason;
        const error = reason instanceof Error ? reason : new Error('ensureFunctions aborted');
        if (!error.name || error.name === 'Error') error.name = 'AbortError';
        reject(error);
      };
      if (signal?.aborted) { onAbort(); return; }
      if (honourAbort) signal?.addEventListener?.('abort', onAbort, { once: true });
      gate.then(() => {
        signal?.removeEventListener?.('abort', onAbort, { once: true });
        resolve();
      });
    });
  };
  const workspace = new ProductWorkspace(app, { storage: new Storage(), backendFactory: () => ({}) });
  app.workspace = workspace;
  // Profile mismatch makes the shared producer settle deterministically right
  // after ensureFunctions, so no worker is needed to observe producer outcomes.
  workspace.baseline = {
    hash: 'baseline-a',
    architecture: 'arm64',
    info: { name: 'baseline-a' },
    functions: { evidenceProfile: 'legacy-profile', fingerprintVersion: 1 },
  };
  installSymmetricWorkspaceDiff(app);
  return { workspace, calls, producer, release, releases };
}

function track(promise) {
  const state = { outcome: 'pending', value: undefined, error: undefined };
  promise.then((value) => { state.outcome = 'resolved'; state.value = value; },
    (error) => { state.outcome = 'rejected'; state.error = error; });
  return state;
}
async function drain(rounds = 5) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 2));
}
function isAbort(error) { return error?.name === 'AbortError'; }
function fakeSignal() {
  const listener = { aborted: false, reason: undefined, add: 0, remove: 0, handlers: [] };
  return {
    signal: {
      get aborted() { return listener.aborted; },
      get reason() { return listener.reason; },
      addEventListener(type, handler) { assert.equal(type, 'abort'); listener.add++; listener.handlers.push(handler); },
      removeEventListener(type) { assert.equal(type, 'abort'); listener.remove++; },
    },
    abort(reason) {
      if (listener.aborted) return;
      listener.aborted = true;
      listener.reason = reason;
      for (const handler of listener.handlers.splice(0)) handler();
    },
    get add() { return listener.add; },
    get remove() { return listener.remove; },
  };
}

// A consumer abort must not reach the other consumer's wait.
{
  const { workspace, calls, producer } = makeWorkspace();
  const a = new AbortController(), b = new AbortController();
  const first = track(workspace.diff({ signal: a.signal }));
  const second = track(workspace.diff({ signal: b.signal }));
  await drain();
  assert.equal(calls.ensure, 1, 'one shared producer must serve both consumers');
  a.abort();
  await drain();
  assert.equal(first.outcome, 'rejected', 'the aborting consumer must settle');
  assert.ok(isAbort(first.error), `aborting consumer must fail with AbortError, got ${String(first.error?.name)}`);
  assert.equal(second.outcome, 'pending', 'an unrelated consumer must not inherit another consumer abort');
  assert.equal(producer.signal?.aborted, false, 'the shared producer must keep running while a consumer still waits');
  b.abort();
  await drain();
}

// A consumer must be able to cancel its own wait on an already-running producer.
{
  const { workspace, calls, producer, release } = makeWorkspace();
  const a = new AbortController(), b = new AbortController();
  const first = track(workspace.diff({ signal: a.signal }));
  const second = track(workspace.diff({ signal: b.signal }));
  await drain();
  b.abort();
  await drain();
  assert.equal(second.outcome, 'rejected', 'a later consumer must be able to cancel its own wait');
  assert.ok(isAbort(second.error), `cancelling consumer must fail with AbortError, got ${String(second.error?.name)}`);
  assert.equal(first.outcome, 'pending', 'the surviving consumer must keep waiting for the shared producer');
  assert.equal(producer.signal?.aborted, false, 'the producer must not be cancelled while a consumer still waits');
  assert.equal(calls.ensure, 1, 'consumer cancellation must not start an extra producer');
  release();
  await drain(8);
  assert.equal(first.outcome, 'rejected', 'the surviving consumer must receive the shared producer outcome');
  assert.equal(first.error?.code, 'DIFF_FINGERPRINT_PROFILE_MISMATCH', 'the surviving wait must settle with the producer result');
}

// Producer lifecycle: cancel only once every consumer has left.
{
  const { workspace, producer } = makeWorkspace();
  const a = new AbortController(), b = new AbortController();
  const first = track(workspace.diff({ signal: a.signal }));
  const second = track(workspace.diff({ signal: b.signal }));
  await drain();
  a.abort();
  await drain();
  assert.equal(producer.signal?.aborted, false, 'one remaining consumer keeps the producer alive');
  b.abort();
  await drain();
  assert.equal(producer.signal?.aborted, true, 'the producer must be cancelled when its last consumer leaves');
  assert.ok(isAbort(first.error), 'the first consumer must fail with its own abort');
  assert.ok(isAbort(second.error), 'the last consumer must fail with its own abort');
  assert.equal(workspace.busy, null, 'a cancelled producer must release the busy slot');
}

// Immediate retries must bypass an abandoned producer, including one whose
// underlying discovery ignores cancellation and settles after its replacement.
for (const honourAbort of [true, false]) {
  const { workspace, calls, producer, releases } = makeWorkspace({ honourAbort });
  const controller = new AbortController();
  const first = track(workspace.diff({ signal: controller.signal }));
  const abandonedTask = workspace.busy;
  const abandonedSignal = producer.signal;
  controller.abort();
  const fresh = track(workspace.diff());
  const replacementTask = workspace.busy;
  assert.equal(calls.ensure, 2, 'an immediate retry must start a fresh producer');
  assert.notEqual(replacementTask, abandonedTask);
  assert.equal(abandonedSignal.aborted, true);
  assert.equal(producer.signal.aborted, false);
  releases[0]();
  await drain(8);
  assert.ok(isAbort(first.error));
  assert.equal(fresh.outcome, 'pending', 'old settlement must not settle the new consumer');
  assert.equal(workspace.busy, replacementTask, 'old finalizer must not clear the replacement busy slot');
  assert.equal(workspace.diffState, null, 'an abandoned producer must not publish a result');
  const joiner = track(workspace.diff());
  assert.equal(calls.ensure, 2, 'a live replacement must still share its producer');
  releases[1]();
  await drain(8);
  assert.equal(fresh.error?.code, 'DIFF_FINGERPRINT_PROFILE_MISMATCH');
  assert.equal(joiner.error, fresh.error);
  assert.equal(workspace.busy, null);
}

// Consumers that never abort still share exactly one producer outcome.
{
  const { workspace, calls, release } = makeWorkspace();
  const b = new AbortController();
  const first = track(workspace.diff({}));
  const second = track(workspace.diff({ signal: b.signal }));
  await drain();
  release();
  await drain(8);
  assert.equal(calls.ensure, 1, 'the single-flight producer must not be duplicated');
  assert.equal(first.outcome, 'rejected');
  assert.equal(second.outcome, 'rejected');
  assert.equal(first.error, second.error, 'every consumer must receive the same shared producer outcome');
  assert.equal(first.error?.code, 'DIFF_FINGERPRINT_PROFILE_MISMATCH');
}

// Abort listener ownership: each consumer registers its own and releases it once.
{
  const { workspace, calls, release } = makeWorkspace();
  const joiner = fakeSignal();
  const producerOwner = fakeSignal();
  const first = track(workspace.diff({ signal: producerOwner.signal }));
  const second = track(workspace.diff({ signal: joiner.signal }));
  await drain();
  assert.equal(joiner.add, 1, 'a later consumer must register its own abort listener');
  joiner.abort(new Error('joiner-cancel'));
  await drain();
  assert.equal(second.outcome, 'rejected', 'the joiner must be cancelled by its own signal');
  assert.ok(isAbort(second.error), 'the joiner must fail with AbortError');
  assert.equal(second.error?.message, 'joiner-cancel', 'the joiner must fail with its own abort reason');
  assert.equal(joiner.remove, 1, 'a settled consumer wait must release its abort listener exactly once');
  assert.equal(first.outcome, 'pending', 'the producer-owning consumer must be untouched by the joiner cancel');
  assert.equal(calls.ensure, 1);
  release();
  await drain(8);
  assert.equal(producerOwner.remove, 1, 'a normal producer settle must release the first consumer listener exactly once');
  assert.equal(first.error?.code, 'DIFF_FINGERPRINT_PROFILE_MISMATCH');
}

// An already-cancelled consumer must not start work at all.
{
  const { workspace, calls } = makeWorkspace();
  const aborted = new AbortController();
  aborted.abort(new Error('pre-aborted'));
  await assert.rejects(workspace.diff({ signal: aborted.signal }), (error) => error?.name === 'AbortError',
    'an already-aborted consumer must fail without starting the producer');
  await drain();
  assert.equal(calls.ensure, 0, 'an already-aborted consumer must not start the shared producer');
  assert.equal(workspace.busy, null, 'an already-aborted consumer must not leave a busy producer behind');
}

console.log('issue #5124 symmetric workspace diff consumer cancellation isolation: PASS');
