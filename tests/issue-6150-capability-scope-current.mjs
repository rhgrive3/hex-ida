import assert from 'node:assert/strict';
import { createCapabilityCatalog } from '../js/ai/capabilities/catalog.js';
import { CapabilityExecutor } from '../js/ai/capabilities/executor.js';
import { ProposalStore } from '../js/ai/proposals.js';

const evidenceStore = { has: (id) => id === 'e1' };
const app = { projectAnnotations: [], workspace: { autosave() {} } };
const executor = new CapabilityExecutor({ catalog: createCapabilityCatalog(), app });

await assert.rejects(
  () => executor.execute('annotation.project', { value: 'wrong-scope' }, { scope: 'function' }),
  (error) => error.type === 'scope_violation',
);

const store = new ProposalStore({ evidenceStore });
const proposal = store.create({
  kind: 'project-annotation',
  target: {},
  before: null,
  after: 'project-value',
  evidenceIds: ['e1'],
});
const { approvalToken } = store.approve(proposal.id);
await store.apply(proposal.id, {
  approvalToken,
  currentState: null,
  apply: async (execution, authorization) => {
    const result = await executor.execute(
      'annotation.project',
      { value: execution.after },
      { scope: 'project', authorization },
    );
    assert.equal(result.value, 'project-value');
  },
});
assert.equal(app.projectAnnotations.length, 1);
console.log('#6150 current CapabilityExecutor scope gate: PASS');
