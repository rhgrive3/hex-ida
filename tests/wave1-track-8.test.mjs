import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { installDemandDrivenAnalysis } from '../js/analysis/demand-driven-runtime.js';
import { createAppAnalysisQueryAdapter as createProductAdapter } from '../js/analysis/query/product-adapter.js';
import { createAppAnalysisQueryAdapter as createProductEvidenceAdapter } from '../js/analysis/query/product-evidence-adapter.js';
import { createProductSurfaceQueries } from '../js/analysis/query/product-surface.js';
import { configureScopedAnalysisHost, disableScopedAnalysisHost } from '../js/analysis/query/scoped-host.js';
import { AnalysisQueryAPI } from '../js/analysis/query/api.js';
import { functionDiscoveryArtifact, discoveryArtifactForRebuildV1 } from '../js/analysis/discovery/artifact.js';
import { createArtifactStore, createArtifactDescriptor, createArtifactBackend } from '../js/core/artifacts/index.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ============================================================================
// 1. [P0] demand-driven-runtime.js: recognitionVersion() staleness & applySlice
// ============================================================================
test('[W1-T8-1][P0] recognitionVersion reflects symbols.gen, knowledge.revision, fields, and applySlice updates after acceptedKey is set', async () => {
  let sliceIndex = 0;
  let recognitionRuns = 0;
  const app = {
    backend: { gen: 1, binaryId: 'bin-rec-1' },
    store: { get: (k) => (k === 'sliceIndex' ? sliceIndex : null) },
    symbols: { gen: 1 },
    knowledge: { revision: 1 },
    fields: { kind: 'fields-v1' },
    recognition: null,
    symbolsReady: Promise.resolve(),
    async ensureRecognition() {
      recognitionRuns++;
      app.recognition = { run: recognitionRuns };
      return app.recognition;
    },
    applySlice(nextSlice) {
      sliceIndex = nextSlice;
      app.symbolsReady = Promise.resolve();
    },
  };

  installDemandDrivenAnalysis(app);

  // First recognition succeeds and populates acceptedKey
  const rec1 = await app.ensureRecognition();
  assert.equal(rec1.run, 1);
  const snap1 = await app.analysisQueries.snapshot();
  const v1 = snap1.artifactVersions.recognitionInputs;

  // Mutating symbols.gen must change recognitionInputs immediately
  app.symbols.gen = 2;
  const snap2 = await app.analysisQueries.snapshot();
  const v2 = snap2.artifactVersions.recognitionInputs;
  assert.notEqual(v2, v1, 'symbols.gen update must change recognitionInputs version');

  // Mutating knowledge.revision must change recognitionInputs immediately
  app.knowledge.revision = 2;
  const snap3 = await app.analysisQueries.snapshot();
  const v3 = snap3.artifactVersions.recognitionInputs;
  assert.notEqual(v3, v2, 'knowledge.revision update must change recognitionInputs version');

  // Replacing app.fields must change recognitionInputs immediately
  app.fields = { kind: 'fields-v2' };
  const snap4 = await app.analysisQueries.snapshot();
  const v4 = snap4.artifactVersions.recognitionInputs;
  assert.notEqual(v4, v3, 'fields replacement must change recognitionInputs version');

  // Re-run recognition at current state (sets acceptedKey to v4's input key)
  const rec2 = await app.ensureRecognition();
  assert.equal(rec2.run, 2);

  // applySlice must clear acceptedKey and update recognitionInputs
  app.applySlice(1);
  await app.symbolsReady;
  await Promise.resolve();
  const snap5 = await app.analysisQueries.snapshot();
  const v5 = snap5.artifactVersions.recognitionInputs;
  assert.notEqual(v5, v4, 'applySlice must update recognitionInputs version');

  // Calling ensureRecognition after applySlice must re-run (acceptedKey was cleared)
  const rec3 = await app.ensureRecognition();
  assert.equal(rec3.run, 3, 'ensureRecognition must re-run after applySlice cleared acceptedKey');
});

