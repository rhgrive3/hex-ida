import assert from 'node:assert/strict';
import { DebugAdapter, normalizeCapabilities } from '../../js/debug/adapter.js';

class ImplementedMemoryAdapter extends DebugAdapter {
  async readMemory() { return { kind: 'read' }; }
  async writeMemory() { return { kind: 'write' }; }
}

const adapter = new ImplementedMemoryAdapter({
  capabilities: { readMemory: true, writeMemory: true },
});

assert.equal(adapter.negotiate({ writeMemory: false }).writeMemory, false);
assert.equal(adapter.negotiate({ readMemory: true }).readMemory, true);
assert.equal(adapter.negotiate({ readMemory: true }).writeMemory, undefined);
assert.equal(adapter.negotiate().readMemory, true);
assert.equal(adapter.negotiate().writeMemory, true);

const normalized = normalizeCapabilities({ readMemory: true, writeMemory: false });
const negotiated = adapter.negotiate(normalized);
assert.equal(negotiated.readMemory, true);
assert.equal(negotiated.writeMemory, false);

assert.equal(adapter.negotiate(new Set(['writeMemory'])).writeMemory, true);
assert.equal(adapter.negotiate(['writeMemory']).writeMemory, true);
assert.equal(adapter.negotiate({ unknownCapability: true }).unknownCapability, false);

const bareAdapter = new DebugAdapter({
  capabilities: { readMemory: true, writeMemory: true },
});

assert.equal(bareAdapter.negotiate({ readMemory: true }).readMemory, false);
assert.equal(bareAdapter.negotiate({ writeMemory: true }).writeMemory, false);
assert.equal(bareAdapter.negotiate().readMemory, false);
assert.equal(bareAdapter.negotiate().writeMemory, false);

console.log('issue-6175-debug-adapter-boundary: ok');
