import test from 'node:test';
import assert from 'node:assert/strict';

import { createAppAnalysisQueryAdapter as createBaseAdapter } from '../js/analysis/query/app-adapter.js';
import { createAppAnalysisQueryAdapter as createProductAdapter } from '../js/analysis/query/product-adapter.js';
import { installDemandDrivenAnalysis } from '../js/analysis/demand-driven-runtime.js';
import { installSharedAppArtifacts } from '../js/analysis/shared-app-artifacts.js';
import { executableByteCoverage } from '../js/analysis/discovery/executable-coverage.js';
import { encodeArtifactPayload } from '../js/core/artifacts/contracts.js';
import { stableStringify } from '../js/core/identity/index.js';
import { SymbolIndex } from '../js/symbols.js';
import { webcrypto } from 'node:crypto';

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
// [T8-P1-1] translationUnit() weakestCompleteness aggregation & symbolFor propagation
// ============================================================================
test('[T8-P1-1] translationUnit aggregates weakestCompleteness from loaded functions', async () => {
  const app = {
    backend: { gen: 1, binaryId: 'bin-tu-1' },
    symbols: {
      nameAt: (addr) => (BigInt(addr) === 0x1000n ? 'fn_partial' : null),
      label: () => null,
    },
    async analyzeFunction(id) {
      assert.equal(id, 0x1000n);
      return {
        startAddress: 0x1000n,
        name: 'fn_partial',
        status: { completeness: 'partial', reason: 'disassembly-truncated' },
        completeness: { complete: false, reason: 'disassembly-truncated' },
        decompiler: {
          signature: 'int fn_partial(int x)',
          pseudocode: 'int fn_partial(int x) {\n  return x + 1;\n}\n',
        },
      };
    },
  };

  const adapter = createBaseAdapter(app);
  const res = await adapter.translationUnit(null, [0x1000n]);
  assert.equal(res.status.completeness, 'partial', 'partial input function must not promote TU to complete');
  assert.equal(res.value.completeness, 'partial');
  assert.equal(res.status.reason, 'disassembly-truncated');
});

test('[T8-P1-1] translationUnit propagates symbolFor into decompile()', async () => {
  // Simple ARM64 function: BL 0x2000; RET
  const blTarget = 0x2000n;
  const fnStart = 0x1000n;
  const instructions = [
    {
      row: 0, address: fnStart, mnemonic: 'bl', operands: '#0x2000',
      ops: [{ k: 'imm', value: blTarget }],
      reads: [], writes: ['x0', 'x30'], isCall: true, target: blTarget,
    },
    {
      row: 1, address: fnStart + 4n, mnemonic: 'ret', operands: '',
      ops: [], reads: ['x0'], writes: [], isReturn: true,
    },
  ];
  const model = {
    arch: 'arm64',
    entry: 0,
    basicBlocks: [{ index: 0, id: 0, startAddr: fnStart, startRow: 0, endRow: 1, rows: [0, 1], succ: [], pred: [] }],
    instructions,
    edges: [],
    calls: [{ row: 0, address: fnStart, target: blTarget, indirect: false }],
    facts: { setsReturnValue: true },
  };

  const app = {
    store: { architecture: 'arm64' },
    backend: { gen: 1, binaryId: 'bin-tu-2' },
    symbols: {
      nameAt: (addr) => {
        const v = BigInt(addr);
        if (v === fnStart) return 'caller_fn';
        if (v === blTarget) return 'resolved_callee_name';
        return null;
      },
      label: () => null,
    },
    async analyzeFunction() {
      return {
        startAddress: fnStart,
        name: 'caller_fn',
        model,
      };
    },
  };

  const adapter = createBaseAdapter(app);
  const res = await adapter.translationUnit(null, [fnStart]);
  const emitted = res.value?.source ?? res.value?.text ?? '';
  assert.ok(emitted, 'translationUnit must emit C source text');
  assert.match(emitted, /resolved_callee_name/, 'decompile inside translationUnit must receive symbolFor');
});

