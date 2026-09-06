import test from 'node:test';
import assert from 'node:assert/strict';

import { DEBUG_PROTOCOL_VERSION } from '../../../js/debug/adapter.js';
import {
  BIGINT_TAG,
  WIRE_TAG,
  RemoteProtocolClient,
  encodeWireValue,
} from '../../../js/debug/remote-protocol.js';

function createClient(options = {}) {
  return new RemoteProtocolClient({
    send: async () => {},
    onMessage: () => () => {},
  }, options);
}

function wireBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

test('RemoteProtocolClient delivers BigInt and byte events while accounting encoded wire bytes (#4083)', () => {
  const client = createClient();
  const received = [];
  client.onEvent((event) => received.push(event));

  const wire = encodeWireValue({
    version: DEBUG_PROTOCOL_VERSION,
    type: 'event',
    epoch: 0,
    event: 'stopped',
    data: {
      address: 0x1_0000_0000n,
      nested: { delta: -2n },
      bytes: new Uint8Array([0, 1, 255]),
    },
  });

  assert.equal(client.receive(wire), true);
  assert.equal(received.length, 1);
  assert.equal(received[0].data.address, 0x1_0000_0000n);
  assert.equal(received[0].data.nested.delta, -2n);
  assert.deepEqual([...received[0].data.bytes], [0, 1, 255]);
  assert.equal(client.eventWindowBytes, wireBytes(wire));
});

test('RemoteProtocolClient keeps ordinary event delivery unchanged (#4083)', () => {
  const client = createClient();
  const received = [];
  client.onEvent((event) => received.push(event));

  const wire = encodeWireValue({
    version: DEBUG_PROTOCOL_VERSION,
    type: 'event',
    epoch: 0,
    event: 'continued',
    data: { threadId: 7 },
  });

  assert.equal(client.receive(wire), true);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].data, { threadId: 7 });
  assert.equal(client.eventWindowBytes, wireBytes(wire));
});

test('RemoteProtocolClient rejects malformed BigInt wire tags without dispatch (#4083)', () => {
  const client = createClient();
  const received = [];
  client.onEvent((event) => received.push(event));

  const malformed = {
    version: DEBUG_PROTOCOL_VERSION,
    type: 'event',
    epoch: 0,
    event: 'stopped',
    data: {
      address: { [WIRE_TAG]: BIGINT_TAG, value: '1.5' },
    },
  };

  assert.equal(client.receive(malformed), false);
  assert.equal(received.length, 0);
  assert.equal(client.eventWindowBytes, 0);
});
