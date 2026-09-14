import assert from 'node:assert/strict';
import test from 'node:test';
import { CapabilityExecutor } from '../../../js/ai/capabilities/executor.js';
import { ProposalExecutor } from '../../../js/ai/interaction/proposal-executor.js';
import { ProposalStore } from '../../../js/ai/proposals.js';

function executorFor(app) {
  const capabilityExecutor = new CapabilityExecutor({
    app,
    catalog: {
      get(id) {
        return id === 'annotation.project'
          ? { id, agentExposed: true, requiresApproval: true, inputSchema: { type: 'object' }, category: 'annotation' }
          : null;
      },
    },
  });
  const store = new ProposalStore({ evidenceStore: { has: () => true }, binding: () => null });
  const proposalExecutor = new ProposalExecutor({ store, capabilityExecutor, app });
  return {
    async annotate(id, value) {
      const proposal = store.create({
        kind: 'project-annotation',
        target: { id },
        before: app?.projectAnnotations?.find?.((item) => item?.id === String(id))?.value ?? null,
        after: value,
        evidenceIds: ['evidence-4460'],
      });
      return proposalExecutor.approveAndApply(proposal.id);
    },
  };
}

test('issue #4460 waits for async autosave before reporting success', async () => {
  const events = [];
  const app = {
    projectAnnotations: [],
    autoReport: { report: { confirmed: [], deep: [] } },
    workspace: {
      async autosave() {
        events.push('started');
        await Promise.resolve();
        events.push('resolved');
        return true;
      },
    },
  };

  const result = await executorFor(app).annotate('async-success', { claim: 'saved' });
  assert.equal(result.execution.id, 'async-success');
  assert.deepEqual(events, ['started', 'resolved']);
  assert.equal(app.projectAnnotations.length, 1);
});

test('issue #4460 propagates async autosave rejection and rolls back mutation', async () => {
  const annotations = [{ id: 'prior', value: 'keep' }];
  const confirmed = [{ id: 'prior-confirmed' }];
  const quotaError = new Error('disk full');
  const app = {
    projectAnnotations: annotations,
    autoReport: { report: { confirmed, deep: [] } },
    workspace: { async autosave() { await Promise.resolve(); throw quotaError; } },
  };

  await assert.rejects(
    executorFor(app).annotate('async-failure', { claim: 'must persist' }),
    (error) => error === quotaError,
  );
  assert.equal(app.projectAnnotations, annotations);
  assert.deepEqual(app.projectAnnotations, [{ id: 'prior', value: 'keep' }]);
  assert.equal(app.autoReport.report.confirmed, confirmed);
  assert.deepEqual(app.autoReport.report.confirmed, [{ id: 'prior-confirmed' }]);
});

test('issue #4460 treats an async false autosave as a tool failure and rolls back', async () => {
  const app = {
    projectAnnotations: [],
    workspace: { async autosave() { return false; } },
  };

  await assert.rejects(
    executorFor(app).annotate('async-false', { claim: 'not durable' }),
    (error) => error?.type === 'tool_failed',
  );
  assert.equal(app.projectAnnotations.length, 0);
  assert.equal(app.autoReport, undefined);
});

test('issue #4460 keeps project.save async result propagation unchanged', async () => {
  const app = { workspace: { async autosave() { return { saved: true }; } } };
  const executor = new CapabilityExecutor({
    app,
    catalog: { get(id) { return id === 'project.save' ? { id, agentExposed: true, requiresApproval: false, inputSchema: { type: 'object' }, category: 'project' } : null; } },
  });

  assert.deepEqual(await executor.execute('project.save'), { saved: true });
});

console.log('issue #4460 async project annotation autosave: PASS');