// ============================================================================
// [T8-P1-2] & [T8-P2-3] Function discovery key contract alignment
// ============================================================================
test('[T8-P1-2] product-adapter ensureFunctionDiscovery checks expectedRegionDiscoveryKey before short-circuiting', async () => {
  let sliceIndex = 0;
  let calls = 0;
  const region = { id: 'text', exec: true, size: 0x100n, vmAddr: 0x1000n };
  const symbols = {
    gen: 1,
    functionStartsComplete: true,
    functionDiscovery: {
      complete: true,
      discoveryKey: '5:bin-disc|slice:0:text',
    },
    allFunctions: () => [{ start: 0x1000n, end: 0x1020n, name: 'f0' }],
    funcs: new BigUint64Array([0x1000n]),
    funcEnds: new BigUint64Array([0x1020n]),
    nameAt: () => 'f0',
  };
  const app = {
    backend: { gen: 5, binaryId: 'bin-disc' },
    store: {
      get: (k) => (k === 'sliceIndex' ? sliceIndex : k === 'regions' ? [region] : k === 'currentRegion' ? region : null),
    },
    codeRegion: () => region,
    symbols,
    async ensureFunctions() {
      calls++;
      symbols.functionDiscovery = {
        complete: true,
        discoveryKey: `5:bin-disc|slice:${sliceIndex}:text`,
      };
      return symbols;
    },
  };

  const adapter = createProductAdapter(app);
  // Same slice (0) matches discoveryKey -> short-circuit, no ensureFunctions call
  await adapter.functions(null, {}, {});
  assert.equal(calls, 0, 'matching discoveryKey must short-circuit');

  // Switch to slice 1 (same epoch and region id) -> mismatch, must run ensureFunctions
  sliceIndex = 1;
  await adapter.functions(null, {}, {});
  assert.equal(calls, 1, 'foreign slice discoveryKey must NOT short-circuit');

  // Now slice 1 discoveryKey matches -> short-circuit again
  await adapter.functions(null, {}, {});
  assert.equal(calls, 1, 'updated slice discoveryKey must short-circuit');

  // Legacy preset without discoveryKey (null/undefined) still short-circuits
  symbols.functionDiscovery = { complete: true };
  sliceIndex = 2;
  await adapter.functions(null, {}, {});
  assert.equal(calls, 1, 'legacy symbols with discoveryKey == null must still short-circuit');
});

test('[T8-P2-3] product-adapter single-flight discoveryKey separates slices with same epoch and region id', async () => {
  let sliceIndex = 0;
  const gates = [];
  const app = {
    backend: { gen: 2, binaryId: 'bin-sf' },
    store: { get: (k) => (k === 'sliceIndex' ? sliceIndex : null) },
    programRegions: () => [{ id: 'text', exec: true, size: 64 }],
    ensureFunctions() {
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    },
  };
  createProductAdapter(app);

  const p0 = app.ensureFunctions({ id: 'text', exec: true, size: 64 });
  sliceIndex = 1;
  const p1 = app.ensureFunctions({ id: 'text', exec: true, size: 64 });
  await Promise.resolve();

  assert.equal(gates.length, 2, 'different slices on same epoch must not coalesce in product-adapter');
  gates[0].resolve('slice-0');
  gates[1].resolve('slice-1');
  assert.deepEqual(await Promise.all([p0, p1]), ['slice-0', 'slice-1']);
});

