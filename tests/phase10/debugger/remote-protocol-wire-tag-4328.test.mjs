import test from 'node:test';
import assert from 'node:assert/strict';

import { DEBUG_PROTOCOL_VERSION } from '../../../js/debug/adapter.js';
import {
  BIGINT_TAG,
  BYTES_TAG,
  WIRE_TAG,
  RemoteProtocolClient,
  decodeWireValue,
  encodeWireValue,
  validateRemotePacket,
} from '../../../js/debug/remote-protocol.js';

function assertMalformed(fn) {
  assert.throws(fn, (error) => error?.code === 'malformed-packet');
}

function createClient() {
  return new RemoteProtocolClient({
    send: async () => {},
    onMessage: () => () => {},
  });
}

test('decodeWireValue rejects unknown reserved wire tags (#4328)', () => {
  for (const tag of ['future-wire-tag', '', null, 7, true]) {
    assertMalformed(() => decodeWireValue({
      [WIRE_TAG]: tag,
      value: '1',
    }));
  }
});

test('packet validation and event receive reject nested unknown wire tags (#4328)', () => {
  const packet = {
    version: DEBUG_PROTOCOL_VERSION,
    type: 'event',
    epoch: 0,
    event: 'stopped',
    data: {
      nested: { [WIRE_TAG]: 'future-wire-tag', x: 1 },
    },
  };

  assertMalformed(() => validateRemotePacket(packet));

  const client = createClient();
  const received = [];
  client.onEvent((event) => received.push(event));
  assert.equal(client.receive(packet), false);
  assert.equal(received.length, 0);
  assert.equal(client.eventWindowBytes, 0);
});

test('known wire tags and plain objects preserve canonical round trips (#4328)', () => {
  const semantic = {
    plain: { x: 1, nested: ['ok', false] },
    address: 0x1_0000_0000n,
    bytes: new Uint8Array([0, 1, 255]),
  };

  const wire = encodeWireValue(semantic);
  assert.equal(wire.address[WIRE_TAG], BIGINT_TAG);
  assert.equal(wire.bytes[WIRE_TAG], BYTES_TAG);
  assert.doesNotThrow(() => validateRemotePacket({
    version: DEBUG_PROTOCOL_VERSION,
    type: 'event',
    epoch: 0,
    event: 'stopped',
    data: wire,
  }));

  const decoded = decodeWireValue(wire);
  assert.equal(decoded.address, semantic.address);
  assert.deepEqual([...decoded.bytes], [...semantic.bytes]);
  assert.deepEqual(decoded.plain, semantic.plain);
  assert.deepEqual(encodeWireValue(decoded), wire);
});
