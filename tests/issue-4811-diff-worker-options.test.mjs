import assert from 'node:assert/strict';
import test from 'node:test';
import { runDiffInWorker } from '../js/diff/runtime.js';

test('issue #4811: runDiffInWorker forwards matcher options across worker boundary', async () => {
  let postedMessage = null;
  class CapturingWorker {
    postMessage(msg) {
      postedMessage = msg;
    }
    terminate() {}
    addEventListener() {}
    removeEventListener() {}
  }

  const signal = new AbortController().signal;
  const matchBudget = { maxCandidateEvaluations: 1000, signal };

  runDiffInWorker([], [], {
    workerFactory: () => new CapturingWorker(),
    mode: 'detailed',
    threshold: 0.75,
    ambiguityWindow: 0.08,
    neighborhoodIterations: 4,
    maxCandidates: 64,
    maxBucketScan: 256,
    allowSimilar: false,
    matchBudget,
  });

  assert.ok(postedMessage, 'worker must receive message');
  const opts = postedMessage.options;
  assert.equal(opts.mode, 'detailed');
  assert.equal(opts.threshold, 0.75);
  assert.equal(opts.ambiguityWindow, 0.08);
  assert.equal(opts.neighborhoodIterations, 4);
  assert.equal(opts.maxCandidates, 64);
  assert.equal(opts.maxBucketScan, 256);
  assert.equal(opts.allowSimilar, false);
  assert.equal(opts.matchBudget.maxCandidateEvaluations, 1000);
  assert.equal(opts.matchBudget.signal, undefined, 'signal must be removed from matchBudget');
});
