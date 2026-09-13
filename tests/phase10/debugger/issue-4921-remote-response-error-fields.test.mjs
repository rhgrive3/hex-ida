// Regression for #4921: remote response error code/message are semantic
// control-flow identifiers. Structured wire values must never be String()-
// coerced into trusted DebugAdapterError fields.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEBUG_PROTOCOL_VERSION, DebugAdapterError } from '../../../js/debug/adapter.js';
import { RemoteProtocolClient, validateRemotePacket } from '../../../js/debug/remote-protocol.js';

function response(fields = {}) {
  return { version: DEBUG_PROTOCOL_VERSION, type: 'response', id: 1, epoch: 0, ...fields };
}

function transport() {
  return { async send() {}, onMessage() { return () => {}; } };
}

function malformed(packet, label) {
  assert.throws(() => validateRemotePacket(packet), (error) => {
    assert.equal(error instanceof DebugAdapterError, true, `${label}: expected DebugAdapterError`);
    assert.equal(error.code, 'malformed-packet', `${label}: expected malformed-packet`);
    return true;
  });
}

test('#4921 accepts primitive string error fields and structured details', async () => {
  const details = { retry: false, attempt: 2, nested: ['a', { b: true }] };
  const packet = response({ error: { code: 'remote-failed', message: 'nope', details } });
  assert.deepEqual(validateRemotePacket(packet).error, packet.error);

  const client = new RemoteProtocolClient(transport(), { timeoutMs: 1000 });
  const pending = client.request('readMemory', { address: '0x0', size: 1 });
  assert.equal(client.receive(packet), true);
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'remote-failed');
    assert.equal(error.message, 'nope');
    assert.deepEqual(error.details, details);
    return true;
  });
  client.close();
});

test('#4921 rejects structured and non-string error code/message before classification', () => {
  for (const [field, value] of [
    ['code', ['timeout']],
    ['code', { toString: 'timeout' }],
    ['code', true],
    ['code', 7],
    ['message', ['remote timed out']],
    ['message', { text: 'remote timed out' }],
    ['message', false],
    ['message', 9],
  ]) {
    malformed(response({ error: { code: 'remote-failed', message: 'failed', [field]: value } }), `${field}:${typeof value}`);
  }
});

test('#4921 malformed error response neither consumes pending request nor launders timeout', async () => {
  const client = new RemoteProtocolClient(transport(), { timeoutMs: 1000 });
  const pending = client.request('readMemory', { address: '0x0', size: 1 });
  // Keep the pre-fix reproduction deterministic too: the buggy implementation
  // settles this promise immediately, before the assertion below can observe it.
  pending.catch(() => {});

  assert.equal(client.pending.size, 1);
  assert.equal(client.receive(response({ error: { code: ['timeout'], message: ['remote timed out'] } })), false);
  assert.equal(client.pending.size, 1, 'malformed response must not settle the request');

  assert.equal(client.receive(response({ error: { code: 'remote-failed', message: 'canonical failure' } })), true);
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'remote-failed');
    assert.equal(error.message, 'canonical failure');
    return true;
  });
  client.close();
});

test('#4921 omitted/empty error fields retain generic fallback semantics', async () => {
  for (const errorPayload of [{}, { code: '', message: '' }]) {
    const client = new RemoteProtocolClient(transport(), { timeoutMs: 1000 });
    const pending = client.request('readMemory', {});
    assert.equal(client.receive(response({ error: errorPayload })), true);
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'remote-error');
      assert.equal(error.message, 'remote error');
      return true;
    });
    client.close();
  }
});

test('#4921 success response/result decoding remains unchanged', async () => {
  const client = new RemoteProtocolClient(transport(), { timeoutMs: 1000 });
  const pending = client.request('readMemory', {});
  const result = { value: ['ok', 1, true] };
  assert.equal(client.receive(response({ result })), true);
  assert.deepEqual(await pending, result);
  client.close();
});

test('#4921 decode-boundary accessor mutation cannot launder a structured code', async () => {
  const errorPayload = { message: 'remote failed' };
  let reads = 0;
  Object.defineProperty(errorPayload, 'code', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      // validateValue(), JSON byte accounting, and raw response validation see
      // a valid string; decode sees the later structured value.
      return reads <= 3 ? 'remote-failed' : ['timeout'];
    },
  });

  const client = new RemoteProtocolClient(transport(), { timeoutMs: 1000 });
  const pending = client.request('readMemory', {});
  pending.catch(() => {});
  assert.equal(client.receive(response({ error: errorPayload })), false);
  assert.equal(client.pending.size, 1, 'post-decode semantic validation must reject the changed field');
  assert.equal(client.receive(response({ error: { code: 'remote-failed', message: 'canonical failure' } })), true);
  await assert.rejects(pending, (error) => error.code === 'remote-failed');
  client.close();
});

test('#4921 inherited error metadata cannot become remote control-flow authority', async () => {
  const priorCode = Object.getOwnPropertyDescriptor(Object.prototype, 'code');
  const priorMessage = Object.getOwnPropertyDescriptor(Object.prototype, 'message');
  try {
    Object.defineProperty(Object.prototype, 'code', { value: 'timeout', writable: true, configurable: true });
    Object.defineProperty(Object.prototype, 'message', { value: 'polluted timeout', writable: true, configurable: true });
    const client = new RemoteProtocolClient(transport(), { timeoutMs: 1000 });
    const pending = client.request('readMemory', {});
    assert.equal(client.receive(response({ error: {} })), true);
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'remote-error');
      assert.equal(error.message, 'remote error');
      return true;
    });
    client.close();
  } finally {
    if (priorCode) Object.defineProperty(Object.prototype, 'code', priorCode);
    else delete Object.prototype.code;
    if (priorMessage) Object.defineProperty(Object.prototype, 'message', priorMessage);
    else delete Object.prototype.message;
  }
});
