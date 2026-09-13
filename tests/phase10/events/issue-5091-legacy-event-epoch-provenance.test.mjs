import assert from 'node:assert/strict';
import test from 'node:test';

import { DebugAdapter } from '../../../js/debug/adapter.js';
import { DebuggerProvider } from '../../../js/runtime/debugger-provider.js';
import { InstrumentationProvider } from '../../../js/runtime/instrumentation-provider.js';
import { RuntimeEventNormalizer } from '../../../js/runtime/events.js';

const context = {
  runtimeSessionId: 'session-1',
  providerId: 'provider-1',
  providerVersion: '1',
  sessionEpoch: 1,
  processKey: 'pid:1',
};

class LegacyEventAdapter extends DebugAdapter {
  constructor() {
    super({ id: 'legacy-event-adapter', kind: 'lldb', capabilities: { modules: false, threads: false } });
    this.listeners = new Set();
  }
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of [...this.listeners]) listener(event); }
}

test('#5091 initial-epoch legacy events retain compatibility before an epoch barrier', () => {
  const normalizer = new RuntimeEventNormalizer(context);
  const event = normalizer.push({ type: 'trace', payload: { marker: 'initial' } });
  assert.ok(event);
  assert.equal(event.sessionEpoch, 1);
});

test('#5091 epoch-less legacy events cannot be relabelled into a newer epoch', () => {
  const normalizer = new RuntimeEventNormalizer(context);
  normalizer.resetEpoch(2);

  assert.equal(normalizer.push({ type: 'trace', payload: { marker: 'stale' } }), null);

  const batch = normalizer.flush();
  assert.equal(batch.completeness, 'truncated');
  assert.equal(batch.dropped, 1);
  assert.equal(batch.events.length, 1);
  assert.equal(batch.events[0].kind, 'dropped-events');
  assert.equal(batch.events[0].sessionEpoch, 2);
});

test('#5091 explicit stale/current epoch authority remains fail-closed/exact', () => {
  const normalizer = new RuntimeEventNormalizer(context);
  normalizer.resetEpoch(2);

  assert.equal(normalizer.push({ type: 'paused', epoch: 1, streamId: 'debugger', sequence: 1 }), null);
  const current = normalizer.push({ type: 'paused', epoch: 2, streamId: 'debugger', sequence: 1 });
  assert.ok(current);
  assert.equal(current.sessionEpoch, 2);
});

test('#5091 stale epoch-less debugger events cannot mutate new-epoch state or modules', async () => {
  const adapter = new LegacyEventAdapter();
  const provider = new DebuggerProvider(adapter, { id: 'provider-1' });
  const session = await provider.openSession({
    binaryId: 'bin_' + 'ab'.repeat(32),
    targetIdentity: { process: 'fixture:1' },
    sessionNonce: 'issue-5091',
  });

  assert.equal(session.state, 'ready');
  const delayedPause = { type: 'paused', payload: { marker: 'stale-pause' } };
  const delayedResume = { type: 'resumed', payload: { marker: 'stale-resume' } };
  const delayedModule = {
    type: 'module-load',
    payload: {
      bindingKey: 'stale-module',
      runtimeBase: 0x7000n,
      runtimeSize: 0x1000n,
      staticBase: 0x1000n,
      binaryId: 'bin_' + 'ab'.repeat(32),
      identityState: 'exact',
      identityEvidenceIds: ['fixture:module-match'],
    },
  };
  session.newProviderEpoch('fixture-reset');
  assert.equal(session.epoch, 2);

  adapter.emit(delayedPause);
  adapter.emit(delayedModule);

  assert.equal(session.state, 'ready');
  assert.equal(session.modules.get('stale-module'), null);

  adapter.emit({ type: 'paused', epoch: 2, streamId: 'debugger', sequence: 1 });
  assert.equal(session.state, 'paused');
  adapter.emit(delayedResume);
  assert.equal(session.state, 'paused');

  const batch = session.facets.debugger.events.flush();
  assert.equal(batch.completeness, 'truncated');
  assert.equal(batch.dropped, 3);
  assert.equal(batch.events.filter((event) => event.kind === 'paused').length, 1);
  assert.ok(batch.events.some((event) => event.kind === 'dropped-events'));

  await session.close();
});


test('#5091 captured legacy epoch authority must match the current generation', () => {
  const normalizer = new RuntimeEventNormalizer(context);
  normalizer.resetEpoch(2);

  assert.equal(
    normalizer.push({ type: 'trace', payload: { marker: 'old-token' } }, { legacySessionEpoch: 1 }),
    null,
  );
  const current = normalizer.push(
    { type: 'trace', payload: { marker: 'current-token' } },
    { legacySessionEpoch: 2 },
  );
  assert.ok(current);
  assert.equal(current.sessionEpoch, 2);
});

test('#5091 protocol epoch authority is snapshotted exactly once', () => {
  const normalizer = new RuntimeEventNormalizer(context);
  normalizer.resetEpoch(2);
  let reads = 0;
  const raw = {
    type: 'event',
    event: 'trace-marker',
    data: { marker: 'single-read' },
    get epoch() {
      reads++;
      return reads === 1 ? 2 : 1;
    },
  };

  const event = normalizer.push(raw);
  assert.ok(event);
  assert.equal(event.sessionEpoch, 2);
  assert.equal(reads, 1);
});

test('#5091 instrumentation backend callbacks do not inherit direct-ingress epoch authority', async () => {
  class Backend {
    constructor() { this.listeners = new Set(); }
    onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    emit(event) { for (const listener of [...this.listeners]) listener(event); }
    setEpoch(next) { this.epoch = next; return next; }
  }

  const backend = new Backend();
  const provider = new InstrumentationProvider(backend, { id: 'instrumentation-5091' });
  const session = await provider.openSession({ binaryId: 'bin_instrumentation_5091' });
  assert.equal(session.newProviderEpoch('instrumentation-reset'), 2);

  backend.emit({ kind: 'trace-marker', payload: { marker: 'unversioned-backend' } });
  const direct = session.facets.instrumentation.events.ingest({ kind: 'trace-marker', payload: { marker: 'direct-current' } });
  assert.ok(direct);
  assert.equal(direct.sessionEpoch, 2);

  const batch = session.facets.instrumentation.events.flush();
  assert.equal(batch.dropped, 1);
  assert.equal(batch.completeness, 'truncated');
  assert.deepEqual(
    batch.events.filter((event) => event.kind === 'trace-marker').map((event) => event.payload.marker),
    ['direct-current'],
  );

  await session.close();
});
