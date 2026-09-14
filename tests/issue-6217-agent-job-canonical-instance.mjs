import assert from 'node:assert/strict';
import { AgentJobManager } from '../js/ai/jobs/index.js';

console.log('Testing #6217: AgentJobManager canonical instance resolution...');

// 1. runSlice(callerCopy) updates manager canonical state
{
  const runtime = { turn: async () => ({ limits: { exhausted: false }, answer: 'done' }) };
  let savedJob = null;
  const persistence = {
    save: async (j) => { savedJob = j; },
    load: async () => null,
  };
  const manager = new AgentJobManager({ runtime, persistence });

  const j = await manager.create({ goal: 'investigate-binary', jobId: 'job-canonical-1' });
  assert.equal(j.status, 'ready');

  // Caller passes the returned clone object `j` to runSlice
  const sliceResult = await manager.runSlice(j);
  assert.equal(sliceResult.status, 'complete');

  // Verify manager.get() returns complete, NOT stale ready
  const inMem = await manager.get(j.id);
  assert.equal(inMem.status, 'complete', 'in-memory canonical state must be complete');
  assert.equal(inMem.budgetUsage.slices, 1);

  // Verify manager.list() returns complete
  const listed = manager.list().find((item) => item.id === j.id);
  assert.equal(listed.status, 'complete');
  assert.equal(listed.budgetUsage.slices, 1);

  // Verify persistence received complete
  assert.equal(savedJob?.status, 'complete');
}

// 2. Reject unknown / forged object ID
{
  const runtime = { turn: async () => ({ limits: { exhausted: false }, answer: 'done' }) };
  const manager = new AgentJobManager({ runtime });

  await assert.rejects(
    () => manager.runSlice({ id: 'forged-job-id', invalid: true }),
    /Unknown agent job: forged-job-id/
  );

  await assert.rejects(
    () => manager.runSlice({ id: null }),
    /Unknown agent job/
  );
}

// 3. String id resolution continues to work
{
  const runtime = { turn: async () => ({ limits: { exhausted: false }, answer: 'done' }) };
  const manager = new AgentJobManager({ runtime });

  const j = await manager.create({ goal: 'test-string-id', jobId: 'job-str-1' });
  const sliceResult = await manager.runSlice(j.id);
  assert.equal(sliceResult.status, 'complete');
  assert.equal((await manager.get(j.id)).status, 'complete');
}

console.log('#6217: All tests passed successfully.');