// ============================================================================
// 2. [P1] product-adapter.js: canonicalIdentity() scopedSourceIdentity contract
// ============================================================================
test('[W1-T8-2][P1] product-adapter canonicalIdentity enforces scopedSourceIdentity contract', async () => {
  let ensureBinaryIdCalls = 0;
  let ensureAnalysisIdentityCalls = 0;
  const file = new Blob([new Uint8Array([0x7f, 0x45, 0x4c, 0x46])]);
  const app = {
    backend: {
      gen: 1,
      file,
      binaryId: 'unverified-fnv-hash',
      async ensureBinaryId() {
        ensureBinaryIdCalls++;
        return 'bin_sha256_' + 'a'.repeat(64);
      },
    },
    store: {
      get: (k) => (k === 'fileInfo' ? { sha256: 'display-only-sha256' } : k === 'file' ? file : null),
    },
    project: { binaryHash: 'project-only-hash' },
    async ensureAnalysisIdentity() {
      ensureAnalysisIdentityCalls++;
      return 'analysis-id';
    },
  };

  const adapter = createProductAdapter(app);

  // Host not enabled -> MUST reject with ANALYSIS_QUERY_SCOPED_SOURCE_UNAVAILABLE
  await assert.rejects(
    () => adapter.currentIdentity({ scopedSourceIdentity: true }),
    (err) => err?.code === 'ANALYSIS_QUERY_SCOPED_SOURCE_UNAVAILABLE',
    'disabled/unconfigured scoped host must fail closed',
  );
  assert.equal(ensureBinaryIdCalls, 0, 'scopedSourceIdentity must never invoke ensureBinaryId');
  assert.equal(ensureAnalysisIdentityCalls, 0, 'scopedSourceIdentity must never invoke ensureAnalysisIdentity');

  // Ensure Web Crypto API is available on Node 18 for scopedImmutableSourceIdentity
  const hadCrypto = Object.prototype.hasOwnProperty.call(globalThis, 'crypto');
  const prevCrypto = globalThis.crypto;
  if (!globalThis.crypto?.getRandomValues) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
  }
  try {
  // Enable scoped host -> unverified backend.binaryId & fileInfo/project hashes must NOT be trusted
  configureScopedAnalysisHost(app, { enabled: true });
  const scoped1 = await adapter.currentIdentity({ scopedSourceIdentity: true });
  assert.match(scoped1.binaryId, /^local_immutable_[0-9a-f]{32}$/, 'must use local_immutable identity when backend.binaryId is unverified');
  assert.equal(ensureBinaryIdCalls, 0, 'must not trigger full-file hashing');

  // Stable across repeated calls for the same Blob
  const scoped2 = await adapter.currentIdentity({ scopedSourceIdentity: true });
  assert.equal(scoped2.binaryId, scoped1.binaryId);

  // When backend.binaryId is a verified bin_sha256_<64 hex>, accept it
  const verifiedDigest = `bin_sha256_${'b'.repeat(64)}`;
  app.backend.binaryId = verifiedDigest;
  const scopedVerified = await adapter.currentIdentity({ scopedSourceIdentity: true });
  assert.equal(scopedVerified.binaryId, verifiedDigest);

  // Disabling scoped host rejects again
  disableScopedAnalysisHost(app);
  await assert.rejects(
    () => adapter.currentIdentity({ scopedSourceIdentity: true }),
    (err) => err?.code === 'ANALYSIS_QUERY_SCOPED_SOURCE_UNAVAILABLE',
  );
  } finally {
    if (!hadCrypto) delete globalThis.crypto;
    else Object.defineProperty(globalThis, 'crypto', { value: prevCrypto, configurable: true, writable: true });
  }
});

