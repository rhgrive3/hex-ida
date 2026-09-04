import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteProtocolClient } from '../../js/debug/remote-protocol.js';
import { DEBUG_PROTOCOL_VERSION } from '../../js/debug/adapter.js';

function clientAt(now, options = {}) {
  let current = now;
  const clock = () => current;
  const client = new RemoteProtocolClient(
    { send: async () => {} },
    { maxEventsPerSecond: 1, maxEventBytesPerSecond: 1024 * 1024, monotonicNow: clock, ...options },
  );
  return { client, advance: (ms) => { current += ms; }, set: (ms) => { current = ms; } };
}

const event = (name) => ({ version: DEBUG_PROTOCOL_VERSION, type: 'event', epoch: 0, event: name, data: {} });

test('6072: window resets on monotonic elapsed time', () => {
  const { client, advance } = clientAt(10_000);
  const delivered = [];
  client.onEvent((packet) => delivered.push(packet.event));
  assert.equal(client.receive(event('first')), true);
  assert.equal(client.receive(event('second')), false);
  advance(1000);
  assert.equal(client.receive(event('third')), true);
  assert.deepEqual(delivered, ['first', 'stream-truncated', 'third']);
});

test('6072: wall-clock rollback cannot pin the window shut', () => {
  const originalNow = Date.now;
  const { client, advance } = clientAt(10_000);
  const delivered = [];
  client.onEvent((packet) => delivered.push(packet.event));
  try {
    assert.equal(client.receive(event('first')), true);
    Date.now = () => 0; // wall clock jumps 10s backwards; monotonic clock is unaffected
    assert.equal(client.receive(event('second')), false);
    advance(1000); // monotonic elapsed: window must reset despite the wall clock
    assert.equal(client.receive(event('third')), true);
  } finally {
    Date.now = originalNow;
  }
  assert.deepEqual(delivered, ['first', 'stream-truncated', 'third']);
});

test('6072: default clock is monotonic (performance.now)', () => {
  const client = new RemoteProtocolClient({ send: async () => {} }, { maxEventsPerSecond: 1 });
  assert.equal(typeof client._monotonicNow, 'function');
  const delivered = [];
  client.onEvent((packet) => delivered.push(packet.event));
  assert.equal(client.receive(event('first')), true);
  assert.equal(client.receive(event('second')), false);
});
