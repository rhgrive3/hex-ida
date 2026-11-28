import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HexSigIndex,
  HEXSIG_VERDICT,
  HEXSIG_THRESHOLDS,
} from '../js/analysis/signature/hex-sig-index.js';
import {
  HEXSIG_ARCH_ARM64,
  HEXSIG_ARCH_X86_64,
  fnv1a64,
  computeStringHash64,
} from '../js/analysis/signature/hex-sig-extractor.js';
import { encodeMatchResult32 } from '../js/analysis/signature/hex-sig-pack.js';
import {
  createHexSigAutoScanner,
  buildHexSigMatchQuery,
} from '../js/analysis/signature/hexsig-auto-scanner.js';
import { AUTO_ANALYSIS_STATUS } from '../js/analysis/common/v6-auto-contracts.js';
import {
  createTilAutoLoader,
  resolveSafePackUrl,
  selectTilPacksForBinary,
} from '../js/analysis/types/core/til-auto-loader.js';
import { TilPackManager } from '../js/analysis/types/core/til-pack-manager.js';
import {
  analyzeFunction,
  resolveModelTexts,
  guessPurpose,
  describeFunction,
} from '../js/analyze.js';
import { setLang } from '../js/i18n.js';

function makeArm64Code(len = 64, seed = 0) {
  const bytes = new Uint8Array(len);
  const dv = new DataView(bytes.buffer);
  const insns = [
    0xd503237f, // pacibsp
    0xa9bf7bfd, // stp x29, x30, [sp, #-16]!
    0x910003fd, // mov x29, sp
    0xd10043ff, // sub sp, sp, #16
    0xaa0003e8, // mov x8, x0
    0x91000508, // add x8, x8, #1
    0xaa0803e0, // mov x0, x8
    0x910043ff, // add sp, sp, #16
    0xa8c17bfd, // ldp x29, x30, [sp], #16
    0xd65f03c0, // ret
  ];
  for (let i = 0; i < Math.floor(len / 4); i++) {
    const w = (insns[i % insns.length] ^ ((i === 4 ? seed : 0) & 0xfff)) >>> 0;
    dv.setUint32(i * 4, w, true);
  }
  return bytes;
}

function makeMockWasmExports({ status, entryIndex = 0, libId = 1, confidence = 900, runnerUpConf = 100, growMemory = false }) {
  let buf = new ArrayBuffer(64 * 1024);
  let heap = 1024;
  const grow = () => {
    const next = new ArrayBuffer(buf.byteLength + 64 * 1024);
    new Uint8Array(next).set(new Uint8Array(buf));
    buf = next;
  };
  return {
    memory: {
      get buffer() {
        return buf;
      },
    },
    hex_engine_scratch_reset() {
      heap = 1024;
    },
    hex_engine_scratch_alloc(size, align = 8) {
      if (growMemory) grow();
      heap = (heap + align - 1) & ~(align - 1);
      const ptr = heap;
      heap += size;
      return ptr;
    },
    hex_hexsig_mount() {
      if (growMemory) grow();
      return 0;
    },
    hex_hexsig_match_fn(_codePtr, _codeLen, _archId, outPtr) {
      if (growMemory) grow();
      const encoded = encodeMatchResult32({
        status,
        entryIndex,
        libId,
        confidence,
        runnerUpConf,
      });
      new Uint8Array(buf, outPtr, encoded.length).set(encoded);
      return 0;
    },
  };
}

