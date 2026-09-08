// Regression for #5596: AgentJobManager.create() must not turn an explicit 0
// per-job hard limit into the manager default via `||`. Zero is a finite value
// under the class normalization contract (bounded(0) === min).
import assert from 'node:assert/strict';
import { AgentJobManager } from '../js/ai/jobs/index.js';

const runtime = { async turn() { return { answer: 'ok', limits: { exhausted: false }, usage: {} }; } };

// Explicit 0 clamps to the minimum hard limit, not the manager default.
{
  const manager = new AgentJobManager({ runtime, maxSlices: 8, maxElapsedMs: 30 * 60 * 1000 });
  const job = await manager.create({ jobId: 'zero-budget', goal: 'analyze', maxSlices: 0, maxElapsedMs: 0 });
  assert.deepEqual(job.limits, { maxSlices: 1, maxElapsedMs: 1000 },
    `explicit 0 must clamp to the minimum hard limits, got ${JSON.stringify(job.limits)}`);
}

// The manager constructor already treated 0 as the clamped minimum.
{
  const manager = new AgentJobManager({ runtime, maxSlices: 0, maxElapsedMs: 0 });
  assert.deepEqual({ maxSlices: manager.maxSlices, maxElapsedMs: manager.maxElapsedMs }, { maxSlices: 1, maxElapsedMs: 1000 });
}

// Omitted per-job limits keep the manager defaults.
{
  const manager = new AgentJobManager({ runtime, maxSlices: 8, maxElapsedMs: 30 * 60 * 1000 });
  const job = await manager.create({ jobId: 'default-budget', goal: 'analyze' });
  assert.deepEqual(job.limits, { maxSlices: 8, maxElapsedMs: 30 * 60 * 1000 });
}

// A per-job slice under the clamped 1-slice hard limit runs once, then the
// job hard-limits instead of continuing.
{
  const sliceRuntime = { async turn() { return { answer: 'pending work', limits: { exhausted: true, reason: 'slice-budget' }, usage: {} }; } };
  const manager = new AgentJobManager({ runtime: sliceRuntime, maxSlices: 8, maxElapsedMs: 30 * 60 * 1000 });
  const job = await manager.create({ jobId: 'zero-slice', goal: 'one slice', maxSlices: 0, maxElapsedMs: 0 });
  const checkpoint = await manager.runSlice(job.id);
  assert.equal(checkpoint.status, 'hard-limit', 'the clamped maxSlices=1 hard limit must stop the job after the first slice');
  const again = await manager.runSlice(job.id);
  assert.equal(again.status, 'hard-limit', 'further slices must not run');
}

console.log('issue #5596 job zero hard-limit regressions PASS');
