// Regression for #5696 (remote slice): the session-owned AbortSignal must
// survive the RemoteDebugAdapter call boundary. writeRegister/writeMemory are
// canonical mutation seams: they must accept trailing request options and
// forward the signal into the protocol request, so a session epoch switch or
// close cancels the transport-visible in-flight remote mutation instead of
// letting it run to completion behind the provider's completion-time check.
import assert from 'node:assert/strict';
import { RemoteDebugAdapter } from '../../../js/adapters/index.js';
import { DebuggerProvider } from '../../../js/runtime/debugger-provider.js';
import { DEBUG_PROTOCOL_VERSION } from '../../../js/debug/adapter.js';
import { encodeWireValue } from '../../../js/debug/remote-protocol.js';

class DeferredRemoteTransport {
  constructor() { this.listener = null; this.sent = []; this.held = new Set(); }
  onMessage(fn) { this.listener = fn; return () => { if (this.listener === fn) this.listener = null; }; }
  hold(method) { this.held.add(method); }
  async send(packet) {
    this.sent.push(packet);
    if (packet.type !== 'request' || this.held.has(packet.method)) return;
    let result = {};
    if (packet.method === 'connect') result = { capabilities: { writeRegister: true, writeMemory: true } };
    else if (packet.method === 'disconnect') result = { disconnected: true };
    else if (packet.method === 'writeRegister') result = { ok: true };
    else if (packet.method === 'writeMemory') result = { written: 1 };
    else return;
    this.deliver({ version: DEBUG_PROTOCOL_VERSION, type: 'response', id: packet.id, epoch: packet.epoch, result });
  }
  deliver(packet) { this.listener?.(encodeWireValue(packet)); }
  close() {}
}

const ABORT_REASON = 'runtime-session-epoch-changed';

// A: direct call boundary — writeRegister honors the canonical trailing
// options and an abort cancels the in-flight request on the wire.
{
  const transport = new DeferredRemoteTransport();
  transport.hold('writeRegister');
  const adapter = new RemoteDebugAdapter(transport, {
    capabilities: { writeRegister: true, writeMemory: true },
    protocol: { timeoutMs: 100 },
  });
  await adapter.connect();

  const ac = new AbortController();
  const pending = adapter.writeRegister('x0', 1n, 1, { signal: ac.signal });
  const request = transport.sent.find((p) => p.type === 'request' && p.method === 'writeRegister');
  assert.ok(request, 'writeRegister must reach the transport as a protocol request');

  ac.abort(ABORT_REASON);
  const cancel = transport.sent.find((p) => p.type === 'cancel' && p.id === request.id);
  assert.ok(cancel, 'aborting the call-boundary signal must emit a transport-visible cancel packet');
  assert.equal(cancel.reason, ABORT_REASON, 'the cancel packet must carry the abort reason');
  assert.equal(cancel.requestEpoch, request.epoch, 'the cancel packet must identify the request epoch');

  const outcome = await pending.then(() => null, (error) => error);
  assert.ok(outcome, 'aborted remote writeRegister must reject');
  assert.equal(outcome.code, 'cancelled', `expected cancellation, got ${outcome?.code}`);
}

// B: same contract for writeMemory.
{
  const transport = new DeferredRemoteTransport();
  transport.hold('writeMemory');
  const adapter = new RemoteDebugAdapter(transport, {
    capabilities: { writeRegister: true, writeMemory: true },
    protocol: { timeoutMs: 100 },
  });
  await adapter.connect();

  const ac = new AbortController();
  const pending = adapter.writeMemory(0x1000n, new Uint8Array([1, 2]), { signal: ac.signal });
  const request = transport.sent.find((p) => p.type === 'request' && p.method === 'writeMemory');
  assert.ok(request, 'writeMemory must reach the transport as a protocol request');

  ac.abort(ABORT_REASON);
  const cancel = transport.sent.find((p) => p.type === 'cancel' && p.id === request.id);
  assert.ok(cancel, 'aborting the call-boundary signal must emit a transport-visible cancel packet');
  assert.equal(cancel.reason, ABORT_REASON, 'the cancel packet must carry the abort reason');

  const outcome = await pending.then(() => null, (error) => error);
  assert.ok(outcome, 'aborted remote writeMemory must reject');
  assert.equal(outcome.code, 'cancelled', `expected cancellation, got ${outcome?.code}`);
}

// C: without an abort, the canonical options must not disturb the happy path.
{
  const transport = new DeferredRemoteTransport();
  const adapter = new RemoteDebugAdapter(transport, { capabilities: { writeRegister: true, writeMemory: true } });
  await adapter.connect();
  assert.deepEqual(await adapter.writeRegister('x1', 2n, 1), { ok: true });
  assert.deepEqual(await adapter.writeMemory(0x1000n, new Uint8Array([9])), { written: 1 });
}

// D: provider-level session authority — a real RemoteDebugAdapter wrapped in
// DebuggerProvider. An epoch switch must cancel the in-flight remote mutation
// on the transport, reject the operation, and keep the late (signal-ignoring
// peer) response out of the intervention ledger.
{
  const transport = new DeferredRemoteTransport();
  transport.hold('writeRegister');
  const adapter = new RemoteDebugAdapter(transport, {
    capabilities: { writeRegister: true, writeMemory: true },
    protocol: { timeoutMs: 100 },
  });
  const provider = new DebuggerProvider(adapter);
  const session = await provider.openSession({ binaryId: 'binary:issue-5696-remote', sessionNonce: 'issue-5696-remote-signal' });
  const dbg = session.facets.debugger;

  const pending = dbg.writeRegister('x0', 7n, { threadId: 1 });
  const request = transport.sent.find((p) => p.type === 'request' && p.method === 'writeRegister');
  assert.ok(request, 'provider mutation must reach the remote transport');

  session.newProviderEpoch();

  const cancel = transport.sent.find((p) => p.type === 'cancel' && p.id === request.id);
  assert.ok(cancel, 'session epoch switch must cancel the in-flight remote mutation on the transport');

  // Signal-ignoring remote peer answers late; the dropped pending must not
  // resurrect the mutation into the ledger.
  transport.deliver({
    version: DEBUG_PROTOCOL_VERSION,
    type: 'response',
    id: request.id,
    epoch: request.epoch,
    result: { ok: true },
  });

  const outcome = await pending.then(() => null, (error) => error);
  assert.ok(outcome, 'stale remote mutation must reject');
  assert.ok(
    ['stale-request', 'cancelled', 'runtime-session-stale'].includes(outcome.code),
    `unexpected stale outcome code: ${outcome?.code}`,
  );
  assert.equal(dbg.interventions.all().length, 0, 'stale remote result must not reach the ledger');

  await session.close();
}

console.log('issue #5696 remote debug adapter signal propagation regression: PASS');
