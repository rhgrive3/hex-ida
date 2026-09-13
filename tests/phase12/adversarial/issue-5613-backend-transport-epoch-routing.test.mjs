// Issue #5613 regression: a file switch advances transportEpoch immediately,
// so old-worker progress and final responses must not cross that boundary.
import assert from 'node:assert/strict';

import { Backend } from '../../../js/backend.js';

const backend = new Backend();
backend.analysisEpoch = 7;
backend.transportEpoch = 2;

let staleProgress = 0;
let staleReject;
const stalePending = new Promise((resolve, reject) => { staleReject = reject; });
stalePending.catch(() => {});
backend.pending.set(1, {
  resolve: () => { throw new Error('stale final response must not resolve'); },
  reject: staleReject,
  uiEpoch: 7,
  transportEpoch: 1,
  workerName: 'platform',
  onProgress: () => { staleProgress += 1; },
});

backend._onMessage({ t: 'analysisProgress', requestId: 1, epoch: 1, phase: 'scan', done: 1, total: 2 }, 'platform');
assert.equal(staleProgress, 0, 'old-transport progress must be ignored');
backend._onMessage({ t: 'ok', id: 1, epoch: 1, result: { stale: true } }, 'platform');
await assert.rejects(stalePending, (error) => error?.stale === true, 'old-transport final must reject as stale');
assert.equal(backend.pending.has(1), false);

let currentProgress = 0;
let currentResolve;
const currentPending = new Promise((resolve) => { currentResolve = resolve; });
backend.pending.set(2, {
  resolve: currentResolve,
  reject: (error) => { throw error; },
  uiEpoch: 7,
  transportEpoch: 2,
  workerName: 'platform',
  onProgress: () => { currentProgress += 1; },
});

backend._onMessage({ t: 'analysisProgress', requestId: 2, epoch: 2, phase: 'scan', done: 2, total: 2 }, 'platform');
assert.equal(currentProgress, 1, 'current-transport progress remains deliverable');
backend._onMessage({ t: 'ok', id: 2, epoch: 2, result: { current: true } }, 'platform');
assert.deepEqual(await currentPending, { current: true });
assert.equal(backend.pending.has(2), false);

console.log('issue-5613 backend transport epoch routing: PASS');