// ============================================================================
// 3. [P1] product-evidence-adapter.js: pagination when baseResult.page.total == null
// ============================================================================
test('[W1-T8-3][P1] product-evidence-adapter paginates suffix cleanly without infinite loop or duplicates when upstream page.total is null', async () => {
  const fnAddr = 0x1000n;
  const upstreamEvidence = [
    { id: 'up-0', kind: 'decompiler', detail: 'upstream-0' },
    { id: 'up-1', kind: 'decompiler', detail: 'upstream-1' },
  ];
  const suffixEvidence = [
    { id: 'suf-0', detail: 'suffix-0' },
    { id: 'suf-1', detail: 'suffix-1' },
    { id: 'suf-2', detail: 'suffix-2' },
    { id: 'suf-3', detail: 'suffix-3' },
    { id: 'suf-4', detail: 'suffix-4' },
  ];

  const app = {
    backend: { gen: 1, binaryId: 'bin-ev-1' },
    symbols: {
      gen: 1,
      nameAt: (a) => (BigInt(a) === fnAddr ? 'target_fn' : null),
      nameEvidence: (a) => (BigInt(a) === fnAddr ? { id: 'pre-name', source: 'symtab', verdict: 'confirmed' } : null),
      functionEvidence: () => null,
      functionAt: (a) => (BigInt(a) === fnAddr ? { start: fnAddr, end: fnAddr + 0x20n, name: 'target_fn' } : null),
    },
    // Partial decompiler result causes app-adapter.evidence() to return page.total = null
    async analyzeFunction() {
      return {
        startAddress: fnAddr,
        name: 'target_fn',
        status: { completeness: 'partial', reason: 'time-budget' },
        completeness: { complete: false, reason: 'time-budget' },
        decompiler: { evidence: upstreamEvidence },
        evidence: suffixEvidence,
        rewriteProof: [],
      };
    },
  };

  const adapter = createProductEvidenceAdapter(app);
  const snapshot = { snapshotId: 'snap-ev-1' };

  // Sequential pagination with limit=2 across prefix(1) + upstream(2, total=null) + suffix(5) = 8 rows
  const collected = [];
  let offset = 0;
  let pages = 0;
  while (offset != null) {
    pages++;
    assert.ok(pages <= 10, `pagination must terminate (infinite loop detected at page ${pages}, offset ${offset})`);
    const res = await adapter.evidence(snapshot, { functionId: fnAddr }, { offset, limit: 2 });
    collected.push(...res.value);
    offset = res.page.next;
  }

  assert.equal(collected.length, 8, 'must return all 8 rows (1 prefix + 2 upstream + 5 suffix)');
  const ids = collected.map((row) => row.evidenceId ?? row.detail);
  assert.deepEqual(ids, [
    'pre-name',
    'up-0',
    'up-1',
    'suf-0',
    'suf-1',
    'suf-2',
    'suf-3',
    'suf-4',
  ], 'rows must appear in exact order with zero duplicates');

  // Random-access jump directly into suffix on a fresh adapter with snapshot=null (exercises binary search)
  const freshAdapter = createProductEvidenceAdapter(app);
  const jumpPage = await freshAdapter.evidence(null, { functionId: fnAddr }, { offset: 4, limit: 2 });
  assert.deepEqual(
    jumpPage.value.map((row) => row.evidenceId),
    ['suf-1', 'suf-2'],
    'direct jump into suffix must not reset suffixOffset to 0',
  );
  assert.equal(jumpPage.page.next, 6);
});

// ============================================================================
// 4. [P1] product-surface.js: STRING_STATES cache key includes binaryId & backend
// ============================================================================
test('[W1-T8-4][P1] product-surface strings() isolates STRING_STATES by binaryId and backend instance', async () => {
  const cstrRegion = { id: 'cstr', section: '__cstring', cstrings: true, size: 64n, vmAddr: 0x2000n };
  let activeStrings = [{ addr: 0x2000n, text: 'alpha_binary_secret' }];
  let scanCallsA = 0;
  let scanCallsB = 0;

  const backendA = {
    gen: 1,
    binaryId: 'bin-alpha',
    strings() {
      scanCallsA++;
      return Promise.resolve({ complete: true, scannedBytes: 64, results: activeStrings });
    },
  };
  const backendB = {
    gen: 1,
    binaryId: 'bin-alpha', // Same binaryId & gen, different backend instance
    strings() {
      scanCallsB++;
      return Promise.resolve({ complete: true, scannedBytes: 64, results: [{ addr: 0x2000n, text: 'new_backend_instance_str' }] });
    },
  };

  const app = {
    backend: backendA,
    store: {
      get: (k) => (k === 'regions' ? [cstrRegion] : k === 'sliceIndex' ? 0 : null),
    },
  };
  app.analysisQueries = new AnalysisQueryAPI(createProductAdapter(app));
  const surface = createProductSurfaceQueries(app);

  // 1) Scan binary A
  const snapA = await surface.snapshot();
  const resA = await surface.strings(snapA);
  assert.deepEqual(resA.value.map((r) => r.text), ['alpha_binary_secret']);
  assert.equal(scanCallsA, 1);

  // 2) Same backend instance & same gen & same sliceIndex, but binaryId changes -> must NOT reuse stale cache
  backendA.binaryId = 'bin-beta';
  activeStrings = [{ addr: 0x2000n, text: 'beta_binary_secret' }];
  const snapBeta = await surface.snapshot();
  const resBeta = await surface.strings(snapBeta);
  assert.deepEqual(resBeta.value.map((r) => r.text), ['beta_binary_secret'], 'changed binaryId must invalidate STRING_STATES');
  assert.equal(scanCallsA, 2);

  // 3) Replace app.backend with backendB (even with same binaryId 'bin-alpha', same gen=1, same sliceIndex=0) -> must NOT reuse backendA's cache
  app.backend = backendB;
  const snapB = await surface.snapshot();
  const resB = await surface.strings(snapB);
  assert.deepEqual(resB.value.map((r) => r.text), ['new_backend_instance_str'], 'replaced backend instance must invalidate STRING_STATES');
  assert.equal(scanCallsB, 1);
});

