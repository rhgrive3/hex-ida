// Issue #4811 regression: runDiffInWorker() must preserve the matcher policy
// that synchronous diffFunctions() receives, excluding only live signals.
import assert from 'node:assert/strict';

import { runDiffInWorker } from '../../../js/diff/runtime.js';

let posted = null;
const worker = {
  onmessage: null,
  onerror: null,
  onmessageerror: null,
  postMessage(message) {
    posted = message;
    queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true, result: { accepted: true } } }));
  },
  terminate() {},
};

const controller = new AbortController();
const result = await runDiffInWorker([], [], {
  workerFactory: () => worker,
  signal: controller.signal,
  mode: 'accurate',
  threshold: 0.9,
  ambiguityWindow: 0.2,
  neighborhoodIterations: 7,
  maxCandidates: 3,
  maxBucketScan: 5,
  allowSimilar: false,
  matchBudget: { maxComponents: 11, signal: controller.signal },
});

assert.deepEqual(result, { accepted: true });
assert.deepEqual(posted.options, {
  mode: 'accurate',
  threshold: 0.9,
  ambiguityWindow: 0.2,
  neighborhoodIterations: 7,
  maxCandidates: 3,
  maxBucketScan: 5,
  allowSimilar: false,
  matchBudget: { maxComponents: 11 },
});
assert.equal(Object.prototype.hasOwnProperty.call(posted.options, 'signal'), false);

console.log('issue-4811-diff-worker-options: ok');
