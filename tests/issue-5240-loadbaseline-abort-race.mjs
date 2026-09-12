// Regression for #5240: ProductWorkspace.loadBaseline must not miss an abort
// that lands between the initial signal.aborted check and the listener
// registration. The re-check right after addEventListener must fail closed:
// no baseline phase starts, the owned backend is disposed immediately, and
// the load settles as AbortError without double dispose or listener leak.
import assert from 'node:assert/strict';
import { ProductWorkspace } from '../js/workspace.js';

class Storage { constructor() { this.m = new Map(); } getItem(k) { return this.m.get(k) || null; } setItem(k, v) { this.m.set(k, String(v)); } }
const region = { id: 'text', name: '__text', exec: true, vmAddr: 0x1000n, size: 0x1000n, fileOffset: 0n };
function makeInfo(name, uuid) {
  return { name, size: 4096, format: 'macho', slices: [{ offset: 0n, size: 4096n, info: { uuid, architecture: 'arm64' }, capability: { architecture: 'arm64' }, regions: [region] }] };
}
function makeApp(hash) {
  const values = { fileInfo: makeInfo('same.bin', 'A'), file: { name: 'same.bin', size: 4096 }, sliceIndex: 0, architecture: 'arm64', currentAddress: 0x1000n, canDisassemble: false };
  const store = { values, get(k) { return this.values[k]; } };
  return {
    store,
    backend: { gen: 1, contentHash: hash, async ensureContentHash() { return this.contentHash; } },
    notes: { id: 'notes', names: new Map(), comments: new Map(), types: new Map(), vars: new Map(), structs: [], nameEntries() { return []; }, save() { return true; } },
    patches: { x: [], clear() { this.x = []; }, list() { return this.x.slice(); }, add() {} },
    bookmarks: { list: () => [] },
    navigation: { lastQuery: null, history: [], entries: [], limit: 20, cursorIndex: 0, index: 0, snapshot() { return {}; }, onChange: null },
  };
}
function makeWorkspace(backendFactory) {
  const app = makeApp('hash-a');
  const workspace = new ProductWorkspace(app, { storage: new Storage(), backendFactory });
  return workspace;
}
// Race-window signal: still reports aborted===false during the initial check,
// but the abort lands while addEventListener runs. A real AbortSignal never
// replays a past 'abort' event to a listener registered after the fact.
function makeRacingSignal() {
  const state = { aborted: false, listenerAdds: 0, listenerRemoves: 0, listener: null };
  const signal = {
    get aborted() { return state.aborted; },
    reason: 'cancelled',
    addEventListener(type, listener) { state.listenerAdds++; state.listener = listener; state.aborted = true; },
    removeEventListener() { state.listenerRemoves++; state.listener = null; },
  };
  return { signal, state };
}
function makeBackend() {
  const state = { openCalls: 0, disposed: 0, releaseOpen: null, ensureHashCalls: 0, analyzeCalls: 0 };
  const backend = {
    open() { state.openCalls++; return new Promise((resolve) => { state.releaseOpen = resolve; }); },
    ensureContentHash() { state.ensureHashCalls++; return Promise.resolve('hash-b'); },
    analyze() { state.analyzeCalls++; return Promise.resolve({ functions: [], symbols: { functionStartsComplete: true, functionCount: 0 } }); },
    dispose() { state.disposed++; },
  };
  return { backend, state };
}
async function settle(promise) {
  let outcome = null;
  const tracked = promise.then((value) => { outcome = { ok: true, value }; }, (error) => { outcome = { ok: false, error }; });
  return { outcome: () => outcome, settled: tracked };
}
const file = new Blob([new Uint8Array(32)]);