// ============================================================================
// 5. [P1] discovery/artifact.js: functionDiscoveryArtifact forwards truncated/stopReason
// ============================================================================
test('[W1-T8-5][P1] functionDiscoveryArtifact propagates producer truncated/stopReason and withholds incomplete artifacts', () => {
  const truncatedProducer = {
    id: 'test.truncated-producer',
    architectureId: null,
    version: '1',
    produce() {
      return {
        evidence: [
          {
            kind: 'prologue-candidate',
            start: '4096',
            authority: 'heuristic',
            regions: [],
          },
        ],
        truncated: true,
        stopReason: 'budget-exhausted',
      };
    },
  };

  const result = functionDiscoveryArtifact({
    input: { image: {} },
    architectureId: 'arm64',
    producers: [truncatedProducer],
    binaryId: 'bin-disc-trunc',
    sourceHash: 'hash-disc-trunc',
    snapshotId: 'snap-disc-trunc',
  });

  assert.equal(result.status.completeness, 'truncated', 'truncated producer must yield truncated status');
  assert.equal(result.status.stopReason, 'budget-exhausted');
  assert.deepEqual(result.candidates, [], 'truncated producer must not publish candidates');
  assert.equal(result.artifact.status.completeness, 'truncated');
  assert.equal(result.artifact.status.stopReason, 'budget-exhausted');
  assert.equal(result.artifact.publication.status, 'withheld', 'incomplete discovery artifact must be withheld');
  assert.throws(
    () => discoveryArtifactForRebuildV1(result.artifact),
    /discovery-rebuild-artifact-not-publishable/,
  );

  // Also verify cancelled stopReason -> partial completeness & withheld
  const cancelledProducer = {
    id: 'test.cancelled-producer',
    architectureId: null,
    version: '1',
    produce() {
      return {
        evidence: [],
        truncated: true,
        stopReason: 'cancelled',
      };
    },
  };

  const cancelledResult = functionDiscoveryArtifact({
    input: { image: {} },
    architectureId: 'arm64',
    producers: [cancelledProducer],
    binaryId: 'bin-disc-cancel',
    sourceHash: 'hash-disc-cancel',
    snapshotId: 'snap-disc-cancel',
  });

  assert.equal(cancelledResult.status.completeness, 'partial');
  assert.equal(cancelledResult.status.stopReason, 'cancelled');
  assert.equal(cancelledResult.artifact.publication.status, 'withheld');
});

// ============================================================================
// 6. [P1] core/artifacts/store.js: #pruneEpochs() ABA prevention
// ============================================================================
function makeDescriptor(key) {
  return createArtifactDescriptor({
    binaryId: `bin-${key}`,
    kind: 'test-artifact',
    producerId: 'test.producer',
    producerVersion: '1.0.0',
    loaderVersion: '1',
    architectureSemanticVersion: '1',
    abiSemanticVersion: '1',
    semanticSchemaVersion: '1',
    config: { key },
  });
}

