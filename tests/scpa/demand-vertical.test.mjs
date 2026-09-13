import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeWorkerFixture } from './native-worker-fixture.mjs';

const query = { query: { scope: { functionIds: ['0x1000', '0x2000'] },
  select: { op: 'eq', field: 'kind', value: 'store' }, resultLimit: 16 } };
const limits = { residentBytes: 64 * 1024 * 1024 };
async function complete(f, input = query, method = 'demandQuery') {
  let value = await f.invoke(method, input, limits);
  for (let step = 0; value.continuation && step < 64; step++) {
    assert.equal(value.answer, null, 'a partial session must not leak a published answer');
    value = await f.invoke('resumeDemandQuery', { cursor: value.continuation.cursor }, limits);
  }
  assert.equal(value.executionStatus, 'completed'); assert.equal(value.resumable, false);
  assert.equal(value.publication?.status, 'published'); assert.ok(value.answer);
  return value;
}

test('real ARM64 worker demand slice publishes conditional precision and byte evidence without global leakage', { timeout: 18000 }, async t => {
  const f = await nativeWorkerFixture(t), value = await complete(f);
  assert.equal(value.answer.existence, 'POSSIBLE'); assert.equal(value.answer.exact, false);
  assert.equal(value.answer.precision.summarySpecializations.length, 1);
  const context = value.answer.precision.summarySpecializations[0];
  const refined = context.valueProjection.values.filter(row => row.fact?.constant?.value === '1' || row.fact?.constant?.value === 1n);
  assert.ok(refined.length >= 2, 'the existing SCCP actually propagates beyond the entry argument');
  assert.ok(refined.every(row => row.conditionalOn.length > 0));
  assert.ok(value.answer.precision.valueFacts.filter(row => refined.some(r => r.localId === row.localId))
    .some(row => row.fact?.constant == null), 'unconditioned owner remains unknown');
  assert.equal(context.valueProjection.cost, undefined, 'timing cannot enter context identity');
  assert.ok(value.answer.dependencies.reads.some(row => row.polarity === 'negative-membership'));
  const replay = await f.invoke('replayDemandResult', { artifactId: value.publication.artifactId }, limits);
  assert.equal(replay.integrity, 'verified'); assert.equal(replay.byteBinding, 'verified');
  assert.equal(replay.semantic, 'unknown'); assert.equal(replay.quarantine, null);
  const graph = await f.invoke('explainDemandResult', { artifactId: value.publication.artifactId, view: 'graph' }, limits);
  assert.ok(graph.graph.nodes.some(row => row.family === 'BinaryEvidence'));
  assert.ok(graph.graph.nodes.some(row => row.payload?.owner === 'analysis/summary/specialization'));
});

test('all three typed templates execute the production demand pipeline and yield owner-backed inspection frontiers', { timeout: 25000 }, async t => {
  const f = await nativeWorkerFixture(t);
  for (const [template, left, right] of [['source-to-sink', 'source', 'sink'], ['allocation-null-guard', 'allocation', 'guard'], ['length-to-buffer-use', 'length', 'bufferUse']]) {
    const value = await complete(f, { template, functionIds: ['0x1000', '0x2000'],
      anchors: { [left]: { op: 'all' }, [right]: { op: 'eq', field: 'kind', value: 'store' } }, resultLimit: 2 }, 'investigateDemand');
    assert.equal(value.answer.investigation.template, template); assert.equal(value.answer.upper.kind, 'TOP');
    const frontier = await f.invoke('demandInvestigationFrontier', { artifactId: value.publication.artifactId, maximumActions: 4 });
    assert.equal(frontier.complete, false); assert.ok(frontier.obligations.length > 0);
    assert.ok(frontier.frontier.actions.length > 0);
    assert.ok(frontier.frontier.actions.every(row => row.executable === false && row.automaticDispatch === false));
  }
});

test('changed source bytes quarantine the observed answer, not UNKNOWN proof results', { timeout: 18000 }, async t => {
  const f = await nativeWorkerFixture(t), value = await complete(f);
  f.data[64] ^= 1;
  const replay = await f.invoke('replayDemandResult', { artifactId: value.publication.artifactId }, limits);
  assert.equal(replay.semantic, 'rejected'); assert.equal(replay.quarantine?.status, 'quarantined');
  assert.equal(replay.quarantine?.persistentWithdrawal, true);
  const explain = await f.invoke('explainDemandResult', { artifactId: value.publication.artifactId });
  assert.equal(explain.status, 'quarantined');
});

