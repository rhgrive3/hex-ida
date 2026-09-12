import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { AnalysisQueryAPI, createAppAnalysisQueryAdapter } from '../../js/analysis/query/index.js';
import { configureScopedAnalysisHost, disableScopedAnalysisHost, scopedAnalysisHost } from '../../js/analysis/query/scoped-host.js';
import { createSliceId } from '../../js/core/identity/index.js';
import { RuntimeProviderPlatform } from '../../js/runtime/provider-platform.js';
import { bindRuntimeProviderPlatformForApp, existingRuntimeProviderPlatformForApp } from '../../js/runtime/app-runtime.js';
import { CAPTURED_ASYNC_EVENT_SCHEMA } from '../../js/runtime/captured-async.js';

const verifyOwnedTraceModule = (module, context) => module.binaryId === context.binaryId
  && module.sliceId === context.sliceId;

// A test-owned offline recording is opened through the actual TraceProvider
// before binding the public app adapter. The query only borrows retained data.
async function retainedApp(t) {
  const bytes = fs.readFileSync(new URL('./fixtures/threaded-integer.elf', import.meta.url));
  const hash = createHash('sha256').update(bytes).digest('hex'), binaryId = 'bin_sha256_' + hash;
  const file = new Blob([bytes]), sliceId = createSliceId({ binaryId, index: 0, architecture: 'arm64' });
  const capability = { architecture: 'arm64', endianness: 'little' };
  const values = { file, fileInfo: { formatId: 'elf', sha256: hash,
    slices: [{ descriptor: { formatMetadata: { endian: 'little' } } }] },
  sliceIndex: 0, regions: [], capability, architecture: 'arm64' };
  let codeReads = 0;
  const app = { backend: { file, gen: 1, transportEpoch: 1, formatId: 'elf', binaryId,
    readAt: () => { codeReads++; throw new Error('retained-route-must-not-read-code'); } },
  store: { get: key => values[key] }, projectRevision: 0, symbols: { revision: 1, functionCount: 0, exact: () => null } };
  const object = { objectId: 'owned-block', objectGeneration: 'allocation-2' };
  const events = ['allocate', 'use', 'dispose'].map((kind, sequence) => ({ id: `retained:${sequence}`, kind,
    strandId: 'owned-strand', sequence, ...object, sourceReferences: [`owned-source:event-${sequence}`] }));
  const contracts = [{ id: 'owned-sequence', version: '1', rule: 'sequenced-before', sourceReferences: ['owned-source:sequence-contract'] }];
  const relations = [0, 1].map(i => ({ id: `relation:${i}`, from: events[i].id, to: events[i + 1].id,
    contractId: 'owned-sequence', contractVersion: '1', sourceReferences: [`owned-source:relation-${i}`] }));
  const recording = { recordingId: 'owned-retained-api-recording', sourceProvider: 'owned-trace-fixture', sourceProviderVersion: '1',
    binaryId, sliceId, completeness: 'complete',
    modules: [{ bindingKey: 'main', runtimeBase: '0x7000', runtimeSize: '0x1000', staticBase: '0x1000',
      binaryId, sliceId, identityState: 'exact', identityEvidenceIds: ['owned-fixture:elf-content-identity'],
      buildIdentity: { kind: 'sha256', hash } }],
    events: events.map(event => ({ eventId: event.id, kind: 'trace-marker', moduleBindingKey: 'main', moduleGeneration: 1,
      observationMode: 'observed', completeness: 'complete', payload: {
        scpaAsync: { schema: CAPTURED_ASYNC_EVENT_SCHEMA, event, contracts, relations }, privateUnrelatedPayload: 'must-remain-private' } })) };
  const open = async id => {
    const platform = new RuntimeProviderPlatform(); platform.registerTrace(recording, {
      id, verifyModuleIdentity: verifyOwnedTraceModule,
    });
    const session = await platform.openSession(id); t.after(() => platform.closeAll());
    return { platform, session };
  };
  const retained = await open('owned-retained-api');
  bindRuntimeProviderPlatformForApp(app, retained.platform);
  configureScopedAnalysisHost(app, { enabled: true }); t.after(() => disableScopedAnalysisHost(app));
  const api = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app)), snapshot = await api.scopedSnapshot();
  const request = session => ({ runtimeSessionId: session.runtimeSessionId, fromEventId: 'retained:0', toEventId: 'retained:2',
    lifetime: { ...object, useEventId: 'retained:1' } });
  return { ...retained, app, api, snapshot, open, request, codeReads: () => codeReads,
    query: (session = retained.session, options = {}) => api.asyncEventOrder(snapshot, request(session), { limits: { deadlineMs: 2000 }, ...options }) };
}