test('[T8-P1-2] demand-driven ensureFunctions ignores zero-size region and does not reuse producer across replaced symbols', async () => {
  let guessCalls = 0;
  const makeSymbols = () => ({
    gen: 0,
    functionCount: 0,
    functionStartsComplete: false,
    funcs: new BigUint64Array(0),
    funcEnds: new BigUint64Array(0),
    addFunctions: () => 0,
  });
  const app = {
    backend: {
      gen: 1,
      binaryId: 'bin-dd',
      guessFunctions: () => {
        guessCalls++;
        return Promise.resolve({ starts: [], discoveryComplete: true });
      },
    },
    store: { get: () => null },
    programRegions: () => [{ id: 'text', exec: true, size: 64, vmAddr: 0x1000n }],
    symbols: makeSymbols(),
    viewer: {},
  };
  installDemandDrivenAnalysis(app);

  // Zero-size extra region must not be included in discoveryKey
  const s1 = await app.ensureFunctions({ id: 'zero', exec: true, size: 0 });
  assert.equal(s1.functionDiscovery.regionSetKey, 'text');
  assert.equal(guessCalls, 1);

  // Replacing app.symbols on the same epoch/artifact/region must re-run discovery, not return stale s1
  const fresh = makeSymbols();
  app.symbols = fresh;
  const s2 = await app.ensureFunctions(null);
  assert.strictEqual(s2, fresh);
  assert.equal(guessCalls, 2);
});

// ============================================================================
// [T8-P1-3] installMultiRegionShapes artifact identity validation
// ============================================================================
test('[T8-P1-3] installMultiRegionShapes rejects stale-slice in-flight result without caching or publishing', async () => {
  let sliceIndex = 0;
  const gate0 = deferred();
  let scanCount = 0;
  const region = { id: 'text', exec: true, size: 0x100n, vmAddr: 0x1000n };
  const app = {
    backend: {
      gen: 3,
      binaryId: 'bin-shapes',
      valueShapes: () => {
        scanCount++;
        if (scanCount === 1) return gate0.promise;
        return Promise.resolve({ entries: [], complete: true });
      },
    },
    store: {
      get: (k) => (k === 'sliceIndex' ? sliceIndex : k === 'regions' ? [region] : null),
    },
    programRegions: () => [region],
    symbols: { gen: 0 },
  };
  installDemandDrivenAnalysis(app);

  const staleTask = app.ensureShapes();
  // Switch slice while slice 0 shape scan is in flight (same epoch!)
  sliceIndex = 1;
  gate0.resolve({ entries: [], complete: true });

  const staleResult = await staleTask;
  assert.equal(staleResult, null, 'stale-slice shape scan must return null');
  assert.equal(app.shapes, undefined, 'stale-slice shape scan must not publish app.shapes');

  // Switch back to slice 0: because stale scan was not cached, it must scan again
  sliceIndex = 0;
  await app.ensureShapes();
  assert.equal(scanCount, 2, 'stale-slice shape scan must not populate regionCache');
});

