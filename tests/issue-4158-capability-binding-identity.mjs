import assert from 'node:assert/strict';
import { CapabilityExecutor } from '../js/ai/capabilities/executor.js';
import { createCapabilityCatalog } from '../js/ai/capabilities/catalog.js';
import { ToolRegistry } from '../js/ai/tools/registry-core.js';

const catalog = createCapabilityCatalog();

function runtimePlatform() {
  const adapter = {
    connected: true,
    readRegisters: async () => ({ pc: '0x1000' }),
  };
  const session = { id: 'runtime-1', binaryHash: 'bin-abc', backend: 'fake', adapter };
  return { currentSession: () => session };
}

// First-party analysis capabilities use a permissive argument schema. The
// executor binding guard therefore remains the authority that must not coerce
// a structured binaryId into the current binary identity.
{
  let executions = 0;
  const tools = new ToolRegistry();
  tools.register({
    name: 'search_functions',
    scopeSupport: ['auto', 'binary', 'project'],
    execute: async () => { executions++; return { results: [] }; },
  });
  const executor = new CapabilityExecutor({ catalog, toolRegistry: tools, binaryId: 'bin-abc' });

  await assert.rejects(
    () => executor.execute('analysis.search-functions', { query: 'x', binaryId: ['bin-abc'] }, { scope: 'binary' }),
    (error) => error?.type === 'scope_violation',
    'structured binaryId must not alias the current binary identity',
  );
  assert.equal(executions, 0, 'invalid binding must fail before the backing tool executes');

  await executor.execute('analysis.search-functions', { query: 'x', binaryId: 'bin-abc' }, { scope: 'binary' });
  await executor.execute('analysis.search-functions', { query: 'x' }, { scope: 'binary' });
  assert.equal(executions, 2, 'valid primitive and omitted optional binary identities remain supported');
}

// verifyBinding is also the runtime-bound defense-in-depth boundary. Runtime
// catalog schemas now reject structured ids earlier, but this guard must stay
// safe even when invoked through a custom/legacy runtime-bound capability.
{
  const platform = runtimePlatform();
  const executor = new CapabilityExecutor({ catalog, runtimePlatform: platform, binaryId: 'bin-abc' });
  const entry = { runtimeBound: true };

  assert.throws(
    () => executor.verifyBinding(entry, { runtimeSessionId: ['runtime-1'], binaryId: 'bin-abc' }, platform),
    (error) => error?.type === 'scope_violation',
    'structured runtimeSessionId must not alias the active session id',
  );
  assert.throws(
    () => executor.verifyBinding(entry, { runtimeSessionId: 'runtime-1', binaryId: ['bin-abc'] }, platform),
    (error) => error?.type === 'scope_violation',
    'structured binaryId must not alias runtime/current binary ids',
  );
  assert.doesNotThrow(() => executor.verifyBinding(entry, { runtimeSessionId: 'runtime-1', binaryId: 'bin-abc' }, platform));
}

// Reject objects by type without invoking coercion hooks.
{
  let coercions = 0;
  const hostile = { toString() { coercions++; return 'bin-abc'; } };
  const executor = new CapabilityExecutor({ catalog, binaryId: 'bin-abc' });
  assert.throws(
    () => executor.verifyBinding({ runtimeBound: false }, { binaryId: hostile }),
    (error) => error?.type === 'scope_violation',
  );
  assert.equal(coercions, 0, 'binding validation must not execute caller coercion hooks');
}

// The actual first-party runtime capability remains valid with canonical ids;
// its schema continues to provide the earlier validation layer.
{
  const executor = new CapabilityExecutor({ catalog, runtimePlatform: runtimePlatform(), binaryId: 'bin-abc' });
  assert.deepEqual(
    await executor.execute('runtime.registers', { runtimeSessionId: 'runtime-1', binaryId: 'bin-abc' }),
    { pc: '0x1000' },
  );
  await assert.rejects(
    () => executor.execute('runtime.registers', { runtimeSessionId: ['runtime-1'], binaryId: 'bin-abc' }),
    (error) => error?.type === 'invalid_tool_call',
    'first-party schema rejection remains intact for structured runtime session ids',
  );
}

console.log('issue-4158-capability-binding-identity: ok');
