import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AnalysisQueryAPI, createAppAnalysisQueryAdapter } from '../../js/analysis/query/index.js';
import { ScopedAnalysisService } from '../../js/analysis/query/scoped-service.js';
import { configureScopedAnalysisHost, disableScopedAnalysisHost, scopedAnalysisHost } from '../../js/analysis/query/scoped-host.js';
import { projectScopedDemandOwners } from '../../js/analysis/scoped-demand-projection.js';
import { createNativeAppleDispatchResolver } from '../../js/analysis/apple/native-metadata.js';
import { nativeWorkerFixture } from './native-worker-fixture.mjs';
import { captured, scope } from './native-owner-fixture.mjs';
import { appleFixture, contextFor } from './native-apple-fixture.mjs';

const LOOP = [
  ['mov', 'x0, #0', 0xd2800000], ['cmp', 'x0, #10', 0xf100281f], ['b.hs', '#0x1014', 0x54000062],
  ['add', 'x0, x0, #1', 0x91000400], ['b', '#0x1004', 0x17fffffd], ['ret', '', 0xd65f03c0],
];
const loopQuery = { functionId: '0x1000', loopId: 'entry-counted-loop', synthesize: true, postcondition: { lower: '10', upper: '10' } };

test('default service loop owner reads the actual 24-byte entry fragment through the platform worker', { timeout: 15000 }, async t => {
  const f = await nativeWorkerFixture(t, { rowsByLocator: { '0x1000': LOOP } });
  const result = await f.invoke('checkLoopInvariant', loopQuery);
  assert.equal(result.status, 'completed'); assert.equal(result.nativeChecked.status, 'verified-fragment');
  assert.equal(result.checked.status, 'verified-model'); assert.equal(result.model.guard.upper, '9');
  assert.equal(result.binding.loopId, 'entry-counted-loop');
  assert.equal(result.capsule.nativeFragment.source.length, 24);
  assert.equal(result.capsule.nativeFragment.source.offset, '64');
  assert.equal(result.capsule.nativeFragment.source.virtualStart, '4096');
  assert.equal(result.sourceBinding, 'current-source-bytes-and-independent-fragment-correspondence');
  assert.equal(result.releaseQualified, false); assert.equal(result.canonicalTruthChanged, false);
  const rebound = await f.invoke('checkLoopInvariant', { ...loopQuery, capsule: result.capsule });
  assert.equal(rebound.capsuleRebound, true); assert.equal(rebound.nativeChecked.status, 'verified-fragment');
});

test('default native loop owner rejects unsupported loop identities and incomplete entry extents', { timeout: 15000 }, async t => {
  const f = await nativeWorkerFixture(t, { rowsByLocator: { '0x1000': LOOP.slice(0, 5) } });
  const unsupportedId = await f.invoke('checkLoopInvariant', { ...loopQuery, loopId: 'guessed-loop' });
  assert.equal(unsupportedId.reason, 'native-loop-id-unsupported'); assert.equal(f.counters.workers, 0);
  const short = await f.invoke('checkLoopInvariant', loopQuery);
  assert.equal(short.status, 'unsupported'); assert.equal(short.reason, 'native-loop-entry-fragment-unavailable');
  assert.equal(short.nativeChecked, undefined);
});

test('current-byte replacement cannot reuse a native loop capsule even when the old pipeline is cached', { timeout: 15000 }, async t => {
  const f = await nativeWorkerFixture(t, { rowsByLocator: { '0x1000': LOOP } });
  const result = await f.invoke('checkLoopInvariant', loopQuery);
  new DataView(f.data.buffer).setUint32(68, 0xf1002c1f, true); // current source now compares against 11
  const replay = await f.invoke('checkLoopInvariant', { ...loopQuery, capsule: result.capsule });
  assert.equal(replay.status, 'rejected'); assert.equal(replay.capsuleRebound, false);
  assert.equal(replay.reason, 'portable-loop-current-owner-or-model-mismatch');
});

test('service loop cancellation and owner retirement stop publication before new work', { timeout: 10000 }, async t => {
  const f = await nativeWorkerFixture(t, { rowsByLocator: { '0x1000': LOOP } });
  const controller = new AbortController(); controller.abort(new Error('test-cancel'));
  const cancelled = await f.service.invoke('checkLoopInvariant', loopQuery, { signal: controller.signal, limits: { deadlineMs: 1000 } });
  assert.equal(cancelled.value.status, 'cancelled'); assert.equal(cancelled.value.nativeChecked, undefined);
  assert.equal(f.counters.workers, 0);
  f.retire(); await assert.rejects(() => f.invoke('checkLoopInvariant', loopQuery), /scoped-service-stale/);
});