test('hex-sig-index: prevents small-func AUTO_NAME promotion when entry.libId is 0xffff or null', () => {
  const minhash = new Uint32Array([11, 22, 33, 44]);
  const pattern = new Uint8Array(32).fill(0xaa);
  const mask = new Uint8Array(32).fill(0xff);

  const index = new HexSigIndex(
    [
      {
        arch: HEXSIG_ARCH_ARM64,
        symbolName: '_unassigned_small',
        libId: 0xffff,
        fingerprint: { l1Minhash: minhash, l2BbCount: 1 },
      },
      {
        arch: HEXSIG_ARCH_ARM64,
        symbolName: '_null_lib_small',
        libId: null,
        fingerprint: { l1Minhash: minhash, l2BbCount: 1 },
      },
    ],
    [{ libId: 0, name: 'libfoo' }],
  );

  // Low-score small candidate path (bestScore < VENDOR_FOLD_SCORE)
  const lowHit = index.match(
    { arch: HEXSIG_ARCH_ARM64, fingerprint: { l1Minhash: minhash, l2BbCount: 1 } },
    { neighborAnchorLibIds: [0xffff, 0xffff, null, null] },
  );
  assert.equal(lowHit.verdict, HEXSIG_VERDICT.NEED_CG_TIEBREAK);
  assert.equal(lowHit.matched, false);

  // Medium-score path (VENDOR_FOLD_ONLY -> would promote if libId were valid)
  const medIndex = new HexSigIndex(
    [
      {
        arch: HEXSIG_ARCH_ARM64,
        symbolName: '_unassigned_med',
        libId: 0xffff,
        pattern,
        mask,
        prologueLen: 32,
        tailLen: 8,
        crc16: 0x1234,
        fingerprint: { l1Minhash: minhash, l2BbCount: 1 },
      },
    ],
    [{ libId: 0, name: 'libfoo' }],
  );
  const medHit = medIndex.match(
    {
      arch: HEXSIG_ARCH_ARM64,
      pattern,
      crc16: 0x9999, // crc mismatch -> patternMatched only (score 680 -> VENDOR_FOLD_ONLY)
      fingerprint: { l1Minhash: minhash, l2BbCount: 1 },
    },
    { neighborAnchorLibIds: [0xffff, 0xffff, 0xffff] },
  );
  assert.equal(medHit.verdict, HEXSIG_VERDICT.VENDOR_FOLD_ONLY);

  // Positive control: valid libId still promotes with >=2 matching neighbors
  const validIndex = new HexSigIndex(
    [
      {
        arch: HEXSIG_ARCH_ARM64,
        symbolName: '_valid_small',
        libId: 0,
        fingerprint: { l1Minhash: minhash, l2BbCount: 1 },
      },
    ],
    [{ libId: 0, name: 'libfoo' }],
  );
  const validHit = validIndex.match(
    { arch: HEXSIG_ARCH_ARM64, fingerprint: { l1Minhash: minhash, l2BbCount: 1 } },
    { neighborAnchorLibIds: [0, 0] },
  );
  assert.equal(validHit.verdict, HEXSIG_VERDICT.AUTO_NAME);
  assert.equal(validHit.matched, true);
});

test('hex-sig-index: matchWasm maps all statuses (0,1,2,3,unknown) and survives memory growth', () => {
  const codeBytes = makeArm64Code(64);
  const index = new HexSigIndex(
    [
      {
        arch: HEXSIG_ARCH_ARM64,
        symbolName: '_wasm_fn',
        libId: 0,
        pattern: codeBytes.subarray(0, 32),
        mask: new Uint8Array(32).fill(0xff),
        prologueLen: 32,
        patternHash64: fnv1a64(codeBytes.subarray(0, 32)),
      },
    ],
    [{ libId: 0, name: 'libcrypto' }],
  );

  const cases = [
    { status: 0, expectedVerdict: HEXSIG_VERDICT.REJECT, expectedMatched: false, expectedEntry: -1 },
    { status: 1, expectedVerdict: HEXSIG_VERDICT.VENDOR_FOLD_ONLY, expectedMatched: true, expectedEntry: 0 },
    { status: 2, expectedVerdict: HEXSIG_VERDICT.AUTO_NAME, expectedMatched: true, expectedEntry: 0 },
    { status: 3, expectedVerdict: HEXSIG_VERDICT.NEED_CG_TIEBREAK, expectedMatched: false, expectedEntry: 0 },
    { status: 99, expectedVerdict: HEXSIG_VERDICT.REJECT, expectedMatched: false, expectedEntry: -1 },
  ];

  for (const tc of cases) {
    const wasmExports = makeMockWasmExports({
      status: tc.status,
      entryIndex: 0,
      libId: 0,
      confidence: 880,
      runnerUpConf: 120,
      growMemory: true,
    });
    const res = index.matchWasm(codeBytes, HEXSIG_ARCH_ARM64, { wasmExports });
    assert.ok(res, `status ${tc.status} should return result`);
    assert.equal(res.verdict, tc.expectedVerdict, `status ${tc.status} verdict`);
    assert.equal(res.matched, tc.expectedMatched, `status ${tc.status} matched`);
    assert.equal(res.entryIndex, tc.expectedEntry, `status ${tc.status} entryIndex`);
  }
});

