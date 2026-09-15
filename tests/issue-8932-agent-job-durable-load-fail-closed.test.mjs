import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentJobManager } from '../js/ai/jobs/index.js';

// #8932: a persistence read failure is not an authoritative "record absent".
// AgentJobManager.load() previously swallowed storage exceptions and returned
// null, so create({jobId}) judged an existing durable job to be free and
// silently overwrote its checkpoint. Reads must surface (fail closed); only a
// backend-authorized null (or a distinct invalid-corrupt record) is absence.

function existingCheckpoint(id, over = {}) {
  return {
    version: 1, id, executionScopeId: `scope-old-${id}`, status: 'checkpointed',
    goal: 'important old work', effectiveScope: 'project', conversationId: null, sessionId: null,
    provider: null, model: null, reasoning: null,
    evidenceIds: ['ev-old'], hypothesisIds: [], completedTools: ['old-tool'], continuationRefs: [], unresolvedWork: ['continue old'],
    budgetUsage: { slices: 3, modelCalls: 3, toolCalls: 10, elapsedMs: 1234, contextBytes: 1000 },
    limits: { maxSlices: 8, maxElapsedMs: 300000 },
    request: {}, lastResult: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function makeManager(durable, { failFirstLoadFor = null } = {}) {
  let failOnce = failFirstLoadFor;
  return new AgentJobManager({
    runtime: { async turn() { throw new Error('turn not needed for create/get'); } },
    persistence: {
      async load(id) {
        if (failOnce && id === failOnce) { failOnce = null; throw new Error('transient storage read failure'); }
        return durable.get(id) ?? null;
      },
      async save(value) { durable.set(value.id, structuredClone(value)); },
    },
  });
}

await test('#8932 create({jobId}) fails closed on a transient read failure instead of overwriting the durable checkpoint', async () => {
  const durable = new Map([['job-A', existingCheckpoint('job-A')]]);
  const manager = makeManager(durable, { failFirstLoadFor: 'job-A' });
  await assert.rejects(
    () => manager.create({ jobId: 'job-A', goal: 'replacement work' }),
    /transient storage read failure/,
  );
  // The old checkpoint must survive the failed existence probe untouched.
  const stored = durable.get('job-A');
  assert.equal(stored.goal, 'important old work');
  assert.equal(stored.status, 'checkpointed');
  assert.deepEqual(stored.evidenceIds, ['ev-old']);
});

await test('#8932 a cleared transient failure still reports the existing job (read-failure is not absence)', async () => {
  const durable = new Map([['job-A', existingCheckpoint('job-A')]]);
  const manager = makeManager(durable, { failFirstLoadFor: 'job-A' });
  await assert.rejects(() => manager.get('job-A'), /transient storage read failure/);
  const job = await manager.get('job-A');
  assert.ok(job);
  assert.equal(job.goal, 'important old work');
});

await test('#8932 authoritative absence (load -> null) still allows create({jobId}) to persist a new job', async () => {
  const durable = new Map();
  const manager = makeManager(durable);
  const created = await manager.create({ jobId: 'job-B', goal: 'brand new' });
  assert.equal(created.goal, 'brand new');
  assert.equal(durable.get('job-B').goal, 'brand new');
});

await test('#8932 a present-but-invalid checkpoint is absence (null), a distinct path from an I/O throw', async () => {
  const durable = new Map([['job-C', { version: 1, id: 'job-C', goal: '', status: 'bogus' }]]); // invalid
  const manager = makeManager(durable);
  const got = await manager.get('job-C'); // must not throw; invalid record => absence
  assert.equal(got, null);
  const created = await manager.create({ jobId: 'job-C', goal: 'overwrite invalid' });
  assert.equal(created.goal, 'overwrite invalid');
});