async function indexedAddress(known) {
  const f = scope(), rows = [
    ['mov', 'x9, #0x1080', 0xd2821009],
    known ? ['mov', 'x10, #1', 0xd280002a] : ['and', 'x10, x0, #1', 0x9240000a],
    ['ldr', 'x11, [x9, x10, lsl #3]', 0xf86a792b], ['blr', 'x11', 0xd63f0160], ['ret', '', 0xd65f03c0],
  ];
  const { owner, result } = captured(0x1000n, rows);
  const demand = await projectScopedDemandOwners(owner, result, { kind: 'demand', ...f, worldId: f.world.id,
    snapshotId: 'snap', producerArtifactId: 'indexed-owner', precision: { maximumValues: 64 } }, { limits: { deadlineMs: 10000 } });
  const load = owner.pipeline.semanticIr.nodes.find(node => node.kind === 'load'), addressId = load.inputs[0];
  const valueBinding = demand.ranges.bindings.find(row => row.semanticValueId === addressId);
  assert.ok(valueBinding, 'actual load address must reach the demand boundary');
  const fact = demand.ranges.values.find(row => row.localId === valueBinding.localId)?.fact;
  assert.ok(fact); return { demand, fact, owner, addressId };
}
test('indexed native addresses retain the unconstrained index rather than asserting the base is exact', { timeout: 10000 }, async () => {
  const { demand, fact, owner, addressId } = await indexedAddress(false);
  assert.equal(demand.status, 'completed'); assert.equal(demand.selectedValues.includes(addressId), true);
  assert.equal(fact.constant, null); assert.notEqual(fact.status, 'exact');
  const view = owner.pipeline.legacyV1.instructions.find(row => row.dst?.semanticValueId === addressId);
  assert.equal(view.op, 'bin'); assert.equal(view.sub, 'add'); assert.equal(view.args.length, 2);
  assert.ok(demand.ranges.values.some(row => row.fact?.congruence?.modulus === 8n));
});
test('known native index propagates through shift and address addition to base plus eight', { timeout: 10000 }, async () => {
  const { fact } = await indexedAddress(true);
  assert.equal(fact.status, 'exact'); assert.equal(BigInt(fact.constant.value), 0x1088n);
  assert.equal(fact.range.lower, 4232n); assert.equal(fact.range.upper, 4232n);
  assert.notEqual(BigInt(fact.constant.value), 0x1080n);
});

