import assert from 'node:assert/strict';
import { AgentJobManager } from '../js/ai/jobs/index.js';

console.log('Testing #6186: AgentJobManager save failure vs execution failure separation...');

// 1. runtime.turn() error results in failed status
{
  let turns = 0;
  const runtime = {
    turn: async () => {
      turns++;
      throw new Error('model inference error');
    },
  };
  const manager = new AgentJobManager({ runtime });
  const job = await manager.create({ goal: 'test-turn-failure', jobId: 'job-turn-fail' });

  await assert.rejects(
    manager.runSlice(job.id),
    /model inference error/
  );

  const inMem = await manager.get(job.id);
  assert.equal(inMem.status, 'failed', 'runtime.turn failure must set job.status to failed');
  assert.equal(turns, 1);
}

// 2. runtime.turn() succeeds but final checkpoint save fails:
// MUST NOT set status to failed; MUST NOT re-run turn on next resume()
{
  let turns = 0;
  const runtime = {
    turn: async () => {
      turns++;
      return { limits: { exhausted: false }, answer: 'completed-task' };
    },
  };

  let saveCount = 0;
  let failFinalSave = true;

  const persistence = {
    save: async (j) => {
      saveCount++;
      // save 1: create()
      // save 2: running status at slice start
      // save 3: final completed checkpoint
      if (saveCount === 3 && failFinalSave) {
        throw new Error('storage write failed on final save');
      }
    },
    load: async () => null,
  };

  const manager = new AgentJobManager({ runtime, persistence });
  const job = await manager.create({ goal: 'test-save-failure', jobId: 'job-save-fail' });
  assert.equal(job.status, 'ready');

  // runSlice should throw the storage error from save()
  await assert.rejects(
    manager.runSlice(job.id),
    /storage write failed on final save/
  );

  // But the in-memory job status must be 'complete', NOT 'failed'!
  const inMem = await manager.get(job.id);
  assert.equal(inMem.status, 'complete', 'status must remain complete after successful turn even if save failed');
  assert.equal(inMem.budgetUsage.slices, 1, 'slices must be counted exactly once');
  assert.equal(turns, 1, 'turn must have executed once');

  // Now, calling resume() must return the completed checkpoint immediately WITHOUT running turn() again!
  failFinalSave = false;
  const resumed = await manager.resume(job.id);
  assert.equal(resumed.status, 'complete');
  assert.equal(turns, 1, 'turn must NOT be re-executed on resume of already completed job');
  assert.equal(resumed.budgetUsage.slices, 1, 'slices must not be double counted');
}

console.log('#6186: All tests passed successfully.');
