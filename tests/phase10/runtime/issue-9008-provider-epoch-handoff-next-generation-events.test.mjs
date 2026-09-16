/**
 * #9008 — provider epoch handoff must not silently drop explicit
 * next-generation events. DebuggerProvider, InstrumentationProvider, and the
 * legacy DebugSession all invoked the external adapter/backend `setEpoch(next)`
 * before committing local epoch authority, so lifecycle events the producer
 * emitted DURING that (fully supported, including asynchronous) transition were
 * rejected against the still-old epoch and vanished while the transition itself
 * succeeded — leaving stale module authority published as `exact`.
 *
 * The fix buffers explicitly-tagged epoch-`next` events for the width of the
 * handoff window and replays them atomically on commit. A failed transition
 * still leaves the committed epoch unchanged (failure-atomic) and discards the
 * buffer; an overflowing buffer fails the transition closed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DebuggerProvider } from '../../../js/runtime/debugger-provider.js';
import { InstrumentationProvider } from '../../../js/runtime/instrumentation-provider.js';
import { DebugSession } from '../../../js/runtime/session.js';
import { DebugAdapter } from '../../../js/debug/adapter.js';

const binaryId = 'bin_sha256_' + 'e9'.repeat(32);

function moduleLoad(sequence, bindingKey, runtimeBase, staticBase, evidence) {
  return {
    type: 'module-load',
    epoch: 2,
    streamId: 'modules',
    sequence,
    payload: {
      bindingKey,
      runtimeBase,
      runtimeSize: 0x100n,
      staticBase,
      binaryId,
      identityState: 'exact',
      identityEvidenceIds: [evidence],
    },
  };
}

/* ------------------------------------------------------------------ */
/* A — DebuggerProvider                                                */
/* ------------------------------------------------------------------ */

test('#9008 A: DebuggerProvider commits epoch-2 lifecycle emitted inside adapter.setEpoch', async () => {
  let emitDuringTransition = null;
  const adapter = {
    id: 'debugger-9008',
    kind: 'lldb',
    capabilities: { modules: true, threads: true },
    listeners: new Set(),
    onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); },
    emit(event) { for (const listener of [...this.listeners]) listener(event); },
    async connect() { return { adapter: this.id, capabilities: this.capabilities }; },
    async getModules() { return []; },
    async getThreads() { return [{ id: 't1' }]; },
    setEpoch() { if (emitDuringTransition) emitDuringTransition(); },
    emit(event) { for (const listener of [...this.listeners]) listener(event); },
    async disconnect() {},
  };
  const provider = new DebuggerProvider(adapter, { id: 'dbg-9008' });
  const session = await provider.openSession({ binaryId, targetIdentity: 'process:9008a', sessionNonce: 'dbg:9008a' });

  adapter.emit({
    type: 'module-load', epoch: 1, streamId: 'modules', sequence: 1,
    payload: {
      bindingKey: 'mod-A', runtimeBase: 0x1000n, runtimeSize: 0x100n, staticBase: 0x4000n,
      binaryId, identityState: 'exact', identityEvidenceIds: ['fixture:9008-a'],
    },
  });
  assert.equal(session.facets.debugger.resolveAddress(0x1010n, { binaryId }).state, 'exact');
  session.facets.debugger.events.flush();

  emitDuringTransition = () => {
    adapter.emit({ type: 'module-unload', epoch: 2, streamId: 'modules', sequence: 10, payload: { bindingKey: 'mod-A' } });
    adapter.emit(moduleLoad(11, 'mod-B', 0x2000n, 0x5000n, 'fixture:9008-b'));
  };
  assert.equal(session.newProviderEpoch('9008-handoff'), 2);
  emitDuringTransition = null;

  assert.equal(session.epoch, 2);
  assert.equal(session.modules.get('mod-A'), null, 'the next-epoch unload must retire module A');
  assert.ok(session.modules.get('mod-B'), 'the next-epoch load must bind module B');
  assert.equal(session.facets.debugger.resolveAddress(0x1010n, { binaryId }).state, 'unresolved',
    'A must stop resolving as exact after the handoff');
  const resolved = session.facets.debugger.resolveAddress(0x2010n, { binaryId });
  assert.equal(resolved.state, 'exact');
  assert.equal(resolved.staticAddress, 0x5010n);

  const batch = session.facets.debugger.events.flush();
  assert.equal(batch.sessionEpoch, 2);
  assert.deepEqual(
    batch.events.map((event) => event.kind),
    ['module-unload', 'module-load'],
    'handoff events must be first in the next epoch canonical queue',
  );
  assert.equal(batch.dropped, 0);
  await session.close();
});

/* ------------------------------------------------------------------ */
/* B — InstrumentationProvider (synchronous and asynchronous)          */
/* ------------------------------------------------------------------ */

class GatedEpochBackend {
  constructor() {
    this.id = 'instrumentation-9008';
    this.listeners = new Set();
    this.asyncEpoch = false;
  }
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of [...this.listeners]) listener(event); }
  async getModules() {
    return [{
      bindingKey: 'mod-A', runtimeBase: 0x1000n, runtimeSize: 0x100n, staticBase: 0x4000n,
      binaryId, identityState: 'exact', identityEvidenceIds: ['fixture:9008-boot-a'],
    }];
  }
}