async function appleApp(t) {
  const fixture = await appleFixture(), file = new Blob([fixture.memory]);
  const capability = { architecture: 'arm64', endianness: 'little' };
  const values = { file, fileInfo: { formatId: 'macho', slices: [{ descriptor: { formatMetadata: { endian: 'little' } } }] },
    sliceIndex: 0, regions: [], capability, architecture: 'arm64' };
  let codeReads = 0;
  const app = { backend: { file, gen: 1, transportEpoch: 1, formatId: 'macho',
    binaryId: 'bin_sha256_' + createHash('sha256').update(fixture.memory).digest('hex'),
    readAt: () => { codeReads++; throw new Error('metadata-route-must-not-decode'); } },
    store: { get: key => values[key] }, projectRevision: 0,
    symbols: { revision: 1, functionCount: 0, exact: () => null },
    objcRuntime: fixture.objcIndex, objcModel: fixture.objcModel, swiftRuntime: fixture.swiftIndex };
  configureScopedAnalysisHost(app, { enabled: true }); t.after(() => disableScopedAnalysisHost(app));
  const api = new AnalysisQueryAPI(createAppAnalysisQueryAdapter(app)), snapshot = await api.scopedSnapshot();
  return { fixture, app, api, snapshot, codeReads: () => codeReads,
    query: (request, options = {}) => api.appleMetadataView(snapshot, request, { limits: { deadlineMs: 2000 }, ...options }) };
}
test('public QueryAPI -> app adapter -> service reads actual Apple parser metadata without a custom provider', { timeout: 10000 }, async t => {
  const f = await appleApp(t);
  const response = await f.query({ kind: 'swift-witness', address: '0x1000', protocolAddress: '0x2000', slot: 0 });
  assert.equal(response.value.status, 'completed'); assert.equal(response.value.records.length, 1);
  assert.equal(BigInt(response.value.records[0].address), 0x6000n);
  assert.equal(BigInt(response.value.records[0].entriesAddress), 0x4008n);
  assert.equal(response.value.snapshotId, f.snapshot.snapshotId);
  assert.equal(response.value.source.binaryId, f.app.backend.binaryId);
  assert.equal(response.value.exact, false); assert.equal(response.value.bytesRevalidated, false);
  const generic = await f.query({ kind: 'swift-generic', address: '0x1300' });
  const capture = await f.query({ kind: 'swift-capture', address: '0x5500' });
  assert.equal(generic.value.records.length, 1); assert.equal(capture.value.records.length, 1);
  assert.equal(generic.value.records[0].substitutions, null); assert.equal(capture.value.records[0].objectLayout, 'unknown');
  assert.equal(f.codeReads(), 0);
});
test('public Apple metadata route retires changed metadata owners and can create a fresh source-bound service', { timeout: 10000 }, async t => {
  const f = await appleApp(t);
  await f.query({ kind: 'swift-type' }); const prior = scopedAnalysisHost(f.app).service;
  f.app.swiftRuntime = { ...f.fixture.swiftIndex };
  await assert.rejects(() => f.query({ kind: 'swift-type' }), /scoped-service-stale/);
  assert.equal(prior.closed, true);
  const result = await f.query({ kind: 'swift-type' });
  assert.equal(result.value.records.length, 3); assert.notEqual(scopedAnalysisHost(f.app).service, prior);
});
test('public Apple metadata cancellation does not reach parser data or produce evidence', { timeout: 10000 }, async t => {
  const f = await appleApp(t), controller = new AbortController(); controller.abort(new Error('test-apple-cancel'));
  await assert.rejects(() => f.query({ kind: 'swift-type' }, { signal: controller.signal }), /test-apple-cancel|aborted|Abort/);
  assert.equal(f.codeReads(), 0); assert.equal(scopedAnalysisHost(f.app).service, null);
});
test('service Apple metadata source retirement while awaiting its owner refuses publication', { timeout: 5000 }, async t => {
  const f = scope(), fixture = await appleFixture(), context = contextFor(fixture, f);
  let release, announce, current = true;
  const entered = new Promise(resolve => { announce = resolve; }), ready = new Promise(resolve => { release = resolve; });
  context.isCurrent = () => current;
  const service = new ScopedAnalysisService({ snapshot: { snapshotId: 'snap', binaryId: f.world.binarySet[0].binaryId }, worldInput: f.world,
    host: { configuration: {}, canonicalArchitecture: 'arm64', isCurrent: () => true,
      loadPipeline: () => { throw new Error('metadata-must-not-load-function'); },
      getNativeAppleMetadataContext: async () => { announce(); await ready; return context; } } });
  t.after(() => service.close());
  const result = service.invoke('appleMetadataView', { kind: 'swift-type' }, { limits: { deadlineMs: 2000 } });
  await entered; current = false; release();
  await assert.rejects(result, /native-apple-owner-stale/);
});

test('native call graph retains nine selected functions when its Apple resolver joins real parser metadata', { timeout: 20000 }, async t => {
  const rowsByLocator = { '0x9000': [['bl', '#0x6000', 0x97fff400], ['ret', '', 0xd65f03c0]] };
  for (let i = 0; i < 8; i++) rowsByLocator['0x' + (0x6000 + i * 0x100).toString(16)] = [['ret', '', 0xd65f03c0]];
  const f = await nativeWorkerFixture(t, { rowsByLocator }), fixture = await appleFixture(), context = contextFor(fixture, f);
  // Bind the independently parsed metadata fixture to this test's native host.
  context.sourceIdentity.binaryId = f.world.binarySet[0].binaryId;
  context.sourceIdentity.sliceId = f.world.binarySet[0].sliceId;
  f.service.dispatchResolvers.register(createNativeAppleDispatchResolver({ snapshotId: 'snap', getContext: async () => context }));
  let result = await f.invoke('callGraphSlice', { functionIds: Object.keys(rowsByLocator), targetLimit: 8 });
  const calls = [...result.calls];
  for (let steps = 0; result.continuation; steps++) {
    assert.ok(steps < 20, 'the bounded nine-function scope must finish');
    result = await f.invoke('resumeCallGraphSlice', { cursor: result.continuation.cursor });
    calls.push(...result.calls);
  }
  assert.equal(calls.length, 1);
  const witness = calls[0].dispatchBound.candidates.find(row => row.family === 'swift-witness');
  assert.ok(witness, 'the default family set must retain the metadata candidate');
  assert.equal(BigInt(witness.item.value.address), 0x6000n);
  const target = calls[0].targets.find(row => row.targetFunctionId === witness.item.value.targetEntityId);
  assert.equal(target.inSelectedScope, true); assert.equal(target.exact, false); assert.equal(target.closed, false);
  assert.equal(calls[0].dispatchBound.exact, false); assert.equal(result.semanticClosure, 'unknown');
});
