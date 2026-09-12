import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, workFor } from './helpers.mjs';
import { RuntimeProviderPlatform } from '../../js/runtime/provider-platform.js';
import { createNativeScopedRuntimeContextProvider } from '../../js/runtime/native-scoped-context.js';
import { bindRuntimeProviderPlatformForApp, existingRuntimeProviderPlatformForApp } from '../../js/runtime/app-runtime.js';
import { queryAsyncEventOrder } from '../../js/analysis/apple/scoped-async.js';
import { CAPTURED_ASYNC_EVENT_SCHEMA } from '../../js/runtime/captured-async.js';

const verifyOwnedTraceModule = (module, context) => module.binaryId === context.binaryId
  && module.sliceId === context.sliceId;

async function setup(t, mutate = () => {}) {
  const f = fixture(), object = { objectId: 'objc-block:allocation-site', objectGeneration: 'allocation:2' };
  const modelEvents = ['allocate', 'use', 'dispose'].map((kind, sequence) => ({ id: `captured:${sequence}`, kind,
    strandId: 'owned-trace:strand', sequence, ...object, sourceReferences: [`owned-fixture:objc-block:${sequence}`] }));
  const contracts = [{ id: 'seq', version: 'owned-contract-v1', rule: 'sequenced-before', sourceReferences: ['owned-fixture:library-sequence-contract'] }];
  const relations = [0, 1].map(i => ({ id: `edge:${i}`, from: modelEvents[i].id, to: modelEvents[i + 1].id,
    contractId: 'seq', contractVersion: 'owned-contract-v1', sourceReferences: [`owned-fixture:relation:${i}`] }));
  const recording = { recordingId: 'owned:async-trace', sourceProvider: 'owned-trace-fixture', sourceProviderVersion: '1',
    binaryId: 'binary-scpa-test', sliceId: 'slice-arm64', completeness: 'complete',
    modules: [{ bindingKey: 'main', runtimeBase: '0x7000', runtimeSize: '0x1000', staticBase: '0x1000',
      binaryId: 'binary-scpa-test', sliceId: 'slice-arm64', identityState: 'exact',
      identityEvidenceIds: ['owned-fixture:content-identity'], buildIdentity: { kind: 'sha256', hash: 'ab'.repeat(32) } }],
    events: modelEvents.map(event => ({ eventId: event.id, kind: 'trace-marker', moduleBindingKey: 'main', moduleGeneration: 1,
      observationMode: 'observed', completeness: 'complete', payload: {
        scpaAsync: { schema: CAPTURED_ASYNC_EVENT_SCHEMA, event, contracts, relations }, privateUnrelatedPayload: 'not-exported' } })) };
  mutate(recording);
  // Offline trace import normalizes owned fixture records. No debugger,
  // instrumentation, emulation, stream, or replay is involved in this fixture.
  const platform = new RuntimeProviderPlatform(); platform.registerTrace(recording, {
    id: 'owned-retained', verifyModuleIdentity: verifyOwnedTraceModule,
  });
  const session = await platform.openSession('owned-retained'); t.after(() => platform.closeAll());
  const scope = { ...f, snapshotId: 'native-async-snapshot', work: workFor(t) };
  let live = true;
  const provider = createNativeScopedRuntimeContextProvider(platform, { binaryId: 'binary-scpa-test', sliceId: 'slice-arm64', isCurrent: () => live });
  const query = { runtimeSessionId: session.runtimeSessionId, fromEventId: 'captured:0', toEventId: 'captured:2',
    lifetime: { ...object, useEventId: 'captured:1' } };
  const run = (extra = {}) => queryAsyncEventOrder(query, { ...scope, getContext: provider.getAsyncEventContext,
    getRuntimeContext: provider.getRuntimeEvidenceContext, isCurrent: () => live, ...extra });
  return { f, scope, query, run, provider, platform, session, recording, retire: () => { live = false; } };
}

test('actual retained TraceProvider records automatically feed captured ObjC object order', async t => {
  const f = await setup(t);
  assert.ok(Object.isFrozen(f.session.normalizedEvents));
  const before = [...f.platform.sessions];
  f.platform.openSession = () => { throw Error('native adapter must not open'); };
  f.platform.switchSession = () => { throw Error('native adapter must not select'); };
  const r = await f.run();
  assert.equal(r.relation, 'before-in-model'); assert.equal(r.captured.status, 'bound');
  assert.deepEqual(r.captured.counts, { declared: 3, bound: 3, missing: 0 });
  assert.equal(r.lifetime.relation, 'between-captured-boundaries-in-model');
  assert.equal(r.lifetime.lifetimeProven, false); assert.equal(r.runtimeExecutionRequested, false);
  assert.equal(r.semanticProof, false); assert.equal(r.staticHappensBeforeProven, false);
  assert.equal(JSON.stringify(r).includes('not-exported'), false);
  assert.deepEqual([...f.platform.sessions], before);
  const native = f.provider.getRuntimeEvidenceContext(f.session.runtimeSessionId, f.scope);
  assert.equal(native.modules, f.session.modules);
  assert.equal(native.getObservation('captured:0', { role: 'instruction' }), null);
});

