import assert from 'node:assert/strict';
import { wrapDebugAdapterAsRuntimeProvider } from '../../js/runtime/provider.js';

function adapter(kind = 'remote', capabilities = {}) {
  return {
    id: 'test-adapter',
    kind,
    capabilities,
    connected: false,
    async connect() { this.connected = true; },
    async disconnect() { this.connected = false; },
  };
}

for (const capabilities of [
  { replay: 'false' },
  { replay: [] },
  { traceFunction: {} },
  { objcRuntime: [] },
  { swiftRuntime: 'true' },
]) {
  const facets = wrapDebugAdapterAsRuntimeProvider(adapter('remote', capabilities)).descriptor().facets;
  assert.deepEqual(facets, ['debugger']);
}

assert.deepEqual(
  wrapDebugAdapterAsRuntimeProvider(adapter('remote', { replay: true })).descriptor().facets,
  ['debugger', 'trace'],
);
assert.deepEqual(
  wrapDebugAdapterAsRuntimeProvider(adapter('remote', { objcRuntime: true })).descriptor().facets,
  ['debugger', 'instrumentation'],
);
assert.deepEqual(
  wrapDebugAdapterAsRuntimeProvider(adapter('frida', {})).descriptor().facets,
  ['debugger', 'instrumentation'],
);
assert.deepEqual(
  wrapDebugAdapterAsRuntimeProvider(adapter('replay', {})).descriptor().facets,
  ['debugger', 'trace'],
);
assert.deepEqual(
  wrapDebugAdapterAsRuntimeProvider(adapter('local', {})).descriptor().facets,
  ['debugger', 'emulator'],
);

console.log('issue-3135 runtime provider facets: ok');
