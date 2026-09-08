// Regression for #5811: DebugAdapterRuntimeProvider.openSession() built the
// session facet surface before connecting, so a RemoteDebugAdapter's facets
// captured the pre-negotiation local allow-list. RemoteDebugAdapter.connect()
// replaces its capabilities with the negotiated intersection, but the already
// frozen facets kept advertising refused capabilities and refused facets
// stayed present. The session surface is now built after connect, from the
// negotiated capabilities.
import assert from 'node:assert/strict';
import { RemoteDebugAdapter } from '../../js/adapters/index.js';
import { DebugAdapterRuntimeProvider } from '../../js/runtime/provider.js';
import { DEBUG_PROTOCOL_VERSION } from '../../js/debug/adapter.js';
import { encodeWireValue } from '../../js/debug/remote-protocol.js';

class LoopbackTransport {
  constructor(advertised) { this.listener = null; this.advertised = advertised; }
  onMessage(fn) { this.listener = fn; return () => { if (this.listener === fn) this.listener = null; }; }
  async send(packet) {
    if (packet.type !== 'request') return;
    let result = {};
    if (packet.method === 'connect') result = { capabilities: this.advertised };
    else if (packet.method === 'disconnect') result = { disconnected: true };
    const response = encodeWireValue({
      version: DEBUG_PROTOCOL_VERSION, type: 'response', id: packet.id, epoch: packet.epoch, result,
    });
    queueMicrotask(() => this.listener?.(response));
  }
}

{
  // Local allow-list advertises objcRuntime + traceFunction; the peer refuses both.
  const transport = new LoopbackTransport({ objcRuntime: false, traceFunction: false });
  const remote = new RemoteDebugAdapter(transport, { capabilities: { objcRuntime: true, traceFunction: true } });
  const provider = new DebugAdapterRuntimeProvider(remote, { id: 'adapter:remote-facet' });

  const session = await provider.openSession({ processKey: 'fixture', binaryId: 'bin-fixture-5811' });
  assert.equal(remote.connected, true, 'the handshake completed');
  assert.equal(remote.capabilities.objcRuntime, false, 'the peer refused objcRuntime');
  assert.equal(session.facets.instrumentation, undefined,
    'an instrumentation facet refused by the peer must not be advertised on the session');
  assert.equal(session.facets.trace?.capabilities?.traceFunction ?? false, false,
    'a trace facet must advertise the negotiated traceFunction, not the local allow-list');
  await session.close();
}

{
  // Deferred-connect sessions must not expose the pre-negotiation local
  // allow-list as a confirmed facet/capability surface.
  const transport = new LoopbackTransport({ objcRuntime: true, traceFunction: true });
  const remote = new RemoteDebugAdapter(transport, { capabilities: { objcRuntime: true, traceFunction: true } });
  const provider = new DebugAdapterRuntimeProvider(remote, { id: 'adapter:remote-facet-deferred' });
  const session = await provider.openSession(
    { processKey: 'fixture-deferred', binaryId: 'bin-fixture-5811' },
    { connect: false },
  );
  assert.equal(remote.connected, false, 'connect:false must leave the handshake deferred');
  assert.equal(session.capabilityState, 'unnegotiated');
  assert.equal(session.negotiated, false);
  assert.deepEqual(session.facets, {}, 'deferred sessions must not publish local capability facets');
  await session.close();
}

{
  // A peer that negotiates capabilities keeps the facet surface consistent.
  const transport = new LoopbackTransport({ objcRuntime: true, traceFunction: true });
  const remote = new RemoteDebugAdapter(transport, { capabilities: { objcRuntime: true, traceFunction: true } });
  const provider = new DebugAdapterRuntimeProvider(remote, { id: 'adapter:remote-facet-ok' });
  const session = await provider.openSession({ processKey: 'fixture-ok', binaryId: 'bin-fixture-5811' });
  assert.ok(session.facets.instrumentation, 'a negotiated instrumentation facet stays available');
  assert.equal(session.facets.instrumentation.capabilities.objcRuntime, true);
  await session.close();
}
