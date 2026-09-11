/**
 * #4502 regression: runtime.memory-read must not coerce structured values into
 * a bounded byte count. The catalog schema rejects these values on the normal
 * path, while the executor keeps the same contract as defense-in-depth when a
 * permissive or older catalog reaches the built-in implementation.
 */
import assert from 'node:assert/strict';
import { CapabilityExecutor } from '../js/ai/capabilities/executor.js';
import { createCapabilityCatalog } from '../js/ai/capabilities/catalog.js';

const calls = [];
const adapter = {
  connected: true,
  readMemory: async (address, size) => {
    calls.push({ address, size });
    return new Uint8Array(size).fill(0xab);
  },
};
const session = { id: 'session-4502', binaryHash: 'binary-4502', adapter };
const runtimePlatform = { currentSession: () => session };

function executor(catalog = createCapabilityCatalog()) {
  return new CapabilityExecutor({ catalog, binaryId: 'binary-4502', runtimePlatform });
}

function args(extra = {}) {
  return { runtimeSessionId: session.id, binaryId: session.binaryHash, address: '0x1000', ...extra };
}

const normal = executor();
const defaultRead = await normal.execute('runtime.memory-read', args());
assert.equal(defaultRead.bytes.length, 1, 'omitted size keeps the one-byte default');
const validRead = await normal.execute('runtime.memory-read', args({ size: 4 }));
assert.equal(validRead.bytes.length, 4, 'primitive integer sizes remain supported');
assert.equal(calls.at(-1).size, 4);

const permissiveEntry = {
  id: 'runtime.memory-read', category: 'runtime', agentExposed: true, runtimeBound: true,
  scopeSupport: ['function', 'binary'], inputSchema: { type: 'object', additionalProperties: true },
};
const permissiveCatalog = { get: (id) => id === permissiveEntry.id ? permissiveEntry : null };
const defenseInDepth = executor(permissiveCatalog);
const malformedSizes = [
  ['4'], '4', true, false, null, { valueOf: () => 4 }, 4n,
  0, -1, 1.5, 262145, Number.MAX_SAFE_INTEGER + 1,
];
for (const size of malformedSizes) {
  await assert.rejects(
    () => defenseInDepth.execute('runtime.memory-read', args({ size })),
    (error) => error.type === 'invalid_tool_call',
    `malformed size must be rejected without coercion: ${String(size)}`,
  );
}
assert.equal(calls.length, 2, 'rejected sizes must not reach the runtime adapter');

const schemaRejected = executor();
for (const size of [['4'], '4', true, false]) {
  await assert.rejects(
    () => schemaRejected.execute('runtime.memory-read', args({ size })),
    (error) => error.type === 'invalid_tool_call',
    `catalog schema must reject ${String(size)}`,
  );
}
assert.equal(calls.length, 2, 'catalog-rejected sizes must not reach the runtime adapter');

console.log('issue-4502-runtime-memory-read-size: ok');
