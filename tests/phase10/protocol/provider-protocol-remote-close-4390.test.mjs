import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RUNTIME_PROVIDER_PROTOCOL,
  RUNTIME_PROVIDER_PROTOCOL_VERSION,
  RuntimeProviderProtocolClient,
} from '../../../js/runtime/provider-protocol.js';

function packet(type, extra = {}) {
  return {
    protocol: RUNTIME_PROVIDER_PROTOCOL,
    version: RUNTIME_PROVIDER_PROTOCOL_VERSION,
    type,
    ...extra,
  };
}

class FakeTransport {
  constructor() {
    this.sent = [];
    this.listener = null;
    this.unsubscribeCalls = 0;
  }

  send(value) { this.sent.push(value); }

  onMessage(listener) {
    this.listener = listener;
    return () => {
      this.unsubscribeCalls++;
      this.listener = null;
    };
  }
}

function rejectsWithCode(promise, code) {
  return assert.rejects(promise, (error) => error?.name === 'DebugAdapterError' && error?.code === code);
}

test('#4390 remote close tears down pending requests and rejects future requests', async () => {
  const transport = new FakeTransport();
  const client = new RuntimeProviderProtocolClient(transport, { timeoutMs: 10000 });

  const pending = client.request('runtime.session.test');
  const rejected = rejectsWithCode(pending, 'disconnected');
  assert.equal(client.pending.size, 1);
  assert.equal(transport.sent.filter((item) => item.type === 'request').length, 1);

  assert.equal(client.receive(packet('close')), true);
  assert.equal(client.closed, true);
  assert.equal(client.pending.size, 0);
  assert.equal(transport.unsubscribeCalls, 1);
  await rejected;

  const sentAfterClose = transport.sent.length;
  await rejectsWithCode(client.request('runtime.session.test'), 'disconnected');
  assert.equal(transport.sent.length, sentAfterClose, 'closed client must not send another request');

  client.close();
  assert.equal(transport.unsubscribeCalls, 1, 'local close after remote close must be idempotent');
});

test('#4390 malformed close remains ignored without changing connection state', () => {
  const transport = new FakeTransport();
  const client = new RuntimeProviderProtocolClient(transport);

  assert.equal(client.receive({
    protocol: 'not-the-runtime-provider-protocol',
    version: RUNTIME_PROVIDER_PROTOCOL_VERSION,
    type: 'close',
  }), false);
  assert.equal(client.closed, false);
  assert.equal(transport.unsubscribeCalls, 0);

  client.close();
  assert.equal(transport.unsubscribeCalls, 1);
});