test('hex-sig-index: rejects all-zero mask, enforces bigint patternHash64, and guards null match/matchBatch', () => {
  const pattern = new Uint8Array(32).fill(0x11);
  const zeroMask = new Uint8Array(32).fill(0x00);
  const index = new HexSigIndex([
    {
      arch: HEXSIG_ARCH_ARM64,
      symbolName: '_zero_mask_fn',
      libId: 0,
      pattern,
      mask: zeroMask,
      prologueLen: 32,
      patternHash64: '12345', // non-bigint should not be indexed
    },
  ]);

  assert.equal(index.byPatternHash.size, 0);
  const zeroMaskHit = index.match({
    arch: HEXSIG_ARCH_ARM64,
    pattern: new Uint8Array(32).fill(0x99),
    patternHash64: '12345',
    fingerprint: { l2BbCount: 5 },
  });
  assert.equal(zeroMaskHit.matched, false);
  assert.equal(zeroMaskHit.verdict, HEXSIG_VERDICT.REJECT);

  const nullHit = index.match(null);
  assert.equal(nullHit.verdict, HEXSIG_VERDICT.REJECT);
  assert.equal(nullHit.matched, false);
  assert.deepEqual(index.matchBatch(null), []);
  assert.deepEqual(index.matchBatch(undefined), []);
});

test('hexsig-auto-scanner: safeMask64, byArch narrowing, fingerprint deep merge, and meta.libId bounds', async () => {
  const codeBytes = makeArm64Code(64, 7);
  const strA = 'unique_anchor_alpha_1234';
  const strB = 'unique_anchor_beta_5678';
  const strHash = computeStringHash64([strA, strB]);

  const index = new HexSigIndex(
    [
      {
        arch: HEXSIG_ARCH_X86_64,
        symbolName: '_wrong_arch_fn',
        libId: 0,
        strings: [strA, strB],
        constants: ['not-a-bigint', 0xdeadbeefn],
        fingerprint: { l3StrHash64: 'bad-hash', l3ConstHash64: {} },
      },
      {
        arch: HEXSIG_ARCH_ARM64,
        symbolName: '_right_arch_fn',
        libId: 0,
        strings: [strA, strB],
        constants: ['invalid-const', 0x123456n],
        fingerprint: { l3StrHash64: strHash, l3ConstHash64: 'invalid' },
      },
    ],
    [{ libId: 0, name: 'libtarget' }],
  );

  // Verify byArch narrowing: replace entries[0] with getter that throws if touched for ARM64
  const origEntries = index.entries;
  let x64Touched = false;
  const proxyEntries = new Proxy(origEntries, {
    get(target, prop, receiver) {
      if (prop === '0') x64Touched = true;
      return Reflect.get(target, prop, receiver);
    },
  });
  index.entries = proxyEntries;
  index.match = () => ({ engine: 'js', matched: false, verdict: HEXSIG_VERDICT.REJECT });

  let observedQueryFp = null;
  const scanner = createHexSigAutoScanner({
    hexSigIndex: index,
    extractQuery: (bytes, archId, anchorCtx) => {
      observedQueryFp = anchorCtx?.fingerprint || null;
      return null;
    },
    getFunctionAnchors: async (_va, _fn, opts) => {
      assert.ok(opts && 'signal' in opts);
      return {
        strings: [strB],
        fingerprint: { l3LibHintMask: 0x0002 },
      };
    },
    matchOpts: { preferWasm: false },
  });

  const out = await scanner.run({
    binaryMeta: { arch: 'arm64' },
    functions: [
      {
        vaHex: '0x1000',
        name: 'sub_1000',
        strings: [strA],
        fingerprint: { l3CryptoMask: 0x0004, l3ConstHash64: 'bad-query-hash' },
      },
    ],
    readFunctionBytes: async () => codeBytes,
  });

  assert.equal(out.status, AUTO_ANALYSIS_STATUS.DONE);
  assert.equal(out.named, 1);
  assert.equal(out.results[0].newName, '_right_arch_fn');
  assert.equal(x64Touched, false, 'matchByAnchors must use byArch and skip x86_64 entries');
  assert.deepEqual(observedQueryFp, {
    l3CryptoMask: 0x0004,
    l3ConstHash64: 'bad-query-hash',
    l3LibHintMask: 0x0002,
  });

  // meta.libId range validation: invalid libId (0xffff / -1) must not write into hexSigIndex.libs
  const libsIndex = new HexSigIndex([], []);
  const hubCalls = [];
  const ac = new AbortController();
  const scannerWithHub = createHexSigAutoScanner({
    hexSigIndex: libsIndex,
    hubLoader: {
      manifest: {
        packs: [
          { packId: 'bad-libid', arch: 'arm64', platform: 'ios', format: 'macho' },
          { packId: 'good-libid', arch: 'arm64', platform: 'ios', format: 'macho' },
        ],
      },
      async loadPack(packId, opts) {
        hubCalls.push({ packId, signal: opts?.signal });
        if (packId === 'bad-libid') {
          return { meta: { packId, libId: 0xffff, libName: 'bad' }, decoded: { entries: [] } };
        }
        return { meta: { packId, libId: 1, libName: 'good' }, decoded: { entries: [] } };
      },
    },
  });
  await scannerWithHub.run({
    binaryMeta: { arch: 'arm64', platform: 'ios', format: 'macho' },
    functions: [],
    readFunctionBytes: async () => codeBytes,
    signal: ac.signal,
  });
  assert.equal(hubCalls.length, 2);
  assert.equal(hubCalls[0].signal, ac.signal);
  assert.equal(libsIndex.libs[0xffff], undefined);
  assert.equal(libsIndex.libs[1]?.libName, 'good');
});

