// Regression for #6150: CapabilityExecutor.execute() checked the catalog's
// scopeSupport only on the agentTool path; built-in and action capabilities
// ran under any options.scope, so a project-scoped capability could execute
// with scope:'function'. The declared scopeSupport is now enforced on every
// execution path.
import assert from 'node:assert/strict';
import { CapabilityExecutor } from '../js/ai/capabilities/executor.js';
import { createCapabilityCatalog } from '../js/ai/capabilities/catalog.js';

const app = {
  projectAnnotations: [],
  workspace: {
    autosave() {},
    snapshot() { return { ok: true }; },
  },
};

{
  // annotation.project declares scopeSupport:['project']; a function-scoped
  // request must be rejected before any mutation path runs.
  const executor = new CapabilityExecutor({ catalog: createCapabilityCatalog(), app });
  await assert.rejects(
    () => executor.execute('annotation.project', { value: 'unexpected' }, { scope: 'function' }),
    (error) => error?.type === 'scope_violation',
    'a project-scoped capability must not execute under function scope',
  );
}

{
  // project.snapshot is likewise project-only.
  const executor = new CapabilityExecutor({ catalog: createCapabilityCatalog(), app });
  await assert.rejects(
    () => executor.execute('project.snapshot', {}, { scope: 'function' }),
    (error) => error?.type === 'scope_violation',
  );
}

{
  // Declared support still executes on every path.
  const executor = new CapabilityExecutor({ catalog: createCapabilityCatalog(), app });
  const result = await executor.execute('project.snapshot', {}, { scope: 'project' });
  assert.ok(result, 'a project-scoped capability executes under project scope');
}

{
  // Unscoped requests keep working.
  const executor = new CapabilityExecutor({ catalog: createCapabilityCatalog(), app });
  const result = await executor.execute('project.snapshot', {});
  assert.ok(result, 'an unscoped request keeps the existing behavior');
}
