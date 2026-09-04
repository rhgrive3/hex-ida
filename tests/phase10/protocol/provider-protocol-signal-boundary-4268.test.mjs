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
  constructor() { this.sent = []; }
  send(value) { this.sent.push(value); }
}

function rejectsWithCode(promise, code) {
  return assert.rejects(promise, (error) => error?.name === 'DebugAdapterError' && error?.code === code);
}

test('#4268 malformed signals fail before pending publication or timer allocation', async () => {
  const transport = new FakeTransport();
  const client = new RuntimeProviderProtocolClient(transport, { timeoutMs: 10, maxPending: 1 });

  await rejectsWithCode(
    client.request('runtime.session.test', null, { signal: {} }),
    'invalid-argument',
  );
  assert.equal(client.pending.size, 0);
  assert.equal(transport.sent.length, 0);

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(transport.sent.length, 0, 'malformed signal must not leave a timeout callback behind');

  const healthy = client.request('runtime.session.test');
  assert.equal(client.pending.size, 1, 'rejected malformed request must not consume maxPending capacity');
  const request = transport.sent.find((item) => item.type === 'request');
  assert.ok(request);
  assert.equal(client.receive(packet('response', { id: request.id, epoch: request.epoch, result: 'ok' })), true);
  assert.equal(await healthy, 'ok');
  assert.equal(client.pending.size, 0);
  client.close();
});

test('#4268 listener setup failure rolls back pending state and timer', async () => {
  const transport = new FakeTransport();
  const client = new RuntimeProviderProtocolClient(transport, { timeoutMs: 10, maxPending: 1 });
  let removeCalls = 0;
  const signal = {
    aborted: false,
    addEventListener() { throw new Error('setup failed'); },
    removeEventListener() { removeCalls++; },
  };

  await rejectsWithCode(
    client.request('runtime.session.test', null, { signal }),
    'invalid-argument',
  );
  assert.equal(client.pending.size, 0);
  assert.equal(removeCalls, 1, 'rollback should best-effort detach a partially registered listener');

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(transport.sent.length, 0, 'rolled-back setup must not fire its timeout cancel');
  client.close();
});

test('#4268 throwing listener cleanup cannot retain a completed request', async () => {
  const transport = new FakeTransport();
  const client = new RuntimeProviderProtocolClient(transport, { timeoutMs: 1000 });
  let listener = null;
  const signal = {
    aborted: false,
    addEventListener(_type, callback) { listener = callback; },
    removeEventListener() { throw new Error('cleanup failed'); },
  };

  const pending = client.request('runtime.session.test', null, { signal });
  assert.equal(typeof listener, 'function');
  const request = transport.sent.find((item) => item.type === 'request');
  assert.ok(request);
  assert.equal(client.receive(packet('response', { id: request.id, epoch: request.epoch, result: 7 })), true);
  assert.equal(await pending, 7);
  assert.equal(client.pending.size, 0);
  client.close();
});

test('#4268 explicit non-nullish non-signals fail closed', async () => {
  const client = new RuntimeProviderProtocolClient(new FakeTransport());
  for (const signal of [false, 0, '', true, { aborted: false, addEventListener() {} }]) {
    await rejectsWithCode(client.request('runtime.session.test', null, { signal }), 'invalid-argument');
    assert.equal(client.pending.size, 0);
  }
  client.close();
});
