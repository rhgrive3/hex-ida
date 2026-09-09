// Regression for #5205: AgentJobManager only accounted a slice's budget when
// runtime.turn() returned a result, so a slice that threw after doing
// model/tool work incremented neither budgetUsage.slices nor elapsedMs — a
// failure-heavy workload could retry past maxSlices/maxElapsedMs forever via
// resume(). Contract now: every started slice attempt counts against the
// hard limit, the failed attempt's wall-clock time counts against
// maxElapsedMs, a hard-limit exhaustion on the failure path closes the job
// ('hard-limit'), user-cancellation checkpoint semantics stay intact, and
// successful slices keep their existing usage aggregation (no double
// counting).
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentJobManager } from '../js/ai/jobs/index.js';

function flakyRuntime(failures, delayMs = 0) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async turn() {
      calls += 1;
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (calls <= failures) throw new Error(`provider failed after work #${calls}`);
      return { answer: 'ok', sessionId: 'session-1', usage: { modelCalls: 1, toolCalls: 1, elapsedMs: 5, contextBytes: 10 } };
    },
  };
}

test('#5205 failed attempts consume maxSlices', async () => {
  const runtime = flakyRuntime(1);
  const jobs = new AgentJobManager({ runtime, maxSlices: 2, maxElapsedMs: 60_000 });
  const job = await jobs.create({ goal: 'x', maxSlices: 2, maxElapsedMs: 60_000 });

  await assert.rejects(() => jobs.resume(job.id), /provider failed after work/);
  let state = await jobs.get(job.id);
  assert.equal(state.budgetUsage.slices, 1, 'a failed attempt must be counted');
  assert.equal(state.status, 'failed');
  assert.equal(runtime.calls, 1);

  // The second attempt succeeds (slices -> 2).
  await jobs.resume(job.id);
  state = await jobs.get(job.id);
  assert.equal(state.budgetUsage.slices, 2, 'no double counting across success+failure');
  assert.equal(state.status, 'complete');
  assert.equal(runtime.calls, 2);

  // The completed job checkpoints without executing another turn (#5431).
  await jobs.resume(job.id);
  state = await jobs.get(job.id);
  assert.equal(state.status, 'complete');
  assert.equal(runtime.calls, 2);
});

test('#5205 a failed final attempt lands on hard-limit, not a silent retryable failed state', async () => {
  const runtime = { calls: 0, async turn() { this.calls += 1; throw new Error('provider failed after work'); } };
  const jobs = new AgentJobManager({ runtime, maxSlices: 1, maxElapsedMs: 60_000 });
  const job = await jobs.create({ goal: 'x', maxSlices: 1, maxElapsedMs: 60_000 });

  await assert.rejects(() => jobs.resume(job.id), /provider failed after work/);
  const state = await jobs.get(job.id);
  assert.equal(runtime.calls, 1);
  assert.equal(state.budgetUsage.slices, 1);
  assert.equal(state.status, 'hard-limit', 'maxSlices exhausted by the failed attempt must close the job');
});

test('#5205 failure loop cannot exceed maxSlices attempts', async () => {
  const runtime = {
    calls: 0,
    async turn() {
      this.calls += 1;
      throw new Error('always failing after work');
    },
  };
  const jobs = new AgentJobManager({ runtime, maxSlices: 2, maxElapsedMs: 60_000 });
  const job = await jobs.create({ goal: 'x', maxSlices: 2, maxElapsedMs: 60_000 });

  await assert.rejects(() => jobs.resume(job.id), /always failing after work/);
  await assert.rejects(() => jobs.resume(job.id), /always failing after work/);
  // The hard limit is exhausted: further resumes resolve with the closed
  // checkpoint instead of executing another failing attempt.
  const gated = await jobs.resume(job.id);
  assert.equal(gated.status, 'hard-limit');
  const state = await jobs.get(job.id);
  assert.equal(runtime.calls, 2, 'hard limit must stop the failure loop');
  assert.equal(state.budgetUsage.slices, 2);
  assert.equal(state.status, 'hard-limit', 'exhausting the limit on a failed attempt closes the job');
});

test('#5205 failed-slice wall-clock time counts against maxElapsedMs', async () => {
  const runtime = {
    calls: 0,
    async turn() {
      this.calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 1100));
      throw new Error('slow failure after work');
    },
  };
  const jobs = new AgentJobManager({ runtime, maxSlices: 32, maxElapsedMs: 1000 });
  const job = await jobs.create({ goal: 'x', maxSlices: 32, maxElapsedMs: 1000 });

  await assert.rejects(() => jobs.resume(job.id), /slow failure after work/);
  const state = await jobs.get(job.id);
  assert.ok(state.budgetUsage.elapsedMs >= 1000, `failed wall-clock must be accounted (got ${state.budgetUsage.elapsedMs})`);
  assert.equal(state.status, 'hard-limit', 'the elapsed ceiling reached by a failed attempt must close the job');
});

test('#5205 user cancellation keeps checkpoint semantics', async () => {
  const controller = new AbortController();
  const runtime = {
    calls: 0,
    async turn() {
      this.calls += 1;
      controller.abort();
      throw new Error('cancelled');
    },
  };
  const jobs = new AgentJobManager({ runtime, maxSlices: 4, maxElapsedMs: 60_000 });
  const job = await jobs.create({ goal: 'x', maxSlices: 4, maxElapsedMs: 60_000 });

  await assert.rejects(() => jobs.resume(job.id, { signal: controller.signal }), /cancelled/);
  const state = await jobs.get(job.id);
  assert.equal(state.status, 'checkpointed', 'abort before exhaustion stays resumable');
  assert.equal(state.budgetUsage.slices, 1, 'the aborted attempt still consumed budget');
  // Next resume executes normally (no abort) — 3 attempts remain.
  const recoveryRuntime = flakyRuntime(0);
  jobs.runtime = recoveryRuntime;
  await jobs.resume(job.id);
  const resumed = await jobs.get(job.id);
  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.budgetUsage.slices, 2);
});

test('#5205 attempt limit survives persistence reload', async () => {
  const saved = new Map();
  const runtime = flakyRuntime(2);
  const jobs = new AgentJobManager({ runtime, persistence: { async save(job) { saved.set(job.id, JSON.parse(JSON.stringify(job))); }, async load(id) { return saved.get(id) ?? null; } }, maxSlices: 2, maxElapsedMs: 60_000 });
  const job = await jobs.create({ goal: 'x', maxSlices: 2, maxElapsedMs: 60_000 });

  await assert.rejects(() => jobs.resume(job.id), /provider failed after work/);
  await assert.rejects(() => jobs.resume(job.id), /provider failed after work/);
  // Simulate a fresh manager over the same persisted store: the hard limit
  // holds (no fresh attempts), and the gated resume resolves with the
  // checkpoint without executing a turn.
  const jobs2 = new AgentJobManager({ runtime, persistence: { async save(job2) { saved.set(job2.id, JSON.parse(JSON.stringify(job2))); }, async load(id) { return saved.get(id) ?? null; } }, maxSlices: 2, maxElapsedMs: 60_000 });
  const resumed = await jobs2.resume(job.id);
  assert.equal(resumed.status, 'hard-limit');
  const state = await jobs2.get(job.id);
  assert.equal(runtime.calls, 2, 'a reloaded job must not gain fresh attempts');
  assert.equal(state.status, 'hard-limit');
});
