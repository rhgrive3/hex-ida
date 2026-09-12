/* #5139 regression: project-annotation proposal identity is fixed at creation
   time. An id-less target used to pass approval, mutate through a freshly
   minted `annotation:<Date.now()>` record, then fail its postcondition against
   the empty id — a failed proposal with an orphan annotation left behind.
   Creation now rejects the id-less target before any approval exists, while
   explicit-id proposals keep the established upsert semantics (#3782). */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ProposalStore } from '../../../js/ai/proposals.js';
import { ProposalExecutor } from '../../../js/ai/interaction/proposal-executor.js';
import { CapabilityExecutor } from '../../../js/ai/capabilities/executor.js';

const evidenceStore = { has: (id) => id === 'ev' };
const catalog = { get: (id) => (id === 'annotation.project' ? { id, agentExposed: true, inputSchema: { type: 'object' } } : null) };

function projectApp() {
  return {
    projectAnnotations: [],
    autoReport: { report: { confirmed: [], deep: [] } },
    workspace: { autosave: async () => true },
  };
}

test('#5139 an id-less project-annotation proposal is rejected at creation, before approval', () => {
  const store = new ProposalStore({ evidenceStore });
  assert.throws(
    () => store.create({ kind: 'project-annotation', target: {}, before: null, after: { verdict: 'verified' }, evidenceIds: ['ev'] }),
    (error) => error.type === 'invalid_tool_call' && /requires a non-empty string target id/.test(error.message),
  );
  assert.equal(store.records.size, 0, 'no proposal record may exist for a rejected id-less target');
  assert.equal(store.audit.some((entry) => entry.type === 'proposal-created'), false);
});

test('#5139 a non-string or empty target id is rejected as well', () => {
  const store = new ProposalStore({ evidenceStore });
  for (const target of [{ id: 42 }, { id: '' }, { id: null }, { id: ['a1'] }]) {
    assert.throws(
      () => store.create({ kind: 'project-annotation', target, before: null, after: 'v', evidenceIds: ['ev'] }),
      /requires a non-empty string target id/,
    );
  }
});

test('#5139 an explicit-id project-annotation proposal still applies end to end', async () => {
  const app = projectApp();
  const store = new ProposalStore({ evidenceStore });
  const executor = new ProposalExecutor({ store, app, capabilityExecutor: new CapabilityExecutor({ catalog, app }) });
  const proposal = store.create({
    kind: 'project-annotation',
    target: { id: 'a1' },
    before: null,
    after: { verdict: 'verified' },
    evidenceIds: ['ev'],
  });

  const result = await executor.approveAndApply(proposal.id);
  assert.equal(result.proposal.status, 'applied');
  assert.deepEqual(app.projectAnnotations.map((item) => item.id), ['a1'], 'the mutated record must carry the approved identity');
  assert.deepEqual(app.autoReport.report.confirmed.map((item) => item.id), ['a1']);
});

test('#5139 no orphan annotation is ever produced for the rejected shape', async () => {
  const app = projectApp();
  const store = new ProposalStore({ evidenceStore });
  const executor = new ProposalExecutor({ store, app, capabilityExecutor: new CapabilityExecutor({ catalog, app }) });
  try {
    const proposal = store.create({ kind: 'project-annotation', target: { struct: 'x' }, before: null, after: 'v', evidenceIds: ['ev'] });
    await executor.approveAndApply(proposal.id);
    assert.fail('an id-less target must never reach execution');
  } catch (error) {
    assert.match(error.message, /requires a non-empty string target id/);
  }
  assert.equal(app.projectAnnotations.length, 0, 'no orphan annotation may be created');
  assert.equal(app.autoReport.report.confirmed.length, 0, 'no orphan confirmed finding may be created');
});
