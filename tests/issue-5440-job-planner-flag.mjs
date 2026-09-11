// Regression for #5440: `planner:false` is an explicit disable flag and must
// survive the job checkpoint; otherwise runSlice silently re-enables the
// planner on the first slice.
import assert from 'node:assert/strict';
import { AgentJobManager } from '../js/ai/jobs/index.js';

// 1. The flag survives create → checkpoint.
{
  const manager = new AgentJobManager({ runtime: { async turn() { return { answer: 'ok', limits: { exhausted: false }, usage: {} }; } } });
  const job = await manager.create({ jobId: 'p-checkpoint', goal: 'no planner', planner: false });
  assert.equal(job.request.planner, false, 'the checkpointed request must carry planner:false');
  const resumed = await manager.resume(job.id);
  assert.equal(resumed.request.planner, false, 'resume keeps the flag');
}

// 2. runSlice passes the flag to the runtime turn.
{
  let seen = null;
  const manager = new AgentJobManager({ runtime: { async turn(request) { seen = { ...request }; return { answer: 'ok', limits: { exhausted: false }, usage: {} }; } } });
  const job = await manager.create({ jobId: 'p-off', goal: 'no planner', planner: false });
  await manager.runSlice(job.id);
  assert.equal(seen?.planner, false, 'runSlice must not re-enable the planner');
}

// 3. `planner:true` and omitted both behave as before.
{
  let seen = null;
  const manager = new AgentJobManager({ runtime: { async turn(request) { seen = { ...request }; return { answer: 'ok', limits: { exhausted: false }, usage: {} }; } } });
  const job = await manager.create({ jobId: 'p-on', goal: 'planner on', planner: true });
  await manager.runSlice(job.id);
  assert.equal(seen?.planner, true);
  const job2 = await manager.create({ jobId: 'p-omitted', goal: 'default' });
  await manager.runSlice(job2.id);
  assert.equal(seen?.planner, undefined, 'omitted stays omitted');
}

console.log('issue #5440 job planner flag persistence regressions PASS');