test('public QueryAPI reads the already retained trace and keeps event order conditional on its contract', { timeout: 10000 }, async t => {
  const f = await retainedApp(t), before = [...f.platform.sessions];
  assert.equal(scopedAnalysisHost(f.app).service, null);
  assert.equal(existingRuntimeProviderPlatformForApp(f.app), f.platform);
  assert.ok(Object.isFrozen(f.session.normalizedEvents));
  for (const method of ['openSession', 'switchSession']) f.platform[method] = () => { throw new Error(`query-must-not-${method}`); };
  for (const method of ['events', 'replay']) f.session[method] = () => { throw new Error(`query-must-not-${method}`); };
  const { value } = await f.query();
  assert.equal(value.status, 'completed'); assert.equal(value.relation, 'before-in-model');
  assert.equal(value.captured.status, 'bound'); assert.deepEqual(value.captured.counts, { declared: 3, bound: 3, missing: 0 });
  assert.deepEqual(value.witness.nodes, ['retained:0', 'retained:1', 'retained:2']);
  assert.equal(value.lifetime.relation, 'between-captured-boundaries-in-model');
  assert.equal(value.binding.snapshotId, f.snapshot.snapshotId); assert.equal(value.binding.runtimeSessionId, f.session.runtimeSessionId);
  assert.equal(value.exact, false); assert.equal(value.lifetime.lifetimeProven, false);
  assert.equal(value.staticHappensBeforeProven, false); assert.equal(value.semanticProof, false);
  assert.equal(value.runtimeExecutionRequested, false); assert.equal(value.canonicalTruthChanged, false);
  assert.equal(value.releaseQualified, false); assert.equal(JSON.stringify(value).includes('must-remain-private'), false);
  assert.deepEqual([...f.platform.sessions], before); assert.equal(f.platform.current, f.session); assert.equal(f.codeReads(), 0);
});

test('public runtime address observations remain unsupported without a retained address-role owner', { timeout: 10000 }, async t => {
  const f = await retainedApp(t);
  const { value } = await f.api.runtimeObservations(f.snapshot,
    { runtimeSessionId: f.session.runtimeSessionId, eventIds: ['retained:1'], role: 'instruction' }, { limits: { deadlineMs: 2000 } });
  assert.equal(value.status, 'unsupported'); assert.equal(value.reason, 'captured-runtime-evidence-owner-unbound');
  assert.equal(value.exact, false); assert.equal(value.observations, undefined); assert.equal(f.codeReads(), 0);
});

test('replacing the bound retained platform retires the old service before a fresh query can publish', { timeout: 10000 }, async t => {
  const f = await retainedApp(t); await f.query();
  const prior = scopedAnalysisHost(f.app).service, replacement = await f.open('owned-retained-api-replacement');
  bindRuntimeProviderPlatformForApp(f.app, replacement.platform);
  await assert.rejects(() => f.query(replacement.session), /scoped-service-stale/);
  assert.equal(prior.closed, true);
  const { value } = await f.query(replacement.session);
  assert.equal(value.status, 'completed'); assert.equal(value.relation, 'before-in-model');
  assert.equal(value.binding.runtimeSessionId, replacement.session.runtimeSessionId);
  assert.notEqual(scopedAnalysisHost(f.app).service, prior);
  assert.equal(f.platform.current, f.session); assert.equal(replacement.platform.current, replacement.session);
  assert.equal(f.codeReads(), 0);
});

test('a changed app source requires an explicit new binding to the retained platform', { timeout: 10000 }, async t => {
  const f = await retainedApp(t); await f.query();
  f.app.backend.gen++;
  assert.equal(existingRuntimeProviderPlatformForApp(f.app), null);
  const snapshot = await f.api.scopedSnapshot();
  const beforeBind = await f.api.asyncEventOrder(snapshot, f.request(f.session), { limits: { deadlineMs: 2000 } });
  assert.equal(beforeBind.value.status, 'unsupported'); assert.equal(beforeBind.value.reason, 'current-async-event-owner-required');
  const prior = scopedAnalysisHost(f.app).service;
  bindRuntimeProviderPlatformForApp(f.app, f.platform);
  await assert.rejects(() => f.api.asyncEventOrder(snapshot, f.request(f.session)), /scoped-service-stale/);
  assert.equal(prior.closed, true);
  const rebound = await f.api.asyncEventOrder(snapshot, f.request(f.session), { limits: { deadlineMs: 2000 } });
  assert.equal(rebound.value.relation, 'before-in-model'); assert.equal(f.codeReads(), 0);
});

test('pre-cancelled public async queries do not create a service or consume retained events', { timeout: 10000 }, async t => {
  const f = await retainedApp(t), controller = new AbortController(), before = f.session.normalizedEvents;
  controller.abort(new Error('owned-async-cancel'));
  await assert.rejects(() => f.query(f.session, { signal: controller.signal }), /owned-async-cancel|aborted|Abort/);
  assert.equal(scopedAnalysisHost(f.app).service, null); assert.equal(f.session.normalizedEvents, before);
  assert.equal(f.platform.sessions.size, 1); assert.equal(f.codeReads(), 0);
});

test('cancellation during native retained-owner capture prevents public result publication', { timeout: 10000 }, async t => {
  const f = await retainedApp(t), controller = new AbortController(), original = f.platform.getSession.bind(f.platform);
  let captured = 0;
  f.platform.getSession = id => {
    const session = original(id);
    if (++captured === 1) queueMicrotask(() => controller.abort(new Error('owned-async-mid-cancel')));
    return session;
  };
  await assert.rejects(() => f.query(f.session, { signal: controller.signal }), /owned-async-mid-cancel|aborted|Abort/);
  assert.ok(captured > 0); assert.equal(f.session.closed, false);
  assert.equal(f.platform.sessions.size, 1); assert.equal(f.codeReads(), 0);
});
