import assert from 'node:assert/strict';
import test from 'node:test';

import { InstrumentationProvider } from '../js/runtime/instrumentation-provider.js';
import { DebuggerProvider } from '../js/runtime/debugger-provider.js';

const binaryId = 'bin_sha256_' + 'cd'.repeat(32);

class MockBackend {
  constructor() {
    this.id = 'mock-instrumentation';
    this.listeners = new Set();
    this.probes = new Map();
    this.nextProbe = 1;
    this.connected = false;
  }
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event) {
    for (const listener of [...this.listeners]) listener(event);
  }
  async getModules() {
    return [
      {
        id: 'bootstrap-mod',
        base: 0x1000n,
        size: 0x1000n,
        staticBase: 0x1000n,
        binaryId,
        identityState: 'exact',
        identityEvidenceIds: ['evidence:bootstrap'],
      },
    ];
  }
  async installProbe(spec) {
    const handle = `probe:${this.nextProbe++}`;
    this.probes.set(handle, spec);
    return { handle };
  }
}

class MockDebuggerAdapter {
  constructor() {
    this.id = 'mock-debugger';
    this.kind = 'debugger';
    this.capabilities = { modules: true };
    this.listeners = new Set();
    this.connected = false;
  }
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event) {
    for (const listener of [...this.listeners]) listener(event);
  }
  async getModules() {
    return [
      {
        id: 'bootstrap-mod',
        base: 0x1000n,
        size: 0x1000n,
        staticBase: 0x1000n,
        binaryId,
        identityState: 'exact',
        identityEvidenceIds: ['evidence:bootstrap'],
      },
    ];
  }
}

test('1. bootstrap module is resolvable', async () => {
  const backend = new MockBackend();
  const provider = new InstrumentationProvider(backend);
  const session = await provider.openSession({ binaryId });
  const res = session.facets.instrumentation.resolveAddress(0x1050n, { binaryId });
  assert.equal(res.state, 'exact');
  assert.equal(res.moduleBindingKey, 'bootstrap-mod');
  await session.close();
});

test('2. module-unload event unloads the module and makes its address range unresolvable', async () => {
  const backend = new MockBackend();
  const provider = new InstrumentationProvider(backend);
  const session = await provider.openSession({ binaryId });

  assert.equal(session.facets.instrumentation.resolveAddress(0x1050n, { binaryId }).state, 'exact');

  backend.emit({
    type: 'module-unload',
    epoch: 1,
    streamId: 'instrument',
    sequence: 2,
    payload: { bindingKey: 'bootstrap-mod' },
  });

  const res = session.facets.instrumentation.resolveAddress(0x1050n, { binaryId });
  assert.equal(res.state, 'unresolved');
  assert.equal(session.modules.get('bootstrap-mod'), null);
  await session.close();
});

test('3. module-load event loads new module and resolves its address range', async () => {
  const backend = new MockBackend();
  const provider = new InstrumentationProvider(backend);
  const session = await provider.openSession({ binaryId });

  // Initially unresolvable
  assert.equal(session.facets.instrumentation.resolveAddress(0x5050n, { binaryId }).state, 'unresolved');

  backend.emit({
    type: 'module-load',
    epoch: 1,
    streamId: 'instrument',
    sequence: 3,
    payload: {
      bindingKey: 'dynamic-lib',
      runtimeBase: 0x5000n,
      runtimeSize: 0x2000n,
      staticBase: 0x5000n,
      binaryId,
      identityState: 'exact',
      identityEvidenceIds: ['evidence:dynamic'],
    },
  });

  const res = session.facets.instrumentation.resolveAddress(0x5050n, { binaryId });
  assert.equal(res.state, 'exact');
  assert.equal(res.moduleBindingKey, 'dynamic-lib');
  const mod = session.modules.get('dynamic-lib');
  assert.equal(mod.loadedSequence, 3);
  await session.close();
});

test('4. reload with same binding key after unload updates generation and address range', async () => {
  const backend = new MockBackend();
  const provider = new InstrumentationProvider(backend);
  const session = await provider.openSession({ binaryId });

  const initial = session.modules.get('bootstrap-mod');
  assert.equal(initial.generation, 1);
  assert.equal(initial.runtimeBase, 0x1000n);

  backend.emit({
    type: 'module-unload',
    epoch: 1,
    streamId: 'instrument',
    sequence: 2,
    payload: { bindingKey: 'bootstrap-mod' },
  });
  assert.equal(session.modules.get('bootstrap-mod'), null);

  backend.emit({
    type: 'module-load',
    epoch: 1,
    streamId: 'instrument',
    sequence: 3,
    payload: {
      bindingKey: 'bootstrap-mod',
      runtimeBase: 0x9000n,
      runtimeSize: 0x1000n,
      staticBase: 0x1000n,
      binaryId,
      identityState: 'exact',
      identityEvidenceIds: ['evidence:reload'],
    },
  });

  const reloaded = session.modules.get('bootstrap-mod');
  assert.ok(reloaded);
  assert.equal(reloaded.generation, 2);
  assert.equal(reloaded.runtimeBase, 0x9000n);
  assert.equal(session.facets.instrumentation.resolveAddress(0x1050n, { binaryId }).state, 'unresolved');
  assert.equal(session.facets.instrumentation.resolveAddress(0x9050n, { binaryId }).state, 'exact');
  await session.close();
});

