import assert from 'node:assert/strict';
import test from 'node:test';

import { DEBUG_PROTOCOL_VERSION } from '../../../js/debug/adapter.js';
import {
  BIGINT_TAG,
  RemoteProtocolClient,
  WIRE_TAG,
  validateRemotePacket,
} from '../../../js/debug/remote-protocol.js';

function response(fields = {}) {
  return {
    version: DEBUG_PROTOCOL_VERSION,
    type: 'response',
    id: 1,
    epoch: 0,
    ...fields,
  };
}

test('response schema requires exactly one explicit result or plain error object', () => {
  for (const packet of [
    response(),
    response({ result: null, error: { code: 'x', message: 'x' } }),
    response({ error: false }),
    response({ error: 'failed' }),
    response({ error: [1] }),
    response({ error: { [WIRE_TAG]: BIGINT_TAG, value: '1' } }),
  ]) {
    assert.throws(() => validateRemotePacket(packet), /malformed-packet/);
  }

  assert.equal(validateRemotePacket(response({ result: null })).result, null);
  assert.deepEqual(
    validateRemotePacket(response({ error: { code: 'remote-failed', message: 'nope' } })).error,
    { code: 'remote-failed', message: 'nope' },
  );
});

test('malformed response does not consume a pending request', async () => {
  const sent = [];
  const transport = {
    async send(packet) { sent.push(packet); },
    onMessage() { return () => {}; },
  };
  const client = new RemoteProtocolClient(transport, { timeoutMs: 1000 });
  const pending = client.request('readMemory', { address: '0x0', size: 1 });

  assert.equal(client.pending.size, 1);
  assert.equal(client.receive(response()), false);
  assert.equal(client.pending.size, 1);

  assert.equal(client.receive(response({ result: null })), true);
  assert.equal(await pending, null);
  assert.equal(client.pending.size, 0);
  client.close();
});

test('valid explicit error response still rejects the request', async () => {
  const transport = {
    async send() {},
    onMessage() { return () => {}; },
  };
  const client = new RemoteProtocolClient(transport, { timeoutMs: 1000 });
  const pending = client.request('readMemory', { address: '0x0', size: 1 });

  assert.equal(client.receive(response({ error: { code: 'remote-failed', message: 'nope' } })), true);
  await assert.rejects(pending, /nope/);
  assert.equal(client.pending.size, 0);
  client.close();
});