// 1. Owned backend, abort inside the check→listener window: fail closed.
{
  const { backend, state: backendState } = makeBackend();
  const workspace = makeWorkspace(() => backend);
  await workspace.bind();
  const { signal, state: signalState } = makeRacingSignal();
  const load = await settle(workspace.loadBaseline(file, { signal }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(backendState.openCalls, 0, 'a race-window abort must not let other.open() start or run to completion');
  assert.equal(backendState.ensureHashCalls, 0, 'later baseline phases must not be reached');
  assert.equal(backendState.analyzeCalls, 0, 'later baseline phases must not be reached');
  assert.equal(backendState.disposed, 1, `the owned backend must be disposed immediately, got ${backendState.disposed}`);
  assert.ok(load.outcome(), 'the load must settle, not stay pending behind the hung open');
  assert.equal(load.outcome().ok, false, 'the raced load must reject');
  assert.equal(load.outcome().error.name, 'AbortError');
  assert.equal(load.outcome().error.code, 'ABORT_ERR');
  assert.equal(signalState.listenerAdds, 1, 'the abort listener must be registered');
  assert.equal(signalState.listenerRemoves, 1, 'the abort listener must be cleaned up');
  assert.equal(workspace.baseline, null, 'nothing may be published as the baseline');
}

// 2. Externally owned backend in the same race: reject without disposing it.
{
  const { backend, state: backendState } = makeBackend();
  const workspace = makeWorkspace(() => { throw new Error('external backend must be used instead of the factory'); });
  await workspace.bind();
  const { signal } = makeRacingSignal();
  const load = await settle(workspace.loadBaseline(file, { backend, signal }));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(load.outcome(), 'the load must settle, not stay pending behind the hung open');
  assert.equal(load.outcome().ok, false, 'the raced load must reject');
  assert.equal(load.outcome().error.name, 'AbortError');
  assert.equal(backendState.openCalls, 0, 'no baseline phase may start after a race-window abort');
  assert.equal(backendState.disposed, 0, 'an externally owned backend must never be disposed here');
}

// 3. Already-aborted signal: legacy behavior — never start baseline work.
{
  const { backend, state: backendState } = makeBackend();
  const workspace = makeWorkspace(() => backend);
  await workspace.bind();
  const state = { aborted: true, listenerAdds: 0 };
  const signal = { get aborted() { return state.aborted; }, reason: 'cancelled', addEventListener() { state.listenerAdds++; }, removeEventListener() {} };
  const load = await settle(workspace.loadBaseline(file, { signal }));
  assert.equal(load.outcome().ok, false, 'an already-aborted signal must reject');
  assert.equal(load.outcome().error.name, 'AbortError');
  assert.equal(backendState.openCalls, 0, 'an already-aborted signal must not start baseline work');
  assert.equal(state.listenerAdds, 0, 'no listener is needed when the signal is already aborted');
}

// 4. Ordinary abort during open keeps working and cleans up the listener.
{
  const { backend, state: backendState } = makeBackend();
  const workspace = makeWorkspace(() => backend);
  await workspace.bind();
  const state = { aborted: false, listener: null, listenerRemoves: 0 };
  const signal = {
    get aborted() { return state.aborted; },
    reason: 'cancelled',
    addEventListener(_type, listener) { state.listener = listener; },
    removeEventListener() { state.listenerRemoves++; state.listener = null; },
  };
  const load = await settle(workspace.loadBaseline(file, { signal }));
  assert.equal(backendState.openCalls, 1, 'open must start for a not-yet-aborted signal');
  assert.equal(load.outcome(), null, 'the load must stay pending while open is in flight');
  state.aborted = true;
  state.listener();
  assert.ok(backendState.disposed >= 1, 'the owned backend must be disposed on abort during open');
  backendState.releaseOpen(makeInfo('base.bin', 'B'));
  await load.settled;
  assert.equal(load.outcome().ok, false, 'an aborted load must never resolve as success');
  assert.equal(load.outcome().error.name, 'AbortError');
  assert.equal(backendState.ensureHashCalls, 0, 'no baseline phase may run after the post-open abort check');
  assert.equal(state.listenerRemoves, 1, 'the finally block must still remove the abort listener');
  assert.equal(workspace.baseline, null, 'an aborted load must not publish a baseline');
}

console.log('issue #5240 loadBaseline abort-race regressions PASS');
