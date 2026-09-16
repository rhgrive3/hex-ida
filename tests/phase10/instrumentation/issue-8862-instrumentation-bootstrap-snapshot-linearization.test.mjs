/**
 * #8862 — the instrumentation bootstrap subscribes to backend events before
 * awaiting backend.getModules(), but it previously applied those accepted
 * module lifecycle events to the pre-snapshot binding table immediately and
 * then imported the snapshot blindly:
 *   A) a module-unload accepted while getModules() is pending was a no-op, and
 *      the older snapshot then resurrected the module as an `exact` binding in
 *      a `ready` session (persistent wrong runtime→static authority);
 *   B) a module-load accepted for a binding key also present in the snapshot
 *      made the unconditional snapshot import throw
 *      module-binding-already-loaded, deterministically failing bootstrap.
 * The fix stages the module-table effect of bootstrap-window events (canonical
 * queue admission unchanged) and replays it after the snapshot import.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { InstrumentationProvider } from '../../../js/runtime/instrumentation-provider.js';

const binaryId = 'bin_sha256_' + 'd8'.repeat(32);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class GatedModulesBackend {
  constructor() {
    this.id = 'instrumentation-bootstrap-gate-fixture';
    this.listeners = new Set();
    this.gate = deferred();
  }
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of [...this.listeners]) listener(event); }
  async getModules() { return this.gate.promise; }
}

test('#8862 A: module-unload accepted during bootstrap is not resurrected by the older snapshot', async () => {
  const backend = new GatedModulesBackend();
  const provider = new InstrumentationProvider(backend, { id: 'inst-8862a' });
  const opening = provider.openSession({ binaryId, targetIdentity: 'process:8862a', sessionNonce: 'inst:8862a' });

  backend.emit({ type: 'module-unload', epoch: 1, streamId: 'modules', sequence: 1, payload: { id: 'mod-A' } });
  backend.gate.resolve([
    { id: 'mod-A', base: 0x1000n, size: 0x100n, staticBase: 0x4000n, binaryId, identityState: 'exact' },
  ]);
  const session = await opening;

  assert.equal(session.state, 'ready');
  assert.equal(session.modules.get('mod-A'), null, 'the unload accepted during bootstrap must retire the older snapshot binding');
  assert.equal(session.modules.active().length, 0);
  assert.equal(session.facets.instrumentation.resolveAddress(0x1010n, { binaryId }).state, 'unresolved',
    'the resurrected module range must not resolve as exact');
  const batch = session.facets.instrumentation.events.flush();
  assert.ok(batch.events.some((event) => event.kind === 'module-unload'), 'the unload event still enters the canonical queue immediately');
  await session.close();
});

test('#8862 B: module-load accepted during bootstrap cannot fail the snapshot import', async () => {
  const backend = new GatedModulesBackend();
  const provider = new InstrumentationProvider(backend, { id: 'inst-8862b' });
  const opening = provider.openSession({ binaryId, targetIdentity: 'process:8862b', sessionNonce: 'inst:8862b' });

  backend.emit({
    type: 'module-load',
    epoch: 1,
    streamId: 'modules',
    sequence: 2,
    payload: { id: 'mod-A', base: 0x2000n, size: 0x100n, staticBase: 0x5000n, binaryId, identityState: 'exact' },
  });
  backend.gate.resolve([
    { id: 'mod-A', base: 0x1000n, size: 0x100n, staticBase: 0x4000n, binaryId, identityState: 'exact' },
  ]);
  const session = await opening;

  assert.equal(session.state, 'ready', 'bootstrap must not fail with module-binding-already-loaded');
  assert.equal(session.modules.active().length, 1);
  const binding = session.modules.get('mod-A');
  assert.equal(binding.runtimeBase ?? binding.base, 0x1000n,
    'the snapshot import replays through the same load guard the steady-state event path applies to an active key');
  await session.close();
});

test('#8862 C: after bootstrap completes, module lifecycle events apply directly as before', async () => {
  const backend = new GatedModulesBackend();
  const provider = new InstrumentationProvider(backend, { id: 'inst-8862c' });
  const opening = provider.openSession({ binaryId, targetIdentity: 'process:8862c', sessionNonce: 'inst:8862c' });
  backend.gate.resolve([]);
  const session = await opening;

  backend.emit({
    type: 'module-load',
    epoch: 1,
    streamId: 'modules',
    sequence: 3,
    payload: { id: 'mod-B', base: 0x2000n, size: 0x100n, staticBase: 0x5000n, binaryId, identityState: 'exact' },
  });
  assert.equal(session.facets.instrumentation.resolveAddress(0x2010n, { binaryId }).state, 'exact');
  const [binding] = session.modules.active();
  assert.equal(binding.bindingKey, 'mod-B');
  assert.equal(binding.loadedSequence, 3);

  backend.emit({ type: 'module-unload', epoch: 1, streamId: 'modules', sequence: 4, payload: { id: 'mod-B' } });
  assert.equal(session.modules.active().length, 0);
  assert.equal(session.facets.instrumentation.resolveAddress(0x2010n, { binaryId }).state, 'unresolved');
  await session.close();
});
