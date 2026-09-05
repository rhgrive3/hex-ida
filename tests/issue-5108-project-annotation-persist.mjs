import assert from 'node:assert/strict';
import { createCapabilityCatalog } from '../js/ai/capabilities/catalog.js';
import { CapabilityExecutor } from '../js/ai/capabilities/executor.js';

const approval = { kind: 'proposal', token: 'test-token-123' };

function appWithAutosave(result) {
  return {
    projectAnnotations: [],
    autoReport: { report: { confirmed: [], deep: [] } },
    workspace: { autosave: () => result },
  };
}

// autosave() === false must fail closed, with in-memory mutations rolled back.
{
  const app = appWithAutosave(false);
  const executor = new CapabilityExecutor({ catalog: createCapabilityCatalog(), app });
  await assert.rejects(
    () => executor.execute('annotation.project', { id: 'a1', kind: 'note', value: 'must persist' }, { authorization: approval }),
    (error) => error?.type === 'tool_failed',
    'a failed autosave must surface as tool_failed',
  );
  assert.equal(app.projectAnnotations.length, 0, 'the unpersisted annotation must be rolled back');
  assert.equal(app.autoReport.report.confirmed.length, 0, 'the unpersisted report entry must be rolled back');
}

// autosave() === true keeps succeeding.
{
  const app = appWithAutosave(true);
  const executor = new CapabilityExecutor({ catalog: createCapabilityCatalog(), app });
  const record = await executor.execute('annotation.project', { id: 'a1', kind: 'note', value: 'kept' }, { authorization: approval });
  assert.equal(record.id, 'a1');
  assert.equal(app.projectAnnotations.length, 1);
  assert.equal(app.autoReport.report.confirmed.length, 1);
}

// No workspace configured: legacy success path is preserved.
{
  const app = { projectAnnotations: [] };
  const executor = new CapabilityExecutor({ catalog: createCapabilityCatalog(), app });
  const record = await executor.execute('annotation.project', { id: 'a2', kind: 'note', value: 'no-store' }, { authorization: approval });
  assert.equal(record.id, 'a2');
}

console.log('issue-5108-project-annotation-persist: ok');