// ============================================================================
// [T8-P1-4] shared-app-artifacts artifact binding & early abort
// ============================================================================
test('[T8-P1-4] ensureStrings and ensureProgram bind to artifact identity and preserve unstamped preset compatibility', async () => {
  let sliceIndex = 0;
  let stringScans = 0;
  let programScans = 0;
  const textRegion = { id: 'text', exec: true, size: 0x100n, section: '__text', vmAddr: 0x1000n };
  const cstrRegion = { id: 'cstr', exec: false, size: 0x100n, section: '__cstring', cstrings: true, vmAddr: 0x2000n };
  const symbols = new SymbolIndex({
    funcs: new BigUint64Array([0x1000n]),
    functionStartsComplete: true,
    regions: [textRegion],
  });
  const app = {
    backend: {
      gen: 1,
      binaryId: 'bin-shared',
      strings: () => {
        stringScans++;
        return Promise.resolve({ complete: true, scannedBytes: 16, results: [{ addr: 0x2000n, text: `s${sliceIndex}` }] });
      },
      scanProgram: (regionId) => {
        programScans++;
        return Promise.resolve({ regionId });
      },
    },
    store: {
      get: (k) => (k === 'sliceIndex' ? sliceIndex : k === 'regions' ? [textRegion, cstrRegion] : null),
    },
    programRegions: () => [textRegion],
    ensureFunctions: async () => {},
    symbols,
  };
  installSharedAppArtifacts(app);

  // Slice 0 populates and stamps stringIndex & program
  const str0 = await app.ensureStrings();
  assert.equal(stringScans, 1);
  assert.strictEqual(await app.ensureStrings(), str0);
  assert.equal(stringScans, 1);

  const prog0 = await app.ensureProgram();
  assert.equal(programScans, 1);
  assert.strictEqual(await app.ensureProgram(), prog0);
  assert.equal(programScans, 1);

  // Switch to slice 1 (same epoch!) -> stamped caches must NOT short-circuit
  sliceIndex = 1;
  const str1 = await app.ensureStrings();
  assert.notStrictEqual(str1, str0);
  assert.equal(stringScans, 2, 'slice switch must re-scan strings');

  const prog1 = await app.ensureProgram();
  assert.notStrictEqual(prog1, prog0);
  assert.equal(programScans, 2, 'slice switch must re-scan program');

  // Unstamped external preset (issue-5279 compatibility) still short-circuits
  const presetStrings = Object.assign([{ addr: 0x2000n, text: 'preset' }], { complete: true });
  app.stringIndex = presetStrings;
  assert.strictEqual(await app.ensureStrings(), presetStrings);
  assert.equal(stringScans, 2);
});

test('[T8-P1-4] createProgramEntry aborts mid-loop before scanning remaining regions on artifact change', async () => {
  let sliceIndex = 0;
  const scanned = [];
  const r1 = { id: 'r1', exec: true, size: 0x100n, section: '__text', vmAddr: 0x1000n };
  const r2 = { id: 'r2', exec: true, size: 0x100n, section: '__text2', vmAddr: 0x2000n };
  const symbols = new SymbolIndex({
    funcs: new BigUint64Array([0x1000n]),
    functionStartsComplete: true,
    regions: [r1, r2],
  });
  const app = {
    backend: {
      gen: 1,
      binaryId: 'bin-loop',
      scanProgram: async (regionId) => {
        scanned.push(regionId);
        // Switch slice during first region scan
        sliceIndex = 1;
        return { regionId };
      },
    },
    store: {
      get: (k) => (k === 'sliceIndex' ? sliceIndex : k === 'regions' ? [r1, r2] : null),
    },
    programRegions: () => [r1, r2],
    ensureFunctions: async () => {},
    symbols,
  };
  installSharedAppArtifacts(app);

  await assert.rejects(() => app.ensureProgram(), /stale shared program/);
  assert.deepEqual(scanned, ['r1'], 'must abort before scanning second region after artifact change');
});

