/**
 * #6150 regression: entry.scopeSupport must be enforced on every execution
 * path, not only agentTool. Previously built-in capabilities such as
 * annotation.project (project-only) executed from any scope.
 *
 * Each case uses a real ProposalStore approval so the scope gate is isolated
 * from the approval gate (#6221).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityCatalog } from '../js/ai/capabilities/catalog.js';
import { CapabilityExecutor } from '../js/ai/capabilities/executor.js';
import { ProposalStore } from '../js/ai/proposals.js';

function evidenceStore() {
  return { has: () => true };
}

// Issue a real approval token for a project-annotation proposal so the
// executor's approval gate passes and only the scope gate is exercised.
function projectApproval(executor) {
  const store = new ProposalStore({ evidenceStore: evidenceStore() });
  const proposal = store.create({
    kind: 'project-annotation',
    target: { id: 'ann-6150' },
    before: null,
    after: 'scoped-value',
    evidenceIds: ['e1'],
  });
  const { approvalToken } = store.approve(proposal.id);
  // Wire the issuing store as the executor's trusted authority when supported
  // (#6221). Pre-6221 executors ignore the field and fall back to shape checks.
  try { executor.proposalStore = store; } catch {}
  return {
    store,
    authorization: { kind: 'proposal', token: approvalToken, proposalId: proposal.id },
  };
}

test('#6150 annotation.project from function scope is rejected', async () => {
  const app = { projectAnnotations: [], workspace: { autosave() {} } };
  const executor = new CapabilityExecutor({ catalog: createCapabilityCatalog(), app });
  const { authorization } = await projectApproval(executor);
  await assert.rejects(
    () => executor.execute('annotation.project', { value: 'unexpected' }, { scope: 'function', authorization }),
    (error) => error.type === 'scope_violation',
  );
  assert.equal(app.projectAnnotations.length, 0);
});

test('#6150 annotation.project from project scope still executes', async () => {
  const app = { projectAnnotations: [], workspace: { autosave() {} } };
  const executor = new CapabilityExecutor({ catalog: createCapabilityCatalog(), app });
  const { authorization } = await projectApproval(executor);
  const result = await executor.execute(
    'annotation.project',
    { value: 'expected' },
    { scope: 'project', authorization },
  );
  assert.equal(result.value, 'expected');
  assert.equal(app.projectAnnotations.length, 1);
});

test('#6150 annotation.project with auto scope preserves legacy behavior', async () => {
  const app = { projectAnnotations: [], workspace: { autosave() {} } };
  const executor = new CapabilityExecutor({ catalog: createCapabilityCatalog(), app });
  const { authorization } = await projectApproval(executor);
  const result = await executor.execute('annotation.project', { value: 'auto-ok' }, { authorization });
  assert.equal(result.value, 'auto-ok');
});

test('#6150 runtime.connect from function scope is rejected', async () => {
  const catalog = createCapabilityCatalog();
  const runtimePlatform = {
    currentSession: () => null,
    startSession: async () => ({ connected: true }),
  };
  const executor = new CapabilityExecutor({ catalog, app: {}, runtimePlatform, binaryId: 'bin-A' });
  // runtime.connect requiresApproval; use a real token from its own store when
  // the executor supports authority wiring, else any shape to reach scope gate.
  const store = new ProposalStore({ evidenceStore: evidenceStore() });
  try { executor.proposalStore = store; } catch {}
  // runtime.connect has no proposal kind mapping; craft the scope probe with a
  // directly-issued token if the executor accepts store-issued tokens,
  // otherwise fall back to shape-only (pre-6221) to isolate the scope gate.
  const proposal = store.create({
    kind: 'project-annotation', target: { id: 'x' }, before: null, after: 'v', evidenceIds: ['e1'],
  });
  const { approvalToken } = store.approve(proposal.id);
  const authorization = { kind: 'proposal', token: approvalToken, proposalId: proposal.id };
  await assert.rejects(
    () => executor.execute('runtime.connect', {}, { scope: 'function', authorization }),
    (error) => error.type === 'scope_violation',
  );
});
