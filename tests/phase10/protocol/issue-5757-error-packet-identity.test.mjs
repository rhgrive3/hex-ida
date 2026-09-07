// Regression for #5757: a provider `error` packet's structured `code` /
// `message` passed packet validation and flowed straight into
// DebugAdapterError, so `error.code` could be an Array/Object sent by the
// remote peer. Only primitive strings are adopted as error identity; anything
// else falls back to the canonical provider-failure identity.
import assert from 'node:assert/strict';
import {
  RUNTIME_PROVIDER_PROTOCOL,
  RUNTIME_PROVIDER_PROTOCOL_VERSION,
  RuntimeProviderProtocolClient,
} from '../../../js/runtime/provider-protocol.js';

function packet(type, extra = {}) {
  return { protocol: RUNTIME_PROVIDER_PROTOCOL, version: RUNTIME_PROVIDER_PROTOCOL_VERSION, type, ...extra };
}

class FakeTransport {
  constructor() { this.sent = []; this.listener = null; }
  send(value) { this.sent.push(value); }
  onMessage(listener) { this.listener = listener; return () => {}; }
  receive(value) { return this.listener?.(value); }
}

{
  const transport = new FakeTransport();
  const client = new RuntimeProviderProtocolClient(transport, { timeoutMs: 60_000 });
  const pending = client.request('debugger.readMemory', {}, { facet: 'debugger' });
  const request = transport.sent[0];

  assert.equal(transport.receive(packet('error', { id: request.id, epoch: 1, code: ['timeout'], message: { text: 'failed' } })), false,
    'structured error identity fields must be rejected at the protocol boundary');
  assert.equal(client.pending.size, 1, 'a malformed error packet must not consume the pending request');
  assert.equal(transport.receive(packet('error', { id: request.id, epoch: 1, code: 'timeout', message: 'failed' })), true);
  const error = await pending.catch((value) => value);
  assert.equal(error?.code, 'timeout', 'the supplied code must not be replaced by the fallback');
  assert.equal(error?.message, 'failed', 'the supplied message must not be replaced by the fallback');
  client.close();
}

for (const malformed of [
  { code: null, message: 'failed', label: 'present-null code' },
  { code: 'timeout', message: null, label: 'present-null message' },
  { code: '', message: 'failed', label: 'empty code' },
  { code: 'timeout', message: '', label: 'empty message' },
  { code: '   ', message: 'failed', label: 'whitespace-only code' },
  { code: 'timeout', message: '   ', label: 'whitespace-only message' },
]) {
  const transport = new FakeTransport();
  const client = new RuntimeProviderProtocolClient(transport, { timeoutMs: 60_000 });
  const pending = client.request('debugger.readMemory', {}, { facet: 'debugger' });
  const request = transport.sent[0];

  const { label, ...fields } = malformed;
  assert.equal(transport.receive(packet('error', { id: request.id, epoch: 1, ...fields })), false,
    `${label} must be rejected at the protocol boundary`);
  assert.equal(client.pending.size, 1, 'present-null identity must not consume the pending request');
  client.close();
  await pending.catch(() => {});
}

{
  // Fully omitted optional identities retain the canonical fallback.
  const transport = new FakeTransport();
  const client = new RuntimeProviderProtocolClient(transport, { timeoutMs: 60_000 });
  const pending = client.request('debugger.readMemory', {}, { facet: 'debugger' });
  const request = transport.sent[0];

  assert.equal(transport.receive(packet('error', { id: request.id, epoch: 1 })), true);
  const error = await pending.catch((value) => value);
  assert.equal(error?.code, 'provider-failure');
  assert.equal(error?.message, 'provider request failed');
  client.close();
}

{
  // Primitive strings keep flowing through unchanged.
  const transport = new FakeTransport();
  const client = new RuntimeProviderProtocolClient(transport, { timeoutMs: 60_000 });
  const pending = client.request('debugger.readMemory', {}, { facet: 'debugger' });
  const request = transport.sent[0];

  transport.receive(packet('error', { id: request.id, epoch: 1, code: 'timeout', message: 'provider gave up', details: { extra: 1 } }));
  const error = await pending.catch((value) => value);
  assert.equal(error?.code, 'timeout');
  assert.equal(error?.message, 'provider gave up');
  assert.deepEqual(error?.details, { extra: 1 });
  client.close();
}
