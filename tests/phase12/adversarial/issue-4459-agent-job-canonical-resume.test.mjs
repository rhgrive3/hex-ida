import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentJobManager } from '../../../js/ai/jobs/index.js';

const MAX_ELAPSED_MS = 4 * 60 * 60 * 1000;

function checkpoint(id, overrides = {}) {
  const { budgetUsage = {}, limits = {}, ...rest } = overrides;
  return {
    version: 1,
    id,
    status: 'ready',
    goal: 'resume safely',
    effectiveScope: 'auto',
    conversationId: null,
    sessionId: null,
    provider: null,
    model: null,
    reasoning: null,
    evidenceIds: [],
    hypothesisIds: [],
    completedTools: [],
    continuationRefs: [],
    unresolvedWork: [],
    budgetUsage: { slices: 0, modelCalls: 0, toolCalls: 0, elapsedMs: 0, contextBytes: 0, ...budgetUsage },
    limits: { maxSlices: 2, maxElapsedMs: 30 * 60 * 1000, ...limits },
    request: {},
    lastResult: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...rest,
  };
}

function runtimeWithCounter() {
  const calls = { count: 0 };
  return {
    calls,
    runtime: {
      async turn() {
        calls.count += 1;
        return { limits: { exhausted: false }, usage: {} };
      },
    },
  };
}

test('issue #4459 rejects a valid-looking checkpoint object that is not registered', async () => {
  const { calls, runtime } = runtimeWithCounter();
  const manager = new AgentJobManager({ runtime });

  await assert.rejects(
    manager.runSlice(checkpoint('unregistered-object')),
    /Unknown agent job: unregistered-object/
  );
  assert.equal(calls.count, 0, 'an unregistered caller object must never reach runtime.turn');
  assert.equal(manager.list().length, 0, 'an unregistered object must not become canonical state');
});

test('issue #4459 ignores tampered state on a detached caller checkpoint', async () => {
  const { calls, runtime } = runtimeWithCounter();
  const manager = new AgentJobManager({ runtime });
  const created = await manager.create({ goal: 'canonical state', jobId: 'canonical-job', maxSlices: 1 });
  const tampered = {
    ...created,
    status: 'hard-limit',
    budgetUsage: { ...created.budgetUsage, slices: 32 },
    limits: { maxSlices: 1_000_000, maxElapsedMs: 1_000_000_000 },
  };

  const result = await manager.runSlice(tampered);
  assert.equal(result.status, 'complete');
  assert.equal(calls.count, 1, 'the registered canonical job should run exactly once');
  assert.deepEqual((await manager.get(created.id)).limits, { maxSlices: 1, maxElapsedMs: 30 * 60 * 1000 });
  assert.equal((await manager.get(created.id)).budgetUsage.slices, 1);
});

test('issue #4459 rejects persisted checkpoints that exceed the reviewed hard ceilings', async () => {
  for (const [label, limits] of [
    ['slice', { maxSlices: 33, maxElapsedMs: 30 * 60 * 1000 }],
    ['elapsed', { maxSlices: 2, maxElapsedMs: MAX_ELAPSED_MS + 1 }],
  ]) {
    const { calls, runtime } = runtimeWithCounter();
    const id = `persisted-over-limit-${label}`;
    const manager = new AgentJobManager({
      runtime,
      persistence: { async load() { return checkpoint(id, { limits }); }, async save() {} },
    });

    await assert.rejects(manager.runSlice(id), /Unknown agent job/);
    assert.equal(calls.count, 0, `${label} over-limit checkpoint must not execute`);
    assert.equal(manager.list().length, 0, `${label} over-limit checkpoint must not be cached`);
  }
});

test('issue #4459 keeps valid persisted ID resume working', async () => {
  const { calls, runtime } = runtimeWithCounter();
  const id = 'persisted-valid';
  const manager = new AgentJobManager({
    runtime,
    persistence: { async load() { return checkpoint(id); }, async save() {} },
  });

  const result = await manager.runSlice(id);
  assert.equal(result.status, 'complete');
  assert.equal(calls.count, 1);
  assert.equal((await manager.get(id)).budgetUsage.slices, 1);
});

console.log('issue #4459 agent-job canonical resume: PASS');