test('retained Swift continuation contract is checked with concrete token generation', async t => {
  const f = await setup(t, recording => {
    const [a, b] = recording.events; recording.events = [a, b];
    a.payload.scpaAsync.event = { id: 'captured:0', kind: 'resume', token: 'continuation:1', objectId: 'swift-continuation', objectGeneration: '2', sourceReferences: ['owned-fixture:resume'] };
    b.eventId = 'captured:2';
    b.payload.scpaAsync.event = { id: 'captured:2', kind: 'continuation-start', token: 'continuation:1', objectId: 'swift-continuation', objectGeneration: '2', sourceReferences: ['owned-fixture:start'] };
    for (const e of recording.events) {
      e.payload.scpaAsync.contracts = [{ id: 'resume-contract', version: '1', rule: 'continuation-resume', sourceReferences: ['owned-fixture:explicit-continuation-contract'] }];
      e.payload.scpaAsync.relations = [{ id: 'resume-edge', from: 'captured:0', to: 'captured:2', contractId: 'resume-contract', contractVersion: '1', sourceReferences: ['owned-fixture:explicit-token-link'] }];
    }
  });
  const r = await f.run(); assert.equal(r.relation, 'before-in-model'); assert.equal(r.captured.status, 'bound');
  assert.equal(r.witness.edges[0].rule, 'continuation-resume'); assert.equal(r.staticHappensBeforeProven, false);
});

test('sequence, actor, timestamps, and complete capture alone never manufacture contracts', async t => {
  const f = await setup(t, recording => { for (const e of recording.events) {
    delete e.payload.scpaAsync.contracts; delete e.payload.scpaAsync.relations;
    e.timestamp = '100'; e.payload.scpaAsync.event.actorId = 'same-actor';
  } });
  const r = await f.run(); assert.equal(r.captured.status, 'bound'); assert.equal(r.relation, 'unknown');
  assert.equal(r.counts.retainedEdges, 0); assert.ok(r.remaining.includes('retained-async-contracts-unavailable'));
});

for (const [name, mutate, reason] of [
  ['recording loss', r => { r.dropped = 1; }, 'trace-incomplete'],
  ['partial recording', r => { r.completeness = 'partial'; }, 'trace-incomplete'],
  ['historical epoch', r => { r.events[1].epoch = 2; }, 'event-epoch-mismatch'],
  ['historical module', r => { r.events[1].moduleGeneration = 2; }, 'module-unqualified'],
  ['unqualified build', r => { r.modules[0].identityState = 'unresolved'; }, 'module-unqualified'],
  ['contradictory content hash', r => { r.modules[0].buildIdentity.hash = 'cd'.repeat(32); }, 'build-identity-mismatch'],
  ['incomparable build UUID', r => { r.modules[0].buildIdentity = { kind: 'uuid', value: 'owned-fixture-uuid' }; }, 'build-identity-incomparable'],
  ['synthetic marker', r => { r.events[1].observationMode = 'synthetic'; }, 'event-unqualified'],
  ['intervened marker', r => { r.events[1].interventionIds = ['owned-intervention']; }, 'event-unqualified'],
  ['future payload', r => { r.events[1].payload.scpaAsync.schema = 'future'; }, 'schema-unqualified'],
  ['ordinary events', r => { for (const e of r.events) delete e.payload.scpaAsync; }, 'markers-unavailable'],
]) test(`native retained async rejects ${name} without omitting its uncertainty`, async t => {
  const f = await setup(t, mutate), r = await f.run(); assert.equal(r.status, 'unsupported');
  assert.ok(r.reason.includes(reason), r.reason); assert.equal(r.relation, 'unknown'); assert.equal(r.runtimeExecutionRequested, false);
});

test('conflicting duplicate contracts and mismatched event identities cannot win by arrival order', async t => {
  const a = await setup(t, r => { r.events[1].payload.scpaAsync.contracts = [{ ...r.events[1].payload.scpaAsync.contracts[0], version: 'different' }]; });
  await assert.rejects(a.run(), /contracts-conflict/);
  const b = await setup(t, r => { r.events[1].payload.scpaAsync.event.id = 'different'; });
  await assert.rejects(b.run(), /async-event-binding/);
});

test('retained source membership, module reload, selection and lifecycle invalidate borrowed contexts', async t => {
  const f = await setup(t), first = f.provider.getAsyncEventContext(f.session.runtimeSessionId, f.scope);
  assert.equal(first.isCurrent(), true);
  f.session.normalizedEvents = Object.freeze([...f.session.normalizedEvents]); assert.equal(first.isCurrent(), false);
  const second = f.provider.getAsyncEventContext(f.session.runtimeSessionId, f.scope);
  const module = f.session.modules.active()[0]; f.session.modules.unload(module.bindingKey); f.session.modules.load(module);
  assert.equal(second.isCurrent(), false);
  const g = await setup(t), third = g.provider.getAsyncEventContext(g.session.runtimeSessionId, g.scope);
  g.platform.current = null; assert.equal(third.isCurrent(), false); assert.equal((await g.run()).status, 'unsupported');
  g.platform.current = g.session; await g.session.close(); assert.equal(third.isCurrent(), false);
});

