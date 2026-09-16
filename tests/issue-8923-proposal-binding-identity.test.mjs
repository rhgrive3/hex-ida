// Issue #8923 regression: proposalBinding() must not String()-coerce structured
// binary/project/runtime IDs into canonical binding authority. The binding also
// carries the canonical analysis revision (see #8929).
import assert from 'node:assert/strict';
import test from 'node:test';

import { AIRuntime } from '../js/ai/runtime.js';

function stubEvidence() {
  return {
    get(id) { return id === 'ev-1' ? { id, status: 'verified' } : null; },
    has(id) { return id === 'ev-1'; },
  };
}

test('#8923 structured IDs do not launder into canonical binding', () => {
  const context = { binaryId: ['bin-A'], projectId: ['proj-A'], runtimeSessionId: ['rt-A'] };
  const runtime = new AIRuntime({ context, evidenceStore: stubEvidence(), planner: false });
  const proposal = runtime.proposalStore.create({
    id: 'proposal-8923', kind: 'comment', target: { address: '0x1000' },
    before: null, after: 'x', evidenceIds: ['ev-1'],
  });
  assert.deepEqual(proposal.binding, { binaryId: null, projectId: null, runtimeSessionId: null, analysisRevision: null });
});

test('#8923 array->primitive switch fails closed instead of applied', async () => {
  const context = { binaryId: ['bin-A'], projectId: ['proj-A'], runtimeSessionId: ['rt-A'] };
  const runtime = new AIRuntime({ context, evidenceStore: stubEvidence(), planner: false });
  const proposal = runtime.proposalStore.create({
    id: 'proposal-8923-apply', kind: 'comment', target: { address: '0x1000' },
    before: null, after: 'x', evidenceIds: ['ev-1'],
  });
  const { approvalToken } = runtime.proposalStore.approve(proposal.id);
  context.binaryId = 'bin-A';
  context.projectId = 'proj-A';
  context.runtimeSessionId = 'rt-A';
  let applied = false;
  await assert.rejects(
    () => runtime.proposalStore.apply(proposal.id, {
      approvalToken, currentState: null, apply: async () => { applied = true; },
    }),
  );
  assert.equal(applied, false);
});

test('#8923 canonical string IDs still reach applied', async () => {
  const context = { binaryId: 'bin-A', projectId: 'proj-A', runtimeSessionId: 'rt-A' };
  const runtime = new AIRuntime({ context, evidenceStore: stubEvidence(), planner: false });
  const proposal = runtime.proposalStore.create({
    id: 'proposal-8923-valid', kind: 'comment', target: { address: '0x1000' },
    before: null, after: 'x', evidenceIds: ['ev-1'],
  });
  assert.deepEqual(proposal.binding, { binaryId: 'bin-A', projectId: 'proj-A', runtimeSessionId: 'rt-A', analysisRevision: null });
  const { approvalToken } = runtime.proposalStore.approve(proposal.id);
  const result = await runtime.proposalStore.apply(proposal.id, {
    approvalToken, currentState: null, apply: async () => {},
  });
  assert.equal(result.status, 'applied');
});