test('[W1-T8-6][P1] ArtifactStore prevents epoch ABA after #pruneEpochs() in quarantineObserved() and get()', async () => {
  // Part A: quarantineObserved() must reject stale observation even after A's epoch was pruned
  const storeA = createArtifactStore({ maxEpochs: 2 });
  const descA = makeDescriptor('A');
  const descB = makeDescriptor('B');
  const descC = makeDescriptor('C');
  const descD = makeDescriptor('D');

  await storeA.publish(descA, { version: 1 });
  const observedHit = await storeA.get(descA, { observeForQuarantine: true });
  assert.equal(observedHit.status, 'hit');

  // Mutate A (delete + republish with new payload)
  await storeA.delete(descA.artifactId);
  await storeA.publish(descA, { version: 2 });

  // Mutate B, C, D to force #pruneEpochs() to evict A from storeA.epochs
  await storeA.publish(descB, { v: 1 });
  await storeA.publish(descC, { v: 1 });
  await storeA.publish(descD, { v: 1 });
  assert.equal(storeA.epochs.has(descA.artifactId), false, 'A must have been pruned from epochs map');

  // Old read receipt must still be detected as superseded (no ABA reset to 0!)
  const qRes = await storeA.quarantineObserved(observedHit, { reason: 'semantic-contradiction' });
  assert.equal(qRes.status, 'stale', 'quarantineObserved must detect superseded read after epoch pruning');
  assert.equal(qRes.reason, 'quarantine-observation-superseded');

  // Newly published version 2 must remain intact and readable
  const after = await storeA.get(descA);
  assert.equal(after.status, 'hit');
  assert.deepEqual(after.payload, { version: 2 });

  // Part B: get() must detect concurrent mutation even if the key is subsequently pruned from epochs
  const baseBackend = createArtifactBackend();
  let pauseFirstGet = true;
  const readStarted = deferred();
  const releaseRead = deferred();
  const wrappedBackend = {
    ...baseBackend,
    capabilities: () => baseBackend.capabilities(),
    putAtomic: (...args) => baseBackend.putAtomic(...args),
    delete: (...args) => baseBackend.delete(...args),
    deleteIfMatches: (...args) => baseBackend.deleteIfMatches(...args),
    close: () => baseBackend.close(),
    async getRaw(id) {
      const raw = await baseBackend.getRaw(id);
      if (id === descA.artifactId && pauseFirstGet) {
        pauseFirstGet = false;
        readStarted.resolve();
        await releaseRead.promise;
        return raw; // Return stale pre-mutation bytes
      }
      return raw;
    },
  };

  const storeB = createArtifactStore({ backend: wrappedBackend, maxEpochs: 2 });
  await storeB.publish(descA, { version: 1 });
  storeB.evictHot(); // Force persistent/backend read path

  const getPromise = storeB.get(descA);
  await readStarted.promise;

  // Concurrently mutate A and prune A's epoch entry by mutating B, C, D
  await storeB.delete(descA.artifactId);
  await storeB.publish(descA, { version: 2 });
  await storeB.publish(descB, { v: 1 });
  await storeB.publish(descC, { v: 1 });
  await storeB.publish(descD, { v: 1 });
  assert.equal(storeB.epochs.has(descA.artifactId), false, 'A must be pruned while get() is paused');

  // Release the stale backend read
  releaseRead.resolve();
  const freshHit = await getPromise;
  assert.equal(freshHit.status, 'hit');
  assert.deepEqual(freshHit.payload, { version: 2 }, 'get() must retry and return post-mutation payload');
  assert.ok(storeB.metrics.mutationRetries >= 1, 'get() must record a mutation retry after epoch-pruned concurrent write');

  // Part C: Unrelated mutation without pruning must NOT falsely mark quarantineObserved as stale
  const storeC = createArtifactStore({ maxEpochs: 16 });
  await storeC.publish(descA, { version: 1 });
  const hitA = await storeC.get(descA, { observeForQuarantine: true });
  await storeC.publish(descB, { v: 1 });
  const qOk = await storeC.quarantineObserved(hitA, { reason: 'semantic-contradiction' });
  assert.equal(qOk.status, 'quarantined', 'unrelated mutation must not falsely supersede quarantineObserved');
});

// ============================================================================
// 7. [P2] product-surface.js: scanNextStringRegion() immediate-abort no unhandled rejection
// ============================================================================
test('[W1-T8-7][P2] scanNextStringRegion attaches rejection handler on immediate abort so no unhandledRejection fires', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    const controller = new AbortController();
    const cstrRegion = { id: 'cstr', section: '__cstring', cstrings: true, size: 64n, vmAddr: 0x2000n };

    const app = {
      backend: {
        gen: 1,
        binaryId: 'bin-abort-1',
        strings() {
          const gate = deferred();
          const req = gate.promise;
          req.cancel = () => {
            const err = new Error('cancelled-by-immediate-abort');
            err.name = 'AbortError';
            gate.reject(err);
          };
          // Simulate abort racing synchronously between outer abort check and waiter registration
          controller.abort();
          return req;
        },
      },
      store: {
        get: (k) => (k === 'regions' ? [cstrRegion] : k === 'sliceIndex' ? 0 : null),
      },
    };
    app.analysisQueries = new AnalysisQueryAPI(createProductAdapter(app));
    const surface = createProductSurfaceQueries(app);
    const snapshot = await surface.snapshot();

    await assert.rejects(
      () => surface.strings(snapshot, {}, {}, { signal: controller.signal }),
      (err) => err?.name === 'AbortError',
    );

    // Flush microtasks and macrotasks so any unhandled rejection would surface
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(unhandled.length, 0, `expected 0 unhandled rejections, got ${unhandled.length}`);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
