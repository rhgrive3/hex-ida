import assert from 'node:assert/strict';

import { LocalFunctionSandboxAdapter, EmulatorAdapter } from '../../js/adapters/index.js';
import { wrapDebugAdapterAsRuntimeProvider } from '../../js/runtime/provider.js';

const sessionRequest = {
  binaryId: 'bin-4477',
  targetIdentity: 'local-sandbox-4477',
  sessionNonce: 'nonce-4477',
};

const localProvider = wrapDebugAdapterAsRuntimeProvider(new LocalFunctionSandboxAdapter({}));
assert.deepEqual(localProvider.descriptor().facets, ['debugger', 'emulator', 'trace']);

const session = await localProvider.openSession(sessionRequest);
assert.equal(typeof session.facets.emulator?.launch, 'function');
assert.equal(typeof session.facets.emulator?.resume, 'function');
await session.close();

const emulatorProvider = wrapDebugAdapterAsRuntimeProvider(new EmulatorAdapter({}));
assert.ok(emulatorProvider.descriptor().facets.includes('emulator'));

const remote = {
  id: 'remote-4477',
  kind: 'remote',
  capabilities: { traceFunction: {}, replay: [] },
  async connect() {},
  async disconnect() {},
};
assert.deepEqual(wrapDebugAdapterAsRuntimeProvider(remote).descriptor().facets, ['debugger']);

console.log('issue-4477 local-sandbox emulator facet: ok');