async function openInstrumentation(asyncEpoch) {
  const backend = new GatedEpochBackend();
  const provider = new InstrumentationProvider(backend, { id: 'inst-9008' });
  const session = await provider.openSession({ binaryId, targetIdentity: 'process:9008b', sessionNonce: 'inst:9008b' });
  assert.equal(session.facets.instrumentation.resolveAddress(0x1010n, { binaryId }).state, 'exact');
  session.facets.instrumentation.events.flush();
  const emitHandoff = () => {
    backend.emit({ type: 'module-unload', epoch: 2, streamId: 'modules', sequence: 10, payload: { bindingKey: 'mod-A' } });
    backend.emit(moduleLoad(11, 'mod-B', 0x2000n, 0x5000n, 'fixture:9008-b'));
  };
  let settleEpoch = null;
  if (asyncEpoch) {
    backend.setEpoch = () => new Promise((resolve) => { settleEpoch = resolve; });
  } else {
    backend.setEpoch = () => { emitHandoff(); };
  }
  return { backend, session, emitHandoff, settleEpoch: () => settleEpoch() };
}

test('#9008 B1: synchronous InstrumentationProvider handoff commits transition events', async () => {
  const { session } = await openInstrumentation(false);
  assert.equal(session.newProviderEpoch('sync-handoff'), 2);
  assert.equal(session.modules.get('mod-A'), null);
  assert.ok(session.modules.get('mod-B'));
  assert.equal(session.facets.instrumentation.resolveAddress(0x1010n, { binaryId }).state, 'unresolved');
  assert.equal(session.facets.instrumentation.resolveAddress(0x2010n, { binaryId }).state, 'exact');
  const batch = session.facets.instrumentation.events.flush();
  assert.equal(batch.sessionEpoch, 2);
  assert.deepEqual(batch.events.map((event) => event.kind), ['module-unload', 'module-load']);
  assert.equal(batch.dropped, 0);
  await session.close();
});

test('#9008 B2: asynchronous InstrumentationProvider handoff buffers events across the pending window', async () => {
  const { session, emitHandoff, settleEpoch } = await openInstrumentation(true);
  const pending = session.newProviderEpoch('async-handoff');
  // The vulnerable interval is the entire asynchronous transition: emit after
  // setEpoch returned its pending promise but before the epoch commits.
  emitHandoff();
  assert.equal(session.epoch, 1, 'commit still only happens after backend success');
  settleEpoch();
  assert.equal(await pending, 2);
  assert.equal(session.modules.get('mod-A'), null, 'the next-epoch unload must not be lost across the async window');
  assert.ok(session.modules.get('mod-B'));
  assert.equal(session.facets.instrumentation.resolveAddress(0x1010n, { binaryId }).state, 'unresolved');
  const batch = session.facets.instrumentation.events.flush();
  assert.equal(batch.sessionEpoch, 2);
  assert.deepEqual(batch.events.map((event) => event.kind), ['module-unload', 'module-load']);
  await session.close();
});

test('#9008 B3: a rejected asynchronous transition stays failure-atomic and discards the buffer', async () => {
  const backend = new GatedEpochBackend();
  const provider = new InstrumentationProvider(backend, { id: 'inst-9008-fail' });
  const session = await provider.openSession({ binaryId, targetIdentity: 'process:9008c', sessionNonce: 'inst:9008c' });
  backend.setEpoch = () => {
    backend.emit({ type: 'module-unload', epoch: 2, streamId: 'modules', sequence: 10, payload: { bindingKey: 'mod-A' } });
    return Promise.reject(new Error('epoch update failed'));
  };
  await assert.rejects(session.newProviderEpoch('failed-handoff'), /epoch update failed/);
  assert.equal(session.epoch, 1);
  assert.ok(session.modules.get('mod-A'), 'a failed transition must not apply next-generation lifecycle authority');
  assert.equal(session.facets.instrumentation.resolveAddress(0x1010n, { binaryId }).state, 'exact');
  const probe = session.facets.instrumentation.events.ingest({ kind: 'trace-marker' });
  assert.equal(probe.sessionEpoch, 1);
  await session.close();
});

/* ------------------------------------------------------------------ */
/* C — legacy DebugSession                                             */
/* ------------------------------------------------------------------ */

test('#9008 C: legacy DebugSession keeps next-epoch trace events emitted during setEpoch', () => {
  let emitDuringTransition = null;
  const adapter = {
    id: 'session-9008',
    kind: 'fixture',
    capabilities: { modules: false, threads: false },
    epochs: [],
    setEpoch(epoch) {
      adapter.epochs.push(epoch);
      if (emitDuringTransition) emitDuringTransition();
    },
    async connect() { return { adapter: adapter.id, capabilities: adapter.capabilities }; },
    onEvent(callback) { adapter.listener = callback; return () => { adapter.listener = null; }; },
    emit(event) { return adapter.listener?.(event); },
    async disconnect() {},
  };
  const session = new DebugSession(adapter, { id: 'epoch-handoff' });

  assert.equal(session.acceptEvent({ type: 'branch', epoch: 1, pc: '0x1000' }), true);
  emitDuringTransition = () => {
    assert.equal(session.acceptEvent({ type: 'branch', epoch: 2, pc: '0x2000' }), false,
      'the transition callback still reports the pre-commit mismatch');
    assert.equal(session.acceptEvent({ type: 'branch', epoch: 3, pc: '0x2100' }), false);
  };
  assert.equal(session.newEpoch(), 2);
  emitDuringTransition = null;

  const pcs = session.traces.snapshot().events.map((event) => event.pc);
  assert.deepEqual(pcs, ['0x2000'], 'the explicit next-epoch event must survive the handoff into the committed epoch');
  assert.ok(!pcs.includes('0x2100'), 'events for non-adjacent generations are never admitted');
  assert.equal(session.acceptEvent({ type: 'branch', epoch: 1, pc: '0x2200' }), false);
  assert.equal(session.acceptEvent({ type: 'branch', epoch: 2, pc: '0x3000' }), true);
});
