/**
 * #6244 regression: a runtime-bound capability must verify that the active
 * runtime session is bound to the current workbench binary even when the
 * caller omits `args.binaryId`. Previously the session/current-binary
 * comparison only existed when the caller passed `binaryId`, so a stale
 * session bound to another binary stayed usable after a binary switch.
 *
 * The lane-specific cases (registers + memory read, mutation guard, session
 * mismatch) are pinned here; the shared binding paths are exercised by
 * tests/agent-capability-plane.mjs and must not regress.
 */
import assert from 'node:assert/strict';
import { CapabilityExecutor } from '../js/ai/capabilities/executor.js';
import { createCapabilityCatalog } from '../js/ai/capabilities/catalog.js';

const catalog = createCapabilityCatalog();

function sessionFor(binaryHash, id = 'session-old') {
  return {
    id,
    binaryHash,
    backend: 'fake',
    adapter: {
      connected: true,
      readRegisters: async () => ({ pc: '0x1111' }),
      readMemory: async (_address, size) => new Uint8Array(size).fill(0xab),
      resume: async () => true,
    },
  };
}

function executorFor(currentBinaryId, session) {
  return new CapabilityExecutor({
    catalog,
    binaryId: currentBinaryId,
    runtimePlatform: { currentSession: () => session },
  });
}

const authorization = { kind: 'proposal', token: '0123456789abcdef' };

/* runtime.registers: omitted binaryId with a stale session must be rejected */
{
  const executor = executorFor('binary-B', sessionFor('binary-A'));
  await assert.rejects(
    () => executor.execute('runtime.registers', { runtimeSessionId: 'session-old' }),
    (error) => error.type === 'scope_violation',
    'omitted binaryId must not skip the session/current-binary binding check',
  );
  await assert.rejects(
    () => executor.execute('runtime.registers', { runtimeSessionId: 'session-old', binaryId: 'binary-B' }),
    (error) => error.type === 'scope_violation',
    'current binary id with a foreign session must be rejected',
  );
  await assert.rejects(
    () => executor.execute('runtime.registers', { runtimeSessionId: 'session-old', binaryId: 'binary-A' }),
    (error) => error.type === 'scope_violation',
    'session binary id must also match the current workbench binary',
  );
}

/* runtime.memory-read shares the same guard */
{
  const executor = executorFor('binary-B', sessionFor('binary-A'));
  await assert.rejects(
    () => executor.execute('runtime.memory-read', { runtimeSessionId: 'session-old', address: '0x1000', size: 8 }),
    (error) => error.type === 'scope_violation',
  );
}

/* binding holds when current == session, with or without explicit binaryId */
{
  const executor = executorFor('binary-A', sessionFor('binary-A'));
  const registers = await executor.execute('runtime.registers', { runtimeSessionId: 'session-old' });
  assert.deepEqual(registers, { pc: '0x1111' });
  const registersExplicit = await executor.execute('runtime.registers', { runtimeSessionId: 'session-old', binaryId: 'binary-A' });
  assert.deepEqual(registersExplicit, { pc: '0x1111' });
}

/* runtime mutation paths share verifyBinding and must stay fail-closed */
{
  const executor = executorFor('binary-B', sessionFor('binary-A'));
  await assert.rejects(
    () => executor.execute('runtime.continue', { runtimeSessionId: 'session-old' }, { authorization }),
    (error) => error.type === 'scope_violation',
  );
}

/* pre-existing session identity mismatch still rejects */
{
  const executor = executorFor('binary-A', sessionFor('binary-A'));
  await assert.rejects(
    () => executor.execute('runtime.registers', { runtimeSessionId: 'session-other' }),
    (error) => error.type === 'scope_violation',
  );
}

console.log('issue-6244-runtime-binary-binding: ok');
