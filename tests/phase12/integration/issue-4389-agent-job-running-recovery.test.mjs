import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentJobManager } from '../../../js/ai/jobs/index.js';

function memoryPersistence({ failFinalSave = false } = {}) {
  const records = new Map();
  let saves = 0;
  return {
    records,
    setFailFinalSave(value) { failFinalSave = value; },
    async save(job) {
      saves++;
      if (failFinalSave && saves >= 3) throw new Error('storage unavailable');
      records.set(job.id, structuredClone(job));
    },
    async load(id) { return structuredClone(records.get(id) ?? null); },
  };
}

test('#4389 a persisted running slice is recoverable after final checkpoint failure', async () => {
  let turns = 0;
  const runtime = {
    async turn() {
      turns++;
      return { answer: `turn-${turns}`, limits: { exhausted: false } };
    },
  };
  const persistence = memoryPersistence({ failFinalSave: true });
  const first = new AgentJobManager({ runtime, persistence });
  await first.create({ jobId: 'issue-4389', goal: 'recover me' });

  await assert.rejects(first.runSlice('issue-4389'), /storage unavailable/);
  assert.equal(turns, 1);
  assert.equal(persistence.records.get('issue-4389').status, 'running');
  assert.match(persistence.records.get('issue-4389').executionLeaseId, /^agent_job_lease_/);

  const restarted = new AgentJobManager({ runtime, persistence });
  const loaded = await restarted.get('issue-4389');
  assert.equal(loaded.status, 'checkpointed');
  assert.match(loaded.unresolvedWork.at(-1), /^resume-after:/);

  persistence.setFailFinalSave(false);
  const resumed = await restarted.resume('issue-4389');
  assert.equal(resumed.status, 'complete');
  assert.equal(turns, 2);
  assert.equal(persistence.records.get('issue-4389').status, 'complete');
});

test('#4389 a live owner cannot be replayed by a second manager sharing persistence', async () => {
  let releaseFirst;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let turns = 0;
  let active = 0;
  let maxActive = 0;
  const runtime = {
    async turn() {
      turns++;
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        if (turns === 1) {
          markStarted();
          await new Promise((resolve) => { releaseFirst = resolve; });
        }
        return { answer: `turn-${turns}`, limits: { exhausted: false } };
      } finally {
        active--;
      }
    },
  };
  const persistence = memoryPersistence();
  const owner = new AgentJobManager({ runtime, persistence });
  await owner.create({ jobId: 'issue-4389-live-owner', goal: 'one owner' });
  const running = owner.runSlice('issue-4389-live-owner');
  await started;
  assert.equal(persistence.records.get('issue-4389-live-owner').status, 'running');

  const contenderRuntime = { turn: (...args) => runtime.turn(...args) };
  const contender = new AgentJobManager({ runtime: contenderRuntime, persistence });
  try {
    await assert.rejects(contender.resume('issue-4389-live-owner'), /active slice/);
    assert.equal(turns, 1);
    assert.equal(maxActive, 1);
  } finally {
    releaseFirst();
    await running;
  }
  assert.equal(persistence.records.get('issue-4389-live-owner').status, 'complete');
  assert.equal((await contender.get('issue-4389-live-owner')).status, 'complete');
});

test('#4389 a running checkpoint left by a runtime crash can be resumed', async () => {
  const persistence = memoryPersistence();
  const seed = new AgentJobManager({ runtime: { async turn() { throw new Error('must not run during seed'); } }, persistence });
  const ready = await seed.create({ jobId: 'issue-4389-crash', goal: 'recover after crash' });
  const interrupted = structuredClone(ready);
  interrupted.status = 'running';
  persistence.records.set(interrupted.id, interrupted);

  let turns = 0;
  const restarted = new AgentJobManager({
    runtime: {
      async turn() {
        turns++;
        return { answer: 'recovered', limits: { exhausted: false } };
      },
    },
    persistence,
  });
  const resumed = await restarted.resume(interrupted.id);
  assert.equal(resumed.status, 'complete');
  assert.equal(turns, 1);
  assert.equal(persistence.records.get(interrupted.id).status, 'complete');
});

test('#4389 an active slice remains single-flight within one manager', async () => {
  let release;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const runtime = {
    async turn() {
      markStarted();
      await new Promise((resolve) => { release = resolve; });
      return { answer: 'done', limits: { exhausted: false } };
    },
  };
  const manager = new AgentJobManager({ runtime });
  await manager.create({ jobId: 'issue-4389-single-flight', goal: 'one at a time' });
  const running = manager.runSlice('issue-4389-single-flight');
  await started;
  await assert.rejects(manager.resume('issue-4389-single-flight'), /active slice/);
  release();
  assert.equal((await running).status, 'complete');
});
