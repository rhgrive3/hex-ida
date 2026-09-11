import test from 'node:test';
import assert from 'node:assert/strict';

import { DEBUG_PROTOCOL_VERSION } from '../../../js/debug/adapter.js';
import {
  BYTES_TAG,
  WIRE_TAG,
  RemoteProtocolClient,
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

function encodedBytes(length) {
  return {
    [WIRE_TAG]: BYTES_TAG,
    value: Buffer.alloc(length, 0x41).toString('base64'),
    length,
  };
}

test('#5245 snapshots/rejects accessor-backed event data before admission and decode', () => {
  const client = makeClient({ maxEventsPerSecond: 100, maxEventBytesPerSecond: 1024 });
  const raw = event('drift');
  const small = { payload: encodedBytes(2) };
  const large = { payload: encodedBytes(1200) };
  let reads = 0;
  Object.defineProperty(raw, 'data', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return reads <= 3 ? small : large;
    },
  });

  const originalFrom = Buffer.from;
  let base64Decodes = 0;
  Buffer.from = function patchedFrom(value, encoding, ...rest) {
    if (encoding === 'base64') base64Decodes += 1;
    return originalFrom.call(Buffer, value, encoding, ...rest);
  };
  try {
    assert.equal(client.receive(raw), false);
    assert.equal(reads, 0, 'accessor must not execute while establishing wire authority');
    assert.equal(base64Decodes, 0, 'rejected accessor input must not materialize tagged bytes');
  } finally {
    Buffer.from = originalFrom;
  }

  assert.equal(client.eventWindowCount, 0);
  assert.equal(client.eventWindowBytes, 0);
  assert.equal(client.droppedEvents, 0);
});

test('#5245 rejects nested accessor-backed tagged fields recursively', () => {
  const tagged = { [WIRE_TAG]: BYTES_TAG, length: 2 };
  let reads = 0;
  Object.defineProperty(tagged, 'value', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return reads === 1 ? 'QUE=' : Buffer.alloc(1200, 0x41).toString('base64');
    },
  });

  const client = makeClient({ maxEventsPerSecond: 100, maxEventBytesPerSecond: 1024 });
  assert.equal(client.receive(event('nested-drift', { payload: tagged })), false);
  assert.equal(reads, 0);
  assert.equal(client.eventWindowCount, 0);
  assert.equal(client.eventWindowBytes, 0);
});

test('#5245 ordinary data-only encoded events retain canonical decode and accounting', () => {
  const client = makeClient({ maxEventsPerSecond: 100, maxEventBytesPerSecond: 4096 });
  const delivered = [];
  client.onEvent((packet) => delivered.push(packet));
  const raw = event('stable', { payload: encodedBytes(3) });
  const encodedBytesCount = Buffer.byteLength(JSON.stringify(raw), 'utf8');

  assert.equal(client.receive(raw), true);
  assert.equal(delivered.length, 1);
  assert.deepEqual([...delivered[0].data.payload], [0x41, 0x41, 0x41]);
  assert.equal(client.eventWindowCount, 1);
  assert.equal(client.eventWindowBytes, encodedBytesCount);
});
