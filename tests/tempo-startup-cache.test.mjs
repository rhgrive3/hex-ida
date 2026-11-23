import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalContentDigest } from '../js/analysis/binary-identity-digest.js';
import { installDemandDrivenAnalysis } from '../js/analysis/demand-driven-runtime.js';
import { AnalysisCache } from '../js/cache/analysis-cache.js';
import {
  ArtifactAnalysisOrchestrator,
  createWorkerAnalysisArtifactDescriptor,
} from '../js/cache/artifact-orchestration.js';
import { createArtifactStore } from '../js/core/artifacts/index.js';
import { AnalysisScheduler } from '../js/core/scheduler/analysis-scheduler.js';
import { AnalysisResumeStore } from '../js/cache/analysis-resume.js';
import { SymbolIndex } from '../js/symbols.js';
import { findings, notableFunctions } from '../js/auto.js';

function createKeyValueIndexedDB() {
  const records = new Map();
  const putKeys = [];
  const writeTransactions = [];
  let created = false;
  function request(result, tx = null) {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      req.result = result;
      req.onsuccess?.();
      if (tx) queueMicrotask(() => tx.oncomplete?.());
    });
    return req;
  }
  const db = {
    objectStoreNames: { contains: () => created },
    createObjectStore() { created = true; return {}; },
    close() {},
    transaction(_storeName, mode = 'readonly') {
      const txKeys = [];
      if (mode === 'readwrite') writeTransactions.push(txKeys);
      const tx = { error: null, oncomplete: null, onabort: null, onerror: null };
      tx.objectStore = () => ({
        get(key) { return request(records.has(key) ? structuredClone(records.get(key)) : undefined, tx); },
        put(value, key) {
          putKeys.push(key);
          txKeys.push(key);
          records.set(key, structuredClone(value));
          return request(key, tx);
        },
        delete(key) { records.delete(key); return request(undefined, tx); },
        openKeyCursor() {
          const keys = [...records.keys()];
          let index = 0;
          const req = { result: undefined, error: null, onsuccess: null, onerror: null };
          const step = () => queueMicrotask(() => {
            if (index >= keys.length) {
              req.result = null;
              req.onsuccess?.();
              queueMicrotask(() => tx.oncomplete?.());
              return;
            }
            const key = keys[index++];
            req.result = {
              primaryKey: key,
              delete() { records.delete(key); },
              continue() { step(); },
            };
            req.onsuccess?.();
          });
          step();
          return req;
        },
      });
      return tx;
    },
  };
  return {
    records,
    putKeys,
    writeTransactions,
    open() {
      const req = { result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        if (!created) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

test('Goal 1: canonicalContentDigest prefers worker sha256 then subtle.digest over pure-JS fallback', async () => {
  const bytes = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]);
  const expected = createHash('sha256').update(bytes).digest('hex');

  // 1a. Prefers platform worker sha256 when available
  let workerCalls = 0;
  let blobReads = 0;
  const backendWithWorker = {
    platformWorker: {},
    file: {
      size: bytes.length,
      slice() { blobReads++; throw new Error('should not read blob on main thread'); },
    },
    _callTo(workerName, type) {
      assert.equal(workerName, 'platform');
      assert.equal(type, 'sha256');
      workerCalls++;
      return Promise.resolve({ hex: expected });
    },
  };
  const fromWorker = await canonicalContentDigest(backendWithWorker, 'fnv1a64:8:deadbeef');
  assert.equal(fromWorker, expected);
  assert.equal(workerCalls, 1);
  assert.equal(blobReads, 0);

  // 1b. Uses crypto.subtle.digest with a single slice read when no worker is present
  let sliceCalls = 0;
  const backendNoWorker = {
    file: {
      size: bytes.length,
      slice(start, end) {
        sliceCalls++;
        return { arrayBuffer: async () => bytes.slice(start, end).buffer };
      },
    },
  };
  const fromSubtle = await canonicalContentDigest(backendNoWorker, null);
  assert.equal(fromSubtle, expected);
  assert.equal(sliceCalls, 1);
});

test('Goal 1: demand-driven ensureBinaryId skips background deferral on foreground priority and avoids double hashing', async () => {
  const bytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
  const expected = createHash('sha256').update(bytes).digest('hex');
  const priorScheduler = globalThis.scheduler;
  let backgroundTasks = 0;
  globalThis.scheduler = {
    postTask() {
      backgroundTasks++;
      return new Promise(() => {}); // would hang if called
    },
  };
  try {
    let contentHashCalls = 0;
    let workerShaCalls = 0;
    const backend = {
      platformWorker: {},
      file: {
        size: bytes.length,
        slice(start, end) { return { arrayBuffer: async () => bytes.slice(start, end).buffer }; },
      },
      gen: 1,
      binaryId: null,
      contentHash: null,
      async ensureContentHash() {
        contentHashCalls++;
        return 'fnv1a64:8:1234567890abcdef';
      },
      _callTo(workerName, type) {
        if (workerName === 'platform' && type === 'sha256') {
          workerShaCalls++;
          return Promise.resolve({ hex: expected });
        }
        throw new Error(`unexpected call ${workerName}:${type}`);
      },
    };
    const app = { backend, store: { get: () => null }, ensureRecognition: async () => null };
    installDemandDrivenAnalysis(app);
    const id = await backend.ensureBinaryId({ priority: 'current' });
    assert.equal(id, `bin_sha256_${expected}`);
    assert.equal(backgroundTasks, 0, 'foreground priority must not defer to background scheduler');
    assert.equal(contentHashCalls, 0, 'must not hash file with FNV-1a before SHA-256');
    assert.equal(workerShaCalls, 1, 'must compute SHA-256 once via platform worker');
  } finally {
    if (priorScheduler === undefined) delete globalThis.scheduler;
    else globalThis.scheduler = priorScheduler;
  }
});

test('Goal 2: ArtifactAnalysisOrchestrator isolates cold publish payload and avoids double decode on validate', async () => {
  const store = createArtifactStore({ indexedDB: null, allowMemoryFallback: true });
  const orchestrator = new ArtifactAnalysisOrchestrator({ store });
  const descriptor = createWorkerAnalysisArtifactDescriptor({
    binaryId: `bin_sha256_${'a'.repeat(64)}`,
    sliceIndex: 0,
    architecture: 'arm64',
    artifactKind: 'worker-analysis-result',
    producerVersion: '1.0.0',
    loaderVersion: '1.0.0',
    architectureSemanticVersion: '1.0.0',
    abiSemanticVersion: '1.0.0',
    semanticSchemaVersion: '1.0.0',
  });
  const largeBytes = new Uint8Array(65536);
  largeBytes[0] = 7;
  const produced = { value: 42n, bytes: largeBytes };
  const cold = await orchestrator.request({
    descriptor,
    produce: async () => produced,
  });
  assert.equal(cold.reused, false);
  assert.notEqual(cold.payload, produced, 'cold publish must return decoded isolated payload');
  assert.notEqual(cold.payload.bytes, produced.bytes, 'cold publish must not alias >=64 KiB Uint8Array view');
  produced.bytes[0] = 99;
  assert.equal(cold.payload.bytes[0], 7);
  cold.payload.bytes[0] = 55;

  // Warm hit with validate returns the validated decoded payload directly
  let validatedRef = null;
  const warm = await orchestrator.request({
    descriptor,
    produce: async () => { throw new Error('should reuse'); },
    validate: (decoded) => {
      validatedRef = decoded;
      return decoded.value === 42n;
    },
  });
  assert.equal(warm.reused, true);
  assert.equal(warm.payload, validatedRef);
  assert.equal(warm.payload.value, 42n);
  assert.equal(warm.payload.bytes[0], 7, 'mutating cold payload must not corrupt stored artifact');
  await orchestrator.close();
});

test('Goal 3: AnalysisResumeStore.updateLastFileMeta avoids rewriting the multi-MB Blob and app.js skips saveLastFile on restore', async () => {
  const indexedDB = createKeyValueIndexedDB();
  const store = new AnalysisResumeStore({ indexedDB, analysisIdentity: 'build-tempo', storage: null });
  const bytes = new Uint8Array([9, 8, 7, 6]);
  const file = {
    name: 'big.bin',
    type: 'application/octet-stream',
    size: bytes.byteLength,
    lastModified: 456,
    slice(start, end, type) { return new Blob([bytes.slice(start, end)], { type }); },
  };
  assert.equal(await store.saveLastFile(file, { sliceIndex: 0 }), true);
  const blobWritesAfterSave = indexedDB.putKeys.filter((k) => k === 'last-file').length;
  assert.equal(blobWritesAfterSave, 1);

  // Metadata update must NOT rewrite 'last-file'
  assert.equal(await store.updateLastFileMeta({ binaryId: 'bin_a', sliceIndex: 0 }), true);
  assert.equal(indexedDB.putKeys.filter((k) => k === 'last-file').length, 1);

  // Redundant unchanged metadata update must perform 0 IDB puts
  const putsBeforeNoop = indexedDB.putKeys.length;
  assert.equal(await store.updateLastFileMeta({ binaryId: 'bin_a', sliceIndex: 0 }), true);
  assert.equal(indexedDB.putKeys.length, putsBeforeNoop);

  // loadLastFile merges updated metadata cleanly
  const loaded = await store.loadLastFile();
  assert.equal(loaded.binaryId, 'bin_a');
  assert.equal(loaded.sliceIndex, 0);
  assert.equal(loaded.name, 'big.bin');

  // Verify app.js guards
  const appSource = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /if \(!sampleOpen && !restoredOpen\) void this\.analysisResume\.saveLastFile\(file/);
  assert.match(appSource, /this\.ensureSwift\(\{ priority: 'background' \}\)/);
});

test('Goal 4: demand-driven localProgram caches ProgramIndex across callers/callees/xrefs and invalidates on symbol gen change', async () => {
  const region = { id: 'text', section: '__text', exec: true, vmAddr: 0x1000n, size: 0x200n };
  const symbols = new SymbolIndex({
    addrs: new BigUint64Array([0x1000n, 0x1040n]),
    kinds: new Uint8Array([0, 0]),
    names: ['_caller', '_callee'],
    flags: new Uint8Array([1, 1]),
    funcs: new BigUint64Array([0x1000n, 0x1040n]),
    funcEnds: new BigUint64Array([0x1030n, 0x1080n]),
    regions: [region],
    functionStartsComplete: true,
    allSeedsExact: true,
  });
  let scanCalls = 0;
  const scanResult = {
    regionId: 'text',
    callFrom: new BigUint64Array([0x1008n]),
    callTo: new BigUint64Array([0x1040n]),
    refFrom: new BigUint64Array([0x1010n]),
    refTo: new BigUint64Array([0x1040n]),
    refKind: new Uint8Array([1]),
    kinds: new Uint8Array([1, 2]),
    kindsCovered: 2,
    words: 2,
    callsCapped: false,
    refsCapped: false,
    completeness: { complete: true, reasons: [] },
  };
  const app = {
    symbols,
    store: {
      get(key) {
        if (key === 'regions') return [region];
        if (key === 'currentRegion') return region;
        if (key === 'architecture') return 'arm64';
        if (key === 'sliceIndex') return 0;
        return null;
      },
    },
    backend: {
      gen: 1,
      binaryId: `bin_sha256_${'b'.repeat(64)}`,
      scanProgram() {
        scanCalls++;
        return Promise.resolve(scanResult);
      },
    },
    validatedFunctionRange(addr) {
      const fn = symbols.functionAt(addr);
      return fn ? { ok: true, start: fn.start, end: fn.end, complete: true } : { ok: false };
    },
    ensureRecognition: async () => null,
  };

  const api = installDemandDrivenAnalysis(app);
  const snap1 = await api.snapshot();
  const firstCallers = await api.callers(snap1, 0x1040n);
  const secondCallers = await api.callers(snap1, 0x1040n);
  assert.equal(scanCalls, 1);
  assert.equal(firstCallers.value.length, 1);
  assert.equal(secondCallers.value.length, 1);

  // Adding a function start bumps symbols.gen -> cache invalidates and caller ownership updates
  symbols.addFunctions([0x1008n]);
  const snap2 = await api.snapshot();
  const afterAdd = await api.callers(snap2, 0x1040n);
  assert.equal(afterAdd.value[0].addr, 0x1008n);
});

test('Goal 5: AnalysisCache.put works with memory and IndexedDB backends without redundant shared-buffer clones', async () => {
  const mem = new Map();
  const memCache = new AnalysisCache({ indexedDB: null, memory: mem });
  const input = { analysisSummaries: { count: 3, nested: [1, 2] } };
  const returned = await memCache.put('hash-1', input);
  returned.analysisSummaries.count = 999;
  const loaded = await memCache.get('hash-1');
  assert.equal(loaded.analysisSummaries.count, 3, 'mutating put return value must not corrupt memory cache');

  // IDB-backed cache
  const records = new Map();
  let created = false;
  const fakeIdb = {
    open() {
      const req = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      const db = {
        objectStoreNames: { contains: () => created },
        createObjectStore() { created = true; return {}; },
        close() {},
        transaction() {
          const tx = { oncomplete: null, onerror: null, onabort: null };
          tx.objectStore = () => ({
            put(record) {
              records.set(record.key, structuredClone(record));
              const r = { onsuccess: null, onerror: null };
              queueMicrotask(() => { r.onsuccess?.(); queueMicrotask(() => tx.oncomplete?.()); });
              return r;
            },
            get(key) {
              const r = { result: records.has(key) ? structuredClone(records.get(key)) : undefined, onsuccess: null, onerror: null };
              queueMicrotask(() => r.onsuccess?.());
              return r;
            },
          });
          return tx;
        },
      };
      req.result = db;
      queueMicrotask(() => { if (!created) req.onupgradeneeded?.(); req.onsuccess?.(); });
      return req;
    },
  };
  const idbCache = new AnalysisCache({ indexedDB: fakeIdb });
  const out = await idbCache.put('hash-idb', { analysisSummaries: { ok: true } });
  assert.equal(out.analysisSummaries.ok, true);
  out.analysisSummaries.ok = false;
  const readBack = await idbCache.get('hash-idb');
  assert.equal(readBack.analysisSummaries.ok, true);
});

test('Goal 7: auto.js single-pass findings and direct-index fairFunctionList preserve exact results', () => {
  const region = { id: 'text', exec: true, vmAddr: 0x1000n, size: 0x1000n };
  const symbols = new SymbolIndex({
    addrs: new BigUint64Array([0x1000n, 0x1080n]),
    kinds: new Uint8Array([0, 0]),
    names: ['_alpha', '_beta'],
    flags: new Uint8Array([1, 1]),
    funcs: new BigUint64Array([0x1000n, 0x1040n, 0x1080n]),
    funcEnds: new BigUint64Array([0x1030n, 0x1070n, 0x10c0n]),
    regions: [region],
    functionStartsComplete: true,
    allSeedsExact: true,
  });
  symbols.rename(0x1040n, '_renamed_mid');

  const program = {
    functionRange(addr) {
      const fn = symbols.functionAt(addr);
      return fn ? { start: fn.start, end: fn.end } : null;
    },
    statsOf() { return { total: 40, numeric: 4, mul: 2, div: 1, fmul: 1, store: 2, load: 2, cmp: 3 }; },
    callCountOf(addr) { return addr === 0x1040n ? 5 : 2; },
    functionsReferencing(addr) {
      return addr === 0x2000n ? [{ addr: 0x1000n, site: 0x1004n }] : [];
    },
  };

  const notable = notableFunctions(program, symbols, region, 10);
  assert.equal(notable.length, 3);
  assert.equal(notable.find((f) => f.addr === 0x1000n)?.name, '_alpha');
  assert.equal(notable.find((f) => f.addr === 0x1040n)?.name, '_renamed_mid');
  assert.equal(notable.find((f) => f.addr === 0x1080n)?.name, '_beta');

  const strList = [
    { addr: 0x2000n, text: 'https://api.example.com/v1', byteLength: 26 },
    { addr: 0x2100n, text: 'jailbreak_detected', byteLength: 18 },
    { addr: 0x2200n, text: 'storekit_receipt', byteLength: 16 },
    { addr: 0x2300n, text: '/var/mobile/app', byteLength: 15 },
  ];
  const found = findings(strList, program, symbols, 10);
  assert.equal(found.length, 4);
  assert.equal(found[0].id, 'endpoint');
  assert.equal(found[0].actionable, true);
  assert.equal(found[0].users[0].name, '_alpha');
});

test('Goal 6: platform worker sha256/digest, scanStrings, search, vmToFile, and CachedByteSource non-eviction', async () => {
  const prevSelf = globalThis.self;
  const responses = [];
  const fakeSelf = {
    onmessage: null,
    postMessage(msg) { responses.push(msg); },
  };
  globalThis.self = fakeSelf;
  let nextId = 1;
  const send = async (t, payload = {}, epoch = 1) => {
    const id = nextId++;
    const startIdx = responses.length;
    await fakeSelf.onmessage({ data: { t, id, epoch, ...payload } });
    const reply = responses.slice(startIdx).find((m) => (m.t === 'ok' || m.t === 'err') && m.id === id);
    assert.ok(reply, `expected reply for ${t}`);
    if (reply.t === 'err') throw new Error(reply.error);
    return reply.result;
  };
  try {
    await import(`../js/platform/worker.js?tempo_test=${Date.now()}`);
    assert.equal(typeof fakeSelf.onmessage, 'function');

    // Build a minimal valid ELF64 binary payload with embedded strings and known bytes
    const raw = new Uint8Array(4096);
    const dv = new DataView(raw.buffer);
    raw.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0); // ELF64 LE
    dv.setUint16(16, 2, true); // ET_EXEC
    dv.setUint16(18, 183, true); // EM_AARCH64
    dv.setUint32(20, 1, true); // EV_CURRENT
    dv.setUint16(52, 64, true); // e_ehsize
    const sampleStr = new TextEncoder().encode('hello_tempo_worker_string');
    raw.set(sampleStr, 64);
    raw.set(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), 512);
    const expectedSha = createHash('sha256').update(raw).digest('hex');

    const fakeFile = new Blob([raw], { type: 'application/octet-stream' });
    Object.defineProperty(fakeFile, 'name', { value: 'tempo-raw.bin', configurable: true });

    const opened = await send('open', { file: fakeFile }, 1);
    assert.ok(opened.raw?.id);
    await send('setRegions', {
      regions: [
        { id: 'r1', name: '__text', vmAddr: 0x100000000n, size: 0x800n, fileOffset: 0n, exec: true },
        { id: 'r2', name: '__data', vmAddr: 0x100001000n, size: 0x800n, fileOffset: 0x800n, exec: false },
      ],
    }, 1);

    // Warm CachedByteSource via readAt (also tests binary-search vmToFile with 64-bit address)
    const readRes = await send('readAt', { addr: 0x100000000n + 64n, len: 25, text: true }, 1);
    assert.equal(readRes.found, true);
    assert.equal(readRes.text, 'hello_tempo_worker_string');
    const statsBefore = await send('memoryStats', {}, 1);

    // Worker sha256 and digest produce exact SHA-256 without evicting CachedByteSource
    const shaRes = await send('sha256', {}, 1);
    assert.equal(shaRes.hex, expectedSha);
    const digestRes = await send('digest', {}, 1);
    assert.equal(digestRes.hex, expectedSha);
    const statsAfter = await send('memoryStats', {}, 1);
    assert.equal(statsAfter.bytesCached, statsBefore.bytesCached);

    // scanStrings with reusable buffer finds the embedded string accurately
    const strRes = await send('strings', { regionId: 'r1', min: 5, limit: 100 }, 1);
    assert.equal(strRes.results.some((r) => r.text === 'hello_tempo_worker_string' && r.addr === 0x100000040n), true);

    // runSearch with compiled pattern finds both text and hex patterns
    const textHits = await send('search', { regionId: 'r1', kind: 'text', query: 'TEMPO_WORKER' }, 1);
    assert.equal(textHits.results.length, 1);
    assert.equal(textHits.results[0].addr, 0x100000046n);
    const hexHits = await send('search', {
      regionId: 'r1',
      kind: 'hex',
      hex: { bytes: [0xde, 0xad, 0xbe, 0xef], mask: [0xff, 0xff, 0xff, 0xff] },
    }, 1);
    assert.equal(hexHits.results.length, 1);
    assert.equal(hexHits.results[0].addr, 0x100000200n);
  } finally {
    if (prevSelf === undefined) delete globalThis.self;
    else globalThis.self = prevSelf;
  }
});

