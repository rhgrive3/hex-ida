import test from 'node:test';
import assert from 'node:assert/strict';

import { DEBUG_PROTOCOL_VERSION } from '../../../js/debug/adapter.js';
import {
  BIGINT_TAG,
  BYTES_TAG,
  WIRE_TAG,
  RemoteProtocolClient,
  encodeWireValue,
} from '../../../js/debug/remote-protocol.js';

function makeClient(options = {}) {
  return new RemoteProtocolClient(
    { send: async () => {}, onMessage: () => () => {} },
    { monotonicNow: () => 0, ...options },
  );
}

function event(name, data = null) {
  return {
    version: DEBUG_PROTOCOL_VERSION,
    type: 'event',
    epoch: 0,
    event: name,
    data,
  };
}

function malformedBytesEvent(name = 'malformed-bytes') {
  return event(name, {
    payload: { [WIRE_TAG]: BYTES_TAG, value: 'not-base64!', length: 4 },
  });
}

test('#5245 count backpressure rejects before wire payload decode', () => {
  const client = makeClient({ maxEventsPerSecond: 1, maxEventBytesPerSecond: 1024 * 1024 });
  const delivered = [];
  client.onEvent((packet) => delivered.push(packet.event));

  assert.equal(client.receive(event('first')), true);
  assert.equal(client.receive(malformedBytesEvent()), false);

  // If decode runs first, malformed base64 returns before the quota branch and
  // this notice never appears. The quota decision must own the drop first.
  assert.deepEqual(delivered, ['first', 'stream-truncated']);
  assert.equal(client.eventWindowCount, 1);
  assert.equal(client.droppedEvents, 1);
});

test('#5245 byte backpressure rejects oversized encoded event before BigInt decode', () => {
  const client = makeClient({ maxEventsPerSecond: 100, maxEventBytesPerSecond: 1024 });
  const delivered = [];
  client.onEvent((packet) => delivered.push(packet.event));

  const wire = event('oversized', {
    payload: { [WIRE_TAG]: BIGINT_TAG, value: 'x'.repeat(1500) },
  });
  assert.ok(new TextEncoder().encode(JSON.stringify(wire)).byteLength > 1024);
  assert.equal(client.receive(wire), false);

  assert.deepEqual(delivered, ['stream-truncated']);
  assert.equal(client.eventWindowCount, 0);
  assert.equal(client.eventWindowBytes, 0);
  assert.equal(client.droppedEvents, 1);
});

test('#5245 admitted malformed events still fail decode without consuming quota', () => {
  const client = makeClient({ maxEventsPerSecond: 2, maxEventBytesPerSecond: 1024 * 1024 });
  const delivered = [];
  client.onEvent((packet) => delivered.push(packet.event));

  assert.equal(client.receive(malformedBytesEvent()), false);
  assert.equal(client.eventWindowCount, 0);
  assert.equal(client.eventWindowBytes, 0);
  assert.equal(client.droppedEvents, 0);

  assert.equal(client.receive(event('valid-after-malformed')), true);
  assert.deepEqual(delivered, ['valid-after-malformed']);
  assert.equal(client.eventWindowCount, 1);
});

test('#5245 accepted events retain canonical decode and encoded-byte accounting', () => {
  const client = makeClient({ maxEventsPerSecond: 2, maxEventBytesPerSecond: 4096 });
  const delivered = [];
  client.onEvent((packet) => delivered.push(packet));

  const wire = encodeWireValue(event('bytes', { payload: new Uint8Array([1, 2, 255]) }));
  const encodedBytes = new TextEncoder().encode(JSON.stringify(wire)).byteLength;
  assert.equal(client.receive(wire), true);

  assert.equal(delivered.length, 1);
  assert.deepEqual([...delivered[0].data.payload], [1, 2, 255]);
  assert.equal(client.eventWindowBytes, encodedBytes);
  assert.equal(client.eventWindowCount, 1);
});

test('#5245 repeated pre-decode drops emit only one truncation notice per window', () => {
  const client = makeClient({ maxEventsPerSecond: 1, maxEventBytesPerSecond: 1024 * 1024 });
  const delivered = [];
  client.onEvent((packet) => delivered.push(packet.event));

  assert.equal(client.receive(event('first')), true);
  assert.equal(client.receive(malformedBytesEvent('drop-one')), false);
  assert.equal(client.receive(malformedBytesEvent('drop-two')), false);

  assert.deepEqual(delivered, ['first', 'stream-truncated']);
  assert.equal(client.droppedEvents, 2);
});

test('#5245 saturated count window never invokes the byte decoder for a valid encoded payload', () => {
  const client = makeClient({ maxEventsPerSecond: 1, maxEventBytesPerSecond: 1024 * 1024 });
  assert.equal(client.receive(event('first')), true);

  const wire = event('valid-bytes-drop', {
    payload: { [WIRE_TAG]: BYTES_TAG, value: 'AQI=', length: 2 },
  });
  const originalFrom = Buffer.from;
  let base64Decodes = 0;
  Buffer.from = function patchedFrom(value, encoding, ...rest) {
    if (encoding === 'base64') base64Decodes += 1;
    return originalFrom.call(Buffer, value, encoding, ...rest);
  };
  try {
    assert.equal(client.receive(wire), false);
    assert.equal(base64Decodes, 0);
  } finally {
    Buffer.from = originalFrom;
  }
});

test('#5245 byte-window rejection never invokes the byte decoder for a valid oversized payload', () => {
  const client = makeClient({ maxEventsPerSecond: 100, maxEventBytesPerSecond: 1024 });
  const payload = Buffer.alloc(1200).toString('base64');
  const wire = event('oversized-valid-bytes', {
    payload: { [WIRE_TAG]: BYTES_TAG, value: payload, length: 1200 },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(wire), 'utf8') > 1024);

  const originalFrom = Buffer.from;
  let base64Decodes = 0;
  Buffer.from = function patchedFrom(value, encoding, ...rest) {
    if (encoding === 'base64') base64Decodes += 1;
    return originalFrom.call(Buffer, value, encoding, ...rest);
  };
  try {
    assert.equal(client.receive(wire), false);
    assert.equal(base64Decodes, 0);
  } finally {
    Buffer.from = originalFrom;
  }
});
