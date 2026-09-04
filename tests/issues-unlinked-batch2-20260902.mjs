// Regressions for the second unlinked-issue batch: one block per issue number.
import assert from 'node:assert/strict';
import test from 'node:test';

// #3308 — autoAnalyze callbacks callable-only; #3286 budgets primitive numbers.
{
  const { autoAnalyze } = await import('../js/auto.js');
  const events = [];
  const report = await autoAnalyze({ strings: [], onProgress: true, isCancelled: {} });
  assert.ok(report, 'truthy non-function callbacks must not raise');
  const report2 = await autoAnalyze({
    strings: [],
    onProgress: (e) => events.push(e),
    pinpointFieldBudget: ['7'],
    pinpointBudget: {},
    pinpointPerGoal: true,
  });
  assert.ok(report2, 'structured budgets must fall back instead of NaN-poisoning');
  assert.ok(Number.isFinite(report2.stats.pinpointUsed ?? 0), 'no NaN poisoning from structured budgets');
  const report3 = await autoAnalyze({ strings: [], pinpointFieldBudget: 3 });
  assert.ok(Number.isFinite(report3.stats.pinpointUsed ?? 0), 'numeric budget stays finite');
  // With goals present the budget bookkeeping stays finite under structured input.
  const report4 = await autoAnalyze({ strings: ['x'.repeat(8)], pinpointBudget: ['360'], pinpointPerGoal: [24] });
  assert.ok(Number.isFinite(report4.stats.pinpointUsed ?? 0), 'structured budgets fall back and stay finite');
}

// #3310 — analyzeFunction progress callbacks callable-only.
{
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../js/analyze.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /if \(onProgress\) onProgress\(/, 'truthiness guard must be callable-typed');
  assert.match(source, /typeof onProgress === 'function' \? onProgress|typeof onProgress === 'function'\) onProgress/);
}

// #3313 — request.received fires once per external request.
{
  const { AnalysisScheduler } = await import('../js/core/scheduler/analysis-scheduler.js');
  const events = [];
  const store = { async get() { return { status: 'miss' }; }, async publish() { return { status: 'stored' }; } };
  const scheduler = new AnalysisScheduler({ store, onEvent: (e) => events.push(e) });
  await scheduler.request({
    descriptor: { artifactId: 'parent', upstreamArtifactIds: ['dep'] },
    dependencies: [{ descriptor: { artifactId: 'dep', upstreamArtifactIds: [] }, async produce() { return {}; } }],
    async produce() { return {}; },
  });
  const received = events.filter((e) => e.type === 'request.received').map((e) => e.artifactId);
  assert.deepEqual(received, ['parent'], 'dependency recursion must not re-announce request.received');
}

// #3312 — lifecycle envelope carries version/running/queued.
{
  const { AnalysisScheduler } = await import('../js/core/scheduler/analysis-scheduler.js');
  const events = [];
  const store = { async get() { return { status: 'miss' }; }, async publish() { return { status: 'stored' }; } };
  const scheduler = new AnalysisScheduler({ store, onEvent: (e) => events.push(e) });
  await scheduler.request({
    descriptor: { artifactId: 'a', upstreamArtifactIds: [] },
    async produce() { return {}; },
  });
  for (const event of events) {
    assert.equal(event.version, 1, `${event.type} must carry schema version`);
    assert.equal(typeof event.running, 'number');
    assert.equal(typeof event.queued, 'number');
  }
}

// #3311 — analyzeFunctionCached region identity resists structured collisions.
{
  const { analyzeFunctionCached, clearAnalysisCache } = await import('../js/analyze.js');
  clearAnalysisCache();
  let calls = 0;
  const backend = { fetchChunk: async () => { calls++; return { mn: ['nop'], ops: [''], bytes: new Uint8Array(4) }; } };
  await analyzeFunctionCached(backend, { id: 'r', vmAddr: 1n, size: 4n, revision: 0 }, 0, 0, null, null, { texts: false });
  await analyzeFunctionCached(backend, { id: 'r', vmAddr: ['1'], size: ['4'], revision: 0 }, 0, 0, null, null, { texts: false });
  assert.equal(calls, 2, 'structured region must not reuse the primitive region cache entry');
}

// #3309 — memoizeAnalysis address identity resists structured collisions.
{
  const { memoizeAnalysis } = await import('../js/auto.js');
  let calls = 0;
  const memoized = memoizeAnalysis(async () => { calls++; return { ok: true }; });
  await memoized(1n, null);
  await memoized(['1'], null);
  assert.equal(calls, 2, 'structured address must not alias the bigint address cache key');
  await memoized(1n, null);
  assert.equal(calls, 2, 'primitive address still hits the cache');
}

