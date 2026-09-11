// Regression for #5760: `receive()` only handled event-batch, response and
// error packets, so a valid `type:'close'` packet from the provider was
// silently ignored: the client stayed open, request sending kept working and
// pending requests hung until their timeout. A close packet is the peer-end
// protocol close and must flip the client into its closed state.
import assert from 'node:assert/strict';

import {
  RUNTIME_PROVIDER_PROTOCOL,
  RUNTIME_PROVIDER_PROTOCOL_VERSION,
  RuntimeProviderProtocolClient,
} from '../js/runtime/provider-protocol.js';

function packet(type, extra = {}) {
  return { protocol: RUNTIME_PROVIDER_PROTOCOL, version: RUNTIME_PROVIDER_PROTOCOL_VERSION, type, ...extra };
}

class FakeTransport {
  constructor() { this.sent = []; this.listener = null; this.unsubscribed = false; }
  send(value) { this.sent.push(value); }
  onMessage(listener) { this.listener = listener; return () => { this.unsubscribed = true; if (this.listener === listener) this.listener = null; }; }
  receive(value) { return this.listener?.(value); }
}

{
  const transport = new FakeTransport();
  const client = new RuntimeProviderProtocolClient(transport, { timeoutMs: 60_000 });
  const pending = client.request('debugger.readMemory', { address: 0x1000n, size: 4 }, { facet: 'debugger' });
  const request = transport.sent[0];

  assert.equal(transport.receive(packet('close', {})), true, 'the client must accept the close packet');
  assert.equal(client.closed, true, 'the client must be closed after a peer close');
  assert.equal(transport.unsubscribed, true, 'the transport subscription must be released');
  assert.equal(transport.sent.filter((entry) => entry.type === 'cancel').length, 0, 'peer close must not write through a closed transport');
  await assert.rejects(pending, (error) => error?.code === 'disconnected', 'pending requests must fail with the peer close');
  await assert.rejects(
    client.request('debugger.readMemory', { address: 0x1000n, size: 4 }, { facet: 'debugger' }),
    (error) => error?.code === 'disconnected',
    'new requests must be rejected after a peer close',
  );
}


{
  const transport = new FakeTransport();
  const client = new RuntimeProviderProtocolClient(transport, { timeoutMs: 60_000 });
  const pending = client.request('debugger.readMemory', { address: 0x2000n, size: 4 }, { facet: 'debugger' });

  client.close();
  assert.equal(transport.sent.filter((entry) => entry.type === 'cancel').length, 1, 'local close must cancel the pending request on the wire');
  await assert.rejects(pending, (error) => error?.code === 'disconnected', 'local close must reject pending requests');
}