// ============================================================================
// [T8-P1-5] executableByteCoverage strict classifyGaps validation & fallback
// ============================================================================
test('[T8-P1-5] executableByteCoverage clips out-of-bounds spans, resolves overlaps conservatively, and falls back on uncovered gaps', async () => {
  const regions = [{ id: 'text', exec: true, vmAddr: 0x1000n, size: 0x20n }];
  // Attributed function: [0x1000, 0x1008) -> gap is [0x1008, 0x1020) (24 bytes)
  const functions = new BigUint64Array([0x1000n]);
  const functionEnds = new BigUint64Array([0x1008n]);

  // classifyGaps returns:
  // - out-of-bounds span [0x0ff0, 0x1008) (should be clipped completely)
  // - padding [0x1008, 0x1014) overlapping unknown [0x1010, 0x1014) (unknown wins on [0x1010, 0x1014))
  // - leaves [0x1014, 0x1020) uncovered -> must fall back to readBytes!
  const readCalls = [];
  const cov = await executableByteCoverage({
    regions,
    functions,
    functionEnds,
    architecture: 'arm64',
    endian: 'little',
    classifyGaps: async () => ({
      spans: [
        { start: 0x0ff0n, end: 0x1008n, class: 'padding' },
        { start: 0x1008n, end: 0x1014n, class: 'padding' },
        { start: 0x1010n, end: 0x1014n, class: 'unknown' },
      ],
    }),
    readBytes: async (addr, size) => {
      readCalls.push([addr, size]);
      // Return all-zero words (padding) for the fallback gap [0x1014, 0x1020)
      return new Uint8Array(Number(size));
    },
  });

  assert.equal(cov.executableBytes, 0x20);
  assert.equal(cov.attributedBytes, 0x08);
  assert.deepEqual(readCalls, [[0x1014n, 12n]], 'must fall back only for uncovered gap [0x1014, 0x1020)');
  assert.deepEqual(cov.unclassified, [
    { start: 0x1008n, end: 0x1010n, class: 'padding' },
    { start: 0x1010n, end: 0x1014n, class: 'unknown' },
    { start: 0x1014n, end: 0x1020n, class: 'padding' },
  ]);
  const totalUnclassified = cov.unclassified.reduce((sum, s) => sum + Number(s.end - s.start), 0);
  assert.equal(cov.attributedBytes + totalUnclassified, cov.executableBytes);
});

