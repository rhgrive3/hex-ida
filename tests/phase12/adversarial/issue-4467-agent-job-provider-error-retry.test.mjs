import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentJobManager } from '../../../js/ai/jobs/index.js';

function providerFailure() {
  return {
    answer: 'fallback',
    evidence: [],
    hypotheses: [],
    activity: [],
    followups: [],
    usage: { modelCalls: 1, toolCalls: 0, elapsedMs: 1, contextBytes: 0 },
    limits: { exhausted: false, reason: 'provider_error' },
  };
}

function success() {
  return {
    answer: 'recovered',
    evidence: [],
    hypotheses: [],
    activity: [],
    followups: [],
    usage: { modelCalls: 1, toolCalls: 0, elapsedMs: 1, contextBytes: 0 },
    limits: { exhausted: false },
  };
}

function persistence() {
  const records = new Map();
  return {
    records,
    async save(value) { records.set(value.id, structuredClone(value)); },
    async load(id) { return structuredClone(records.get(id) ?? null); },
  };
}

test('#4467 provider_error is checkpointed with a retryable reason and resumes after recovery', async () => {
  const store = persistence();
  let calls = 0;
  const runtime = {
    async turn() {
      calls += 1;
      return calls === 1 ? providerFailure() : success();
    },
  };
  const firstManager = new AgentJobManager({ runtime, persistence: store });
  const created = await firstManager.create({ jobId: 'job-4467', goal: 'retry provider failure' });

  const failed = await firstManager.runSlice(created.id);
  assert.equal(failed.status, 'checkpointed');
  assert.deepEqual(failed.lastResult.limits, { exhausted: false, reason: 'provider_error' });
  assert.deepEqual(failed.unresolvedWork, ['resume-after:provider_error']);
  assert.equal(store.records.get(created.id).status, 'checkpointed');

  const restarted = new AgentJobManager({ runtime, persistence: store });
  const recovered = await restarted.resume(created.id);
  assert.equal(recovered.status, 'complete');
  assert.equal(recovered.lastResult.answer, 'recovered');
  assert.equal(calls, 2, 'resume must call the runtime again after provider recovery');
});

test('#4467 a reasonless non-exhausted result remains a normal completion', async () => {
  let calls = 0;
  const manager = new AgentJobManager({
    runtime: { async turn() { calls += 1; return success(); } },
  });
  const job = await manager.create({ jobId: 'job-4467-success', goal: 'normal completion' });
  const result = await manager.runSlice(job.id);
  assert.equal(result.status, 'complete');
  assert.equal(calls, 1);
});

test('#4467 budget exhaustion keeps checkpoint and hard-limit semantics', async () => {
  const manager = new AgentJobManager({
    maxSlices: 1,
    runtime: { async turn() { return { ...providerFailure(), limits: { exhausted: true, reason: 'tool-call-budget' } }; } },
  });
  const job = await manager.create({ jobId: 'job-4467-budget', goal: 'budget limit' });
  const result = await manager.runSlice(job.id);
  assert.equal(result.status, 'hard-limit');
  assert.equal(result.lastResult.limits.reason, 'tool-call-budget');
});

console.log('issue #4467 provider error job retry: PASS');
