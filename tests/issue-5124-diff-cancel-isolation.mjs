import assert from 'node:assert/strict';
import { installSymmetricWorkspaceDiff } from '../js/diff/symmetric-workspace-runtime.js';

// Issue #5124: workspace.diff() shared one busy task holding only the first
// caller's AbortSignal. A second caller's signal was never registered, so the
// first caller's abort failed unrelated waiters while a waiter's own abort
// was ignored. Each consumer wait must be isolated; only the shared producer
// lifecycle (abort when no waiter remains) may stop the work.

const localAbortError = (reason) => {
  const error = new Error(typeof reason === 'string' && reason ? reason : 'aborted');
  error.name = 'AbortError';
  return error;
};

const makeHarness = () => {
  const workspace = {
    bindingRevision: 1,
    baseline: { hash: 'baseline-hash' },
    identity: { hash: 'current-hash', metadata: {} },
    _assertBinding() {},
    async loadBaseline(file) { return { file }; },
  };
  const app = {
    workspace,
    codeRegion: () => null,
    programRegions: () => [],
    ensureFunctions: (_region, opts) => new Promise((_, reject) => {
      opts.signal?.addEventListener('abort', () => reject(localAbortError(opts.signal?.reason)), { once: true });
    }),
    backend: {},
    symbols: {},
  };
  installSymmetricWorkspaceDiff(app);
  return { app, workspace };
};

const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => {
    const error = new Error(`timed out waiting for ${label}`);
    error.name = 'TimeoutError';
    reject(error);
  }, ms)),
]);
const isAbortError = (error) => error?.name === 'AbortError';
const pendingState = (promise) => Promise.race([
  promise.then(() => 'settled', () => 'rejected'),
  new Promise((resolve) => setTimeout(() => resolve('pending'), 50)),
]);

// Second waiter's abort ends only its own wait; producer and first waiter continue.
{
  const { workspace } = makeHarness();
  const a = new AbortController();
  const b = new AbortController();
  const p1 = workspace.diff({ signal: a.signal });
  const p2 = workspace.diff({ signal: b.signal });
  p1.catch(() => {});
  p2.catch(() => {});
  b.abort('b-leaving');
  await assert.rejects(withTimeout(p2, 300, 'p2 after B abort'), isAbortError, "B's abort must end B's own wait");
  assert.equal(await pendingState(p1), 'pending', "B's abort must not disturb A's wait or the shared producer");
  a.abort('a-leaving');
  await assert.rejects(withTimeout(p1, 300, 'p1 after A abort'), isAbortError, "A's abort must end A's own wait");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(workspace.busy, null, 'busy must clear once the flight settles');
}

// First waiter's abort must not fail a still-waiting second waiter.
{
  const { workspace } = makeHarness();
  const a = new AbortController();
  const b = new AbortController();
  const p1 = workspace.diff({ signal: a.signal });
  const p2 = workspace.diff({ signal: b.signal });
  p1.catch(() => {});
  p2.catch(() => {});
  a.abort('a-leaving');
  await assert.rejects(withTimeout(p1, 300, 'p1 after A abort'), isAbortError);
  assert.equal(await pendingState(p2), 'pending', "A's abort must not fail B's wait while B still waits");
  b.abort('b-leaving');
  await assert.rejects(withTimeout(p2, 300, 'p2 after B abort'), isAbortError);
}

// A lone caller keeps the old behavior: aborting cancels the work.
{
  const { workspace } = makeHarness();
  const a = new AbortController();
  const p = workspace.diff({ signal: a.signal });
  p.catch(() => {});
  a.abort('solo-leaving');
  await assert.rejects(withTimeout(p, 300, 'solo wait after abort'), isAbortError, 'single-caller abort must still cancel the work');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(workspace.busy, null);
}

console.log('issue #5124 diff single-flight cancel isolation: PASS');
