// Regression for #5436: runDiffInWorker() normalizes a synchronous
// workerFactory failure into the promise rejection contract instead of
// throwing out of band.
import assert from 'node:assert/strict';
import { runDiffInWorker } from '../js/diff/runtime.js';

// 1. A throwing workerFactory rejects the promise; nothing throws synchronously.
{
  let threwSync = false;
  let rejection = null;
  try {
    const pending = runDiffInWorker([], [], { workerFactory() { throw new Error('worker-create-failed'); } });
    pending.then(() => {}, (error) => { rejection = error; });
  } catch { threwSync = true; }
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(threwSync, false, 'the factory failure must not throw synchronously');
  assert.ok(rejection instanceof Error, 'the returned promise must reject');
  assert.equal(rejection.message, 'worker-create-failed');
}

// 2. Non-Error throws are still rejections.
{
  const outcome = await runDiffInWorker([], [], { workerFactory() { throw 'plain-string-failure'; } })
    .then(() => 'resolved', (error) => `rejected:${error?.message ?? error}`);
  assert.equal(outcome, 'rejected:plain-string-failure');
}

// 3. The pre-abort contract is unchanged (rejects before invoking the factory).
{
  const controller = new AbortController();
  controller.abort(new Error('gone'));
  const outcome = await runDiffInWorker([], [], { signal: controller.signal, workerFactory() { throw new Error('must not run'); } })
    .then(() => 'resolved', (error) => `rejected:${error.message}`);
  assert.equal(outcome, 'rejected:gone');
}

console.log('issue #5436 diff worker factory rejection regressions PASS');
