import assert from 'node:assert/strict';
import { AgentJobManager } from '../../../js/ai/jobs/index.js';

const saved = [];
let seenRequest = null;
const manager = new AgentJobManager({
  runtime: {
    async turn(request) {
      seenRequest = request;
      return { limits: { exhausted: false }, usage: {} };
    },
  },
  persistence: {
    async save(value) {
      saved.push(structuredClone(value));
    },
  },
});

const budget = { maxToolCalls: 1, nested: { maxSearchResults: 2 } };
const task = { kind: 'audit', target: { functionId: 'fn-1' }, steps: ['inspect'] };
const created = await manager.create({
  goal: 'audit',
  jobId: 'job-3725',
  style: 'concise',
  intent: 'inspect',
  budget,
  task,
  maxSearchResults: 7,
  plannerTimeoutMs: 250,
});

assert.deepEqual(created.request.budget, { maxToolCalls: 1, nested: { maxSearchResults: 2 } });
assert.deepEqual(created.request.task, { kind: 'audit', target: { functionId: 'fn-1' }, steps: ['inspect'] });
assert.deepEqual(saved[0].request, created.request, 'persisted request must match the creation-time checkpoint');

budget.maxToolCalls = 24;
budget.nested.maxSearchResults = 99;
task.target.functionId = 'fn-mutated';
task.steps.push('rewrite');

const inMemory = manager.list().find((job) => job.id === created.id);
assert.deepEqual(inMemory.request, created.request, 'caller mutation must not alter canonical in-memory request state');

await manager.runSlice(created.id);

assert.ok(seenRequest, 'runtime must receive the job request');
assert.deepEqual(seenRequest.budget, { maxToolCalls: 1, nested: { maxSearchResults: 2 } });
assert.deepEqual(seenRequest.task, { kind: 'audit', target: { functionId: 'fn-1' }, steps: ['inspect'] });
assert.deepEqual(seenRequest.budget, saved[0].request.budget, 'runtime budget must match the persisted creation snapshot');
assert.deepEqual(seenRequest.task, saved[0].request.task, 'runtime task must match the persisted creation snapshot');
assert.equal(seenRequest.style, 'concise');
assert.equal(seenRequest.intent, 'inspect');
assert.equal(seenRequest.maxSearchResults, 7);
assert.equal(seenRequest.plannerTimeoutMs, 250);

console.log('issue-3725 AI job request snapshot regression: ok');
