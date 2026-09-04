import assert from 'node:assert/strict';
import { AgentJobManager } from '../js/ai/jobs/index.js';

// 1. runtime.turn() 成功 + final checkpoint save成功 -> complete
{
  let turnCalls = 0;
  const runtime = {
    turn: async () => {
      turnCalls++;
      return { answer: 'All done', limits: { exhausted: false }, usage: { modelCalls: 1 } };
    },
  };
  let savedJob = null;
  const persistence = {
    save: async (job) => { savedJob = job; },
    load: async () => null,
  };
  const manager = new AgentJobManager({ runtime, persistence });
  const job = await manager.create({ goal: 'goal-1', jobId: 'job-1' });
  const res = await manager.runSlice(job.id);
  assert.equal(res.status, 'complete');
  assert.equal(turnCalls, 1);
  assert.equal(savedJob.status, 'complete');
  assert.equal(savedJob.lastResult.answer, 'All done');
}

// 2 & 3 & 4. runtime.turn() 成功 + final checkpoint save失敗
// -> result を失わず、failed としてturn再実行可能にしない
// -> checkpoint 保存だけを retry できる (manager.save)
// -> recovery しても runtime.turn() call count は 1 のまま
{
  let turnCalls = 0;
  const runtime = {
    turn: async () => {
      turnCalls++;
      return {
        answer: 'Completed calculation',
        limits: { exhausted: false },
        evidence: [{ id: 'ev-1' }],
        usage: { modelCalls: 2, elapsedMs: 50 },
      };
    },
  };
  let saveCount = 0;
  let failPostTurnSave = true;
  let lastSaved = null;
  const persistence = {
    save: async (job) => {
      saveCount++;
      if (failPostTurnSave && job.status === 'complete') {
        throw new Error('EIO: Disk save error');
      }
      lastSaved = job;
    },
    load: async () => null,
  };

  const manager = new AgentJobManager({ runtime, persistence });
  const job = await manager.create({ goal: 'goal-2', jobId: 'job-2' });
  assert.equal(saveCount, 1); // create save succeeded

  // Fail on the post-turn save (when job.status === 'complete')
  await assert.rejects(
    manager.runSlice(job.id),
    /Disk save error/,
  );
  assert.equal(turnCalls, 1, 'turn was called');

  // Verify in-memory job state: must NOT be 'failed'
  const inMem = await manager.get(job.id);
  assert.equal(inMem.status, 'complete', 'status must be complete, not failed');
  assert.equal(inMem.lastResult.answer, 'Completed calculation');
  assert.deepEqual(inMem.evidenceIds, ['ev-1']);
  assert.equal(inMem.budgetUsage.slices, 1);
  assert.equal(inMem.budgetUsage.modelCalls, 2);

  // 4. Retry checkpoint save directly
  failPostTurnSave = false;
  const saved = await manager.save(job.id);
  assert.equal(saved.status, 'complete');
  assert.equal(lastSaved.status, 'complete');
  assert.equal(lastSaved.lastResult.answer, 'Completed calculation');
  assert.equal(turnCalls, 1, 'turn was not called during save retry');

  // 3. Resume should not re-run turn
  const resumed = await manager.resume(job.id);
  assert.equal(resumed.status, 'complete');
  assert.equal(turnCalls, 1, 'turn must not be re-run after recovery');
}

// 5. runtime.turn() 自体が throw した場合の既存 failed / checkpointed semantics は維持
{
  let turnCalls = 0;
  const runtime = {
    turn: async () => {
      turnCalls++;
      throw new Error('RateLimitExceeded');
    },
  };
  const persistence = {
    save: async () => {},
    load: async () => null,
  };
  const manager = new AgentJobManager({ runtime, persistence });
  const job = await manager.create({ goal: 'goal-5', jobId: 'job-5' });
  await assert.rejects(
    manager.runSlice(job.id),
    /RateLimitExceeded/,
  );
  assert.equal(turnCalls, 1);
  const inMem = await manager.get(job.id);
  assert.equal(inMem.status, 'failed');
  assert.ok(inMem.unresolvedWork.some((w) => w.includes('RateLimitExceeded')));
}

// 6 & 7. result が limits.exhausted:true の checkpointed slice でも save 失敗後に slice を二重実行しない
// budgetUsage / lastResult / evidenceIds を二重加算しない
{
  let turnCalls = 0;
  const runtime = {
    turn: async () => {
      turnCalls++;
      if (turnCalls === 1) {
        return {
          answer: 'Partial 1',
          limits: { exhausted: true, reason: 'slice-budget' },
          evidence: [{ id: 'ev-slice-1' }],
          usage: { modelCalls: 1, elapsedMs: 10 },
        };
      } else {
        return {
          answer: 'Final 2',
          limits: { exhausted: false },
          evidence: [{ id: 'ev-slice-2' }],
          usage: { modelCalls: 1, elapsedMs: 10 },
        };
      }
    },
  };

  let failPostSlice1Save = true;
  const persistence = {
    save: async (job) => {
      if (failPostSlice1Save && job.status === 'checkpointed') {
        throw new Error('persistence timeout');
      }
    },
    load: async () => null,
  };

  const manager = new AgentJobManager({ runtime, persistence });
  const job = await manager.create({ goal: 'goal-6', jobId: 'job-6' });

  // Slice 1: turn succeeds, but save throws
  await assert.rejects(
    manager.runSlice(job.id),
    /persistence timeout/,
  );
  assert.equal(turnCalls, 1);

  const inMem = await manager.get(job.id);
  assert.equal(inMem.status, 'checkpointed', 'status must be checkpointed');
  assert.equal(inMem.budgetUsage.slices, 1);
  assert.deepEqual(inMem.evidenceIds, ['ev-slice-1']);

  // Resume after fixing persistence:
  failPostSlice1Save = false;
  const resumed = await manager.resume(job.id);
  // Now slice 2 should execute
  assert.equal(turnCalls, 2, 'slice 2 should run, but slice 1 was NOT re-run');
  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.budgetUsage.slices, 2);
  assert.deepEqual(resumed.evidenceIds, ['ev-slice-1', 'ev-slice-2']);
  assert.equal(resumed.budgetUsage.modelCalls, 2);
}

// 8. persistence が継続的に失敗しても実行済み turn を無制限 rerun しない
{
  let turnCalls = 0;
  const runtime = {
    turn: async () => {
      turnCalls++;
      return { answer: 'Done', limits: { exhausted: false } };
    },
  };
  const persistence = {
    save: async (job) => {
      if (job.status === 'complete') {
        throw new Error('permanent disk failure');
      }
    },
    load: async () => null,
  };

  const manager = new AgentJobManager({ runtime, persistence });
  const job = await manager.create({ goal: 'goal-8', jobId: 'job-8' });

  // 1st run: turn runs once, post-turn save fails
  await assert.rejects(manager.runSlice(job.id), /permanent disk failure/);
  assert.equal(turnCalls, 1);

  // 2nd run (retry): must fail at save, NOT rerun turn
  await assert.rejects(manager.runSlice(job.id), /permanent disk failure/);
  assert.equal(turnCalls, 1, 'turn must not rerun on repeated save failure');

  // 3rd run (resume): must fail at save, NOT rerun turn
  await assert.rejects(manager.resume(job.id), /permanent disk failure/);
  assert.equal(turnCalls, 1, 'turn must not rerun on repeated save failure');
}

console.log('issue-6273 regression test: PASS');