test('negative membership invalidation rejects retained cursors and published answers', { timeout: 18000 }, async t => {
  const f = await nativeWorkerFixture(t), value = await complete(f);
  f.service.dependencies.reset('late-function-and-image');
  const stale = await f.invoke('explainDemandResult', { artifactId: value.publication.artifactId });
  assert.equal(stale.status, 'miss');
  const active = await f.invoke('demandQuery', query, limits); assert.ok(active.continuation);
  f.service.dependencies.reset('late-target');
  await assert.rejects(() => f.invoke('resumeDemandQuery', { cursor: active.continuation.cursor }, limits), /session-unavailable|stale/);
});

test('cancelled continuation cannot resume or publish partial demand state', { timeout: 8000 }, async t => {
  const f = await nativeWorkerFixture(t), active = await f.invoke('demandQuery', query, limits);
  assert.ok(active.continuation); assert.equal(active.answer, null);
  await f.invoke('cancelScopedQuery', { cursor: active.continuation.cursor });
  await assert.rejects(() => f.invoke('resumeDemandQuery', { cursor: active.continuation.cursor }, limits), /session-unavailable|stale/);
  assert.equal(f.backend._artifactRuntime().store.metrics.quarantines, 0);
});


test('native ABI placement uses the registered current function owner without a host callback', { timeout: 12000 }, async t => {
  const f = await nativeWorkerFixture(t);
  const value = await f.invoke('abiPlacementEvidence', { functionId: '0x2000', kind: 'arguments' }, limits);
  assert.equal(value.native, true); assert.equal(value.status, 'partial'); assert.equal(value.exact, false);
  assert.equal(value.canonicalOwner.abiId, 'aapcs64'); assert.equal(value.binding.snapshotId, 'snap');
  assert.ok(value.results.every(row => row.staticExact === false));
  assert.ok(value.results.some(row => row.status === 'unresolved'), 'absence of a prototype stays unresolved');
});

test('native block field candidates use actual stack stores, MemorySSA and current SSA capture references', { timeout: 18000 }, async t => {
  const mov = (reg, immediate) => ['mov', `x${reg}, #${immediate}`, (0xd2800000 | immediate << 5 | reg) >>> 0];
  const store = (reg, offset, bits = 64) => ['str', `${bits === 64 ? 'x' : 'w'}${reg}, [sp${offset ? `, #${offset}` : ''}]`,
    ((bits === 64 ? 0xf9000000 : 0xb9000000) | (offset / (bits / 8)) << 10 | 31 << 5 | reg) >>> 0];
  const rows = [mov(9, 0x8000), store(9, 0), mov(9, 0), store(9, 8, 32), store(9, 12, 32),
    mov(9, 0x2000), store(9, 16), mov(9, 0x8800), store(9, 24), store(0, 32), ['ret', '', 0xd65f03c0]];
  const f = await nativeWorkerFixture(t, { rowsByLocator: { '0x1000': rows } });
  const value = await complete(f, { query: { scope: { functionIds: ['0x1000'] },
    select: { op: 'eq', field: 'kind', value: 'store' }, resultLimit: 1 }, precision: { maximumValues: 64 } });
  const blocks = value.answer.precision.blockCaptures.flatMap(row => row.views);
  assert.ok(blocks.length > 0, 'automatic native candidate lane reaches the existing Block recognizer');
  const block = blocks.find(row => row.captures.some(field => field.offset === 32));
  assert.ok(block); assert.equal(block.recognition, 'unqualified-layout-candidate');
  assert.ok(block.captures[0].nodeReference); assert.ok(block.captures[0].memoryReference);
  assert.equal(block.exact, false); assert.equal(block.noCapturesProven, false);
  const direct = await f.invoke('blockCaptures', { functionId: '0x1000', blockValueId: block.binding.blockValueId }, limits);
  assert.equal(direct.status, 'completed'); assert.ok(direct.captures.some(field => field.offset === 32));
});

test('computed register targets reach existing SCC summaries, specialization and unified dispatch without closing the world', { timeout: 18000 }, async t => {
  const rowsByLocator = {
    '0x1000': [['mov', 'x9, #0x1ff0', 0xd283fe09], ['add', 'x9, x9, #0x10', 0x91004129],
      ['mov', 'x0, #7', 0xd28000e0], ['blr', 'x9', 0xd63f0120], ['ret', '', 0xd65f03c0]],
    '0x2000': [['str', 'x0, [sp]', 0xf90003e0], ['ret', '', 0xd65f03c0]],
  };
  const f = await nativeWorkerFixture(t, { rowsByLocator }), value = await complete(f);
  const context = value.answer.precision.summarySpecializations.find(row => row.targetBinding.source === 'native-range-to-selected-entry');
  assert.ok(context, 'the existing Phase8 result binds the selected call context');
  assert.ok(context.valueProjection.values.some(row => String(row.fact?.constant?.value) === '7'));
  assert.ok(value.answer.precision.dispatchBounds.some(bound => bound.candidates.some(row => row.provenance?.declaration.reference.source === 'native-range-to-selected-entry')));
  assert.ok(value.answer.precision.dispatchBounds.every(bound => bound.exact === false));
  const graph = await f.invoke('explainDemandResult', { artifactId: value.publication.artifactId, view: 'graph' }, limits);
  assert.ok(graph.graph.nodes.some(row => row.payload?.summary?.functionId === context.callerFunctionId
    && row.payload.summary.unknownCallEffects.length > 0), 'unknown caller effects survive the candidate link');
});

