import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isStrippedFunctionName,
  resolveHexSigArchId,
  normalizeHexSigLibName,
  normalizeHexSigManifestForSelection,
  buildHexSigMatchQuery,
  createHexSigAutoScanner,
} from '../js/analysis/signature/hexsig-auto-scanner.js';
import { AUTO_ANALYSIS_STATUS } from '../js/analysis/common/v6-auto-contracts.js';
import {
  HEXSIG_ARCH_NONE,
  HEXSIG_ARCH_ARM64,
  HEXSIG_ARCH_X86_64,
  fnv1a64,
  crc16Ccitt,
} from '../js/analysis/signature/hex-sig-extractor.js';
import { HexSigIndex, HEXSIG_VERDICT } from '../js/analysis/signature/hex-sig-index.js';
import { selectHexSigPacksForBinary } from '../js/analysis/signature/hexsig-hub-loader.js';
import { encodeHsig1Pack, HSIG1_MAX_SLOT4_BYTES } from '../js/analysis/signature/hex-sig-pack.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCANNER_SRC_PATH = path.resolve(__dirname, '../js/analysis/signature/hexsig-auto-scanner.js');
const REAL_MANIFEST_PATH = path.resolve(__dirname, '../dist/hexsig-hub/manifest.json');

function makePatternBytes(seed, len = 64) {
  const buf = new Uint8Array(len);
  const hi = (seed >>> 8) & 0xff;
  const lo = seed & 0xff;
  for (let i = 0; i < len; i++) {
    buf[i] = ((lo * 37 + hi * 131 + i * 17 + 0x55) ^ ((i * 3) + hi)) & 0xff;
  }
  if (len >= 4) {
    buf[0] = lo;
    buf[1] = hi;
    buf[2] = (seed >>> 16) & 0xff;
    buf[3] = (lo ^ hi ^ 0xa5) & 0xff;
  }
  return buf;
}

function makeExactEntry({ symbolName, codeBytes, arch = HEXSIG_ARCH_X86_64, libId = 1 }) {
  const pattern = codeBytes.subarray(0, 32).slice();
  const mask = new Uint8Array(32).fill(0xff);
  const tailLen = Math.min(32, Math.max(0, codeBytes.length - 32));
  const crc16 = tailLen > 0
    ? crc16Ccitt(codeBytes, 32, 32 + tailLen)
    : crc16Ccitt(pattern, 16, pattern.length);
  return {
    arch,
    archId: arch,
    symbolName,
    libId,
    pattern,
    mask,
    prologueLen: pattern.length,
    length: pattern.length,
    patternHash64: fnv1a64(pattern),
    tailLen,
    crc16,
  };
}

