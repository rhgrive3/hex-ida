// Regression for #5651: DebugAdapter's constructor spread `capabilities`
// before normalizeCapabilities(), so Set-form capability collections (which
// normalizeCapabilities explicitly supports) lost every element — Set entries
// are not own-enumerable properties. A valid Set allow-list silently became
// "no capabilities", surfacing later as unsupported operations.
// Contract now: the constructor gives Set inputs the same meaning as
// normalizeCapabilities, with connect/disconnect defaults preserved.
import assert from 'node:assert/strict';
import { DebugAdapter, normalizeCapabilities, DEBUG_CAPABILITIES } from '../js/debug/adapter.js';
import { RemoteDebugAdapter } from '../js/adapters/index.js';

// 1. normalizeCapabilities keeps its Set support (control).
assert.equal(normalizeCapabilities(new Set(['readMemory'])).readMemory, true);

// 2. The constructor must honor a Set allow-list instead of dropping it.
{
  const adapter = new DebugAdapter({ id: 'test', capabilities: new Set(['readMemory']) });
  assert.equal(adapter.capabilities.readMemory, true, 'Set capability must survive the constructor boundary');
  adapter.require('readMemory'); // must not throw
}

// 3. Set entries map to `true`; unknown names stay outside the canonical set.
{
  const adapter = new DebugAdapter({ id: 'test', capabilities: new Set(['readMemory', 'notARealCapability']) });
  assert.equal(adapter.capabilities.readMemory, true);
  assert.equal(adapter.capabilities.notARealCapability, undefined, 'unknown capability names must not join the canonical set');
  for (const key of DEBUG_CAPABILITIES) {
    if (key === 'readMemory' || key === 'connect' || key === 'disconnect') continue;
    assert.equal(adapter.capabilities[key], false, `capability ${key} must stay false`);
  }
}

// 4. connect/disconnect defaults are preserved for Set inputs.
{
  const adapter = new DebugAdapter({ id: 'test', capabilities: new Set(['readMemory']) });
  assert.equal(adapter.capabilities.connect, true);
  assert.equal(adapter.capabilities.disconnect, true);
}

// 5. Object form and empty input keep their existing behavior.
{
  const adapter = new DebugAdapter({ id: 'test', capabilities: { readMemory: true } });
  assert.equal(adapter.capabilities.readMemory, true);
  const bare = new DebugAdapter({ id: 'test' });
  assert.equal(bare.capabilities.readMemory, false);
  assert.equal(bare.capabilities.connect, true);
}

// 6. RemoteDebugAdapter: Set allow-list + advertised peer capability negotiates true.
{
  let hello = null;
  const transport = {
    async send(packet) {
      if (packet && packet.method === 'connect') {
        hello = { capabilities: { readMemory: true } };
        if (adapter.protocol.onResponse) adapter.protocol.onResponse({ id: packet.id, epoch: 0, ok: true, result: hello });
      }
    },
    onMessage() { return () => {}; },
  };
  const adapter = new RemoteDebugAdapter(transport, { capabilities: new Set(['readMemory']) });
  assert.equal(adapter.allowedCapabilities.readMemory, true, 'Set allow-list must survive the remote constructor boundary');
}
