// Focused regression for #8686 (exact-head AUTO-review R2 counterexample):
// the prior publication model claimed a per-refresh token that only changed
// when another refresh started, so an already-started refresh still committed
// its stale snapshot after an accepted current-epoch module-unload + module-load
// pair had replaced the same binding with newer exact mapping/evidence — no
// epoch change, no second refresh. The refresh rolled the event-established
// mapping back and resolveAddress() reported the resurrected stale provenance
// as exact. Module publication authority must be monotonic across BOTH refresh
// starts and accepted module lifecycle mutations, so the late refresh is
// rejected and the event-established mapping remains authoritative.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DebuggerProvider } from '../../../js/runtime/debugger-provider.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const binaryId = 'binary-8686-same-epoch';
const OLD = (evidence) => [{
  id: 'main', base: 0x1000n, size: 0x100n, staticBase: 0x4000n,
  binaryId, identityState: 'exact', identityEvidenceIds: [evidence],
}];

function refreshAdapter() {
  const queue = [];
  const listeners = new Set();
  return {
    id: 'refresh-8686-same-epoch',
    kind: 'debugger',
    capabilities: { modules: true },
    connected: false,
    epoch: 0,
    queue,
    listeners,
    setEpoch(value) { this.epoch = value; },
    async connect() { this.connected = true; },
    async disconnect() { this.connected = false; },
    getModules() { return queue.shift(); },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(event) { for (const listener of [...listeners]) listener(event); },
  };
}

async function openSession(adapter, bootstrap) {
  adapter.queue.push(bootstrap);
  const provider = new DebuggerProvider(adapter, { id: `provider:${adapter.id}` });
  const session = await provider.openSession({ binaryId, processKey: 'proc-8686-same-epoch', sessionNonce: `nonce:${adapter.id}` });
  assert.equal(session.state, 'ready');
  return { provider, session, debugger: session.facets.debugger };
}

test('#8686 accepted current-epoch lifecycle events supersede a same-epoch pending refresh', async () => {
  const adapter = refreshAdapter();
  const { session, debugger: facet } = await openSession(adapter, OLD('BOOT'));
  assert.equal(session.epoch, 1, 'this counterexample stays within a single epoch');

  const pendingGate = deferred();
  adapter.queue.push(pendingGate.promise);
  const pending = facet.refreshModules();

  // Same-epoch, no second refresh, no close: an accepted unload + load pair
  // replaces `main` with a strictly newer exact mapping while the refresh is
  // still awaiting getModules().
  adapter.emit({ type: 'module-unload', epoch: 1, streamId: 'debugger', sequence: 1, payload: { bindingKey: 'main' } });
  adapter.emit({
    type: 'module-load', epoch: 1, streamId: 'debugger', sequence: 2,
    payload: { bindingKey: 'main', runtimeBase: 0x5000n, runtimeSize: 0x100n, staticBase: 0x9000n, binaryId, identityState: 'exact', identityEvidenceIds: ['SAME-EPOCH-LIVE'] },
  });

  assert.equal(session.epoch, 1);
  const [afterEvents] = session.modules.active();
  assert.equal(afterEvents.runtimeBase, 0x5000n);
  assert.deepEqual(afterEvents.identityEvidenceIds, ['SAME-EPOCH-LIVE']);
  const genAfterEvents = afterEvents.generation;
  const histAfterEvents = session.modules.history().length;

  // The pending refresh now resolves with its OLD snapshot. Because an accepted
  // current-epoch lifecycle event advanced publication authority after the
  // refresh was captured, the stale commit must be rejected.
  pendingGate.resolve(OLD('SAME-EPOCH-LATE'));
  await assert.rejects(pending, (error) => error?.code === 'runtime-session-stale');

  const [active] = session.modules.active();
  assert.equal(active.runtimeBase, 0x5000n, 'the event-established mapping must survive the late refresh');
  assert.deepEqual(active.identityEvidenceIds, ['SAME-EPOCH-LIVE']);
  assert.equal(active.generation, genAfterEvents, 'a rejected late refresh must not advance generation/history');
  assert.equal(session.modules.history().length, histAfterEvents);

  assert.equal(facet.resolveAddress(0x5010n, { binaryId }).state, 'exact');
  assert.equal(facet.resolveAddress(0x5010n, { binaryId }).staticAddress, 0x9010n, 'exact provenance stays bound to the event-established mapping');
  assert.equal(facet.resolveAddress(0x1010n, { binaryId }).state, 'unresolved', 'the stale OLD refresh range must never be resurrected');
  await session.close();
});
