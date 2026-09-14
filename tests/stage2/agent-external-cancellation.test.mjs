import assert from 'node:assert/strict';
import { runAgent } from '../../js/agent/runtime.js';

const emptyContext = () => ({ candidateFunctions:[], analyze:async () => { throw new Error('analysis-must-not-run-after-cancel'); } });

{
  const controller = new AbortController();
  controller.abort('user-cancelled');
  let modelCalls = 0;
  const result = await runAgent({
    goal:'inspect function', context:emptyContext(), signal:controller.signal, timeoutMs:10000,
    llm:{ async next() { modelCalls++; return { tool:'analyze_function', args:[0x1000n] }; } },
  });
  assert.equal(modelCalls, 0, 'a pre-aborted run must not start model work');
  assert.ok(result.missingEvidence.includes('cancelled'), 'the terminal proof must record caller cancellation');
}

{
  const controller = new AbortController();
  let modelCalls = 0;
  let releaseModel;
  let markStarted;
  const modelStarted = new Promise((resolve) => { markStarted = resolve; });
  const blockedModel = new Promise((resolve) => { releaseModel = resolve; });
  const running = runAgent({
    goal:'inspect function', context:emptyContext(), signal:controller.signal, timeoutMs:10000,
    llm:{ async next() { modelCalls++; markStarted(); await blockedModel; return { tool:'analyze_function', args:[0x1000n] }; } },
  });
  await modelStarted;
  controller.abort('user-cancelled');
  const result = await Promise.race([
    running,
    new Promise((_, reject) => setTimeout(() => reject(new Error('external-cancel-did-not-settle')), 1000)),
  ]);
  releaseModel();
  assert.equal(modelCalls, 1);
  assert.equal(result.observations.length, 0, 'no tool may execute after caller cancellation');
  assert.ok(result.missingEvidence.includes('cancelled'), 'mid-model abort must remain cancellation, not timeout');
}
