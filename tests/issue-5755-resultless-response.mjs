// Regression for #5755: a provider `response` packet without a `result`
// property passed validateProviderPacket (the wire codec cannot carry
// `undefined`, so the property was simply absent) and resolved the pending
// request with a success `undefined`. A response is now structurally
// malformed unless it carries a result property; an intentional null result
// is sent as `{ result: null }` and stays valid.
import assert from 'node:assert/strict';

import {
  RUNTIME_PROVIDER_PROTOCOL,
  RUNTIME_PROVIDER_PROTOCOL_VERSION,
  RuntimeProviderProtocolClient,
  validateProviderPacket,
} from '../js/runtime/provider-protocol.js';

function packet(type, extra = {}) {
  return { protocol: RUNTIME_PROVIDER_PROTOCOL, version: RUNTIME_PROVIDER_PROTOCOL_VERSION, type, ...extra };
}

class FakeTransport {
  constructor() { this.sent = []; this.listener = null; }
  send(value) { this.sent.push(value); }
  onMessage(listener) { this.listener = listener; return () => { if (this.listener === listener) this.listener = null; }; }
  receive(value) { return this.listener?.(value); }
}

{
  // The codec gate rejects a resultless response packet.
  assert.throws(
    () => validateProviderPacket(packet('response', { id: 1, epoch: 1 })),
    /result/i,
    'a response without a result property must be structurally malformed',
  );
}

{
  // A resultless response can no longer resolve the pending request.
  const transport = new FakeTransport();
  const client = new RuntimeProviderProtocolClient(transport, { timeoutMs: 60_000 });
  const pending = client.request('debugger.readMemory', { address: 0x1000n, size: 4 }, { facet: 'debugger' });
  const request = transport.sent[0];
  assert.equal(transport.receive(packet('response', { id: request.id, epoch: 1 })), false, 'the client must ignore the malformed response');
  assert.equal(client.pending.has(request.id), true, 'the request must stay pending instead of resolving undefined');
  client.close();
  await assert.rejects(pending, (error) => error?.code === 'disconnected', 'the pending request must never resolve with a success undefined');
}

{
  // An intentional null result stays valid and resolves as null.
  const transport = new FakeTransport();
  const client = new RuntimeProviderProtocolClient(transport, { timeoutMs: 60_000 });
  const pending = client.request('debugger.getMetadata', {}, { facet: 'debugger' });
  const request = transport.sent[0];
  assert.equal(transport.receive(packet('response', { id: request.id, epoch: 1, result: null })), true, 'a null result is a valid response');
  assert.equal(await pending, null);
  client.close();
}