test('selected call context substitutes actual canonical parameter roots into memory effects', { timeout: 18000 }, async t => {
  const f = await nativeWorkerFixture(t, { rowsByLocator: {
    '0x1000': [['add', 'x0, sp, #0', 0x910003e0], ['mov', 'x1, #5', 0xd28000a1], ['bl', '#0x2000', 0x940003fe], ['ret', '', 0xd65f03c0]],
    '0x2000': [['str', 'x1, [x0, #8]', 0xf9000401], ['ret', '', 0xd65f03c0]],
  } });
  const value = await complete(f), context = value.answer.precision.summarySpecializations[0];
  assert.ok(context);
  assert.ok(context.writes.some(row => row.instantiated.some(effect => effect.minimumOffset === '8'
    && effect.maximumOffset === '8' && effect.aliasAuthority === false)), 'caller object receives the callee relative access candidate');
  assert.ok(context.writes.every(row => row.upper === 'TOP'), 'lifetime and open effects cannot become exact');
});

test('native knowledge query consumes the current fingerprint owner and KnowledgeDB without accepting collision identities', { timeout: 15000 }, async t => {
  const { KnowledgeDB } = await import('../../js/knowledge/index.js');
  const database = new KnowledgeDB({ indexedDB: null });
  const candidate = { architecture: 'arm64', bytes: new Uint8Array([0x20, 0, 0x80, 0xd2, 0xff, 3, 0, 0x94, 0xc0, 3, 0x5f, 0xd6]),
    address: 0x1000n, name: 'fixture-name' };
  await database.remember({ ...candidate, id: 'a', sourceBinaryHash: 'fixture-only-source', name: 'collision-a' });
  await database.remember({ ...candidate, id: 'b', sourceBinaryHash: 'fixture-only-source', name: 'collision-b' });
  const f = await nativeWorkerFixture(t, { knowledgeOwner: database });
  const result = await f.invoke('knowledgeMatches', { functionId: '0x1000', maxCandidates: 4 }, limits);
  assert.equal(result.status, 'completed'); assert.equal(result.candidates.length, 2); assert.equal(result.exact, false);
  assert.ok(result.collisions.length > 0); assert.equal(result.upperBound.kind, 'top');
  assert.ok(result.candidates.every(row => row.exactIdentity === false && row.metadataTransferAllowed === false));
  assert.equal(result.inputIdentity.revision, '2');
  assert.equal(result.capsule.schema, 'match-capsule/v1');
  assert.equal(result.capsule.candidates.length, 2);
  assert.equal(result.capsule.transferableClaims.length, 0);
  assert.ok(result.capsule.collisionSet.length >= 2);
  assert.ok(result.capsule.candidates.every(row => row.constraints.unknown.length >= 4));
  await database.clear();
  const empty = await f.invoke('knowledgeMatches', { functionId: '0x1000', maxCandidates: 4 }, limits);
  assert.equal(empty.candidates.length, 0); assert.equal(empty.existence, 'UNKNOWN'); assert.equal(empty.inputIdentity.revision, '3');
});

test('native-best model-free adapter uses the same production service, evidence replay and finite cancellation', { timeout: 22000 }, async t => {
  const { ScopedNativeBestAdapter } = await import('../../js/analysis/benchmark/scoped-native-adapter.js');
  const f = await nativeWorkerFixture(t), adapter = new ScopedNativeBestAdapter(f.service, {
    caseId: 'fixture-only', snapshotId: 'snap', worldId: f.service.worldId, baselineCommit: '6'.repeat(40) });
  const caps = await adapter.capabilities(); assert.equal(caps.oracleAuthority, false);
  const value = await adapter.query({ kind: 'demand', request: query }, { deadlineMs: 18000, limits });
  assert.equal(value.status, 'completed'); assert.equal(value.result.publication.status, 'published');
  assert.equal(value.measurements.correctness, 'UNMEASURED'); assert.equal(value.measurements.sameAstra, 'UNMEASURED');
  const replay = await adapter.explain({ level: 'integrity' }); assert.equal(replay.replay.byteBinding, 'verified');
  const cut = await adapter.query({ kind: 'demand', request: query }, { maximumSteps: 1, limits });
  assert.equal(cut.status, 'partial'); assert.ok(cut.result.continuation);
  await assert.rejects(() => f.invoke('resumeDemandQuery', { cursor: cut.result.continuation.cursor }), /session-unavailable/);
  const after = await adapter.query({ kind: 'demand', request: query }, { maximumSteps: 1, limits });
  assert.equal(after.status, 'partial');
});

