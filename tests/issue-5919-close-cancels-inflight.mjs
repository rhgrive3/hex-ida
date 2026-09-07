// Regression for #5919: RuntimeProviderProtocolClient.close() rejected the
// local promises of in-flight requests but never sent the `cancel` packets
// that per-request timeout/abort and epoch invalidation send, so the remote
// provider kept executing work whose result nobody would read. A client close
// now cancels every in-flight request on the wire before tearing down.
import assert from 'node:assert/strict';
import {
  RUNTIME_PROVIDER_PROTOCOL,
  RUNTIME_PROVIDER_PROTOCOL_VERSION,
  RuntimeProviderProtocolClient,
} from '../js/runtime/provider-protocol.js';

class FakeTransport {
  constructor() { this.sent = []; this.listener = null; this.unsubscribed = false; }
  send(value) { this.sent.push(value); }
  onMessage(listener) { this.listener = listener; return () => { this.unsubscribed = true; }; }
  receive(value) { return this.listener?.(value); }
}

function packet(type, extra = {}) {
  return { protocol: RUNTIME_PROVIDER_PROTOCOL, version: RUNTIME_PROVIDER_PROTOCOL_VERSION, type, ...extra };
}

{
  const transport = new FakeTransport();
  const client = new RuntimeProviderProtocolClient(transport, { timeoutMs: 60_000 });
  const first = client.request('debugger.readMemory', {}, { facet: 'debugger' });
  const second = client.request('trace.replay', {}, { facet: 'trace' });
  const requestIds = transport.sent.filter((item) => item.type === 'request').map((item) => item.id);

  client.close();

  const cancels = transport.sent.filter((item) => item.type === 'cancel');
  assert.deepEqual(cancels.map((item) => item.id).sort((a, b) => a - b), requestIds.sort((a, b) => a - b),
    'close must send a cancel packet for every in-flight request');
  assert.ok(cancels.every((item) => item.epoch === 1), 'cancel packets carry the pending request epoch');
  await assert.rejects(first, (error) => error?.code === 'disconnected');
  await assert.rejects(second, (error) => error?.code === 'disconnected');
  assert.equal(transport.unsubscribed, true, 'the transport subscription is still released');
}

{
  // A close without in-flight requests stays a no-op teardown.
  const transport = new FakeTransport();
  const client = new RuntimeProviderProtocolClient(transport, { timeoutMs: 60_000 });
  client.close();
  assert.equal(transport.sent.filter((item) => item.type === 'cancel').length, 0);
}
