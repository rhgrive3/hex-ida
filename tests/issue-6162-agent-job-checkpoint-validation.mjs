import assert from 'node:assert/strict';
import { AgentJobManager } from '../js/ai/jobs/index.js';

console.log('Testing #6162: AgentJobManager persisted checkpoint validation...');

const validBaseCheckpoint = {
  version: 1,
  id: 'job-valid',
  status: 'ready',
  goal: 'valid-goal',
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

// 1. Valid checkpoint loads normally
{
  const runtime = { turn: async () => ({ limits: { exhausted: false }, answer: 'done' }) };
  const persistence = {
    load: async (id) => (id === 'job-valid' ? { ...validBaseCheckpoint } : null),
    save: async () => {},
  };
  const manager = new AgentJobManager({ runtime, persistence });

  const loaded = await manager.get('job-valid');
  assert.ok(loaded);
  assert.equal(loaded.id, 'job-valid');
  assert.equal(loaded.status, 'ready');
}

// 2. Mismatched ID in persistence is rejected
{
  const runtime = { turn: async () => ({ limits: { exhausted: false }, answer: 'done' }) };
  const persistence = {
    // caller requests job-A, but persistence returns record for job-B
    load: async () => ({ ...validBaseCheckpoint, id: 'job-B' }),
    save: async () => {},
  };
  const manager = new AgentJobManager({ runtime, persistence });

  const loaded = await manager.get('job-A');
  assert.equal(loaded, null, 'mismatched checkpoint id must be rejected');
  assert.equal(manager.list().length, 0, 'rejected checkpoint must not be cached in this.jobs');
}

// 3. Malformed status / budgetUsage / limits rejected
{
  const runtime = { turn: async () => ({ limits: { exhausted: false }, answer: 'done' }) };
  const testCases = [
    { name: 'unknown status', record: { ...validBaseCheckpoint, id: 'job-bad', status: 'bogus' } },
    { name: 'null budgetUsage', record: { ...validBaseCheckpoint, id: 'job-bad', budgetUsage: null } },
    { name: 'missing slices in budget', record: { ...validBaseCheckpoint, id: 'job-bad', budgetUsage: { modelCalls: 0 } } },
    { name: 'string limits', record: { ...validBaseCheckpoint, id: 'job-bad', limits: { maxSlices: 'eight' } } },
    { name: 'non-array evidenceIds', record: { ...validBaseCheckpoint, id: 'job-bad', evidenceIds: 'none' } },
    { name: 'wrong version', record: { ...validBaseCheckpoint, id: 'job-bad', version: 999 } },
    { name: 'empty goal', record: { ...validBaseCheckpoint, id: 'job-bad', goal: '' } },
  ];

  for (const tc of testCases) {
    const persistence = {
      load: async () => tc.record,
      save: async () => {},
    };
    const manager = new AgentJobManager({ runtime, persistence });
    const loaded = await manager.get('job-bad');
    assert.equal(loaded, null, `malformed record (${tc.name}) must be rejected`);
    assert.equal(manager.list().length, 0, `malformed record (${tc.name}) must not be cached in this.jobs`);
  }
}

// 4. Recovery: subsequent valid load after invalid load succeeds
{
  const runtime = { turn: async () => ({ limits: { exhausted: false }, answer: 'done' }) };
  let returnsValid = false;
  const persistence = {
    load: async (id) => (returnsValid ? { ...validBaseCheckpoint, id } : { ...validBaseCheckpoint, id, status: 'invalid' }),
    save: async () => {},
  };
  const manager = new AgentJobManager({ runtime, persistence });

  const firstAttempt = await manager.get('job-recover');
  assert.equal(firstAttempt, null);

  returnsValid = true;
  const secondAttempt = await manager.get('job-recover');
  assert.ok(secondAttempt);
  assert.equal(secondAttempt.id, 'job-recover');
  assert.equal(secondAttempt.status, 'ready');
}

console.log('#6162: All tests passed successfully.');