test('actual loader fixup declaration joins a canonical load to native DispatchBound without authentication or memory truth', { timeout: 18000 }, async t => {
  // This is an isolated production-owner integration fixture, not a full
  // Mach-O file/device admission or a dyld execution experiment.
  const { ByteView } = await import('../../js/binary/reader.js');
  const { parseChainedBindingSites, machOPointerMetadataRevision } = await import('../../js/binary/macho-dyld.js');
  const { queryMachOPointerView } = await import('../../js/analysis/apple/scoped-metadata.js');
  let f, image, calls = 0;
  const hook = async (request, context) => {
    calls++;
    const result = await queryMachOPointerView(request, { ...context, snapshotId: 'snap', getContext: () => ({
      image, worldId: context.world.id, snapshotId: 'snap', binaryId: f.world.binarySet[0].binaryId,
      sliceId: f.world.binarySet[0].sliceId, artifactId: 'test-loader-owned-record', loaderRevision: machOPointerMetadataRevision(image),
      storageAddress: '6144', rawValue: '8192', byteBinding: 'host-read-current-source', evidenceIds: ['test-pointer-source'], isCurrent: () => true }) });
    return { ...result, byteSource: { worldId: context.world.id, snapshotId: 'snap', binaryId: result.source.binaryId,
      loaderRevision: result.source.loaderRevision, offset: '2112', length: 8, bytes: [...f.data.slice(2112, 2120)] } };
  };
  f = await nativeWorkerFixture(t, { queryNativeApplePointer: hook, rowsByLocator: {
    '0x1000': [['mov', 'x9, #0x1800', 0xd2830009], ['ldr', 'x10, [x9]', 0xf940012a], ['blr', 'x10', 0xd63f0140], ['ret', '', 0xd65f03c0]],
    '0x2000': [['str', 'x0, [sp]', 0xf90003e0], ['ret', '', 0xd65f03c0]],
  } });
  const v = new DataView(f.data.buffer), base = 0xc00;
  v.setBigUint64(2112, 8192n, true); v.setUint32(base + 4, 28, true); v.setUint32(base + 28, 1, true);
  v.setUint32(base + 32, 8, true); v.setUint32(base + 36, 24, true); v.setUint16(base + 40, 0x1000, true);
  v.setUint16(base + 42, 2, true); v.setUint16(base + 56, 1, true); v.setUint16(base + 58, 0x800, true);
  image = { imageBase: 4096n, metadata: {}, warnings: [], segments: [{ address: 4096n, size: 8192n,
    fileOffset: 64n, fileSize: BigInt(f.data.length - 64) }], addressToOffset: address => address - 4096n + 64n };
  const parsed = parseChainedBindingSites(new ByteView(f.data), { offset: base, size: 0x80 }, image, []);
  assert.equal(parsed.bindingSitesComplete, true, image.warnings.join('; '));
  const result = await complete(f);
  assert.ok(calls > 0, 'actual canonical load navigation reaches the existing loader owner');
  const candidates = result.answer.precision.dispatchBounds.flatMap(row => row.candidates);
  const target = candidates.find(row => row.provenance?.declaration?.pointerView);
  assert.ok(target, 'actual recorded pointer candidate survives unified dispatch');
  assert.ok(target.requirements.includes('memory-content-stability-not-proven'));
  assert.equal(target.provenance.declaration.pointerView.pointer.executionTargetExact, false);
  const replay = await f.invoke('replayDemandResult', { artifactId: result.publication.artifactId, level: 'integrity' }, limits);
  assert.equal(replay.byteBinding, 'verified');
  f.data[2112] ^= 1;
  const changed = await f.invoke('replayDemandResult', { artifactId: result.publication.artifactId, level: 'integrity' }, limits);
  assert.equal(changed.semantic, 'rejected');
  assert.ok(changed.rejected.some(row => row.reason === 'byte-content-mismatch'));
  assert.equal(changed.quarantine?.status, 'quarantined');
});
