import assert from 'node:assert/strict';
import { RemoteDebugAdapter } from '../js/adapters/index.js';
import { DEBUG_PROTOCOL_VERSION } from '../js/debug/adapter.js';
import { encodeWireValue } from '../js/debug/remote-protocol.js';

const settle = (promise) =>
  promise.then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }));

function makeTransport() {
  const sent = [];
  const byId = new Map();
  const policies = new Map();
  let listener = null;
  const deliver = (id, result) => {
    const req = byId.get(id);
    if (!req) return;
    listener?.(encodeWireValue({ version: DEBUG_PROTOCOL_VERSION, type: 'response', id, epoch: req.epoch, result }));
  };
  return {
    sent,
    onMessage(fn) {
      listener = fn;
      return () => { if (listener === fn) listener = null; };
    },
    async send(wire) {
      sent.push(wire);
      if (wire.type === 'request') {
        byId.set(wire.id, wire);
        if (policies.has(wire.method)) queueMicrotask(() => deliver(wire.id, policies.get(wire.method)));
      }
    },
    auto(method, result) { policies.set(method, result); },
    respondNow(id, result) { deliver(id, result); },
    close() {},
  };
}

function requestFor(transport, method, afterId = -Infinity) {
  return transport.sent.filter((p) => p.type === 'request' && p.method === method && p.id > afterId)[0] || null;
}

// Scenario 1 (#4688 core): a connect request still in flight when disconnect() is
// called must not resurrect the session once its response lands afterwards.
{
  const transport = makeTransport();
  const adapter = new RemoteDebugAdapter(transport, { capabilities: { readMemory: true }, protocol: { timeoutMs: 25 } });
  const connecting = settle(adapter.connect());
  const connectRequest = requestFor(transport, 'connect');
  assert.ok(connectRequest, 'connect() must open a remote connect request');
  assert.equal(connectRequest.epoch, 0);

  await adapter.disconnect();
  assert.equal(adapter.connected, false);
  assert.equal(adapter.epoch, 1, 'disconnect must advance the lifecycle generation even while connect is pending');
  assert.ok(
    transport.sent.some((p) => p.type === 'cancel' && p.requestEpoch === 0),
    'disconnect must cancel the in-flight connect at the protocol level',
  );

  transport.respondNow(connectRequest.id, { capabilities: { readMemory: true } });
  const outcome = await connecting;
  assert.equal(outcome.status, 'rejected', 'the stale connect must reject, not resolve');
  assert.equal(outcome.reason?.code, 'stale-request');
  assert.equal(adapter.connected, false, 'a response older than the disconnect must not reconnect the adapter');
}

// Scenario 1b: the connect response settles first, then disconnect advances the epoch
// before the connect continuation runs; connect() must verify its own generation.
{
  const transport = makeTransport();
  const adapter = new RemoteDebugAdapter(transport, { capabilities: { readMemory: true }, protocol: { timeoutMs: 25 } });
  const connecting = settle(adapter.connect());
  const connectRequest = requestFor(transport, 'connect');

  transport.respondNow(connectRequest.id, { capabilities: {} });
  adapter.disconnect();

  const outcome = await connecting;
  assert.equal(outcome.status, 'rejected', 'a connect whose generation was advanced must not publish');
  assert.equal(outcome.reason?.code, 'stale-request');
  assert.equal(adapter.connected, false);
  assert.equal(adapter.capabilities.readMemory, true, 'stale connect must not rewrite negotiated capabilities');
}

// Scenario 2: the normal connect handshake still succeeds and publishes state.
{
  const transport = makeTransport();
  transport.auto('connect', { capabilities: { readMemory: true } });
  const adapter = new RemoteDebugAdapter(transport, { capabilities: { readMemory: true, attach: true }, protocol: { timeoutMs: 25 } });
  const result = await adapter.connect();
  assert.equal(adapter.connected, true);
  assert.equal(adapter.capabilities.readMemory, true, 'intersection of allow-list and advertisement is kept');
  assert.equal(adapter.capabilities.attach, false, 'capabilities the peer does not advertise are dropped');
  assert.equal(result.capabilities.readMemory, true);
}

// Scenario 3 + 6: a disconnect on a live session keeps the peer handshake and the
// epoch-change cancellation of pending requests.
{
  const transport = makeTransport();
  transport.auto('connect', { capabilities: { readMemory: true } });
  transport.auto('disconnect', { disconnected: true });
  const adapter = new RemoteDebugAdapter(transport, { capabilities: { readMemory: true }, protocol: { timeoutMs: 25 } });
  await adapter.connect();
  assert.equal(adapter.connected, true);
  assert.equal(adapter.epoch, 0);

  const readPromise = settle(adapter.readMemory(0x1000n, 2));
  assert.ok(requestFor(transport, 'readMemory'), 'the memory read must be in flight');

  await adapter.disconnect();
  const read = await readPromise;
  assert.equal(read.status, 'rejected', 'pending requests must be cancelled by the epoch change');
  assert.equal(read.reason?.code, 'stale-request');
  assert.equal(adapter.connected, false);
  assert.equal(adapter.epoch, 1);
  assert.ok(requestFor(transport, 'disconnect'), 'a connected session must still send the peer disconnect handshake');
}

// Scenario 4: a stale connect response must never clobber a newer connect generation.
{
  const transport = makeTransport();
  const adapter = new RemoteDebugAdapter(transport, { capabilities: { readMemory: true, launch: true }, protocol: { timeoutMs: 25 } });
  const firstConnecting = settle(adapter.connect());
  const firstRequest = requestFor(transport, 'connect');
  assert.equal(firstRequest.epoch, 0);

  await adapter.disconnect();

  const secondConnecting = settle(adapter.connect());
  const secondRequest = requestFor(transport, 'connect', firstRequest.id);
  assert.ok(secondRequest, 'a new connect must start after disconnect');
  assert.equal(secondRequest.epoch, 1, 'the reconnect must run under the advanced generation');

  transport.respondNow(secondRequest.id, { capabilities: { readMemory: true } });
  const second = await secondConnecting;
  assert.equal(second.status, 'fulfilled');
  assert.equal(adapter.connected, true);
  assert.equal(adapter.capabilities.readMemory, true);

  transport.respondNow(firstRequest.id, { capabilities: { launch: true } });
  const first = await firstConnecting;
  assert.equal(first.status, 'rejected');
  assert.equal(first.reason?.code, 'stale-request');
  assert.equal(adapter.connected, true, 'the stale connect must not disturb the current session');
  assert.equal(adapter.capabilities.readMemory, true, 'the current connect capabilities must survive');
  assert.notEqual(adapter.capabilities.launch, true, 'the stale connect must not inject its own capabilities');
}

// Scenario 5: disconnect on a never-connected adapter still invalidates the generation.
{
  const transport = makeTransport();
  const adapter = new RemoteDebugAdapter(transport, { capabilities: { readMemory: true }, protocol: { timeoutMs: 25 } });
  const epochBefore = adapter.epoch;
  const result = await adapter.disconnect();
  assert.deepEqual(result, { disconnected: true });
  assert.equal(adapter.epoch, epochBefore + 1, 'every disconnect advances the lifecycle generation');
}

console.log('issue-4688 remote connect/disconnect lifecycle race: ok');