test('Review fixes: atomic saveLastFile, priority forwarding, duplicate-address symbol order, and scheduler toJSON/non-index array safety', async () => {
  // Finding 9: saveLastFile writes both keys in a single readwrite transaction
  const indexedDB = createKeyValueIndexedDB();
  const resumeStore = new AnalysisResumeStore({ indexedDB, analysisIdentity: 'build-atomic', storage: null });
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const file = {
    name: 'atomic.bin',
    type: 'application/octet-stream',
    size: bytes.byteLength,
    lastModified: 1234,
    slice(start, end, type) { return new Blob([bytes.slice(start, end)], { type }); },
  };
  assert.equal(await resumeStore.saveLastFile(file, { sliceIndex: 0 }), true);
  assert.equal(indexedDB.writeTransactions.length, 1, 'saveLastFile must use a single readwrite transaction');
  assert.deepEqual(indexedDB.writeTransactions[0], ['last-file', 'last-file-meta']);

  // Finding 10: priority is forwarded into worker sha256 payload
  const expectedSha = createHash('sha256').update(bytes).digest('hex');
  const seenPayloads = [];
  const priorScheduler = globalThis.scheduler;
  globalThis.scheduler = { postTask: (fn) => Promise.resolve().then(fn) };
  try {
    const backend = {
      platformWorker: {},
      file,
      gen: 1,
      binaryId: null,
      contentHash: null,
      async ensureContentHash() { return 'fnv1a64:4:0000000000000000'; },
      _callTo(_workerName, _type, payload) {
        seenPayloads.push(payload);
        return Promise.resolve({ hex: expectedSha });
      },
    };
    const app = { backend, store: { get: () => null }, ensureRecognition: async () => null };
    installDemandDrivenAnalysis(app);
    await backend.ensureBinaryId({ priority: 'background' });
    assert.deepEqual(seenPayloads[0], { priority: 'background' });

    const directDigest = await canonicalContentDigest(backend, null, null, null, { priority: 'current' });
    assert.equal(directDigest, expectedSha);
    assert.deepEqual(seenPayloads[1], { priority: 'current' });
  } finally {
    if (priorScheduler === undefined) delete globalThis.scheduler;
    else globalThis.scheduler = priorScheduler;
  }

  // Finding 2: fairFunctionList picks the rightmost duplicate-address symbol matching SymbolIndex.nameAt
  const region = { id: 'text', exec: true, vmAddr: 0x1000n, size: 0x1000n };
  const dupSymbols = new SymbolIndex({
    addrs: new BigUint64Array([0x1000n, 0x1000n, 0x1040n]),
    kinds: new Uint8Array([0, 0, 0]),
    names: ['_first_dup', '_rightmost_dup', '_second'],
    flags: new Uint8Array([1, 1, 1]),
    funcs: new BigUint64Array([0x1000n, 0x1040n]),
    funcEnds: new BigUint64Array([0x1030n, 0x1080n]),
    regions: [region],
    functionStartsComplete: true,
    allSeedsExact: true,
  });
  const dupProgram = {
    functionRange(addr) {
      const fn = dupSymbols.functionAt(addr);
      return fn ? { start: fn.start, end: fn.end } : null;
    },
    statsOf() { return { total: 10, numeric: 1, mul: 1, div: 0, fmul: 0, store: 0, load: 0, cmp: 0 }; },
    callCountOf() { return 2; },
  };
  const notable = notableFunctions(dupProgram, dupSymbols, region, 10);
  assert.equal(notable.find((f) => f.addr === 0x1000n)?.name, dupSymbols.nameAt(0x1000n));
  assert.equal(notable.find((f) => f.addr === 0x1000n)?.name, '_rightmost_dup');

  // Finding 13: AnalysisScheduler rejects toJSON objects and arrays with non-index own keys from structuredClone fast path
  const artStore = createArtifactStore({ indexedDB: null, allowMemoryFallback: true });
  const scheduler = new AnalysisScheduler({ store: artStore });
  const toJsonDesc = createWorkerAnalysisArtifactDescriptor({
    binaryId: `bin_sha256_${'c'.repeat(64)}`,
    sliceIndex: 0,
    architecture: 'arm64',
    artifactKind: 'tojson-test',
    producerVersion: '1.0.0',
    loaderVersion: '1.0.0',
    architectureSemanticVersion: '1.0.0',
    abiSemanticVersion: '1.0.0',
    semanticSchemaVersion: '1.0.0',
  });
  const withToJson = Object.freeze({ raw: 1, toJSON() { return { serialized: true }; } });
  const toJsonRes = await scheduler.request({ descriptor: toJsonDesc, produce: async () => withToJson });
  assert.deepEqual(toJsonRes.payload, { raw: 1 });

  const arrDesc = createWorkerAnalysisArtifactDescriptor({
    binaryId: `bin_sha256_${'d'.repeat(64)}`,
    sliceIndex: 0,
    architecture: 'arm64',
    artifactKind: 'arr-extra-key-test',
    producerVersion: '1.0.0',
    loaderVersion: '1.0.0',
    architectureSemanticVersion: '1.0.0',
    abiSemanticVersion: '1.0.0',
    semanticSchemaVersion: '1.0.0',
  });
  const weirdArr = [1, 2];
  weirdArr.extra = 'dropped-by-json';
  Object.freeze(weirdArr);
  const arrRes = await scheduler.request({ descriptor: arrDesc, produce: async () => weirdArr });
  assert.deepEqual(arrRes.payload, [1, 2]);
  assert.equal('extra' in arrRes.payload, false);
  await artStore.close();
});
