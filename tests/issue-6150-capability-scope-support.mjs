// Regression for #6150: CapabilityExecutor.execute() checked the catalog's
// scopeSupport only on the agentTool path; built-in and action capabilities
// ran under any options.scope, so a project-scoped capability could execute
// with scope:'function'. The declared scopeSupport is now enforced on every
// execution path.
import assert from 'node:assert/strict';
import { CapabilityExecutor } from '../js/ai/capabilities/executor.js';
import { createCapabilityCatalog, HEX_CAPABILITIES } from '../js/ai/capabilities/catalog.js';

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

{
  // Registry-override contract for agentTool capabilities (#6150): the tool
  // record's scopeSupport wins over the catalog declaration. A catalog entry
  // declaring ['project'] with a registry record allowing ['function'] must
  // still execute under function scope — the common gate resolves the same
  // effective authority as executeTool(), it does not reject on the
  // declaration alone.
  const record = {
    name: 'analyze_something',
    description: 'scoped tool',
    scopeSupport: ['function'],
    execute() { return { ok: true }; },
  };
  const toolRegistry = {
    get(name) { return name === record.name ? record : null; },
    has(name) { return name === record.name; },
    execute(name, args, options) { return record.execute(args, options); },
  };
  const catalog = createCapabilityCatalog([
    ...HEX_CAPABILITIES,
    {
      id: 'analysis.override-scope',
      title: 'Registry override scope probe',
      description: 'agentTool whose registry record narrows/widens scope support',
      category: 'analysis',
      agentExposed: true,
      agentTool: record.name,
      scopeSupport: ['project'],
      inputSchema: { type: 'object' },
    },
  ]);
  const executor = new CapabilityExecutor({ catalog, toolRegistry, app });
  const result = await executor.execute('analysis.override-scope', {}, { scope: 'function' });
  assert.ok(result, 'agentTool scope authority follows the registry record override');
  await assert.rejects(
    () => executor.execute('analysis.override-scope', {}, { scope: 'binary' }),
    (error) => error?.type === 'scope_violation',
    'neither the record nor the declaration supports binary scope',
  );
}

{
  // runtime.connect declares scopeSupport:['binary'] and requiresApproval;
  // a non-binary scope must be rejected by the common gate BEFORE approval
  // consumption (a reached approval check would answer approval_required
  // for this bogus authorization) and before any runtime session starts.
  const calls = [];
  const adapter = {
    connected: true,
    capabilities: {},
    connect() { calls.push('connect'); return { connected: true }; },
    readMemory() { return [1, 2, 3, 4, 5, 6, 7, 8]; },
  };
  const runtimePlatform = {
    currentSession(emit = false) { return { id: 'session-1', adapter, binaryHash: 'bin-A' }; },
    startSession(spec) { calls.push(spec?.adapter ? 'start' : 'start-noadapter'); return { id: 'session-1', adapter }; },
    sessions: { close() {} },
  };
  const executor = new CapabilityExecutor({ catalog: createCapabilityCatalog(), runtimePlatform, binaryId: 'bin-A' });
  await assert.rejects(
    () => executor.execute('runtime.connect', { adapter: 'runtime-adapter-spec', binaryId: 'bin-A' }, { scope: 'function', authorization: { kind: 'proposal', token: 'abcdefgh' } }),
    (error) => error?.type === 'scope_violation',
    'runtime.connect is binary-scoped; the gate must precede approval consumption',
  );
  assert.deepEqual(calls, [], 'no runtime session may start for a scope-violating request');
  const read = await executor.execute('runtime.memory-read', { address: 4096, size: 8, runtimeSessionId: 'session-1' }, { scope: 'binary' });
  assert.ok(read, 'runtime.memory-read accepts binary scope');
  await assert.rejects(
    () => executor.execute('runtime.memory-read', { address: 4096, size: 8, runtimeSessionId: 'session-1' }, { scope: 'project' }),
    (error) => error?.type === 'scope_violation',
    'runtime.memory-read is function/binary only',
  );
}
