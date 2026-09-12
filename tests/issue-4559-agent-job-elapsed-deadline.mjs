// Regression for #4559: AgentJobManager.maxElapsedMs is a hard job deadline,
// so every active slice must inherit the remaining elapsed budget instead of
// running with the runtime/provider default timeout.
import assert from 'node:assert/strict';
import { AIRuntime } from '../js/ai/runtime.js';
import { AgentJobManager } from '../js/ai/jobs/index.js';

function result({ elapsedMs = 0, exhausted = true, reason = exhausted ? 'slice-budget' : null } = {}) {
  return {
    answer: exhausted ? 'continue' : 'done',
    limits: { exhausted, reason },
    usage: { elapsedMs, modelCalls: 0, toolCalls: 0, contextBytes: 0 },
    evidence: [], hypotheses: [], activity: [], followups: [],
    scope: { effective: 'auto' },
  };
}

// A fresh 1000ms job must cap its first slice at 1000ms. After the first
// result reports 900ms consumed, the next slice gets at most the remaining
// 100ms rather than another full provider timeout.
{
  const seen = [];
  let calls = 0;
  const runtime = {
    async turn(_request, options = {}) {
      seen.push(options?.budget?.timeoutMs);
      calls += 1;
      return calls === 1 ? result({ elapsedMs: 900, exhausted: true }) : result({ elapsedMs: 0, exhausted: false });
    },
  };
  const manager = new AgentJobManager({ runtime, maxSlices: 8, maxElapsedMs: 1000 });
  const job = await manager.create({ jobId: 'elapsed-deadline', goal: 'continue analysis', maxElapsedMs: 1000 });
  await manager.runSlice(job.id);
  await manager.runSlice(job.id);
  assert.deepEqual(seen, [1000, 100], 'each slice must be capped by the job elapsed budget remaining at slice start');
}

// A stricter caller timeout remains authoritative: injecting the job ceiling
// must take min(caller timeout, job remaining), never widen a caller deadline.
{
  let seen = null;
  const runtime = {
    async turn(_request, options = {}) {
      seen = options?.budget?.timeoutMs;
      return result({ elapsedMs: 0, exhausted: false });
    },
  };
  const manager = new AgentJobManager({ runtime, maxSlices: 8, maxElapsedMs: 1000 });
  const job = await manager.create({ jobId: 'caller-deadline', goal: 'short turn', maxElapsedMs: 1000 });
  await manager.runSlice(job.id, { budget: { timeoutMs: 50, maxModelCalls: 1 } });
  assert.equal(seen, 50, 'the job deadline must not widen an explicit shorter caller timeout');
}

// Once prior usage reaches the elapsed hard limit, no later slice may call the
// runtime at all. This existing fail-closed boundary must remain intact.
{
  let calls = 0;
  const runtime = {
    async turn() {
      calls += 1;
      return result({ elapsedMs: 1000, exhausted: true });
    },
  };
  const manager = new AgentJobManager({ runtime, maxSlices: 8, maxElapsedMs: 1000 });
  const job = await manager.create({ jobId: 'elapsed-exhausted', goal: 'bounded analysis', maxElapsedMs: 1000 });
  const first = await manager.runSlice(job.id);
  assert.equal(first.status, 'hard-limit');
  await manager.runSlice(job.id);
  assert.equal(calls, 1, 'runtime.turn must not run after the elapsed hard limit is exhausted');
}

// A timeout result must keep the normal checkpoint contract: it remains
// resumable and records the timeout reason instead of being promoted to done.
{
  let seenTimeout = null;
  const runtime = {
    async turn(_request, options = {}) {
      seenTimeout = options?.budget?.timeoutMs;
      return result({ exhausted: true, reason: 'timeout' });
    },
  };
  const manager = new AgentJobManager({ runtime, maxSlices: 4, maxElapsedMs: 1000 });
  const job = await manager.create({ jobId: 'elapsed-timeout-checkpoint', goal: 'timeout checkpoint', maxElapsedMs: 1000 });
  const checkpoint = await manager.runSlice(job.id);
  assert.equal(seenTimeout, 1000, 'timeout path must inherit the remaining job deadline');
  assert.equal(checkpoint.status, 'checkpointed', 'timeout remains resumable');
  assert.ok(checkpoint.unresolvedWork.includes('resume-after:timeout'), 'timeout reason remains in unresolvedWork');
}

// User cancellation keeps its existing checkpoint/error contract while the
// same AbortSignal and elapsed deadline reach the active turn.
{
  const controller = new AbortController();
  let seenSignal = null;
  let seenTimeout = null;
  const runtime = {
    async turn(_request, options = {}) {
      seenSignal = options.signal;
      seenTimeout = options?.budget?.timeoutMs;
      controller.abort('user-stop');
      throw new Error('cancelled-by-user');
    },
  };
  const manager = new AgentJobManager({ runtime, maxSlices: 4, maxElapsedMs: 1000 });
  const job = await manager.create({ jobId: 'elapsed-cancel-checkpoint', goal: 'cancel checkpoint', maxElapsedMs: 1000 });
  await assert.rejects(manager.runSlice(job.id, { signal: controller.signal }), /cancelled-by-user/);
  const checkpoint = await manager.get(job.id);
  assert.equal(seenSignal, controller.signal, 'deadline injection must preserve the caller AbortSignal identity');
  assert.equal(seenTimeout, 1000, 'cancel path must inherit the remaining job deadline');
  assert.equal(checkpoint.status, 'checkpointed', 'user cancellation remains resumable');
  assert.ok(checkpoint.unresolvedWork.includes('cancelled-by-user'), 'cancellation reason remains in unresolvedWork');
}

// maxSlices remains an independent hard limit: the elapsed-deadline injection
// must not grant a second turn after the slice denominator is exhausted.
{
  let calls = 0;
  const runtime = {
    async turn() {
      calls += 1;
      return result({ exhausted: true });
    },
  };
  const manager = new AgentJobManager({ runtime, maxSlices: 1, maxElapsedMs: 1000 });
  const job = await manager.create({ jobId: 'elapsed-max-slices', goal: 'slice ceiling', maxSlices: 1, maxElapsedMs: 1000 });
  const first = await manager.runSlice(job.id);
  assert.equal(first.status, 'hard-limit');
  await manager.runSlice(job.id);
  assert.equal(calls, 1, 'maxSlices must still stop later turns');
}

// The real runtime's finite provider timeout remains authoritative when it is
// stricter than a roomy job deadline. AgentJobManager may shorten that limit,
// never widen it.
{
  const observed = [];
  const runtime = new AIRuntime({
    context: {},
    planner: false,
    provider: {
      turnTimeoutMs: () => 30000,
      async nextTurn(_request, options = {}) {
        observed.push(options.timeoutMs ?? null);
        return { type: 'final', answer: 'ok', confidence: 1, evidenceIds: [], followups: [] };
      },
    },
  });
  const manager = new AgentJobManager({ runtime, maxSlices: 4, maxElapsedMs: 60000 });
  const job = await manager.create({ jobId: 'elapsed-provider-timeout', goal: 'provider timeout', maxElapsedMs: 60000 });
  await manager.runSlice(job.id);
  assert.ok(observed[0] != null && Number.isFinite(observed[0]) && observed[0] > 0 && observed[0] <= 30000,
    `finite provider timeout must still shorten a roomy job deadline, saw ${observed[0]}`);
}

console.log('issue #4559 agent job elapsed deadline regressions PASS');
