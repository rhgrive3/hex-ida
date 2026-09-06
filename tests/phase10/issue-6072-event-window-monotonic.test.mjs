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

function withDefaultClockStubs({ performanceValue, hrtimeBigint, dateNow }, fn) {
  const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const originalHrtimeBigint = process.hrtime.bigint;
  const originalDateNow = Date.now;
  try {
    Object.defineProperty(globalThis, 'performance', {
      value: performanceValue,
      configurable: true,
      writable: true,
      enumerable: true,
    });
    process.hrtime.bigint = hrtimeBigint;
    Date.now = dateNow;
    return fn();
  } finally {
    if (performanceDescriptor) Object.defineProperty(globalThis, 'performance', performanceDescriptor);
    else delete globalThis.performance;
    process.hrtime.bigint = originalHrtimeBigint;
    Date.now = originalDateNow;
  }
}

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

test('6072: default clock uses performance.now when available', () => {
  let now = 10_000;
  withDefaultClockStubs({
    performanceValue: { now: () => now },
    hrtimeBigint: () => { throw new Error('hrtime must not be used'); },
    dateNow: () => { throw new Error('wall clock must not be used'); },
  }, () => {
    const client = new RemoteProtocolClient({ send: async () => {} }, { maxEventsPerSecond: 1 });
    assert.equal(client.receive(event('first')), true);
    assert.equal(client.receive(event('second')), false);
    now += 1000;
    assert.equal(client.receive(event('third')), true);
  });
});

test('6072: performance failure falls back to process.hrtime, not wall clock', () => {
  let monotonicNs = 10_000_000_000n;
  let wallNow = 10_000;
  const delivered = [];
  withDefaultClockStubs({
    performanceValue: { now: () => { throw new Error('performance failed'); } },
    hrtimeBigint: () => monotonicNs,
    dateNow: () => wallNow,
  }, () => {
    const client = new RemoteProtocolClient({ send: async () => {} }, { maxEventsPerSecond: 1 });
    client.onEvent((packet) => delivered.push(packet.event));
    assert.equal(client.receive(event('first')), true);
    assert.equal(client.receive(event('second')), false);

    wallNow = -1_000_000; // rollback alone cannot pin or reset the window
    monotonicNs += 1_000_000_000n;
    assert.equal(client.receive(event('third')), true);
    assert.equal(client.receive(event('fourth')), false);

    wallNow = 1_000_000_000; // forward jump alone cannot reset the window either
    assert.equal(client.receive(event('fifth')), false);
    monotonicNs += 1_000_000_000n;
    assert.equal(client.receive(event('sixth')), true);
  });
  assert.deepEqual(delivered, ['first', 'stream-truncated', 'third', 'stream-truncated', 'sixth']);
});

test('6072: unavailable performance falls back to process.hrtime', () => {
  let monotonicNs = 20_000_000_000n;
  withDefaultClockStubs({
    performanceValue: undefined,
    hrtimeBigint: () => monotonicNs,
    dateNow: () => 0,
  }, () => {
    const client = new RemoteProtocolClient({ send: async () => {} }, { maxEventsPerSecond: 1 });
    assert.equal(client.receive(event('first')), true);
    assert.equal(client.receive(event('second')), false);
    monotonicNs += 1_000_000_000n;
    assert.equal(client.receive(event('third')), true);
  });
});

test('6072: no monotonic source fails closed instead of using Date.now', () => {
  withDefaultClockStubs({
    performanceValue: undefined,
    hrtimeBigint: () => { throw new Error('hrtime unavailable'); },
    dateNow: () => 123_456,
  }, () => {
    assert.throws(
      () => new RemoteProtocolClient({ send: async () => {} }, { maxEventsPerSecond: 1 }),
      (error) => error?.code === 'monotonic-clock-unavailable',
    );
  });
});
