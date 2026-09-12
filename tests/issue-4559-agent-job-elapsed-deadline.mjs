// Regression for #4559: AgentJobManager.maxElapsedMs is a hard job deadline,
// so every active slice must inherit the remaining elapsed budget instead of
// running with the runtime/provider default timeout.
import assert from 'node:assert/strict';
import { AgentJobManager } from '../js/ai/jobs/index.js';

function result({ elapsedMs = 0, exhausted = true } = {}) {
  return {
    answer: exhausted ? 'continue' : 'done',
    limits: { exhausted, reason: exhausted ? 'slice-budget' : null },
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

console.log('issue #4559 agent job elapsed deadline regressions PASS');