// #3344 — EvidenceStore.ingestPlan exact-identity verified authority.
{
  const { EvidenceStore } = await import('../js/ai/evidence.js');
  const store = new EvidenceStore();
  store.ingestPlan({
    best: { address: '0x1000' },
    candidates: [{
      address: ['0x1000'],
      verification: { verified: true, evidenceIds: ['ev1'] },
      evidence: [['ev1']],
      score: 1,
    }],
  });
  assert.equal(store.all().some((row) => row.status === 'verified'), false,
    'structured lookalike must not launder DETERMINISTIC_VERIFICATION authority');
  const store2 = new EvidenceStore();
  store2.ingestPlan({
    best: { address: '0x1000' },
    candidates: [{
      address: '0x1000',
      verification: { verified: true, evidenceIds: ['ev1'] },
      evidence: ['ev1'],
      score: 1,
    }],
  });
  assert.equal(store2.all().some((row) => row.status === 'verified'), true,
    'canonical identity keeps verified authority');
}

// #3340 — derived adapters delegate specified falsy ids to base validation.
{
  const { SymbolicAdapter, RemoteDebugAdapter, LocalFunctionSandboxAdapter } = await import('../js/adapters/index.js');
  for (const bad of [false, 0, '']) {
    assert.throws(() => new SymbolicAdapter({ id: bad }), (e) => e.code === 'invalid-adapter-id');
    assert.throws(() => new LocalFunctionSandboxAdapter(null, { id: bad }), (e) => e.code === 'invalid-adapter-id');
    assert.throws(() => new RemoteDebugAdapter({}, { id: bad }), (e) => e.code === 'invalid-adapter-id');
  }
  assert.equal(new SymbolicAdapter({}).id != null, true, 'unset id still takes the default');
  assert.equal(new LocalFunctionSandboxAdapter(null, {}).id, 'local-function-sandbox');
  const remoteTransport = { send: async () => ({}), onMessage: () => () => {}, close: () => {} };
  assert.equal(new RemoteDebugAdapter(remoteTransport, {}).id, 'remote-debug');
}

// #3324 — artifact records require canonical descriptors.
{
  const { createArtifactRecord, createArtifactDescriptor, encodeArtifactPayload, validateArtifactRecord, ArtifactError } = await import('../js/core/artifacts/contracts.js');
  const forged = {
    artifactId: 'artifact_forged', artifactKind: 'analysis', producerId: 'fake', producerVersion: '1',
    versions: { semanticSchema: '1' }, upstreamArtifactIds: [], binaryId: 'bin', sliceId: null,
    entityId: null, runtimeSnapshotId: null, originRefs: [], canonicalConfigHash: 'fake',
  };
  assert.throws(() => createArtifactRecord(forged, encodeArtifactPayload({ ok: true })), ArtifactError);
  const real = createArtifactDescriptor({
    binaryId: 'bin', artifactKind: 'analysis', producerId: 'p', producerVersion: '1',
    versions: { loader: 'n/a', architectureSemantic: 'n/a', abiSemantic: 'n/a', semanticSchema: '1.0.0' },
    upstreamArtifactIds: [], originRefs: [],
  });
  const payload = encodeArtifactPayload({ ok: true });
  const record = createArtifactRecord(real, payload);
  assert.equal(validateArtifactRecord(record, payload), true);
}

// #3301 — remote writeMemory rejects structured written counts.
{
  const { RemoteDebugAdapter } = await import('../js/adapters/index.js');
  let receiver = () => {};
  const transport = {
    send: async (packet) => {
      if (packet.type !== 'request') return;
      if (packet.method === 'connect') queueMicrotask(() => receiver({ version: 1, type: 'response', id: packet.id, epoch: packet.epoch, result: { capabilities: { writeMemory: true } } }));
      if (packet.method === 'writeMemory') queueMicrotask(() => receiver({ version: 1, type: 'response', id: packet.id, epoch: packet.epoch, result: { written: ['1'] } }));
    },
    onMessage: (fn) => { receiver = fn; return () => {}; },
    close: () => {},
  };
  const adapter = new RemoteDebugAdapter(transport, { capabilities: { writeMemory: true } });
  await adapter.connect();
  await assert.rejects(
    () => adapter.writeMemory(0x1000, new Uint8Array([0x41])),
    (e) => e.code === 'malformed-remote',
  );
}

// #3300 — replay readMemory size shares the strict contract.
{
  const { ReplayAdapter } = await import('../js/adapters/index.js');
  const adapter = new ReplayAdapter({ memory: { '4096': [1, 2] } });
  for (const bad of [['1'], '1', true, {}]) {
    await assert.rejects(() => adapter.readMemory(4096, bad), (e) => e.code === 'invalid-size');
  }
  const bytes = await adapter.readMemory(4096, 2);
  assert.equal(bytes.length, 2);
}