test('hexsig-auto-scanner: aborts cleanly after getFunctionAnchors and flushes prior chunkBatch without naming aborted fn', async () => {
  const code1 = makeArm64Code(64, 1);
  const code2 = makeArm64Code(64, 2);
  const q1 = buildHexSigMatchQuery(code1, HEXSIG_ARCH_ARM64);
  const q2 = buildHexSigMatchQuery(code2, HEXSIG_ARCH_ARM64);

  const index = new HexSigIndex(
    [
      {
        arch: HEXSIG_ARCH_ARM64,
        symbolName: '_fn_one',
        libId: 0,
        pattern: q1.pattern,
        mask: new Uint8Array(32).fill(0xff),
        prologueLen: 32,
        patternHash64: q1.patternHash64,
        crc16: q1.crc16,
        tailLen: q1.tailLen,
      },
      {
        arch: HEXSIG_ARCH_ARM64,
        symbolName: '_fn_two',
        libId: 0,
        pattern: q2.pattern,
        mask: new Uint8Array(32).fill(0xff),
        prologueLen: 32,
        patternHash64: q2.patternHash64,
        crc16: q2.crc16,
        tailLen: q2.tailLen,
      },
    ],
    [{ libId: 0, name: 'libtest' }],
  );

  const ac = new AbortController();
  const namedRecords = [];
  const batchRecords = [];

  const scanner = createHexSigAutoScanner({
    hexSigIndex: index,
    chunkSize: 10,
    matchOpts: { preferWasm: false },
    getFunctionAnchors: async (vaHex, _fn, opts) => {
      assert.equal(opts.signal, ac.signal);
      if (vaHex === '0x2000') {
        ac.abort('stop-at-second');
      }
      return null;
    },
  });

  const out = await scanner.run({
    binaryMeta: { arch: 'arm64' },
    functions: [
      { vaHex: '0x1000', name: 'sub_1000' },
      { vaHex: '0x2000', name: 'sub_2000' },
      { vaHex: '0x3000', name: 'sub_3000' },
    ],
    readFunctionBytes: async (vaHex) => (vaHex === '0x1000' ? code1 : code2),
    signal: ac.signal,
    onNamed: (rec) => namedRecords.push(rec),
    onBatchNamed: (batch) => batchRecords.push(...batch),
  });

  assert.equal(out.status, AUTO_ANALYSIS_STATUS.ABORTED);
  assert.equal(out.named, 1);
  assert.equal(namedRecords.length, 1);
  assert.equal(namedRecords[0].newName, '_fn_one');
  assert.equal(batchRecords.length, 1, 'already-named chunkBatch must be flushed on abort');
  assert.equal(batchRecords[0].newName, '_fn_one');
});

