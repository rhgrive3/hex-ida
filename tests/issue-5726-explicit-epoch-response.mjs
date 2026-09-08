// Regression for #5726: a request opened with an explicit non-current epoch
// must be settleable by its own-epoch response. The response's settle
// authority is the pending request's epoch, not the client's current epoch.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RemoteProtocolClient } from '../js/debug/remote-protocol.js';
import { DEBUG_PROTOCOL_VERSION } from '../js/debug/adapter.js';

function makeClient() {
  const sent = [];
  const transport = { async send(packet) { sent.push(packet); } };
  const client = new RemoteProtocolClient(transport, { timeoutMs: 100 });
  return { client, sent };
}

test('#5726 an explicit-epoch request settles with its own-epoch response', async () => {
  const { client, sent } = makeClient();
  const pending = client.request('readMemory', {}, { epoch: 1, timeoutMs: 100 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const request = sent.find((packet) => packet.type === 'request');
  assert.equal(request.epoch, 1);

  const accepted = client.receive({
    version: DEBUG_PROTOCOL_VERSION,
    type: 'response',
    id: request.id,
    epoch: 1,
    result: { ok: true },
  });
  assert.equal(accepted, true);
  assert.deepEqual(await pending, { ok: true });
  assert.equal(client.pending.size, 0);
  client.close();
});

test('#5726 a foreign-epoch response for a current-epoch request stays rejected', async () => {
  const { client, sent } = makeClient();
  const pending = client.request('readMemory', {}, { timeoutMs: 100 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const request = sent.find((packet) => packet.type === 'request');
  assert.equal(request.epoch, 0);

  const wrongEpoch = client.receive({
    version: DEBUG_PROTOCOL_VERSION,
    type: 'response',
    id: request.id,
    epoch: 9,
    result: { forged: true },
  });
  assert.equal(wrongEpoch, false, 'an epoch outside request+current must never settle');
  assert.equal(client.pending.size, 1);

  const accepted = client.receive({
    version: DEBUG_PROTOCOL_VERSION,
    type: 'response',
    id: request.id,
    epoch: 0,
    result: { ok: true },
  });
  assert.equal(accepted, true);
  assert.deepEqual(await pending, { ok: true });
  client.close();
});

test('#5726 stale-epoch invalidation via setEpoch keeps rejecting old responses', async () => {
  const { client, sent } = makeClient();
  client.setEpoch(7);
  const pending = client.request('readRegisters', {}, { timeoutMs: 100 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const request = sent.find((packet) => packet.type === 'request');
  client.setEpoch(8);
  await assert.rejects(pending, (error) => error.code === 'stale-request' || /stale-request|invalidated by session epoch/.test(error.message));
  const late = client.receive({
    version: DEBUG_PROTOCOL_VERSION,
    type: 'response',
    id: request.id,
    epoch: 7,
    result: { late: true },
  });
  assert.equal(late, false, 'a request cancelled by an epoch change must not settle afterwards');
  client.close();
});

test('#5726 a foreign-epoch event stays rejected', () => {
  const { client } = makeClient();
  let seen = 0;
  client.onEvent(() => seen++);
  const accepted = client.receive({
    version: DEBUG_PROTOCOL_VERSION,
    type: 'event',
    epoch: 5,
    event: 'halted',
    data: {},
  });
  assert.equal(accepted, false);
  assert.equal(seen, 0);
  client.close();
});