// #3339 — address-provenance boundaries reject bare strings.
{
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../js/address-provenance.js', import.meta.url), 'utf8');
  assert.match(source, /address-provenance-boundary-collection-required/);
  assert.doesNotMatch(source, /Array\.from\(opts\.functionStarts/, 'string iterable decomposition must be gone');
  assert.doesNotMatch(source, /Array\.from\(opts\.branchEntries/);
}

// #3285 — AAPCS64 parameter metadata authorities are primitive numbers.
{
  const { classifyCallArguments } = await import('../js/architecture/compat/ir-core-arm64-aapcs64-v1.js');
  const good = classifyCallArguments({ callPrototype: { args: [{ type: 'float', hfa: true, members: 4, bits: 32 }] } }, {});
  assert.deepEqual(good.arguments[0].regs, ['v0', 'v1', 'v2', 'v3']);
  assert.equal(good.arguments[0].bits, 32);
  const bad = classifyCallArguments({ callPrototype: { args: [{ type: 'float', hfa: true, members: ['4'], bits: ['32'] }] } }, {});
  assert.notDeepEqual(bad.arguments[0].regs, ['v0', 'v1', 'v2', 'v3'], 'structured metadata must not mint a 4-register HFA');
}

// #3276 — ObjC dispatch IMP is canonical-address evidence.
{
  const { buildObjcRuntimeIndex, resolveObjcDispatch } = await import('../js/apple/objc-runtime.js');
  const index = buildObjcRuntimeIndex({
    runtimeCompleteness: { categories: { complete: true } },
    classes: [{ name: 'A', methods: [{ selector: 'f', addr: ['4096'] }] }],
  });
  const result = resolveObjcDispatch(index, { receiverType: 'A', selector: 'f' });
  assert.equal(result.resolved, null, 'structured IMP must not resolve dispatch');
  const good = buildObjcRuntimeIndex({
    runtimeCompleteness: { categories: { complete: true } },
    classes: [{ name: 'B', methods: [{ selector: 'f', imp: 4096 }] }],
  });
  const ok = resolveObjcDispatch(good, { receiverType: 'B', selector: 'f' });
  assert.ok(ok.resolved, 'canonical IMP still resolves');
}

// #3272 — AAPCS64 C.3: HFA stack spill sets NSRN to 8.
{
  const { classifyCallArguments } = await import('../js/architecture/compat/ir-core-arm64-aapcs64-v1.js');
  const proto = { args: [
    { abiClass: 'float', bits: 64 }, { abiClass: 'float', bits: 64 },
    { abiClass: 'float', bits: 64 }, { abiClass: 'float', bits: 64 },
    { abiClass: 'float', bits: 64 }, { abiClass: 'float', bits: 64 },
    { abiClass: 'hfa', members: 3, bits: 64 },
    { abiClass: 'float', bits: 64 },
  ] };
  const result = classifyCallArguments({ callPrototype: proto }, {});
  assert.equal(result.arguments[7].location, 'stack', 'post-spill FP arguments must go to the stack');
  const normal = classifyCallArguments({ callPrototype: { args: [{ abiClass: 'float', bits: 64 }, { abiClass: 'float', bits: 64 }] } }, {});
  assert.equal(normal.arguments[1].reg, 'v1', 'the non-spill path is unchanged');
}

// #3304 — open(2)/openat(2) no longer label a definite variadic mode.
{
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../js/blocks-base.js', import.meta.url), 'utf8');
  const openEntry = source.match(/\{ id:'open',[^}]*\}/)?.[0] ?? '';
  assert.match(openEntry, /args:\['path','flags'\]/, 'open(2) table must not claim a definite mode argument');
  const openatEntry = source.match(/\{ id:'openat',[^}]*\}/)?.[0] ?? '';
  assert.match(openatEntry, /args:\['dirfd','path','flags'\]/);
}

// #3427 — InvestigationService scheduler priority is string-only authority.
{
  const { InvestigationService, __investigationInternalsForTests } = await import('../js/analysis/investigation-service.js');
  const { priorityOf } = __investigationInternalsForTests;
  for (const value of ['user-blocking', 'user-visible', 'background']) {
    assert.equal(priorityOf({ priority:value }), value, `canonical priority ${value} must be preserved`);
  }
  for (const value of [['user-blocking'], ['background'], {}, 2, true, false, null, undefined, 'unknown']) {
    assert.equal(priorityOf({ priority:value }), 'user-visible', `malformed priority ${String(value)} must use fallback`);
  }

  const observed = [];
  const app = {
    symbols: {},
    codeRegion: () => ({ id:'text', vmAddr:0n, size:4n, exec:true }),
    ensureFunctions: async (_region, options) => { observed.push(options.priority); return {}; },
  };
  const service = new InvestigationService(app);
  await service.discoverFunctions({ priority:['user-blocking'] });
  await service.discoverFunctions({ priority:'background' });
  assert.deepEqual(observed, ['user-visible', 'background'], 'discoverFunctions must forward only canonical scheduler priorities');
}

console.log('unlinked batch2 regressions: PASS');