test('5. stale epoch module event does not affect session modules', async () => {
  const backend = new MockBackend();
  const provider = new InstrumentationProvider(backend);
  const session = await provider.openSession({ binaryId });

  session.newProviderEpoch('bump-epoch');
  assert.equal(session.epoch, 2);

  // Emit event with old epoch 1
  backend.emit({
    type: 'module-load',
    epoch: 1,
    streamId: 'instrument',
    sequence: 5,
    payload: {
      bindingKey: 'stale-mod',
      runtimeBase: 0x8000n,
      runtimeSize: 0x1000n,
      staticBase: 0x8000n,
    },
  });

  assert.equal(session.modules.get('stale-mod'), null);
  assert.equal(session.facets.instrumentation.resolveAddress(0x8050n).state, 'unresolved');
  await session.close();
});

test('6. malformed module event does not create partial binding', async () => {
  const backend = new MockBackend();
  const provider = new InstrumentationProvider(backend);
  const session = await provider.openSession({ binaryId });

  // Missing runtimeSize / base
  backend.emit({
    type: 'module-load',
    epoch: 1,
    streamId: 'instrument',
    sequence: 6,
    payload: {
      bindingKey: 'malformed-mod',
      // no runtimeBase or runtimeSize
    },
  });

  assert.equal(session.modules.get('malformed-mod'), null);
  await session.close();
});

test('7. probe intervention ID attribution is preserved during event ingest', async () => {
  const backend = new MockBackend();
  const provider = new InstrumentationProvider(backend);
  const session = await provider.openSession({ binaryId });

  const probe = await session.facets.instrumentation.installProbe({ address: 0x1010n, kind: 'call' });
  backend.emit({
    type: 'instrumentation-observation',
    epoch: 1,
    streamId: 'thread:1',
    sequence: 1,
    payload: { probeHandle: probe.result.handle, observation: 'hit' },
  });

  const batch = session.facets.instrumentation.events.flush();
  assert.equal(batch.events.length, 1);
  assert.deepEqual(batch.events[0].interventionIds, [probe.intervention.interventionId]);
  await session.close();
});

test('8. module lifecycle parity between InstrumentationProvider and DebuggerProvider', async () => {
  const instBackend = new MockBackend();
  const instProvider = new InstrumentationProvider(instBackend);
  const instSession = await instProvider.openSession({ binaryId });

  const dbgAdapter = new MockDebuggerAdapter();
  const dbgProvider = new DebuggerProvider(dbgAdapter);
  const dbgSession = await dbgProvider.openSession({ binaryId });

  // Both should start with bootstrap-mod
  assert.equal(instSession.modules.active().length, 1);
  assert.equal(dbgSession.modules.active().length, 1);
  assert.equal(instSession.modules.get('bootstrap-mod').runtimeBase, dbgSession.modules.get('bootstrap-mod').runtimeBase);

  // Module load via payload.module
  const eventData = {
    type: 'module-load',
    epoch: 1,
    streamId: 'test',
    sequence: 10,
    payload: {
      module: {
        id: 'shared-mod',
        base: 0x4000n,
        size: 0x1000n,
        staticBase: 0x2000n,
        binaryId,
        identityState: 'exact',
        identityEvidenceIds: ['evidence:shared'],
      },
    },
  };

  instBackend.emit(eventData);
  dbgAdapter.emit(eventData);

  const instBinding = instSession.modules.get('shared-mod');
  const dbgBinding = dbgSession.modules.get('shared-mod');
  assert.ok(instBinding);
  assert.ok(dbgBinding);
  assert.equal(instBinding.runtimeBase, dbgBinding.runtimeBase);
  assert.equal(instBinding.runtimeSize, dbgBinding.runtimeSize);
  assert.equal(instBinding.identityState, dbgBinding.identityState);
  assert.equal(instBinding.loadedSequence, dbgBinding.loadedSequence);

  // Module unload
  const unloadData = {
    type: 'module-unload',
    epoch: 1,
    streamId: 'test',
    sequence: 11,
    payload: { id: 'shared-mod' },
  };

  instBackend.emit(unloadData);
  dbgAdapter.emit(unloadData);

  assert.equal(instSession.modules.get('shared-mod'), null);
  assert.equal(dbgSession.modules.get('shared-mod'), null);

  await instSession.close();
  await dbgSession.close();
});
