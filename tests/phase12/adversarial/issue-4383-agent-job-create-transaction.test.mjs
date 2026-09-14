import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentJobManager } from '../../../js/ai/jobs/index.js';

const runtime = { async turn() { throw new Error('unsaved job must not execute'); } };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const explicit of [true, false]) {
  test(`failed ${explicit ? 'explicit' : 'generated'} job creation leaves no ghost`, async () => {
    const failure = new Error('disk-full');
    let attemptedId;
    let fail = true;
    const records = new Map();
    const manager = new AgentJobManager({ runtime, persistence: {
      async load(id) { return records.get(id) ?? null; },
      async save(job) {
        attemptedId = job.id;
        if (fail) throw failure;
        records.set(job.id, structuredClone(job));
      },
    } });
    await assert.rejects(manager.create({ goal: 'test', ...(explicit ? { jobId: 'retry' } : {}) }), (e) => e === failure);
    const failedId = attemptedId;
    assert.equal(await manager.get(failedId), null);
    assert.deepEqual(manager.list(), []);
    assert.equal(manager.creatingIds.size, 0);
    assert.equal(manager.loadingPromises.size, 0);
    await assert.rejects(manager.runSlice(failedId), /Unknown agent job/);
    fail = false;
    const saved = await manager.create({ jobId: failedId, goal: 'retry' });
    assert.equal(saved.id, failedId);
    assert.equal((await manager.get(failedId)).status, 'ready');
    assert.equal(manager.list().length, 1);
    assert.deepEqual(records.get(failedId), saved);
  });
}

for (const succeeds of [true, false]) {
  test(`pending save remains unpublished and reserved (${succeeds ? 'success' : 'failure'})`, async () => {
    const entered = deferred(), saving = deferred();
    let saves = 0;
    const manager = new AgentJobManager({ runtime, persistence: {
      async load() { return null; },
      async save() { saves++; entered.resolve(); await saving.promise; },
    } });
    const pending = manager.create({ jobId: 'pending', goal: 'test' });
    const failure = new Error('save-failed');
    const outcome = succeeds ? pending : assert.rejects(pending, (e) => e === failure);
    await entered.promise;
    try {
      assert.equal(manager.creatingIds.has('pending'), true);
      assert.equal(manager.jobs.has('pending'), false);
      assert.deepEqual(manager.list(), []);
      assert.equal(await manager.get('pending'), null);
      await assert.rejects(manager.runSlice('pending'), /Unknown agent job/);
      await assert.rejects(manager.create({ jobId: 'pending', goal: 'duplicate' }), /already exists/);
      assert.equal(saves, 1);
    } finally {
      if (succeeds) saving.resolve(); else saving.reject(failure);
      await outcome;
    }
    assert.equal(manager.creatingIds.size, 0);
    assert.equal(manager.jobs.has('pending'), succeeds);
  });
}

test('creation without persistence preserves detached checkpoints', async () => {
  const manager = new AgentJobManager({ runtime });
  const created = await manager.create({ jobId: 'local', goal: 'original' });
  created.goal = 'mutated';
  assert.equal((await manager.get('local')).goal, 'original');
  await assert.rejects(manager.create({ jobId: 'local', goal: 'duplicate' }), /already exists/);
});
