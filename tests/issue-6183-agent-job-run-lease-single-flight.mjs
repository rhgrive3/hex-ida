import assert from 'node:assert/strict';
import { AgentJobManager } from '../js/ai/jobs/index.js';

console.log('Testing #6183: AgentJobManager run lease single-flight...');

// 1. In-memory concurrent runSlice rejects second slice
{
  let turnBarrierResolve;
  const turnBarrier = new Promise((resolve) => { turnBarrierResolve = resolve; });
  let turnExecutions = 0;

  const runtime = {
    turn: async () => {
      turnExecutions++;
      await turnBarrier;
      return { limits: { exhausted: false }, answer: 'done' };
    },
  };
  const manager = new AgentJobManager({ runtime });
  const job = await manager.create({ goal: 'test-concurrency', jobId: 'job-c1' });

  const p1 = manager.runSlice(job.id);

  // Attempt concurrent runSlice on the same job
  await assert.rejects(
    manager.runSlice(job.id),
    /Agent job already has an active slice/
  );

  // Also reject if caller passes the cloned object
  await assert.rejects(
    manager.runSlice(job),
    /Agent job already has an active slice/
  );

  turnBarrierResolve();
  const res1 = await p1;
  assert.equal(res1.status, 'complete');
  assert.equal(turnExecutions, 1);
}

// 2. Cache-miss + persistence load race: exactly one active slice
{
  let loadBarrierResolve;
  const loadBarrier = new Promise((resolve) => { loadBarrierResolve = resolve; });
  let turnExecutions = 0;

  const runtime = {
    turn: async () => {
      turnExecutions++;
      return { limits: { exhausted: false }, answer: 'done' };
    },
  };

  const persistedData = {
    version: 1,
    id: 'persisted-job-1',
    status: 'ready',
    goal: 'persisted-goal',
    effectiveScope: 'auto',
    conversationId: null,
    sessionId: null,
    provider: null,
    model: null,
    reasoning: null,
    evidenceIds: [], hypothesisIds: [], completedTools: [],
    continuationRefs: [], unresolvedWork: [],
    budgetUsage: { slices: 0, modelCalls: 0, toolCalls: 0, elapsedMs: 0, contextBytes: 0 },
    limits: { maxSlices: 8, maxElapsedMs: 1800000 },
    request: {}, lastResult: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };

  const persistence = {
    load: async (id) => {
      await loadBarrier;
      // return a new clone every time
      return JSON.parse(JSON.stringify(persistedData));
    },
    save: async () => {},
  };

  const manager = new AgentJobManager({ runtime, persistence });

  // Initiate two runSlices concurrently while persistence.load is blocked
  const p1 = manager.runSlice('persisted-job-1');
  const p2 = manager.runSlice('persisted-job-1');

  loadBarrierResolve();

  const results = await Promise.allSettled([p1, p2]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');

  assert.equal(fulfilled.length, 1, 'Exactly one runSlice must succeed');
  assert.equal(rejected.length, 1, 'Second runSlice must be rejected');
  assert.match(rejected[0].reason.message, /Agent job already has an active slice/);
  assert.equal(turnExecutions, 1, 'turn() must be executed only once');
}

// 3. Different job IDs can execute concurrently
{
  const runtime = {
    turn: async () => ({ limits: { exhausted: false }, answer: 'done' }),
  };
  const manager = new AgentJobManager({ runtime });
  const jA = await manager.create({ goal: 'goal-A', jobId: 'job-A' });
  const jB = await manager.create({ goal: 'goal-B', jobId: 'job-B' });

  const [resA, resB] = await Promise.all([
    manager.runSlice(jA.id),
    manager.runSlice(jB.id),
  ]);

  assert.equal(resA.status, 'complete');
  assert.equal(resB.status, 'complete');
}

// 4. Lease is released on turn failure so next attempt is not blocked
{
  let shouldFail = true;
  const runtime = {
    turn: async () => {
      if (shouldFail) throw new Error('turn failure');
      return { limits: { exhausted: false }, answer: 'recovered' };
    },
  };
  const manager = new AgentJobManager({ runtime });
  const job = await manager.create({ goal: 'test-error-release', jobId: 'job-err' });

  await assert.rejects(
    manager.runSlice(job.id),
    /turn failure/
  );

  // Lease must be freed: next attempt must not fail with 'already has an active slice'
  shouldFail = false;
  const res = await manager.runSlice(job.id);
  assert.equal(res.status, 'complete');
}

console.log('#6183: All tests passed successfully.');