describe('v6-auto-hexsig-scanner (Track 2)', () => {
  it('enforces INV-005 (no imports from js/targets/architecture/ or js/semantics/)', () => {
    const src = fs.readFileSync(SCANNER_SRC_PATH, 'utf8');
    const importLines = src.split('\n').filter((line) => /\b(import|from|require)\b/.test(line));
    for (const line of importLines) {
      assert.equal(/targets\/architecture/.test(line), false, `INV-005 violation: ${line}`);
      assert.equal(/semantics\//.test(line), false, `INV-005 violation: ${line}`);
    }
  });

  it('re-exports isStrippedFunctionName with exact contract behavior', () => {
    for (const s of [null, undefined, '', '   ', 'sub_1000', 'FUN_00401000', 'func_abcd', 'fn_42', 'loc_dead', 'unk_cafe', 'unnamed_1']) {
      assert.equal(isStrippedFunctionName(s), true, `expected stripped: ${String(s)}`);
    }
    for (const real of ['main', '_main', 'aes_128_ecb_cipher', '_Z3foov', 'objc_msgSend', 'sub_custom']) {
      assert.equal(isStrippedFunctionName(real), false, `expected non-stripped: ${real}`);
    }
  });

  it('resolveHexSigArchId handles ARM64, x86_64, amd64, numeric IDs, and unknown arches', () => {
    assert.equal(resolveHexSigArchId(HEXSIG_ARCH_ARM64), HEXSIG_ARCH_ARM64);
    assert.equal(resolveHexSigArchId('arm64'), HEXSIG_ARCH_ARM64);
    assert.equal(resolveHexSigArchId('AARCH64'), HEXSIG_ARCH_ARM64);
    assert.equal(resolveHexSigArchId('arm64e'), HEXSIG_ARCH_ARM64);
    assert.equal(resolveHexSigArchId(' arm64_32 '), HEXSIG_ARCH_ARM64);

    assert.equal(resolveHexSigArchId(HEXSIG_ARCH_X86_64), HEXSIG_ARCH_X86_64);
    assert.equal(resolveHexSigArchId('x86_64'), HEXSIG_ARCH_X86_64);
    assert.equal(resolveHexSigArchId('x86-64'), HEXSIG_ARCH_X86_64);
    assert.equal(resolveHexSigArchId('x64'), HEXSIG_ARCH_X86_64);
    assert.equal(resolveHexSigArchId('amd64'), HEXSIG_ARCH_X86_64);
    assert.equal(resolveHexSigArchId('  AMD64  '), HEXSIG_ARCH_X86_64);

    for (const unk of ['mips', 'riscv64', 'x86', 'i386', 'arm', '', null, undefined, 99, {}]) {
      assert.equal(resolveHexSigArchId(unk), HEXSIG_ARCH_NONE, `expected NONE for ${String(unk)}`);
    }
  });

  it('normalizeHexSigLibName extracts clean display name from strings and objects', () => {
    assert.equal(normalizeHexSigLibName('  OpenSSL  '), 'OpenSSL');
    assert.equal(normalizeHexSigLibName({ libName: 'Ubuntu OpenSSL', vendor: 'OpenSSL' }), 'Ubuntu OpenSSL');
    assert.equal(normalizeHexSigLibName({ libName: '  ', name: 'libcrypto', vendor: 'OpenSSL' }), 'libcrypto');
    assert.equal(normalizeHexSigLibName({ vendor: 'Android NDK', packId: 'android-ndk-x64' }), 'Android NDK');
    assert.equal(normalizeHexSigLibName({ packId: 'fedora-zlib-x64' }), 'fedora-zlib-x64');
    assert.equal(normalizeHexSigLibName(null), '');
    assert.equal(normalizeHexSigLibName({}), '');
  });

  it('selects real x64 packs from dist/hexsig-hub/manifest.json when binaryMeta.arch === "amd64"', async () => {
    const realManifest = JSON.parse(fs.readFileSync(REAL_MANIFEST_PATH, 'utf8'));
    const origX64Arch = realManifest.packs.find((p) => p.packId === 'ubuntu-openssl-x64')?.arch;
    assert.equal(origX64Arch, 'x86_64', 'real manifest should contain x86_64 pack entries');

    const normalized = normalizeHexSigManifestForSelection(realManifest);
    assert.equal(realManifest.packs.find((p) => p.packId === 'ubuntu-openssl-x64')?.arch, 'x86_64', 'must not mutate source manifest');

    const selected = selectHexSigPacksForBinary(normalized, { arch: 'x64', format: 'elf', platform: 'linux' });
    assert.ok(selected.length >= 5, `expected >= 5 x64 packs, got ${selected.length}`);
    assert.ok(selected.some((p) => p.packId === 'ubuntu-openssl-x64'));
    assert.ok(selected.every((p) => p.arch === 'x64'));

    const loadedPackIds = [];
    const index = new HexSigIndex();
    const scanner = createHexSigAutoScanner({
      hexSigIndex: index,
      maxPacks: 2,
      hubLoader: {
        manifest: realManifest,
        async loadPack(packId) {
          loadedPackIds.push(packId);
          const meta = realManifest.packs.find((p) => p.packId === packId);
          return { meta, rawBytes: new Uint8Array(0), decoded: { entries: [] } };
        },
      },
    });

    const out = await scanner.run({
      binaryMeta: { arch: 'amd64', format: 'elf', platform: 'linux' },
      functions: [],
      readFunctionBytes: async () => null,
    });

    assert.equal(loadedPackIds.length, 2);
    assert.deepEqual(loadedPackIds, selected.slice(0, 2).map((p) => p.packId));
    assert.equal(out.status, AUTO_ANALYSIS_STATUS.SKIPPED);
  });

  it('returns UNSUPPORTED_ARCH for unknown binary architecture without scanning', async () => {
    const index = new HexSigIndex([makeExactEntry({ symbolName: 'foo', codeBytes: makePatternBytes(1) })]);
    let readCalls = 0;
    const scanner = createHexSigAutoScanner({ hexSigIndex: index });
    const out = await scanner.run({
      binaryMeta: { arch: 'mips64' },
      functions: [{ vaHex: '0x1000', name: 'sub_1000', size: 64 }],
      readFunctionBytes: async () => {
        readCalls++;
        return makePatternBytes(1);
      },
    });
    assert.equal(out.status, AUTO_ANALYSIS_STATUS.UNSUPPORTED_ARCH);
    assert.equal(readCalls, 0);
    assert.equal(out.scanned, 0);
  });

  it('matches real JS index, enforces HexSigAutoMatch schema, preserves existing symbols, and rejects tail mismatch', async () => {
    const fnA = makePatternBytes(11, 64);
    const fnB = makePatternBytes(22, 64);
    const fnATailMismatch = fnA.slice();
    fnATailMismatch[40] ^= 0xff; // prologue identical, tail CRC differs

    const libs = [];
    libs[3] = { libId: 3, packId: 'ubuntu-openssl-x64', vendor: 'OpenSSL', libName: 'Ubuntu OpenSSL' };
    const index = new HexSigIndex([
      makeExactEntry({ symbolName: 'aes_128_ecb_cipher', codeBytes: fnA, arch: HEXSIG_ARCH_X86_64, libId: 3 }),
      makeExactEntry({ symbolName: 'sha256_block_data_order', codeBytes: fnB, arch: HEXSIG_ARCH_X86_64, libId: 3 }),
    ], libs);

    const bytesByVa = new Map([
      ['0x1000', fnA],
      ['0x2000', fnATailMismatch],
      ['0x3000', fnB],
    ]);
    const readVas = [];
    const namedEvents = [];
    const batches = [];

    const scanner = createHexSigAutoScanner({
      hexSigIndex: index,
      matchOpts: { preferWasm: false },
      chunkSize: 2,
    });

    const out = await scanner.run({
      binaryMeta: { arch: 'x86_64' },
      functions: [
        { vaHex: '0x0800', name: 'main', size: 64 }, // existing symbol -> must be skipped
        { vaHex: '0x1000', name: 'sub_1000', size: 64 }, // exact match
        { vaHex: '0x2000', name: 'FUN_2000', size: 64 }, // tail mismatch -> must not AUTO_NAME
        { vaHex: '0x3000', name: null, size: 64 }, // unnamed stripped -> exact match
      ],
      readFunctionBytes: async (vaHex) => {
        readVas.push(vaHex);
        return bytesByVa.get(vaHex) ?? null;
      },
      onNamed: (m) => namedEvents.push(m),
      onBatchNamed: (b) => batches.push(b),
    });

    assert.equal(out.status, AUTO_ANALYSIS_STATUS.DONE);
    assert.equal(out.skippedNamed, 1);
    assert.equal(out.scanned, 3);
    assert.equal(out.named, 2);
    assert.equal(readVas.includes('0x800'), false, 'existing named symbol must not be read');
    assert.equal(readVas.includes('0x0800'), false);
    assert.equal(out.results.length, 2);
    assert.equal(namedEvents.length, 2);
    assert.equal(batches.flat().length, 2);

    const m0 = out.results[0];
    assert.deepEqual(Object.keys(m0).sort(), [
      'engine',
      'libId',
      'libName',
      'margin',
      'newName',
      'oldName',
      'score',
      'vaHex',
      'verdict',
    ]);
    assert.equal(m0.vaHex, '0x1000');
    assert.equal(m0.oldName, 'sub_1000');
    assert.equal(m0.newName, 'aes_128_ecb_cipher');
    assert.equal(m0.libId, 3);
    assert.equal(m0.libName, 'Ubuntu OpenSSL');
    assert.ok(m0.score >= 820);
    assert.ok(m0.margin >= 80);
    assert.equal(m0.engine, 'js');
    assert.equal(m0.verdict, HEXSIG_VERDICT.AUTO_NAME);

    assert.equal(out.results[1].vaHex, '0x3000');
    assert.equal(out.results[1].oldName, null);
    assert.equal(out.results[1].newName, 'sha256_block_data_order');
  });

  it('supports WASM match engine and custom extractQuery merging', async () => {
    const fnBytes = makePatternBytes(5, 48);
    const customFp = { l3StrHash64: 0x1234n };
    const q = buildHexSigMatchQuery(fnBytes, HEXSIG_ARCH_ARM64, () => ({ fingerprint: customFp }));
    assert.equal(q.arch, HEXSIG_ARCH_ARM64);
    assert.equal(q.archId, HEXSIG_ARCH_ARM64);
    assert.equal(q.codeBytes, fnBytes);
    assert.equal(q.fingerprint, customFp);

    const fakeLibs = [];
    fakeLibs[7] = { libId: 7, libName: 'iOS ARM64 Crypto' };
    const fakeIndex = {
      entries: [{}],
      libs: fakeLibs,
      getLib(id) { return this.libs[id] || null; },
      match(query, opts) {
        assert.equal(opts.preferWasm, true);
        assert.equal(query.fingerprint, customFp);
        return {
          engine: 'wasm',
          matched: true,
          verdict: HEXSIG_VERDICT.AUTO_NAME,
          symbolName: 'ios_sha256_transform',
          libId: 7,
          score1: 950,
          margin: 200,
        };
      },
    };

    const scanner = createHexSigAutoScanner({
      hexSigIndex: fakeIndex,
      extractQuery: () => ({ fingerprint: customFp }),
    });
    const out = await scanner.run({
      binaryMeta: { arch: 'arm64e' },
      functions: [{ vaHex: '0x100004000', name: 'sub_100004000', size: 48 }],
      readFunctionBytes: async () => fnBytes,
    });
    assert.equal(out.status, AUTO_ANALYSIS_STATUS.DONE);
    assert.equal(out.named, 1);
    assert.equal(out.results[0].engine, 'wasm');
    assert.equal(out.results[0].libName, 'iOS ARM64 Crypto');
  });

  it('records mountPack { ok: false, reason } errors and does not mark pack as mounted', async () => {
    const mountedPackIds = new Set();
    const index = new HexSigIndex();
    const manifest = {
      packs: [
        { packId: 'pack-a', arch: 'arm64', libId: 1, libName: 'Lib A' },
      ],
    };

    const scanner = createHexSigAutoScanner({
      hexSigIndex: index,
      mountedPackIds,
      hubLoader: {
        manifest,
        async loadPack(packId) {
          return {
            meta: manifest.packs[0],
            rawBytes: new Uint8Array([1, 2, 3]),
            decoded: { entries: [] },
            packId,
          };
        },
      },
      mountPack: async () => ({ ok: false, reason: 'slot4_oom' }),
    });

    const out = await scanner.run({
      binaryMeta: { arch: 'arm64' },
      functions: [{ vaHex: '0x1000', name: 'sub_1000', size: 64 }],
      readFunctionBytes: async () => makePatternBytes(1),
    });

    assert.equal(mountedPackIds.has('pack-a'), false);
    assert.equal(out.errors.length, 1);
    assert.deepEqual(out.errors[0], { packId: 'pack-a', reason: 'slot4_oom' });
    assert.equal(out.status, AUTO_ANALYSIS_STATUS.OFFLINE);
  });

  it('does NOT demote WASM for functions shorter than 4 bytes (skips before match)', async () => {
    const preferWasmSeen = [];
    const fakeIndex = {
      entries: [{}],
      libs: [],
      getLib: () => null,
      match(_query, opts) {
        preferWasmSeen.push(opts.preferWasm);
        return {
          engine: 'wasm',
          matched: false,
          verdict: HEXSIG_VERDICT.REJECT,
          symbolName: null,
          libId: 0xffff,
          score1: 0,
          margin: 0,
        };
      },
    };

    const scanner = createHexSigAutoScanner({ hexSigIndex: fakeIndex });
    const out = await scanner.run({
      binaryMeta: { arch: 'arm64' },
      functions: [
        { vaHex: '0x1000', name: 'sub_1000', size: 2 },
        { vaHex: '0x1004', name: 'sub_1004', size: 3 },
        { vaHex: '0x1010', name: 'sub_1010', size: 64 },
      ],
      readFunctionBytes: async (vaHex) => {
        if (vaHex === '0x1000') return new Uint8Array([0x01, 0x02]);
        if (vaHex === '0x1004') return new Uint8Array([0x01, 0x02, 0x03]);
        return makePatternBytes(9, 64);
      },
    });

    assert.equal(out.status, AUTO_ANALYSIS_STATUS.DONE);
    assert.equal(out.scanned, 1);
    assert.deepEqual(preferWasmSeen, [true]);
  });

  it('auto-demotes sessionPreferWasm to false once when 2 packs exceed 224KB (HSIG1_MAX_SLOT4_BYTES)', async () => {
    // 2 packs totaling > 224KB (> 229,376B): each HSIG1 entry is 96B + symbol name, so 2 packs * 1250 entries > 240KB
    const entriesPack1 = [];
    const entriesPack2 = [];
    for (let i = 0; i < 1250; i++) {
      entriesPack1.push(makeExactEntry({
        symbolName: `pack1_sym_${String(i).padStart(4, '0')}`,
        codeBytes: makePatternBytes(i + 1, 64),
        arch: HEXSIG_ARCH_X86_64,
        libId: 1,
      }));
      entriesPack2.push(makeExactEntry({
        symbolName: `pack2_sym_${String(i).padStart(4, '0')}`,
        codeBytes: makePatternBytes(i + 5000, 64),
        arch: HEXSIG_ARCH_X86_64,
        libId: 2,
      }));
    }

    const index = new HexSigIndex();
    const manifest = {
      packs: [
        { packId: 'big-pack-1', arch: 'x86_64', libId: 1, libName: 'Big Pack 1' },
        { packId: 'big-pack-2', arch: 'x86_64', libId: 2, libName: 'Big Pack 2' },
      ],
    };

    // Mock WASM exports with Slot4/scratch cap at HSIG1_MAX_SLOT4_BYTES (224KB) so >224KB pack OOMs -> JS fallback
    let scratchUsed = 0;
    const mockWasmExports = {
      memory: new WebAssembly.Memory({ initial: 8 }),
      hex_engine_scratch_reset() { scratchUsed = 0; },
      hex_engine_scratch_alloc(size) {
        if (scratchUsed + size > HSIG1_MAX_SLOT4_BYTES) return 0;
        const ptr = 1024 + scratchUsed;
        scratchUsed += (size + 7) & ~7;
        return ptr;
      },
      hex_hexsig_mount: () => 0,
      hex_hexsig_match_fn: () => 0,
    };

    let matchWasmCalls = 0;
    const origMatchWasm = index.matchWasm.bind(index);
    index.matchWasm = (codeBytes, archId, opts) => {
      matchWasmCalls++;
      return origMatchWasm(codeBytes, archId, opts);
    };

    const preferWasmHistory = [];
    const origMatch = index.match.bind(index);
    index.match = (query, opts) => {
      preferWasmHistory.push(opts?.preferWasm);
      return origMatch(query, opts);
    };

    const scanner = createHexSigAutoScanner({
      hexSigIndex: index,
      maxPacks: 2,
      matchOpts: { preferWasm: true, wasmExports: mockWasmExports },
      hubLoader: {
        manifest,
        async loadPack(packId) {
          const meta = manifest.packs.find((p) => p.packId === packId);
          return {
            meta,
            rawBytes: new Uint8Array(0),
            decoded: { entries: packId === 'big-pack-1' ? entriesPack1 : entriesPack2 },
          };
        },
      },
    });

    const target0 = makePatternBytes(1, 64);
    const target1 = makePatternBytes(5001, 64);
    const target2 = makePatternBytes(2, 64);
    const bytesMap = new Map([
      ['0x1000', target0],
      ['0x2000', target1],
      ['0x3000', target2],
    ]);

    const out = await scanner.run({
      binaryMeta: { arch: 'amd64' },
      functions: [
        { vaHex: '0x1000', name: 'sub_1000', size: 64 },
        { vaHex: '0x2000', name: 'sub_2000', size: 64 },
        { vaHex: '0x3000', name: 'sub_3000', size: 64 },
      ],
      readFunctionBytes: async (vaHex) => bytesMap.get(vaHex),
    });

    assert.equal(out.status, AUTO_ANALYSIS_STATUS.DONE);
    assert.throws(
      () => encodeHsig1Pack({ entries: index.entries }),
      /exceeds Slot 4 budget/,
      'combined 2-pack HSIG1 blob must exceed 224KB (HSIG1_MAX_SLOT4_BYTES)'
    );
    assert.equal(matchWasmCalls, 1, 'matchWasm must be attempted only once before session auto-demotion');
    assert.deepEqual(preferWasmHistory, [true, false, false]);
    assert.equal(out.named, 3);
    assert.ok(out.results.every((r) => r.engine === 'js'));
  });

  it('terminates early on empty index: SKIPPED with no errors, OFFLINE when pack loading failed', async () => {
    const emptyIdx1 = new HexSigIndex();
    const scanner1 = createHexSigAutoScanner({ hexSigIndex: emptyIdx1 });
    const res1 = await scanner1.run({
      binaryMeta: { arch: 'arm64' },
      functions: [{ vaHex: '0x1000', name: 'sub_1000', size: 64 }],
      readFunctionBytes: async () => makePatternBytes(1),
    });
    assert.equal(res1.status, AUTO_ANALYSIS_STATUS.SKIPPED);

    const emptyIdx2 = new HexSigIndex();
    const scanner2 = createHexSigAutoScanner({
      hexSigIndex: emptyIdx2,
      hubLoader: {
        manifest: { packs: [{ packId: 'offline-pack', arch: 'arm64', libId: 1 }] },
        async loadPack() {
          throw new Error('network_unreachable');
        },
      },
    });
    const res2 = await scanner2.run({
      binaryMeta: { arch: 'arm64' },
      functions: [{ vaHex: '0x1000', name: 'sub_1000', size: 64 }],
      readFunctionBytes: async () => makePatternBytes(1),
    });
    assert.equal(res2.status, AUTO_ANALYSIS_STATUS.OFFLINE);
    assert.equal(res2.errors.length, 1);
  });

  it('checks abort and budget immediately after await loadPack', async () => {
    // Case A: abort during loadPack -> ABORTED, mountPack not called
    const ac = new AbortController();
    let mountCalled = 0;
    const scannerAbort = createHexSigAutoScanner({
      hexSigIndex: new HexSigIndex(),
      hubLoader: {
        manifest: { packs: [{ packId: 'p1', arch: 'arm64', libId: 1 }] },
        async loadPack() {
          ac.abort();
          return { meta: { packId: 'p1', libId: 1 }, rawBytes: new Uint8Array(0), decoded: { entries: [] } };
        },
      },
      mountPack: () => { mountCalled++; },
    });
    const rAbort = await scannerAbort.run({
      binaryMeta: { arch: 'arm64' },
      functions: [{ vaHex: '0x1000', name: 'sub_1000', size: 64 }],
      readFunctionBytes: async () => makePatternBytes(1),
      signal: ac.signal,
    });
    assert.equal(rAbort.status, AUTO_ANALYSIS_STATUS.ABORTED);
    assert.equal(mountCalled, 0);

    // Case B: budget exhausted during loadPack -> BUDGET_EXHAUSTED, mountPack not called
    let now = 0;
    let mountCalledBudget = 0;
    const scannerBudget = createHexSigAutoScanner({
      hexSigIndex: new HexSigIndex(),
      maxBudgetMs: 100,
      nowFn: () => now,
      hubLoader: {
        manifest: { packs: [{ packId: 'p1', arch: 'arm64', libId: 1 }] },
        async loadPack() {
          now = 150;
          return { meta: { packId: 'p1', libId: 1 }, rawBytes: new Uint8Array(0), decoded: { entries: [] } };
        },
      },
      mountPack: () => { mountCalledBudget++; },
    });
    const rBudget = await scannerBudget.run({
      binaryMeta: { arch: 'arm64' },
      functions: [{ vaHex: '0x1000', name: 'sub_1000', size: 64 }],
      readFunctionBytes: async () => makePatternBytes(1),
    });
    assert.equal(rBudget.status, AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED);
    assert.equal(mountCalledBudget, 0);
  });

  it('flushes remaining chunkBatch on BUDGET_EXHAUSTED, but does NOT flush on ABORTED', async () => {
    const b0 = makePatternBytes(10, 64);
    const b1 = makePatternBytes(20, 64);
    const b2 = makePatternBytes(30, 64);
    const index = new HexSigIndex([
      makeExactEntry({ symbolName: 'fn_zero', codeBytes: b0, arch: HEXSIG_ARCH_ARM64, libId: 1 }),
      makeExactEntry({ symbolName: 'fn_one', codeBytes: b1, arch: HEXSIG_ARCH_ARM64, libId: 1 }),
      makeExactEntry({ symbolName: 'fn_two', codeBytes: b2, arch: HEXSIG_ARCH_ARM64, libId: 1 }),
    ], [null, { libId: 1, libName: 'TestLib' }]);

    const bytesMap = new Map([
      ['0x1000', b0],
      ['0x2000', b1],
      ['0x3000', b2],
    ]);

    // BUDGET_EXHAUSTED mid-chunk (chunkSize = 4, budget hits before 3rd function)
    let now = 0;
    let reads = 0;
    const flushedBatches = [];
    const scannerBudget = createHexSigAutoScanner({
      hexSigIndex: index,
      matchOpts: { preferWasm: false },
      chunkSize: 4,
      maxBudgetMs: 50,
      nowFn: () => now,
    });
    const resBudget = await scannerBudget.run({
      binaryMeta: { arch: 'arm64' },
      functions: [
        { vaHex: '0x1000', name: 'sub_1000', size: 64 },
        { vaHex: '0x2000', name: 'sub_2000', size: 64 },
        { vaHex: '0x3000', name: 'sub_3000', size: 64 },
      ],
      readFunctionBytes: async (vaHex) => {
        reads++;
        if (reads === 2) now = 100; // exceed budget after 2nd function read
        return bytesMap.get(vaHex);
      },
      onBatchNamed: (batch) => flushedBatches.push(batch),
    });

    assert.equal(resBudget.status, AUTO_ANALYSIS_STATUS.BUDGET_EXHAUSTED);
    assert.equal(resBudget.named, 2);
    assert.equal(flushedBatches.length, 1);
    assert.deepEqual(flushedBatches[0].map((m) => m.newName), ['fn_zero', 'fn_one']);

    // ABORTED mid-chunk -> remaining chunkBatch must NOT be flushed
    const ac = new AbortController();
    let abortReads = 0;
    const abortBatches = [];
    const scannerAbort = createHexSigAutoScanner({
      hexSigIndex: index,
      matchOpts: { preferWasm: false },
      chunkSize: 4,
    });
    const resAbort = await scannerAbort.run({
      binaryMeta: { arch: 'arm64' },
      functions: [
        { vaHex: '0x1000', name: 'sub_1000', size: 64 },
        { vaHex: '0x2000', name: 'sub_2000', size: 64 },
      ],
      signal: ac.signal,
      readFunctionBytes: async (vaHex) => {
        abortReads++;
        if (abortReads === 2) ac.abort();
        return bytesMap.get(vaHex);
      },
      onBatchNamed: (batch) => abortBatches.push(batch),
    });

    assert.equal(resAbort.status, AUTO_ANALYSIS_STATUS.ABORTED);
    assert.equal(resAbort.named, 1);
    assert.equal(abortBatches.length, 0);
  });
});
