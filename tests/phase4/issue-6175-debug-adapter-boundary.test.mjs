import assert from 'node:assert/strict';
import { DebugAdapter, normalizeCapabilities } from '../../js/debug/adapter.js';

// The base adapter deliberately fail-closes advertised method capabilities;
// use concrete methods here so this boundary test exercises positive request
// negotiation rather than the separate base-stub contract.
class MemoryAdapter extends DebugAdapter {
  async readMemory() { return null; }
  async writeMemory() { return null; }
}

const adapter = new MemoryAdapter({
  capabilities: { readMemory: true, writeMemory: true },
});

assert.equal(adapter.negotiate({ writeMemory: false }).writeMemory, false);
assert.equal(adapter.negotiate({ readMemory: true }).readMemory, true);
assert.equal(adapter.negotiate({ readMemory: true }).writeMemory, undefined);

const normalized = normalizeCapabilities({ readMemory: true, writeMemory: false });
const negotiated = adapter.negotiate(normalized);
assert.equal(negotiated.readMemory, true);
assert.equal(negotiated.writeMemory, false);

assert.equal(adapter.negotiate(new Set(['writeMemory'])).writeMemory, true);
assert.equal(adapter.negotiate(['writeMemory']).writeMemory, true);
assert.equal(adapter.negotiate({ unknownCapability: true }).unknownCapability, false);

console.log('issue-6175-debug-adapter-boundary: ok');