// ============================================================================
// [T8-P2-1] contracts.js OrdinaryOwnPropertyKeys order & __proto__ safety
// ============================================================================
test('[T8-P2-1] encodeArtifactPayload streams multi-view objects in canonical key order and preserves __proto__', () => {
  const viewA = new Uint8Array(64 * 1024);
  viewA.fill(0x11);
  const viewB = new Uint8Array(64 * 1024);
  viewB.fill(0x22);
  const viewIdx = new Uint8Array(64 * 1024);
  viewIdx.fill(0x33);

  // Deliberately unsorted insertion order: z_key, a_key, __proto__, '10', '2'
  const payload = Object.create(null);
  payload.z_key = viewB;
  payload.a_key = viewA;
  Object.defineProperty(payload, '__proto__', {
    value: { tag: 'proto-data' },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  payload['10'] = viewIdx;
  payload['2'] = 'two';

  const hadCrypto = Object.prototype.hasOwnProperty.call(globalThis, 'crypto');
  const prevCrypto = globalThis.crypto;
  if (!globalThis.crypto?.getRandomValues) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
  }
  try {
    const encoded = encodeArtifactPayload(payload);
    const expected = new TextEncoder().encode(stableStringify(payload));

    assert.equal(encoded.byteLength, expected.byteLength, 'encoded byte length must match canonical stableStringify');
    assert.equal(Buffer.compare(Buffer.from(encoded), Buffer.from(expected)), 0, 'encoded bytes must be byte-for-byte identical');
    assert.ok(encoded.buffer.byteLength > encoded.byteLength, 'must take the spliced fast path rather than falling back');
  } finally {
    if (hadCrypto) Object.defineProperty(globalThis, 'crypto', { value: prevCrypto, configurable: true, writable: true });
    else delete globalThis.crypto;
  }
});

// ============================================================================
// [T8-P2-2] metadataSummary sync throw absorption, rejection eviction & binaryId/sliceIndex key
// ============================================================================
test('[T8-P2-2] metadataSummary absorbs sync throws, evicts async rejections, and keys by binaryId + sliceIndex', async () => {
  let sliceIndex = 0;
  let calls = 0;
  let mode = 'sync-throw';
  const region = { id: 'text', vmAddr: 0n, size: 0x100n, exec: true };
  const app = {
    store: {
      get: (k) => (k === 'architecture' ? 'riscv64' : k === 'sliceIndex' ? sliceIndex : null),
    },
    backend: {
      gen: 1,
      binaryId: 'bin-meta-1',
      binaryMetadata() {
        calls++;
        if (mode === 'sync-throw') throw new Error('sync boom');
        if (mode === 'async-reject') return Promise.reject(new Error('async boom'));
        return Promise.resolve({ summary: { bits: 64 }, metadata: { flags: 0 } });
      },
      async analyzeSemanticFunction() {
        return { completeness: 'complete' };
      },
    },
    symbols: { functionAt: () => ({ start: 0n, end: 4n }), nameAt: () => null },
    validatedFunctionRange: () => ({
      ok: true,
      start: 0n,
      end: 4n,
      region,
      function: { start: 0n, end: 4n },
      complete: true,
      provenance: 'test',
    }),
  };

  const adapter = createBaseAdapter(app);

  // 1. Sync throw absorbed -> returns unsupported (missing elf flags) instead of throwing sync boom
  const r1 = await adapter.functionById(null, 0n, {});
  assert.equal(calls, 1);
  assert.equal(r1.status.completeness, 'unsupported');

  // 2. Async reject is evicted -> next call retries
  mode = 'async-reject';
  const r2 = await adapter.functionById(null, 0n, {});
  assert.equal(calls, 2);
  assert.equal(r2.status.completeness, 'unsupported');

  // 3. Subsequent call succeeds and caches for this (epoch, binaryId, sliceIndex)
  mode = 'ok';
  const r3 = await adapter.functionById(null, 0n, {});
  assert.equal(calls, 3);
  assert.equal(r3.status.completeness, 'complete');

  await adapter.functionById(null, 0n, {});
  assert.equal(calls, 3, 'same epoch + binaryId + sliceIndex must reuse cached summary');

  // 4. Switching sliceIndex on same epoch invalidates cache
  sliceIndex = 1;
  await adapter.functionById(null, 0n, {});
  assert.equal(calls, 4, 'sliceIndex change must invalidate metadataSummary cache');

  // 5. Switching binaryId on same epoch + sliceIndex invalidates cache
  app.backend.binaryId = 'bin-meta-2';
  await adapter.functionById(null, 0n, {});
  assert.equal(calls, 5, 'binaryId change must invalidate metadataSummary cache');
});

// ============================================================================
// [T8-P2-4] callers() queryLimited contract unified with callees()
// ============================================================================
test('[T8-P2-4] callers() enforces queryLimited partial completeness, query-limit reason, and page.next matching callees()', async () => {
  const region = { id: 'text', exec: true, size: 0x100n, vmAddr: 0x1000n };
  const app = {
    backend: {
      gen: 1,
      binaryId: 'bin-callers',
      scanProgram: async () => ({
        regionId: 'text',
        callFrom: new BigUint64Array([0x1010n, 0x1020n]),
        callTo: new BigUint64Array([0x1000n, 0x1000n]),
        callCount: 2,
        refFrom: new BigUint64Array(0),
        refTo: new BigUint64Array(0),
        refKind: new Uint8Array(0),
        refCount: 0,
      }),
    },
    store: {
      get: (k) => (k === 'regions' ? [region] : k === 'currentRegion' ? region : null),
    },
    programRegions: () => [region],
    symbols: new SymbolIndex({
      funcs: new BigUint64Array([0x1000n, 0x1010n, 0x1020n]),
      functionStartsComplete: true,
      regions: [region],
    }),
  };

  installDemandDrivenAnalysis(app);

  // Request offset=0, limit=1 with 2 callers: ProgramIndex.callersOf(addr, 1) marks queryLimited=true
  const page1 = await app.analysisQueries.callers(await app.analysisQueries.snapshot(), 0x1000n, { offset: 0, limit: 1 });
  assert.equal(page1.status.completeness, 'partial', 'queryLimited callers must be partial');
  assert.equal(page1.status.reason, 'query-limit', 'queryLimited callers must report query-limit reason');
  assert.equal(page1.page.returned, 1);
  assert.equal(page1.page.next, 1, 'queryLimited callers must expose next offset');
});
