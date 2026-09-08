/**
 * #6318 — InstrumentationProvider が module-load / module-unload event を
 * session.modules へ反映せず resolveAddress が stale になる。
 *
 * openSession() の bootstrap では backend.getModules() を binding table に
 * 載せるが、その後 backend.onEvent() 経由で届く module lifecycle event は
 * RuntimeEventNormalizer へ渡すだけで table を更新していなかった。結果、
 * unload済み module の address が解決し続け、load後の新 module が
 * 永遠に unresolved になる。DebuggerProvider は同じ canonical event を
 * session.modules.load()/unload() へ反映済みなので、parity を固定する。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { InstrumentationProvider } from '../js/runtime/instrumentation-provider.js';

const binaryId = 'bin_sha256_' + 'c7'.repeat(32);

class EventBackend {
  constructor(initialModules = []) {
    this.id = 'instrumentation-module-events-fixture';
    this.listeners = new Set();
    this.modules = initialModules;
  }
  async connect() {}
  async disconnect() {}
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of [...this.listeners]) listener(event); }
  async getModules() { return this.modules; }
}

test('#6318 bootstrap module keeps resolving and module-unload retires its range', async () => {
  const backend = new EventBackend([
    { id: 'mod-A', base: 0x1000n, size: 0x100n, staticBase: 0x4000n, binaryId, identityState: 'exact' },
  ]);
  const provider = new InstrumentationProvider(backend, { id: 'inst-module-events' });
  const session = await provider.openSession({ binaryId, targetIdentity: 'process:6318a', sessionNonce: 'inst:6318a' });

  const bootstrap = session.facets.instrumentation.resolveAddress(0x1010n, { binaryId });
  assert.equal(bootstrap.state, 'exact', 'bootstrap module must keep resolving');
  assert.equal(bootstrap.staticAddress, 0x4010n);

  backend.emit({ type: 'module-unload', epoch: 1, streamId: 'modules', sequence: 1, payload: { id: 'mod-A' } });

  const afterUnload = session.facets.instrumentation.resolveAddress(0x1010n, { binaryId });
  assert.equal(afterUnload.state, 'unresolved', 'unloaded module range must stop resolving');
  assert.equal(session.modules.active().length, 0);
  assert.equal(session.modules.get('mod-A'), null);

  const batch = session.facets.instrumentation.events.flush();
  assert.ok(batch.events.some((event) => event.kind === 'module-unload'), 'module-unload event stays in the canonical queue');
  await session.close();
});

test('#6318 module-load event makes a new module range resolvable', async () => {
  const backend = new EventBackend([]);
  const provider = new InstrumentationProvider(backend, { id: 'inst-module-load' });
  const session = await provider.openSession({ binaryId, targetIdentity: 'process:6318b', sessionNonce: 'inst:6318b' });
  assert.equal(session.modules.active().length, 0);

  backend.emit({
    type: 'module-load',
    epoch: 1,
    streamId: 'modules',
    sequence: 2,
    payload: { id: 'mod-B', base: 0x2000n, size: 0x100n, staticBase: 0x5000n, binaryId, identityState: 'exact' },
  });

  const resolved = session.facets.instrumentation.resolveAddress(0x2010n, { binaryId });
  assert.equal(resolved.state, 'exact', 'loaded module range must resolve');
  assert.equal(resolved.staticAddress, 0x5010n);
  const [binding] = session.modules.active();
  assert.equal(binding.bindingKey, 'mod-B');
  assert.equal(binding.loadedSequence, 2, 'event sequence must be recorded as loadedSequence');
  await session.close();
});

test('#6318 unload then reload on the same binding key advances the generation', async () => {
  const backend = new EventBackend([
    { id: 'mod-A', base: 0x1000n, size: 0x100n, staticBase: 0x4000n, binaryId, identityState: 'exact' },
  ]);
  const provider = new InstrumentationProvider(backend, { id: 'inst-module-reload' });
  const session = await provider.openSession({ binaryId, targetIdentity: 'process:6318c', sessionNonce: 'inst:6318c' });
  assert.equal(session.modules.get('mod-A').generation, 1);

  backend.emit({ type: 'module-unload', epoch: 1, streamId: 'modules', sequence: 1, payload: { id: 'mod-A' } });
  backend.emit({
    type: 'module-load',
    epoch: 1,
    streamId: 'modules',
    sequence: 2,
    payload: { id: 'mod-A', base: 0x3000n, size: 0x100n, staticBase: 0x6000n, binaryId, identityState: 'exact' },
  });

  assert.equal(session.modules.get('mod-A').generation, 2, 'reload must create a new generation');
  assert.equal(session.facets.instrumentation.resolveAddress(0x1010n, { binaryId }).state, 'unresolved', 'old range stays retired');
  const reloaded = session.facets.instrumentation.resolveAddress(0x3010n, { binaryId });
  assert.equal(reloaded.state, 'exact');
  assert.equal(reloaded.staticAddress, 0x6010n);
  await session.close();
});

test('#6318 stale epoch module events never touch the module table', async () => {
  const backend = new EventBackend([
    { id: 'mod-A', base: 0x1000n, size: 0x100n, staticBase: 0x4000n, binaryId, identityState: 'exact' },
  ]);
  const provider = new InstrumentationProvider(backend, { id: 'inst-module-stale-epoch' });
  const session = await provider.openSession({ binaryId, targetIdentity: 'process:6318d', sessionNonce: 'inst:6318d' });
  session.newProviderEpoch();

  backend.emit({ type: 'module-unload', epoch: 1, streamId: 'modules', sequence: 1, payload: { id: 'mod-A' } });
  backend.emit({
    type: 'module-load',
    epoch: 1,
    streamId: 'modules',
    sequence: 2,
    payload: { id: 'mod-stale', base: 0x9000n, size: 0x100n, staticBase: 0x9000n, binaryId, identityState: 'exact' },
  });

  assert.equal(session.modules.get('mod-stale'), null, 'stale-epoch module-load must not create a binding');
  assert.equal(session.modules.get('mod-A').generation, 1, 'stale-epoch module-unload must not retire the binding');
  assert.equal(session.facets.instrumentation.resolveAddress(0x1010n, { binaryId }).state, 'exact');
  assert.equal(session.facets.instrumentation.events.flush().events.length, 0, 'rejected events stay out of the canonical queue');
  await session.close();
});

test('#6318 malformed module events do not create partial bindings', async () => {
  const backend = new EventBackend([]);
  const provider = new InstrumentationProvider(backend, { id: 'inst-module-malformed' });
  const session = await provider.openSession({ binaryId, targetIdentity: 'process:6318e', sessionNonce: 'inst:6318e' });

  backend.emit({
    type: 'module-load',
    epoch: 1,
    streamId: 'modules',
    sequence: 1,
    payload: { id: 'mod-no-range', staticBase: 0x7000n, binaryId, identityState: 'exact' },
  });
  backend.emit({ type: 'module-load', epoch: 1, streamId: 'modules', sequence: 2, payload: { size: 0x100n } });

  assert.equal(session.modules.active().length, 0, 'module-load without a usable range must not create a binding');
  await session.close();
});

test('#6318 module-load events without a binding key are ignored for the table', async () => {
  const backend = new EventBackend([]);
  const provider = new InstrumentationProvider(backend, { id: 'inst-module-keyless' });
  const session = await provider.openSession({ binaryId, targetIdentity: 'process:6318f', sessionNonce: 'inst:6318f' });

  backend.emit({
    type: 'module-load',
    epoch: 1,
    streamId: 'modules',
    sequence: 1,
    payload: { base: 0x2000n, size: 0x100n, staticBase: 0x5000n, binaryId, identityState: 'exact' },
  });

  assert.equal(session.modules.active().length, 0, 'no binding key means no binding table entry');
  await session.close();
});

test('#6318 probe intervention attribution on ingested events keeps working', async () => {
  class ProbeBackend extends EventBackend {
    constructor(initialModules) {
      super(initialModules);
      this.next = 1;
      this.probes = new Map();
    }
    async installProbe(spec) { const handle = `probe:${this.next++}`; this.probes.set(handle, spec); return { handle }; }
  }
  const backend = new ProbeBackend([
    { id: 'mod-A', base: 0x1000n, size: 0x100n, staticBase: 0x4000n, binaryId, identityState: 'exact' },
  ]);
  const provider = new InstrumentationProvider(backend, { id: 'inst-probe-events' });
  const session = await provider.openSession({ binaryId, targetIdentity: 'process:6318g', sessionNonce: 'inst:6318g' });
  const probe = await session.facets.instrumentation.installProbe({ address: 0x1010n, kind: 'call' });
  backend.emit({ type: 'instrumentation-observation', epoch: 1, streamId: 'thread:1', sequence: 1, payload: { probeHandle: probe.result.handle, call: 'foo' } });
  const batch = session.facets.instrumentation.events.flush();
  assert.deepEqual(batch.events[0].interventionIds, [probe.intervention.interventionId], 'existing probe intervention ingest path is unchanged');
  await session.close();
});

test('#6318 module lifecycle parity with DebuggerProvider semantics', async () => {
  const { DebuggerProvider } = await import('../js/runtime/debugger-provider.js');

  class DebuggerEventAdapter {
    constructor(initialModules = []) {
      this.id = 'debugger-module-events-fixture';
      this.kind = 'debugger';
      this.capabilities = {};
      this.listeners = new Set();
      this.modules = initialModules;
    }
    async connect() {}
    async disconnect() {}
    onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    emit(event) { for (const listener of [...this.listeners]) listener(event); }
    async getModules() { return this.modules; }
  }

  const moduleEvent = (sequence, payload) => ({ type: 'module-load', epoch: 1, streamId: 'modules', sequence, payload });
  const unloadEvent = (sequence, payload) => ({ type: 'module-unload', epoch: 1, streamId: 'modules', sequence, payload });
  const loadPayload = { id: 'mod-P', base: 0x2000n, size: 0x100n, staticBase: 0x5000n, binaryId, identityState: 'exact' };

  const adapter = new DebuggerEventAdapter();
  const debugSession = await new DebuggerProvider(adapter, { id: 'debug-module-parity' })
    .openSession({ binaryId, targetIdentity: 'process:6318h', sessionNonce: 'debug:6318h' });
  adapter.emit(moduleEvent(1, loadPayload));
  adapter.emit(unloadEvent(2, { id: 'mod-P' }));
  const debugActive = debugSession.modules.active();
  await debugSession.close();

  const backend = new EventBackend([]);
  const instSession = await new InstrumentationProvider(backend, { id: 'inst-module-parity' })
    .openSession({ binaryId, targetIdentity: 'process:6318i', sessionNonce: 'inst:6318i' });
  backend.emit(moduleEvent(1, loadPayload));
  backend.emit(unloadEvent(2, { id: 'mod-P' }));
  const instActive = instSession.modules.active();
  await instSession.close();

  assert.deepEqual(
    instActive.map((binding) => [binding.bindingKey, binding.generation, binding.unloadedSequence]),
    debugActive.map((binding) => [binding.bindingKey, binding.generation, binding.unloadedSequence]),
    'both providers must land in the same binding table state for identical module events',
  );
});