test('til-auto-loader & til-pack-manager: signal propagation and AbortError non-fallback', async () => {
  const seenFetchSignals = [];
  let cacheGetCalled = false;

  const manager = new TilPackManager({
    storage: {
      async get() {
        cacheGetCalled = true;
        return null;
      },
      async put() {},
    },
    fetcher: async (url, init) => {
      seenFetchSignals.push({ url, signal: init?.signal, redirect: init?.redirect });
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    },
  });

  const ac = new AbortController();
  ac.abort('cancelled');

  // Pre-aborted fetchManifest throws without calling fetcher
  await assert.rejects(
    () => manager.fetchManifest('https://example.com/manifest.json', { signal: ac.signal }),
    (err) => err && (err.name === 'AbortError' || err.message === 'cancelled'),
  );
  assert.equal(seenFetchSignals.length, 0);

  // AbortError during remote fetch must rethrow instead of falling back to cache
  const ac2 = new AbortController();
  await assert.rejects(
    () => manager.loadPackWithFallback('pack-a', {
      url: 'https://example.com/pack-a.til1',
      signal: ac2.signal,
    }),
    (err) => err && err.name === 'AbortError',
  );
  assert.equal(seenFetchSignals.length, 1);
  assert.equal(seenFetchSignals[0].signal, ac2.signal);
  assert.equal(seenFetchSignals[0].redirect, 'error');
  assert.equal(cacheGetCalled, false, 'AbortError must not trigger cache fallback');

  // Auto-loader propagates signal into tilPackManager.fetchManifest and returns ABORTED
  const ac3 = new AbortController();
  const manifestSignals = [];
  const loader = createTilAutoLoader({
    tilPackManager: {
      async fetchManifest(_url, opts) {
        manifestSignals.push(opts?.signal);
        ac3.abort('user-cancel');
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      },
    },
    manifestUrl: 'https://example.com/manifest.json',
  });
  const loaderRes = await loader.run({ binaryMeta: { platform: 'ios' }, signal: ac3.signal });
  assert.equal(loaderRes.status, AUTO_ANALYSIS_STATUS.ABORTED);
  assert.equal(manifestSignals[0], ac3.signal);
});