test('native source change during captured evidence binding rejects publication', async t => {
  const f = await setup(t);
  await assert.rejects(f.run({ getRuntimeContext: (...args) => {
    const context = f.provider.getRuntimeEvidenceContext(...args); f.retire(); return context;
  } }), /stale/);
});

test('retained event scan obeys shared budget and cancellation', async t => {
  const f = await setup(t);
  await assert.rejects(f.run({ work: workFor(t, { workUnits: 0 }) }));
  const controller = new AbortController(); controller.abort();
  assert.throws(() => f.provider.getAsyncEventContext(f.session.runtimeSessionId, { ...f.scope, signal: controller.signal }), /cancelled/);
});

test('retained async and total scan caps preserve the whole selected denominator', async t => {
  const f = await setup(t, r => { const base = r.events[0]; r.events = Array.from({ length: 129 }, (_, i) => ({ ...base,
    eventId: `bounded:${i}`, payload: { scpaAsync: { schema: CAPTURED_ASYNC_EVENT_SCHEMA,
      event: { ...base.payload.scpaAsync.event, id: `bounded:${i}`, sequence: i } } } })); });
  assert.equal((await f.run()).reason, 'native-retained-async-event-bound');
  const g = await setup(t, r => { r.events = Array.from({ length: 4097 }, (_, i) => ({
    eventId: `ordinary:${i}`, kind: 'trace-marker', completeness: 'complete', payload: {} })); });
  assert.equal((await g.run()).reason, 'native-retained-trace-event-bound');
  const h = await setup(t, r => { const base = r.events[0]; r.events = Array.from({ length: 80 }, (_, i) => ({ ...base,
    eventId: `bytes:${i}`, payload: { padding: 'x'.repeat(8192), scpaAsync: { schema: CAPTURED_ASYNC_EVENT_SCHEMA,
      event: { ...base.payload.scpaAsync.event, id: `bytes:${i}`, sequence: i } } } })); });
  await assert.rejects(h.run(), /byte-bound/);
});

test('mutated retained payload getters are rejected without invocation', async t => {
  const f = await setup(t); let calls = 0;
  const payload = Object.freeze(Object.defineProperty({}, 'scpaAsync', { enumerable: true, get() { calls++; return {}; } }));
  const replaced = Object.freeze({ ...f.session.normalizedEvents[0], payload });
  f.session.normalizedEvents = Object.freeze([replaced, ...f.session.normalizedEvents.slice(1)]);
  await assert.rejects(f.run(), /payload-accessor/); assert.equal(calls, 0);
});

test('first-party app binder borrows only an existing platform for the pinned current source', async t => {
  const f = await setup(t), file = new Blob(['owned']), info = { hash: 'owned-hash' };
  const data = new Map([['fileInfo', info], ['sliceIndex', 0], ['architecture', 'arm64']]);
  const app = { backend: { file, gen: 1, transportEpoch: 1 }, store: { get: key => data.get(key) } };
  assert.equal(existingRuntimeProviderPlatformForApp(app), null);
  assert.throws(() => bindRuntimeProviderPlatformForApp(app, {}), /platform-required/);
  assert.equal(bindRuntimeProviderPlatformForApp(app, f.platform), f.platform);
  assert.equal(existingRuntimeProviderPlatformForApp(app), f.platform);
  const native = createNativeScopedRuntimeContextProvider(existingRuntimeProviderPlatformForApp(app), {
    binaryId: 'binary-scpa-test', sliceId: 'slice-arm64', isCurrent: () => existingRuntimeProviderPlatformForApp(app) === f.platform });
  const context = native.getAsyncEventContext(f.session.runtimeSessionId, f.scope);
  app.backend.gen++; assert.equal(existingRuntimeProviderPlatformForApp(app), null); assert.equal(context.isCurrent(), false);
  bindRuntimeProviderPlatformForApp(app, f.platform); data.set('sliceIndex', 1); assert.equal(existingRuntimeProviderPlatformForApp(app), null);
  data.set('sliceIndex', 0); assert.equal(existingRuntimeProviderPlatformForApp(app), null, 'retired binding cannot revive');
  bindRuntimeProviderPlatformForApp(app, f.platform); app.backend.file = new Blob(['owned']); assert.equal(existingRuntimeProviderPlatformForApp(app), null);
  bindRuntimeProviderPlatformForApp(app, f.platform); info.hash = 'new-content'; assert.equal(existingRuntimeProviderPlatformForApp(app), null);
});
