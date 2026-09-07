// Regression for #5931: event-listener isolation must cover async failures —
// a listener returning a rejected promise must not leak an unhandledRejection.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RemoteProtocolClient } from '../js/debug/remote-protocol.js';
import { RemoteDebugAdapter } from '../js/adapters/index.js';
import { DEBUG_PROTOCOL_VERSION } from '../js/debug/adapter.js';

async function settle(microtasks = 3) {
  for (let i = 0; i < microtasks; i++) await new Promise((resolve) => setImmediate(resolve));
}

test('#5931 an async remote-protocol listener that rejects stays isolated', async () => {
  process.setMaxListeners(0);
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const client = new RemoteProtocolClient({ async send() {} }, { timeoutMs: 100 });
    client.onEvent(async () => { throw new Error('async listener boom'); });
    const accepted = client.receive({
      version: DEBUG_PROTOCOL_VERSION,
      type: 'event',
      epoch: 0,
      event: 'halted',
      data: {},
    });
    assert.equal(accepted, true);
    await settle();
    assert.deepEqual(unhandled, [], 'async listener rejections must not leak as unhandledRejection');
    client.close();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('#5931 async adapter event listeners stay isolated on the production transport path', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  let adapter = null;
  let receiver = null;
  const transport = {
    async send() {},
    onMessage(fn) {
      receiver = fn;
      return () => { if (receiver === fn) receiver = null; };
    },
    deliver(packet) {
      assert.equal(typeof receiver, 'function', 'adapter constructor must install the protocol transport callback');
      return receiver(packet);
    },
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    adapter = new RemoteDebugAdapter(transport, { protocol: { timeoutMs: 100 } });
    adapter.onEvent(async () => { throw new Error('adapter async boom'); });
    const accepted = transport.deliver({
      version: DEBUG_PROTOCOL_VERSION,
      type: 'event',
      epoch: 0,
      event: 'halted',
      data: {},
    });
    assert.equal(accepted, true);
    await settle();
    assert.deepEqual(unhandled, [], 'production adapter dispatch must isolate async listener rejections');
  } finally {
    adapter?.protocol.close();
    process.off('unhandledRejection', onUnhandled);
  }
});

test('#5931 the stream-truncated notice path is isolated as well', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    // Drive the rate limiter into backpressure with a rejecting async listener.
    let monotonic = 0;
    const client = new RemoteProtocolClient({ async send() {} }, {
      timeoutMs: 100,
      monotonicNow: () => ++monotonic,
      maxEventsPerSecond: 1,
      maxEventBytesPerSecond: 1024,
    });
    client.onEvent(async () => { throw new Error('notice boom'); });
    const first = client.receive({ version: DEBUG_PROTOCOL_VERSION, type: 'event', epoch: 0, event: 'halted', data: {} });
    assert.equal(first, true);
    await settle();
    // The second event within the window triggers the truncation notice.
    const second = client.receive({ version: DEBUG_PROTOCOL_VERSION, type: 'event', epoch: 0, event: 'halted', data: {} });
    assert.equal(second, false);
    await settle();
    assert.deepEqual(unhandled, []);
    client.close();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
