// Regression for #8686: DebuggerProvider's refreshModules() published
// whichever asynchronous getModules() call finished last, with no epoch
// capture, no per-refresh publication token, and no cancellation
// participation. An older concurrent refresh could roll back a newer
// committed snapshot, and an epoch-1 refresh could overwrite module
// authority already established by accepted epoch-2 lifecycle events, while
// resolveAddress() kept reporting the resurrected mapping as exact. The
// provider-native path now mirrors the legacy DebugSession.refreshState()
// freshness contract (#3928): only the most recently started refresh under
// the current epoch, on an open session, may commit.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DebuggerProvider } from '../../../js/runtime/debugger-provider.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const binaryId = 'binary-8686';
const OLD = (evidence) => [{
  id: 'main', base: 0x1000n, size: 0x100n, staticBase: 0x4000n,
  binaryId, identityState: 'exact', identityEvidenceIds: [evidence],
}];
const NEW = (evidence) => [{
  id: 'main', runtimeBase: 0x5000n, runtimeSize: 0x100n, staticBase: 0x9000n,
  binaryId, identityState: 'exact', identityEvidenceIds: [evidence],
}];

function refreshAdapter() {
  const queue = [];
  const listeners = new Set();
  return {
    id: 'refresh-8686',
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
  const session = await provider.openSession({ binaryId, processKey: 'proc-8686', sessionNonce: `nonce:${adapter.id}` });
  assert.equal(session.state, 'ready');
  return { provider, session, debugger: session.facets.debugger };
}

test('#8686 newer concurrent refresh stays authoritative when the older request resolves last', async () => {
  const adapter = refreshAdapter();
  const { session, debugger: facet } = await openSession(adapter, OLD('BOOT'));
  assert.equal(session.modules.active()[0].generation, 1);

  const olderGate = deferred();
  const newerGate = deferred();
  adapter.queue.push(olderGate.promise, newerGate.promise);
  const older = facet.refreshModules();
  const newer = facet.refreshModules();

  newerGate.resolve(NEW('NEWER'));
  await newer;
  assert.equal(session.modules.active()[0].generation, 2);
  assert.equal(session.modules.active()[0].runtimeBase, 0x5000n);
  const historyLength = session.modules.history().length;

  olderGate.resolve(OLD('OLDER-LATE'));
  await assert.rejects(older, (error) => error?.code === 'runtime-session-stale');
  const [active] = session.modules.active();
  assert.equal(active.runtimeBase, 0x5000n, 'the older completion must not roll back the newer snapshot');
  assert.deepEqual(active.identityEvidenceIds, ['NEWER']);
  assert.equal(active.generation, 2, 'the superseded refresh must not advance generation/history');
  assert.equal(session.modules.history().length, historyLength);
  assert.equal(facet.resolveAddress(0x5010n, { binaryId }).staticAddress, 0x9010n);
  assert.equal(facet.resolveAddress(0x1010n, { binaryId }).state, 'unresolved');
  await session.close();
});

test('#8686 epoch-1 refresh cannot publish after newProviderEpoch advances to epoch 2', async () => {
  const adapter = refreshAdapter();
  const { session, debugger: facet } = await openSession(adapter, OLD('BOOT'));

  const staleGate = deferred();
  adapter.queue.push(staleGate.promise);
  const stale = facet.refreshModules();
  assert.equal(session.newProviderEpoch('restart'), 2);
  assert.equal(adapter.epoch, 2);

  staleGate.resolve(NEW('EPOCH1-LATE'));
  await assert.rejects(stale, (error) => error?.code === 'runtime-session-stale');
  const [active] = session.modules.active();
  assert.equal(active.runtimeBase, 0x1000n, 'no epoch-1 refresh snapshot may publish into epoch 2');
  assert.equal(active.generation, 1);
  assert.deepEqual(active.identityEvidenceIds, ['BOOT']);
  await session.close();
});

test('#8686 accepted current-epoch module events beat a late epoch-1 refresh', async () => {
  const adapter = refreshAdapter();
  const { session, debugger: facet } = await openSession(adapter, OLD('BOOT'));

  const staleGate = deferred();
  adapter.queue.push(staleGate.promise);
  const stale = facet.refreshModules();
  await session.newProviderEpoch('restart');
  adapter.emit({ type: 'module-unload', epoch: 2, streamId: 'debugger', sequence: 1, payload: { bindingKey: 'main' } });
  adapter.emit({ type: 'module-load', epoch: 2, streamId: 'debugger', sequence: 2, payload: { bindingKey: 'main', runtimeBase: 0x5000n, runtimeSize: 0x100n, staticBase: 0x9000n, binaryId, identityState: 'exact', identityEvidenceIds: ['EPOCH2-LIVE'] } });
  assert.equal(session.epoch, 2);
  assert.equal(session.modules.active()[0].runtimeBase, 0x5000n);

  staleGate.resolve(OLD('EPOCH1-LATE'));
  await assert.rejects(stale, (error) => error?.code === 'runtime-session-stale');
  const [active] = session.modules.active();
  assert.equal(active.runtimeBase, 0x5000n);
  assert.deepEqual(active.identityEvidenceIds, ['EPOCH2-LIVE']);

  const resolved = facet.resolveAddress(0x5010n, { binaryId });
  assert.equal(resolved.state, 'exact');
  assert.equal(resolved.staticAddress, 0x9010n, 'exact provenance stays bound to the epoch-2 mapping');
  assert.equal(facet.resolveAddress(0x1010n, { binaryId }).state, 'unresolved', 'the epoch-1 range must not be resurrected');
  await session.close();
});

test('#8686 close during refresh prevents late publication', async () => {
  const adapter = refreshAdapter();
  const { session, debugger: facet } = await openSession(adapter, OLD('BOOT'));

  const lateGate = deferred();
  adapter.queue.push(lateGate.promise);
  const pending = facet.refreshModules();
  await session.close();

  lateGate.resolve(NEW('LATE-AFTER-CLOSE'));
  await assert.rejects(pending, (error) => error?.code === 'runtime-session-stale');
  assert.equal(session.closed, true);
  assert.equal(session.modules.active()[0].runtimeBase, 0x1000n, 'a closed session must never publish module state');
  assert.equal(session.modules.active()[0].generation, 1);
});

test('#8686 an unsuperseded current refresh still updates additions, removals, and changed bindings', async () => {
  const adapter = refreshAdapter();
  const { session, debugger: facet } = await openSession(adapter, OLD('BOOT'));

  adapter.queue.push([
    ...OLD('BOOT-CURRENT'),
    { id: 'extra', base: 0x8000n, size: 0x200n, staticBase: 0x2000n, binaryId, identityState: 'exact', identityEvidenceIds: ['EXTRA'] },
  ]);
  const changed = await facet.refreshModules();
  assert.equal(changed.length, 2);
  assert.ok(session.modules.get('extra'));
  assert.deepEqual(session.modules.get('main').identityEvidenceIds, ['BOOT-CURRENT']);

  adapter.queue.push([{ id: 'extra', base: 0x8000n, size: 0x200n, staticBase: 0x2000n, binaryId, identityState: 'exact', identityEvidenceIds: ['EXTRA'] }]);
  await facet.refreshModules();
  assert.equal(session.modules.get('main'), null, 'removed bindings are still unloaded by the authoritative refresh');
  assert.equal(session.modules.active().length, 1);
  await session.close();
});

test('#8686 publication authority does not weaken malformed-snapshot fail-closed behavior', async () => {
  const adapter = refreshAdapter();
  const { session, debugger: facet } = await openSession(adapter, OLD('BOOT'));

  adapter.queue.push(Promise.resolve('not-an-array'));
  await assert.rejects(facet.refreshModules(), (error) => error?.code === 'runtime-invalid-modules');

  adapter.queue.push(Promise.resolve([
    { id: 'dup', base: 0x9000n, size: 0x10n, staticBase: 0x10n, binaryId },
    { id: 'dup', base: 0x9100n, size: 0x10n, staticBase: 0x11n, binaryId },
  ]));
  await assert.rejects(facet.refreshModules());

  const [active] = session.modules.active();
  assert.equal(active.runtimeBase, 0x1000n);
  assert.equal(active.generation, 1);
  assert.equal(session.modules.active().length, 1);
  await session.close();
});

test('#8686 a failed refresh releases authority so the next refresh can publish', async () => {
  const adapter = refreshAdapter();
  const { session, debugger: facet } = await openSession(adapter, OLD('BOOT'));

  adapter.queue.push(Promise.reject(new Error('transport down')));
  await assert.rejects(facet.refreshModules(), /transport down/);

  adapter.queue.push(NEW('RECOVERED'));
  await facet.refreshModules();
  assert.equal(session.modules.active()[0].runtimeBase, 0x5000n);
  assert.deepEqual(session.modules.active()[0].identityEvidenceIds, ['RECOVERED']);
  await session.close();
});
