import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RUNTIME_PROVIDER_PROTOCOL,
  RUNTIME_PROVIDER_PROTOCOL_VERSION,
  RuntimeProviderProtocolClient,
} from '../../../js/runtime/provider-protocol.js';

function transport({throwOnCancel = false} = {}) {
  const sent = [];
  return {
    sent,
    send(packet) {
      if (throwOnCancel && packet.type === 'cancel') throw new Error('transport unavailable');
      sent.push(packet);
    },
    onMessage() { return () => {}; },
  };
}

function cancels(sent) {
  return sent.filter((packet) => packet.type === 'cancel');
}

// Keep this regression on a human-authored exact head after generated sync commits.
test('epoch transition cancels pending remote work with the old epoch', async () => {
  const wire = transport();
  const client = new RuntimeProviderProtocolClient(wire, {timeoutMs: 60000});
  const pending = client.request('runtime.session.longOperation');
  const request = wire.sent.find((packet) => packet.type === 'request');

  assert.equal(client.setEpoch(2), 2);
  await assert.rejects(pending, (error) => error?.code === 'cancelled');
  assert.deepEqual(cancels(wire.sent), [{
    protocol: RUNTIME_PROVIDER_PROTOCOL,
    version: RUNTIME_PROVIDER_PROTOCOL_VERSION,
    type: 'cancel',
    id: request.id,
    epoch: request.epoch,
  }]);
});

test('epoch transition sends one cancel for each pending request and none when empty', async () => {
  const wire = transport();
  const client = new RuntimeProviderProtocolClient(wire, {timeoutMs: 60000});
  const pending = [
    client.request('runtime.session.first'),
    client.request('runtime.session.second'),
  ];
  const requests = wire.sent.filter((packet) => packet.type === 'request');

  client.setEpoch(2);
  await Promise.all(pending.map((promise) => assert.rejects(promise, (error) => error?.code === 'cancelled')));
  assert.deepEqual(cancels(wire.sent).map(({id, epoch}) => ({id, epoch})), requests.map(({id, epoch}) => ({id, epoch})));

  const before = wire.sent.length;
  client.setEpoch(3);
  assert.equal(wire.sent.length, before);
});

test('cancel transport failure cannot prevent local epoch transition or cleanup', async () => {
  const wire = transport({throwOnCancel: true});
  const client = new RuntimeProviderProtocolClient(wire, {timeoutMs: 60000});
  const pending = client.request('runtime.session.longOperation');

  assert.doesNotThrow(() => client.setEpoch(2));
  await assert.rejects(pending, (error) => error?.code === 'cancelled');
  assert.equal(client.epoch, 2);

  wire.send = (packet) => wire.sent.push(packet);
  const next = client.request('runtime.session.next');
  const nextRequest = wire.sent.at(-1);
  assert.equal(nextRequest.epoch, 2);
  client.receive({
    protocol: RUNTIME_PROVIDER_PROTOCOL,
    version: RUNTIME_PROVIDER_PROTOCOL_VERSION,
    type: 'response',
    id: nextRequest.id,
    epoch: 2,
    result: 'ok',
  });
  assert.equal(await next, 'ok');
});

test('stale responses stay rejected after epoch cancellation', async () => {
  const wire = transport();
  const client = new RuntimeProviderProtocolClient(wire, {timeoutMs: 60000});
  const pending = client.request('runtime.session.longOperation');
  const request = wire.sent[0];
  client.setEpoch(2);
  await assert.rejects(pending, (error) => error?.code === 'cancelled');

  assert.equal(client.receive({
    protocol: RUNTIME_PROVIDER_PROTOCOL,
    version: RUNTIME_PROVIDER_PROTOCOL_VERSION,
    type: 'response',
    id: request.id,
    epoch: request.epoch,
    result: 'stale',
  }), false);
});
