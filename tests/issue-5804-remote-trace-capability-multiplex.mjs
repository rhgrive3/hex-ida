import assert from 'node:assert/strict';
import { RemoteDebugAdapter } from '../js/adapters/index.js';
import { DEBUG_PROTOCOL_VERSION } from '../js/debug/adapter.js';
import { encodeWireValue } from '../js/debug/remote-protocol.js';

// #5804: individual trace capabilities (traceCall, traceReturn, traceBranch,
// traceMemoryWrite, traceMemoryRead) are negotiated independently of
// traceFunction. RemoteDebugAdapter multiplexes them onto the generic `trace`
// wire method, so send-time authorization must follow params.capability and
// must not re-require traceFunction.

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
    onMessage(fn) { listener = fn; return () => { if (listener === fn) listener = null; }; },
    async send(wire) {
      sent.push(wire);
      if (wire.type === 'request') {
        byId.set(wire.id, wire);
        if (policies.has(wire.method)) queueMicrotask(() => deliver(wire.id, policies.get(wire.method)));
      }
    },
    auto(method, result) { policies.set(method, result); },
    close() {},
  };
}

function traceRequests(transport) {
  return transport.sent.filter((p) => p.type === 'request' && p.method === 'trace');
}

async function connectAdapter(capabilities) {
  const transport = makeTransport();
  transport.auto('connect', { capabilities });
  transport.auto('trace', { events: [] });
  const adapter = new RemoteDebugAdapter(transport, { capabilities: { ...capabilities } });
  await adapter.connect();
  return { transport, adapter };
}

// 1. traceCall:true / traceFunction:false: traceCall() must send the wire trace request.
{
  const { transport, adapter } = await connectAdapter({ traceCall: true });
  assert.equal(adapter.capabilities.traceCall, true);
  assert.equal(adapter.capabilities.traceFunction, false);
  const outcome = await settle(adapter.traceCall({ limit: 10 }));
  assert.equal(outcome.status, 'fulfilled', `traceCall must run with its own capability, got ${outcome.reason?.code}`);
  const request = traceRequests(transport)[0];
  assert.ok(request, 'a trace request must reach the wire');
  assert.equal(request.params.capability, 'traceCall');
  assert.deepEqual(outcome.value, { events: [] });
}

// 2. Same adapter shape: a generic trace() still requires traceFunction and never hits the wire.
{
  const { transport, adapter } = await connectAdapter({ traceCall: true });
  const before = traceRequests(transport).length;
  const outcome = await settle(adapter.trace({ limit: 5 }));
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.reason?.code, 'unsupported');
  assert.equal(traceRequests(transport).length, before, 'a rejected trace() must not send a wire request');
}

// 3. Each individual trace capability works without traceFunction.
for (const capability of ['traceReturn', 'traceBranch', 'traceMemoryWrite', 'traceMemoryRead']) {
  const { transport, adapter } = await connectAdapter({ [capability]: true });
  const method = capability;
  const outcome = await settle(adapter[method]({ limit: 1 }));
  assert.equal(outcome.status, 'fulfilled', `${capability} must be executable with its own capability, got ${outcome.reason?.code}`);
  const request = traceRequests(transport)[0];
  assert.ok(request, `${capability} must send a trace request`);
  assert.equal(request.params.capability, capability);
}

// 4. A false capability rejects before any wire traffic.
{
  const { transport, adapter } = await connectAdapter({ traceCall: true });
  const before = traceRequests(transport).length;
  const outcome = await settle(adapter.traceBranch({ limit: 1 }));
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.reason?.code, 'unsupported');
  assert.equal(traceRequests(transport).length, before);
}

// 4b. Locally allowed but not advertised by the peer: negotiation keeps it false and runtime rejects.
{
  const transport = makeTransport();
  transport.auto('connect', { capabilities: { traceCall: false } });
  const adapter = new RemoteDebugAdapter(transport, { capabilities: { traceCall: true, traceFunction: false } });
  await adapter.connect();
  assert.equal(adapter.capabilities.traceCall, false);
  const outcome = await settle(adapter.traceCall({ limit: 1 }));
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.reason?.code, 'unsupported');
  assert.equal(traceRequests(transport).length, 0);
}

// 5. traceFunction:true keeps the existing generic path working (no regression for LLDB/Frida).
{
  const { transport, adapter } = await connectAdapter({ traceFunction: true, traceCall: true });
  const outcome = await settle(adapter.trace({ limit: 3 }));
  assert.equal(outcome.status, 'fulfilled', `traceFunction path must stay green, got ${outcome.reason?.code}`);
  assert.equal(traceRequests(transport)[0].params.limit, 3);
  const multiplexed = await settle(adapter.traceCall({ limit: 4 }));
  assert.equal(multiplexed.status, 'fulfilled');
  assert.equal(traceRequests(transport)[1].params.capability, 'traceCall');
}

// 5b. An unknown/foreign capability marker must not mint authority: it falls back to traceFunction.
{
  const { transport, adapter } = await connectAdapter({ traceCall: true });
  const before = traceRequests(transport).length;
  const outcome = await settle(adapter.trace({ capability: 'readMemory', limit: 1 }));
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.reason?.code, 'unsupported');
  assert.equal(traceRequests(transport).length, before);
}

// 6. The remote method allow-list is preserved.
{
  const { transport, adapter } = await connectAdapter({ traceFunction: true, traceCall: true });
  const outcome = await settle(Promise.resolve().then(() => adapter.call('replay', {})));
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.reason?.code, 'unsupported-method');
  assert.ok(!transport.sent.some((p) => p.type === 'request' && p.method === 'replay'));
}

console.log('issue-5804 remote trace capability multiplex regression: PASS');
