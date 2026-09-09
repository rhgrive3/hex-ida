import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RUNTIME_PROVIDER_PROTOCOL,
  RUNTIME_PROVIDER_PROTOCOL_VERSION,
  RuntimeProviderProtocolClient,
  validateProviderPacket,
} from '../../../js/runtime/provider-protocol.js';

function eventBatchPacket(packetEpoch, batchEpoch, { events = true } = {}) {
  return {
    protocol: RUNTIME_PROVIDER_PROTOCOL,
    version: RUNTIME_PROVIDER_PROTOCOL_VERSION,
    type: 'event-batch',
    epoch: packetEpoch,
    facet: 'trace',
    batch: {
      runtimeSessionId: 'runtime_fixture',
      providerId: 'remote-provider',
      sessionEpoch: batchEpoch,
      completeness: 'partial',
      dropped: 0,
      events: events ? [{
        eventId: `event:${batchEpoch}`,
        runtimeSessionId: 'runtime_fixture',
        providerId: 'remote-provider',
        providerVersion: '1',
        sessionEpoch: batchEpoch,
        kind: 'trace-marker',
        payload: { pc: '0x1000' },
        completeness: 'partial',
      }] : [],
    },
  };
}

class FakeTransport {
  constructor() { this.listener = null; }
  send() {}
  onMessage(listener) {
    this.listener = listener;
    return () => { if (this.listener === listener) this.listener = null; };
  }
  receive(value) { return this.listener?.(value); }
}

test('#4566 validator rejects an event batch whose inner epoch is stale', () => {
  assert.throws(
    () => validateProviderPacket(eventBatchPacket(2, 1)),
    (error) => error?.code === 'protocol-mismatch' && /epoch/i.test(error.message),
  );
});

test('#4566 current outer epoch cannot relabel a stale inner event batch', () => {
  const transport = new FakeTransport();
  const client = new RuntimeProviderProtocolClient(transport);
  const received = [];
  client.setEpoch(2);
  client.onEvent((batch) => received.push(batch));

  assert.equal(transport.receive(eventBatchPacket(2, 1)), false);
  assert.equal(received.length, 0);
  client.close();
});

test('#4566 current outer epoch cannot relabel a future inner event batch either', () => {
  const transport = new FakeTransport();
  const client = new RuntimeProviderProtocolClient(transport);
  let seen = 0;
  client.setEpoch(2);
  client.onEvent(() => seen++);

  assert.equal(transport.receive(eventBatchPacket(2, 3)), false);
  assert.equal(seen, 0);
  client.close();
});

test('#4566 matching packet and batch epochs remain deliverable', () => {
  const transport = new FakeTransport();
  const client = new RuntimeProviderProtocolClient(transport);
  const received = [];
  client.setEpoch(2);
  client.onEvent((batch) => received.push(batch));

  assert.equal(transport.receive(eventBatchPacket(2, 2)), true);
  assert.equal(received.length, 1);
  assert.equal(received[0].sessionEpoch, 2);
  client.close();
});

test('#4566 stale outer epoch remains rejected even when the batch agrees with it', () => {
  const transport = new FakeTransport();
  const client = new RuntimeProviderProtocolClient(transport);
  let seen = 0;
  client.setEpoch(2);
  client.onEvent(() => seen++);

  assert.equal(transport.receive(eventBatchPacket(1, 1)), false);
  assert.equal(seen, 0);
  client.close();
});

test('#4566 empty event batches are still bound to their envelope epoch', () => {
  assert.throws(
    () => validateProviderPacket(eventBatchPacket(3, 2, { events: false })),
    (error) => error?.code === 'protocol-mismatch' && /epoch/i.test(error.message),
  );
});
