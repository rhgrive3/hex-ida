import assert from 'node:assert/strict';

import { DebuggerProvider } from '../../../js/runtime/debugger-provider.js';

const snapshots = [
  [{
    id: 'module:a',
    base: 0x1000n,
    size: 0x100n,
    staticBase: 0x4000n,
    binaryId: 'binary:a',
    identityState: 'exact',
    identityEvidenceIds: ['e:load-1'],
  }],
  [{
    id: 'module:a',
    base: 0x2000n,
    size: 0x100n,
    staticBase: 0x5000n,
    binaryId: 'binary:a',
    identityState: 'exact',
    identityEvidenceIds: ['e:load-2'],
  }],
  [],
];

const adapter = {
  id: 'refresh-test',
  kind: 'debugger',
  capabilities: { modules: true },
  connected: false,
  async connect() { this.connected = true; },
  async disconnect() { this.connected = false; },
  async getModules() { return snapshots.shift(); },
};

const provider = new DebuggerProvider(adapter, { id: 'provider:refresh-test' });
const session = await provider.openSession({
  binaryId: 'binary:a',
  processKey: 'process:a',
  sessionNonce: 'session:a',
});

let resolved = session.facets.debugger.resolveAddress(0x1010n, { binaryId: 'binary:a' });
assert.equal(resolved.state, 'exact');
assert.equal(resolved.staticAddress, 0x4010n);

const refreshed = await session.facets.debugger.refreshModules();
assert.equal(refreshed.length, 1);
assert.equal(refreshed[0].base, 0x2000n);
assert.equal(session.facets.debugger.resolveAddress(0x1010n, { binaryId: 'binary:a' }).state, 'unresolved');
resolved = session.facets.debugger.resolveAddress(0x2010n, { binaryId: 'binary:a' });
assert.equal(resolved.state, 'exact');
assert.equal(resolved.staticAddress, 0x5010n);

await session.facets.debugger.refreshModules();
assert.equal(session.modules.active().length, 0);
assert.equal(session.facets.debugger.resolveAddress(0x2010n, { binaryId: 'binary:a' }).state, 'unresolved');

await session.close();
console.log('issue #2729 debugger module refresh regression PASS');