test('til-auto-loader: resolveSafePackUrl selects sha256 for non-.gz pack.url, rollbackMounted is exception-resilient, scorePack evaluates any after frameworks/archs', async () => {
  const nonGz = resolveSafePackUrl('', {
    id: 'p1',
    url: 'https://example.com/p1.til1',
    sha256: 'raw-sha',
    gzSha256: 'gz-sha',
  });
  assert.deepEqual(nonGz, {
    url: 'https://example.com/p1.til1',
    expectedSha256: 'raw-sha',
    expectedRawSha256: 'raw-sha',
  });

  const gz = resolveSafePackUrl('', {
    id: 'p2',
    url: 'https://example.com/p2.til1.gz?v=2',
    sha256: 'raw-sha',
    gzSha256: 'gz-sha',
  });
  assert.deepEqual(gz, {
    url: 'https://example.com/p2.til1.gz?v=2',
    expectedSha256: 'gz-sha',
    expectedRawSha256: 'raw-sha',
  });

  // scorePack: 'any' platform bonus should fire when pack.frameworks or pack.archs matched
  const manifest = {
    schema: 'til-hub-manifest/v1',
    packs: [
      {
        id: 'pack-any-with-arch',
        priority: 0,
        archs: ['arm64'],
        matchRules: { platforms: ['any'] },
      },
      {
        id: 'pack-arch-only',
        priority: 0,
        archs: ['arm64'],
      },
    ],
  };
  const selected = selectTilPacksForBinary(manifest, { platform: 'linux', arch: 'arm64' }, { maxPacks: 2 });
  assert.equal(selected.length, 2);
  assert.equal(selected[0].id, 'pack-any-with-arch', 'pack with any platform bonus (+2) must rank above arch-only pack');

  // rollbackMounted & releasePackTidBase exception resilience
  const unmounted = [];
  const released = [];
  const ac = new AbortController();
  const mockManager = {
    slots: {
      A: { packId: 'pack-1', lastAccess: 1 },
      B: { packId: 'pack-2', lastAccess: 2 },
    },
    getMountedSlots() {
      return this.slots;
    },
    unmountSlot(slot) {
      unmounted.push(slot);
      if (slot === 'A') throw new Error('boom-unmount-A');
    },
    releasePackTidBase(packId) {
      released.push(packId);
      throw new Error('boom-release');
    },
    async loadPackWithFallback(packId) {
      if (packId === 'pack-1') {
        return { mounted: true, slot: 'A', evictedPackId: 'old-evicted', entry: { lastAccess: 1 }, source: 'remote' };
      }
      ac.abort('abort-on-second');
      return { mounted: true, slot: 'B', entry: { lastAccess: 2 }, source: 'remote' };
    },
  };

  const loader = createTilAutoLoader({
    tilPackManager: mockManager,
    fetchManifest: async () => ({
      schema: 'til-hub-manifest/v1',
      packs: [
        { id: 'pack-1', file: 'p1.til1', priority: 2, matchRules: { platforms: ['ios'] } },
        { id: 'pack-2', file: 'p2.til1', priority: 1, matchRules: { platforms: ['ios'] } },
      ],
    }),
    baseUrl: 'https://example.com',
  });
  const runRes = await loader.run({ binaryMeta: { platform: 'ios' }, signal: ac.signal });
  assert.equal(runRes.status, AUTO_ANALYSIS_STATUS.ABORTED);
  assert.deepEqual(unmounted, ['A', 'B'], 'rollback must continue to slot B even if slot A throws');
  assert.ok(released.includes('old-evicted'));
  assert.ok(released.includes('pack-1'));
});

test('analyze.js: normalizes region BigInt, uses SP cursor with abort, validates resolveModelTexts signal, guards non-array calls', async () => {
  // 1. Numeric region.vmAddr & region.size + SP cursor frameBytes
  const backend = {
    async fetchChunk() {
      return {
        mn: ['sub', 'add', 'ret'],
        ops: ['sp, sp, #0x20', 'sp, sp, #0x20', ''],
        bytes: new Uint8Array(12),
      };
    },
    async readAt() {
      return { found: false };
    },
  };

  const res = await analyzeFunction(
    backend,
    { id: 'text', vmAddr: 0x1000, size: 12 },
    0,
    2,
    null,
  );
  assert.equal(res.startAddr, 0x1000n);
  assert.equal(res.endAddr, 0x1008n);
  assert.equal(res.frameBytes, 0x20);
  assert.equal(res.returns, 1);

  // 2. resolveModelTexts validates malformed signal before touching backend
  let readCalled = false;
  await assert.rejects(
    () => resolveModelTexts(
      {
        async readAt() {
          readCalled = true;
          return { found: false };
        },
      },
      { addressRefs: [{ addr: 0x2000n }] },
      10,
      { signal: { aborted: false } },
    ),
    TypeError,
  );
  assert.equal(readCalled, false);

  // 3. guessPurpose & describeFunction (JA and EN) tolerate non-array calls
  assert.deepEqual(guessPurpose(null), []);
  assert.deepEqual(guessPurpose('not-an-array'), []);
  assert.deepEqual(guessPurpose([{ name: 'malloc' }]), ['メモリを確保']);

  const dummyRes = {
    instructions: 4,
    savesLr: false,
    calls: null,
    indirectCalls: 0,
    loops: [],
    condBranches: 0,
    argRegs: [],
    setsReturnValue: false,
    frameBytes: 0,
    savesCallee: [],
    usesFloat: false,
    usesSimd: false,
    usesAtomic: false,
    hasTrap: false,
    dataRows: 0,
    truncated: false,
  };
  setLang('ja');
  const jaLines = describeFunction(dummyRes, 'fn_test');
  assert.ok(Array.isArray(jaLines) && jaLines.length > 0);
  setLang('en');
  const enLines = describeFunction(dummyRes, 'fn_test');
  assert.ok(Array.isArray(enLines) && enLines.length > 0);
  setLang('ja');
});
