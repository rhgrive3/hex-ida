import { gzipSync } from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';
import { V6Workbench } from '../js/ui/v6-workbench-bridge.js';
import {
  buildBeginnerFunctionCard,
  decorateFunctionAnalysisForUi,
  installFunctionAnalysisPresentation,
} from '../js/ui/function-analysis-presentation.js';
import { createAppAnalysisQueryAdapter } from '../js/analysis/query/app-adapter.js';
import { AUTO_ANALYSIS_STATUS, PATCH_RISK_LEVEL } from '../js/analysis/common/v6-auto-contracts.js';
import { encodeHsig1Pack } from '../js/analysis/signature/hex-sig-pack.js';
import { HEXSIG_ARCH_ARM64 } from '../js/analysis/signature/hex-sig-extractor.js';
import { HEXSIG_HUB_SCHEMA } from '../js/analysis/signature/hexsig-hub-loader.js';
import { compileTil1 } from '../js/analysis/types/core/til-binary-compiler.js';
import { SymbolIndex, EMPTY_INDEX } from '../js/symbols.js';
import { NoteStore } from '../js/names.js';
import { PRIMARY_NAV } from '../js/ui/registry.js';
import { App } from '../js/app.js';
import { lang, setLang } from '../js/i18n.js';

const INITIAL_LANG = lang();
test.afterEach(() => {
  setLang(INITIAL_LANG);
});

function waitTick(ms = 30) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeFakeArm64FuncBytes(seed = 0x11) {
  const out = new Uint8Array(40);
  for (let i = 0; i < 10; i++) {
    out[i * 4 + 0] = (seed + i * 7) & 0xff;
    out[i * 4 + 1] = (0x20 + i * 3) & 0xff;
    out[i * 4 + 2] = (0x80 + (i % 5)) & 0xff;
    out[i * 4 + 3] = 0x91; // ADD Xd, Xn, #imm
  }
  return out;
}

function makeFakeHsigPack(symbolName, codeBytes) {
  const prologueLen = Math.min(32, codeBytes.length);
  const pattern = codeBytes.subarray(0, prologueLen);
  const mask = new Uint8Array(prologueLen).fill(0xff);
  return encodeHsig1Pack({
    archMask: HEXSIG_ARCH_ARM64,
    entries: [{
      symbolName,
      libId: 1,
      archId: HEXSIG_ARCH_ARM64,
      prologueLen,
      pattern,
      mask,
      minFuncLen: codeBytes.length,
      baseConfidence: 950,
    }],
  });
}

function makeFakeTilPackBytes(fnName = 'demo_til_fn') {
  return compileTil1({
    functions: [{ name: fnName, returnType: 'int', params: [{ name: 'a', type: 'int' }] }],
  });
}

function makeMockDocument() {
  const createEl = (tag) => {
    const listeners = new Map();
    const el = {
      tagName: String(tag).toUpperCase(),
      className: '',
      children: [],
      attributes: new Map(),
      dataset: {},
      _text: '',
      get textContent() { return this._text; },
      set textContent(v) { this._text = String(v ?? ''); },
      setAttribute(k, v) { this.attributes.set(k, String(v)); },
      getAttribute(k) { return this.attributes.get(k) ?? null; },
      appendChild(child) { this.children.push(child); return child; },
      removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) this.children.splice(idx, 1);
        return child;
      },
      replaceChildren(...nodes) { this.children = [...nodes]; },
      addEventListener(ev, fn) {
        if (!listeners.has(ev)) listeners.set(ev, new Set());
        listeners.get(ev).add(fn);
      },
      removeEventListener(ev, fn) {
        listeners.get(ev)?.delete(fn);
      },
      _listeners: listeners,
    };
    return el;
  };
  return { createElement: createEl };
}

test('PRIMARY_NAV.length === 4 invariant holds', () => {
  assert.equal(PRIMARY_NAV.length, 4);
});

test('onBinaryReady has +0 ms synchronous overhead and enforces 4-case matrix, binaryKey & lazy hexdb', async () => {
  let hexdbOpened = 0;
  let hexdbCreated = 0;
  const wb = new V6Workbench(null, {
    hexdbFactory: () => {
      hexdbCreated++;
      return {
        open: async () => { hexdbOpened++; },
        close: async () => {},
      };
    },
  });

  // Case 1: !isBinarySwitch && !providers -> SKIPPED, pre-mounted state preserved
  wb._wasmAnalysis = { sentinel: true };
  wb._wasmIndex = { sentinel: true };
  wb.onBinaryReady({ sha256: 'binA', sliceIndex: 0 });
  assert.equal(hexdbCreated, 0, 'hexdb must be lazily created in timer, not synchronously');
  const s1 = wb.getAutoAnalysisState();
  assert.equal(s1.til.status, AUTO_ANALYSIS_STATUS.SKIPPED);
  assert.equal(s1.binaryKey, 'binA|0|');
  assert.ok(Array.isArray(s1.til.errors));
  assert.equal(wb._wasmAnalysis?.sentinel, true, 'Case 1 must preserve pre-mounted _wasmAnalysis');

  await waitTick(20);
  assert.equal(hexdbCreated, 1);
  assert.equal(hexdbOpened, 1);

  // Case 2: isBinarySwitch && !providers -> resetState: true, SKIPPED
  wb.onBinaryReady({ sha256: 'binB', sliceIndex: 0 });
  assert.equal(wb._wasmAnalysis, null, 'Case 2 must reset _wasmAnalysis on binary switch');
  assert.equal(wb.getAutoAnalysisState().binaryKey, 'binB|0|');
  assert.equal(wb.getAutoAnalysisState().til.status, AUTO_ANALYSIS_STATUS.SKIPPED);

  // Case 3: !isBinarySwitch && providers -> resetState: false, IDLE synchronously, providers never called sync
  wb._wasmAnalysis = { keepMe: true };
  let syncProviderCalls = 0;
  wb.onBinaryReady({ sha256: 'binB', sliceIndex: 0 }, {
    getBinaryMeta: () => { syncProviderCalls++; return { platform: 'ios', arch: 'arm64' }; },
    getFunctions: () => { syncProviderCalls++; return []; },
    getDeobfCandidates: () => { syncProviderCalls++; return []; },
  });
  assert.equal(syncProviderCalls, 0, 'providers must NOT be called synchronously');
  assert.equal(wb._wasmAnalysis?.keepMe, true, 'Case 3 must preserve initial pre-mounted state');
  assert.equal(wb.getAutoAnalysisState().til.status, AUTO_ANALYSIS_STATUS.IDLE);

  await waitTick(40);
  assert.ok(syncProviderCalls >= 1, 'providers invoked asynchronously after idle timer');

  // Case 4: isBinarySwitch && providers -> resetState: true, IDLE synchronously
  wb._wasmAnalysis = { shouldClear: true };
  wb.onBinaryReady({ sha256: 'binC', sliceIndex: 0 }, {
    getBinaryMeta: () => ({ platform: 'ios', arch: 'arm64' }),
    getFunctions: () => [],
    getDeobfCandidates: () => [],
  });
  assert.equal(wb._wasmAnalysis, null, 'Case 4 must clear previous binary state');
  assert.equal(wb.getAutoAnalysisState().binaryKey, 'binC|0|');
  assert.equal(wb.getAutoAnalysisState().til.status, AUTO_ANALYSIS_STATUS.IDLE);
  wb.dispose();
});

test('TIL Proxy preserves single _accessSeq (no shadowing), isolates tilAbortController timeout, and blocks community mirror SSRF', async () => {
  const tilBytes = makeFakeTilPackBytes('auto_fn_1');
  const manualTilBytes = makeFakeTilPackBytes('manual_fn_1');
  const wb = new V6Workbench(null, {
    tilFetcher: async () => ({
      ok: true,
      status: 200,
      async arrayBuffer() {
        return manualTilBytes.buffer.slice(manualTilBytes.byteOffset, manualTilBytes.byteOffset + manualTilBytes.byteLength);
      },
    }),
  });

  // Pass tilFetchManifest & tilFetcher via providers (verifies providers.* precedence!)
  wb.onBinaryReady({ sha256: 'tilSeqBin', sliceIndex: 0 }, {
    tilManifestUrl: 'https://example.com/til-hub/manifest.json',
    tilBaseUrl: 'https://example.com/til-hub',
    tilFetchManifest: async () => ({
      schema: 'til-hub-manifest/v1',
      packs: [{
        id: 'ios-demo-til',
        file: 'ios-demo-til.til1',
        priority: 10,
        matchRules: { platforms: ['ios'], dylibs: [], hints: [] },
      }],
    }),
    tilFetcher: async () => ({
      ok: true,
      status: 200,
      async arrayBuffer() {
        return tilBytes.buffer.slice(tilBytes.byteOffset, tilBytes.byteOffset + tilBytes.byteLength);
      },
    }),
    getBinaryMeta: () => ({ platform: 'ios', arch: 'arm64' }),
    getFunctions: () => [],
    getDeobfCandidates: () => [],
  });

  await waitTick(60);
  const slotsAfterAuto = wb.tilPackManager.getMountedSlots();
  assert.equal(slotsAfterAuto.A?.packId, 'ios-demo-til');
  const autoLastAccess = slotsAfterAuto.A.lastAccess;
  assert.ok(wb.tilPackManager._accessSeq >= autoLastAccess, 'underlying tilPackManager._accessSeq must advance without shadowing');

  // Subsequent manual mount must get a strictly greater lastAccess
  await wb.tilPackManager.loadPackWithFallback('manual-pack', {
    url: 'https://example.com/manual.til1',
    preferredSlot: 'B',
  });
  const slotsAfterManual = wb.tilPackManager.getMountedSlots();
  assert.ok(slotsAfterManual.B.lastAccess > autoLastAccess, 'manual mount lastAccess must be strictly greater than auto mount');
  wb.dispose();

  // Timeout isolation + Community mirror SSRF check
  let manualAborted = false;
  const wbTimeout = new V6Workbench(null, {
    tilFetcher: async () => ({
      ok: true,
      status: 200,
      async arrayBuffer() { return new ArrayBuffer(0); },
    }),
    autoAnalysis: {
      tilTimeoutMs: 25,
      tilManifestUrl: 'https://example.com/til-hub/manifest.json',
      tilFetchManifest: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        }, { once: true });
      }),
    },
  });
  const manualPromise = wbTimeout.tilPackManager.fetcher('https://example.com/manual.til').catch(() => {
    manualAborted = true;
  });
  wbTimeout.onBinaryReady({ sha256: 'tilTimeoutBin', sliceIndex: 0 }, {
    getBinaryMeta: () => ({ platform: 'ios', arch: 'arm64' }),
    getFunctions: () => [],
    getDeobfCandidates: () => [],
  });
  await waitTick(70);
  await manualPromise;
  assert.equal(manualAborted, false, 'manual tilPackManager fetcher must not be aborted by auto-analysis timeout');
  wbTimeout.dispose();

  const origFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error('should_not_fetch_ssrf');
  };
  try {
    const wb2 = new V6Workbench(null, {
      autoAnalysis: {
        tilIsCommunityMirror: true,
        tilManifestUrl: 'http://127.0.0.1/til-hub/manifest.json',
      },
    });
    wb2.onBinaryReady({ sha256: 'ssrfBin', sliceIndex: 0 }, {
      getBinaryMeta: () => ({ platform: 'ios', arch: 'arm64' }),
      getFunctions: () => [],
      getDeobfCandidates: () => [],
    });
    await waitTick(40);
    assert.equal(fetchCalled, false, 'SSRF community mirror URL must be rejected before fetch');
    wb2.dispose();
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('_fetchBoundedBytes handles arrayBuffer() fallback, reader.cancel() on overflow, and hexsigManifestUrl lazy loader switching/fallback', async () => {
  const fnBytes = makeFakeArm64FuncBytes(0x55);
  const packBytes = makeFakeHsigPack('lazy_hexsig_fn', fnBytes);
  const gzPack = new Uint8Array(gzipSync(packBytes));
  const manifestJson = JSON.stringify({
    schema: HEXSIG_HUB_SCHEMA,
    format: 'HSIG1',
    packs: [{
      packId: 'ios-arm64-lazy',
      file: 'ios-arm64-lazy.hsig1.gz',
      libName: 'LazyLib',
      libId: 1,
      arch: 'arm64',
      archMask: HEXSIG_ARCH_ARM64,
      entryCount: 1,
      rawBytes: packBytes.length,
    }],
  });
  const manifestBytes = new TextEncoder().encode(manifestJson);

  let readerCancelled = false;
  let mode = 'arrayBufferFallback';
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (mode === 'overflowStream') {
      let sent = 0;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: {
          getReader() {
            return {
              async read() {
                if (sent >= 3) return { done: true, value: undefined };
                sent++;
                return { done: false, value: new Uint8Array(600 * 1024) };
              },
              async cancel() { readerCancelled = true; },
            };
          },
        },
      };
    }
    if (mode === 'offline') {
      throw new Error('network_down');
    }
    // arrayBuffer() fallback (no resp.body)
    const bytes = String(url).endsWith('manifest.json') ? manifestBytes : gzPack;
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(bytes.byteLength) },
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  };

  try {
    const wb = new V6Workbench(null, {
      autoAnalysis: { hexsigVerifySha256: false },
    });

    // 1. arrayBuffer() fallback works end-to-end via providers.hexsigManifestUrl
    wb.onBinaryReady({ sha256: 'lazy1', sliceIndex: 0 }, {
      hexsigManifestUrl: 'https://example.com/hexsig-hub/manifest.json',
      getBinaryMeta: () => ({ platform: 'ios', arch: 'arm64' }),
      getFunctions: () => [{ va: 0x1000n, name: 'sub_1000', size: fnBytes.length }],
      readFunctionBytes: async () => fnBytes,
      getDeobfCandidates: () => [],
    });
    await waitTick(80);
    assert.equal(wb.getAutoAnalysisState().hexsig.status, AUTO_ANALYSIS_STATUS.DONE);
    assert.equal(wb._autoNamedFunctions.get('0x1000')?.newName, 'lazy_hexsig_fn');

    // 2. Streaming overflow triggers reader.cancel() and falls back to OFFLINE on empty index
    mode = 'overflowStream';
    wb.onBinaryReady({ sha256: 'lazy2', sliceIndex: 0 }, {
      hexsigManifestUrl: 'https://example.com/hexsig-hub/manifest.json',
      getBinaryMeta: () => ({ platform: 'ios', arch: 'arm64' }),
      getFunctions: () => [{ va: 0x1000n, name: 'sub_1000', size: fnBytes.length }],
      readFunctionBytes: async () => fnBytes,
      getDeobfCandidates: () => [],
    });
    await waitTick(80);
    assert.equal(readerCancelled, true, 'reader.cancel() must be called when streaming response exceeds maxBytes');
    assert.equal(wb.getAutoAnalysisState().hexsig.status, AUTO_ANALYSIS_STATUS.OFFLINE);

    // 3. Offline manifest fetch on empty index -> OFFLINE
    mode = 'offline';
    wb.onBinaryReady({ sha256: 'lazy3', sliceIndex: 0 }, {
      hexsigManifestUrl: 'https://example.com/hexsig-hub/manifest.json',
      getBinaryMeta: () => ({ platform: 'ios', arch: 'arm64' }),
      getFunctions: () => [{ va: 0x1000n, name: 'sub_1000', size: fnBytes.length }],
      readFunctionBytes: async () => fnBytes,
      getDeobfCandidates: () => [],
    });
    await waitTick(80);
    assert.equal(wb.getAutoAnalysisState().hexsig.status, AUTO_ANALYSIS_STATUS.OFFLINE);
    wb.dispose();
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('real App._buildV6AutoProviders (virtual addr readAt, background priority, provenance, 5-stage protection) & _syncAutoReportWasmAnalysis', async () => {
  const fnBytes = makeFakeArm64FuncBytes(0x33);
  const packBytes = makeFakeHsigPack('demo_crypto_init', fnBytes);
  const gzPack = new Uint8Array(gzipSync(packBytes));

  const readAtCalls = [];
  const syms = new SymbolIndex({ regions: [] });
  syms.addNames([{ addr: 0x3000n, name: 'existing_real_fn' }]);
  syms.rename(0x2000n, 'my_manual_fn');
  const notes = new NoteStore('test-real-app-notes', []);
  notes.setName(0x4000n, 'note_named_fn');

  let viewerRefresh = 0;
  const fakeApp = Object.create(App.prototype);
  fakeApp.backend = {
    gen: 7,
    readAt: async (addr, len, text, opts) => {
      readAtCalls.push({ addr, len, text, opts });
      return { found: true, bytes: fnBytes };
    },
  };
  fakeApp.store = {
    get(k) {
      if (k === 'sliceIndex') return 0;
      if (k === 'architecture') return 'arm64';
      return null;
    },
  };
  fakeApp.currentSlice = () => ({ info: { platform: 'ios', architecture: 'arm64', dylibs: [] } });
  fakeApp.executableRegionFor = (va) => ({
    id: 1,
    vmAddr: 0x1000n,
    fileOffset: 0x4000n,
    size: 0x5000n,
  });
  fakeApp.symbols = syms;
  fakeApp.notes = notes;
  fakeApp.viewer = { setSymbols() { viewerRefresh++; }, invalidate() {} };
  fakeApp.v6Workbench = new V6Workbench(fakeApp, {
    autoAnalysis: {
      hexsigManifest: {
        schema: HEXSIG_HUB_SCHEMA,
        format: 'HSIG1',
        packs: [{
          packId: 'ios-arm64-demo',
          file: 'ios-arm64-demo.hsig1.gz',
          libName: 'DemoLib',
          libId: 1,
          arch: 'arm64',
          archMask: HEXSIG_ARCH_ARM64,
          entryCount: 1,
          rawBytes: packBytes.length,
        }],
      },
      hexsigVerifySha256: false,
      hexsigFetchBytes: async () => gzPack,
    },
  });

  const providers = fakeApp._buildV6AutoProviders(7, 0);
  assert.equal(providers.tilManifestUrl, 'til-hub/manifest.json');
  assert.equal(providers.hexsigManifestUrl, 'hexsig-hub/manifest.json');

  // Verify readFunctionBytes passes virtual address (0x1000n, NOT fileOffset 0x4000n), background priority, and unwraps { found, bytes }
  const gotBytes = await providers.readFunctionBytes(0x1000n, fnBytes.length);
  assert.ok(gotBytes instanceof Uint8Array);
  assert.equal(readAtCalls.length, 1);
  assert.equal(readAtCalls[0].addr, 0x1000n, 'must pass virtual address to backend.readAt');
  assert.equal(readAtCalls[0].text, false);
  assert.deepEqual(readAtCalls[0].opts, { priority: 'background' });

  // Verify onAutoNamedBatch 5-stage protection & SymbolIndex provenance
  const accepted = providers.onAutoNamedBatch([
    { vaHex: '0x1000', newName: 'demo_crypto_init', score: 920 },
    { vaHex: '0x2000', newName: 'should_not_overwrite_rename', score: 950 },
    { vaHex: '0x3000', newName: 'should_not_overwrite_real', score: 950 },
    { vaHex: '0x4000', newName: 'should_not_overwrite_note', score: 950 },
  ]);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].vaHex, '0x1000');
  assert.equal(syms.nameAt(0x1000n), 'demo_crypto_init');
  assert.equal(syms.nameAt(0x2000n), 'my_manual_fn');
  assert.equal(syms.nameAt(0x3000n), 'existing_real_fn');
  assert.equal(viewerRefresh, 1);

  const prov = syms.provenanceAt?.(0x1000n);
  if (prov) {
    assert.equal(prov.source, 'hexsig');
    assert.equal(prov.confirmed, false);
    assert.ok(prov.confidence > 0.9 && prov.confidence < 0.95);
  }

  // Verify EMPTY_INDEX guard & sliceIndex guard
  fakeApp.symbols = EMPTY_INDEX;
  assert.deepEqual(providers.onAutoNamedBatch([{ vaHex: '0x5000', newName: 'x', score: 900 }]), []);
  assert.equal(EMPTY_INDEX.functionCount, 0);

  // Verify _syncAutoReportWasmAnalysis re-syncs after reset (!this.v6Workbench._wasmAnalysis)
  const wa = { rmw: { hits: [] } };
  fakeApp.autoReport = { report: { wasmAnalysis: wa } };
  fakeApp._lastIngestedWasmAnalysis = wa;
  fakeApp.v6Workbench._wasmAnalysis = null;
  fakeApp._syncAutoReportWasmAnalysis();
  assert.equal(fakeApp.v6Workbench._wasmAnalysis, wa, 'must re-ingest when _wasmAnalysis was reset');

  fakeApp.v6Workbench.dispose();
});

test('continuous binary switches & detach() reset hexsigIndex cleanly without entry doubling, and STL 2-evidence + clean function hasOverlay=false work E2E', async () => {
  const fnBytes = makeFakeArm64FuncBytes(0x33);
  const packBytes = makeFakeHsigPack('demo_crypto_init', fnBytes);

  const manifest = {
    schema: HEXSIG_HUB_SCHEMA,
    format: 'HSIG1',
    packs: [{
      packId: 'ios-arm64-demo',
      file: 'ios-arm64-demo.hsig1.gz',
      libName: 'DemoLib',
      libId: 1,
      arch: 'arm64',
      archMask: HEXSIG_ARCH_ARM64,
      entryCount: 1,
      rawBytes: packBytes.length,
    }],
  };

  const wb = new V6Workbench(null, {
    autoAnalysis: {
      hexsigManifest: manifest,
      hexsigVerifySha256: false,
      hexsigFetchBytes: async () => new Uint8Array(gzipSync(packBytes)),
    },
  });

  const runSwitch = async (sha) => {
    const syms = new SymbolIndex({ regions: [] });
    syms.addNames([{ addr: 0x3000n, name: 'existing_real_fn' }]);
    syms.rename(0x2000n, 'my_manual_fn');
    const notes = new NoteStore(`test-notes-${sha}`, []);
    notes.setName(0x3000n, 'note_named_fn');

    let viewerRefreshCount = 0;
    const fakeApp = {
      symbols: syms,
      notes,
      viewer: { setSymbols() { viewerRefreshCount++; }, invalidate() {} },
    };
    wb.app = fakeApp;

    wb.onBinaryReady({ sha256: sha, sliceIndex: 0 }, {
      getBinaryMeta: () => ({ platform: 'ios', arch: 'arm64' }),
      getFunctions: () => [
        { va: 0x1000n, name: 'sub_1000', size: fnBytes.length },
        { va: 0x2000n, name: 'sub_2000', size: fnBytes.length },
        { va: 0x3000n, name: 'existing_real_fn', size: fnBytes.length },
      ],
      readFunctionBytes: async () => fnBytes,
      onAutoNamedBatch: (batch) => {
        const accepted = [];
        const toAdd = [];
        for (const m of batch) {
          const vaBig = BigInt(m.vaHex);
          const decKey = vaBig.toString();
          if (notes.nameOf(vaBig)) continue;
          if (syms.renames?.has(decKey)) continue;
          accepted.push(m);
          toAdd.push({ addr: vaBig, name: m.newName, provenance: { source: 'hexsig', confidence: 0.95, confirmed: false } });
        }
        if (toAdd.length > 0 && syms.addNames(toAdd, { source: 'hexsig', confidence: 0.95, confirmed: false }) > 0) {
          fakeApp.viewer.setSymbols(syms);
        }
        return accepted;
      },
      getDeobfCandidates: () => [
        { va: 0x1000n, name: 'sub_1000', isEntry: true, size: 600 },
        { va: 0x4000n, name: 'clean_fn', size: 600 },
      ],
      loadDeobfCandidateInput: (c) => {
        if (c.vaHex === '0x1000') {
          return {
            cfg: null,
            mbaNodes: [],
            stlInput: {
              fields: [{ offset: 0, size: 8 }, { offset: 8, size: 8 }, { offset: 16, size: 8 }],
              symbols: ['std::vector<int>::push_back(int const&)'],
              structSize: 24,
              ptrSize: 8,
            },
          };
        }
        return {
          cfg: { entry: 0, blocks: [{ id: 0, succs: [] }] },
          mbaNodes: [],
          stlInput: null,
        };
      },
    });

    await waitTick(80);
    return { syms, viewerRefreshCount };
  };

  const first = await runSwitch('bin1');
  assert.equal(wb.hexsigIndex.entries.length, 1, 'first mount has 1 entry');
  assert.equal(first.syms.nameAt(0x1000n), 'demo_crypto_init');
  assert.equal(first.syms.nameAt(0x2000n), 'my_manual_fn', 'SymbolIndex.rename protected');
  assert.equal(first.viewerRefreshCount, 1);
  assert.equal(wb._autoNamedFunctions.has('0x2000'), false);
  assert.ok(wb.getAutoAnalysisState().deobf.stlHits >= 1);
  assert.equal(wb.getFunctionEnrichment('0x4000').deobfOverlay.hasOverlay, false);

  // Detach and switch to second binary: hexsigIndex entries must NOT double
  wb.detach();
  assert.equal(wb.hexsigIndex.entries.length, 0);
  const second = await runSwitch('bin2');
  assert.equal(wb.hexsigIndex.entries.length, 1, 're-mounting same pack after detach/switch must NOT double entries');
  assert.equal(second.syms.nameAt(0x1000n), 'demo_crypto_init');
  wb.dispose();
});

test('deobfOverlay propagates into assessPatchRisk in both buildBeginnerFunctionCard and getBeginnerFunctionGuide', () => {
  const wb = new V6Workbench(null);
  wb.deobfOverlay.setAnnotation({
    insnVa: '0x1000',
    kind: 1,
    source: 'bounded_abstract_vm',
    text: 'CFF recovered',
  });
  const guide = wb.getBeginnerFunctionGuide('0x1000');
  assert.equal(guide.enrichment.deobfOverlay.hasOverlay, true);
  assert.ok(guide.patchRisk.score >= 35, 'deobfOverlay must contribute +35 risk score in getBeginnerFunctionGuide');
  assert.ok(guide.patchRisk.glossaryKeys.includes('cff'));

  const card = buildBeginnerFunctionCard(
    { model: { startAddress: 0x1000n, instructions: [{ mnemonic: 'mov' }], basicBlocks: [] } },
    null,
    { v6Enrichment: guide.enrichment },
  );
  assert.ok(card.patchRisk.score >= 35, 'deobfOverlay must contribute +35 risk score in buildBeginnerFunctionCard');
  assert.ok(card.glossaryMatches.includes('cff'));
  wb.dispose();
});

test('installFunctionAnalysisPresentation + installRoutes unwrap/reinstall works across fallback, analysisQueries, and ARM64 legacy startAddr paths', async () => {
  let hookCalls = 0;
  let baseCalls = 0;
  let queryCalls = 0;

  const mockApp = {
    backend: { gen: 1, binaryId: 'b1' },
    store: { get: (k) => (k === 'regions' ? [] : -1) },
    symbols: EMPTY_INDEX,
    v6Workbench: new V6Workbench(null),
    getFunctionEnrichment(va) {
      return this.v6Workbench.getFunctionEnrichment(va, { rawName: '_Z3fooi' });
    },
    _scheduleV6PostAnalyzeHook() {
      hookCalls++;
    },
    async analyzeFunctionAt(addr) {
      baseCalls++;
      return {
        startAddr: BigInt(addr),
        model: {
          startAddress: BigInt(addr),
          instructions: [{ mnemonic: 'mov' }, { mnemonic: 'ret' }],
          basicBlocks: [],
        },
      };
    },
  };

  const firstRoute = installFunctionAnalysisPresentation(mockApp);
  const secondRoute = installFunctionAnalysisPresentation(mockApp);
  assert.equal(firstRoute, secondRoute, 'idempotency preserved');
  mockApp._reinstallPresentationWrapper = () => installFunctionAnalysisPresentation(mockApp);

  // Path 1: Before installRoutes
  const r1 = await mockApp.analyzeFunctionAt(0x1000n);
  assert.equal(baseCalls, 1);
  assert.equal(hookCalls, 1);
  assert.equal(r1.beginnerSummary?.patchRisk?.level, PATCH_RISK_LEVEL.LOW);

  // Path 2: After repeated installRoutes with !app.analysisQueries fallback
  createAppAnalysisQueryAdapter(mockApp);
  createAppAnalysisQueryAdapter(mockApp);
  mockApp.analysisQueries = null;
  const r2 = await mockApp.analyzeFunctionAt(0x1000n);
  assert.equal(baseCalls, 2);
  assert.equal(hookCalls, 2, 'hook fires strictly once on fallback path');
  assert.ok(r2.beginnerSummary?.v6Highlights?.length >= 1);

  // Path 3: With active app.analysisQueries returning semantic result
  mockApp.analysisQueries = {
    async snapshot() { return { id: 'snap1' }; },
    async function(_snap, id) {
      queryCalls++;
      return {
        completeness: 'complete',
        value: {
          startAddr: BigInt(id),
          model: { startAddress: BigInt(id), instructions: [{ mnemonic: 'ret' }], basicBlocks: [] },
        },
      };
    },
  };
  const r3 = await mockApp.analyzeFunctionAt(0x1000n);
  assert.equal(queryCalls, 1);
  assert.equal(hookCalls, 3, 'hook fires strictly once on analysisQueries path');
  assert.ok(r3.beginnerSummary?.v6Highlights?.length >= 1);

  mockApp.v6Workbench.dispose();
});

test('decorateFunctionAnalysisForUi covers all 4 cases accurately', () => {
  const withModel = Object.freeze({
    model: { startAddress: 0x1000n, instructions: [{ mnemonic: 'ret' }], basicBlocks: [] },
  });

  // Case 1: result.model present & no v6Enrichment -> strict === identity
  assert.equal(decorateFunctionAnalysisForUi(withModel), withModel);

  // Case 3: result.model present & v6Enrichment present -> shallow copy, no presentationProjection
  const c3 = decorateFunctionAnalysisForUi(withModel, {
    v6Enrichment: { rawName: '_Z3fooi', demangledName: 'foo(int)', wasmHints: { available: false } },
  });
  assert.notEqual(c3, withModel);
  assert.equal(c3.presentationProjection, undefined);
  assert.ok(c3.beginnerSummary.v6Highlights.length >= 1);

  // Case 2 & Case 4: !result.model with legacyV1
  const legacyOnly = {
    pipeline: { legacyV1: { startAddress: 0x2000n, instructions: [{ mnemonic: 'ret' }], blocks: [] } },
  };
  const c2 = decorateFunctionAnalysisForUi(legacyOnly);
  assert.ok(c2.presentationProjection?.canonical === true);
  assert.equal(c2.beginnerSummary.v6Highlights, undefined);

  const c4 = decorateFunctionAnalysisForUi(legacyOnly, {
    v6Enrichment: { rawName: '_Z3bari', demangledName: 'bar(int)', wasmHints: { available: false } },
  });
  assert.ok(c4.presentationProjection?.canonical === true);
  assert.ok(c4.beginnerSummary.v6Highlights.length >= 1);

  // Backward compatibility: buildBeginnerFunctionCard without opts returns exact 4 fields
  const baseCard = buildBeginnerFunctionCard(withModel, 'plain_fn');
  assert.deepEqual(Object.keys(baseCard).sort(), ['headline', 'patchImpact', 'technicalDetails', 'whatItDoes']);
});

test('mountBeginnerWorkflowPanel refreshes activeCard with latest v6Enrichment (including ARM64 startAddr), supports multiple panels, and cleans up on destroy() / dispose()', () => {
  const fakeApp = {
    semantic: {
      result: {
        startAddr: 0x1000n,
        model: { instructions: [{ mnemonic: 'paciasp' }, { mnemonic: 'ret' }], basicBlocks: [] },
      },
    },
  };
  const wb = new V6Workbench(fakeApp);
  const doc = makeMockDocument();
  const c1 = doc.createElement('div');
  const c2 = doc.createElement('div');

  const h1 = wb.mountBeginnerWorkflowPanel(c1, { doc, activeFuncVa: '0x1000' });
  const h2 = wb.mountBeginnerWorkflowPanel(c2, { doc, activeFuncVa: '0x2000' });
  assert.equal(wb._mountedWorkflowPanels.size, 2);
  assert.equal(wb._autoAnalysisListeners.size, 2);

  // Verify ARM64 legacy startAddr matched semantic.result and detected PAC instruction as HIGH risk
  const guide1 = wb.getBeginnerFunctionGuide('0x1000');
  assert.equal(guide1.patchRisk.level, PATCH_RISK_LEVEL.HIGH);

  wb.notifyAutoAnalysisUpdate({ deobfHit: true, stlHit: true });
  assert.equal(wb.getAutoAnalysisState().deobf.deobfHits, 1);
  assert.equal(wb.getAutoAnalysisState().deobf.stlHits, 1);

  // Single panel destroy unsubscribes only itself
  h1.destroy();
  assert.equal(wb._mountedWorkflowPanels.size, 1);
  assert.equal(wb._autoAnalysisListeners.size, 1);

  // detach() keeps remaining panel & listener alive
  wb.detach();
  assert.equal(wb._mountedWorkflowPanels.size, 1);
  assert.equal(wb._autoAnalysisListeners.size, 1);

  // dispose() destroys all remaining panels & clears listeners
  wb.dispose();
  assert.equal(wb._mountedWorkflowPanels.size, 0);
  assert.equal(wb._autoAnalysisListeners.size, 0);
  h2.update(); // safe no-op after dispose
});

test('openFile & selectSlice start _startV6AutoAnalysis on ensureBinaryId/restoreAnalysisSession/restoreDeltaSession failures and sampleOpen', async () => {
  const startedCalls = [];
  const makeFakeApp = ({ ensureFails = false, restoreAnalysisFails = false, restoreDeltaFails = false, sampleOpen = false, staleEpoch = false } = {}) => {
    const state = { sliceIndex: 0, file: { name: 'a.bin' }, fileInfo: { name: 'a.bin', slices: [{ info: { isArm64: true } }] } };
    const app = Object.create(App.prototype);
    app.backend = {
      gen: 1,
      binaryId: null,
      advanceEpoch() { this.gen++; },
      async open() { return { name: 'a.bin', slices: [{ info: { isArm64: true } }] }; },
      async ensureBinaryId() {
        if (staleEpoch) app.backend.gen = 99;
        if (ensureFails) throw new Error('binaryId_fail');
        return 'bid-1';
      },
    };
    app.store = {
      get: (k) => state[k],
      set: (patch) => Object.assign(state, patch),
    };
    app.viewer = { setSymbols() {}, invalidate() {} };
    app.bookmarks = { clear() {} };
    app._undoStack = [];
    app._redoStack = [];
    app.analysisResume = {
      saveLastFile: async () => {},
      updateLastFileMeta: async () => {},
    };
    app.sampleOpen = sampleOpen;
    app.forgetSemantics = () => {};
    app._resetDeltaReadiness = () => {};
    app._createPatchSet = () => ({});
    app.setBusy = () => {};
    app.applySlice = (idx) => { state.sliceIndex = idx; };
    app.attachNotes = async () => {};
    app.workspace = { bind: async () => null, autosave() {}, invalidate() {} };
    app.plugins = { emit() {} };
    app.navigation = { clear() {} };
    app.autoReport = null;
    app.flushDeltaSave = async () => {};
    app.cancelAll = () => {};
    app.currentSlice = () => ({ info: { isArm64: true } });
    app.restoreAnalysisSession = async () => {
      if (restoreAnalysisFails) throw new Error('restore_analysis_fail');
      return false;
    };
    app.restoreDeltaSession = async () => {
      if (restoreDeltaFails) throw new Error('restore_delta_fail');
    };
    app.persistAnalysisSession = async () => false;
    app._currentDeltaFingerprint = () => ({ sha256: 'sha-open', sliceIndex: state.sliceIndex });
    app.v6 = {
      onBinaryReady(fp, prov) {
        startedCalls.push({ fp, hasProv: Boolean(prov) });
      },
    };
    app.v6Workbench = app.v6;
    return app;
  };

  const origDoc = globalThis.document;
  const origCE = globalThis.CustomEvent;
  globalThis.document = { dispatchEvent() {} };
  globalThis.CustomEvent = class CustomEvent { constructor(t, o) { this.type = t; this.detail = o?.detail; } };
  try {
    // 1. openFile: ensureBinaryId fails (matching epoch) -> still triggers _startV6AutoAnalysis
    startedCalls.length = 0;
    const a1 = makeFakeApp({ ensureFails: true });
    await a1.openFile({ name: 'a.bin' });
    await a1.analysisResumeReady;
    assert.equal(startedCalls.length, 1, 'openFile must fallback-start v6 auto analysis when ensureBinaryId fails');

    // 2. openFile: ensureBinaryId fails (stale epoch) -> must NOT trigger
    startedCalls.length = 0;
    const a2 = makeFakeApp({ ensureFails: true, staleEpoch: true });
    await a2.openFile({ name: 'a.bin' });
    await a2.analysisResumeReady;
    assert.equal(startedCalls.length, 0, 'openFile must not start v6 auto analysis when epoch is stale');

    // 3. openFile: restoreAnalysisSession + restoreDeltaSession both throw -> still triggers
    startedCalls.length = 0;
    const a3 = makeFakeApp({ restoreAnalysisFails: true, restoreDeltaFails: true });
    await a3.openFile({ name: 'a.bin' });
    await a3.analysisResumeReady;
    assert.equal(startedCalls.length, 1, 'openFile must start v6 auto analysis even when session/delta restore fail');

    // 4. openFile: sampleOpen === true -> still triggers
    startedCalls.length = 0;
    const a4 = makeFakeApp({ sampleOpen: true });
    await a4.openFile({ name: 'sample.bin' }, { sample: true });
    await a4.analysisResumeReady;
    assert.equal(startedCalls.length, 1, 'openFile must start v6 auto analysis for sampleOpen');
    a4.backend.gen++; // cancel 250ms sample guide timer

    // 5. selectSlice: ensureBinaryId fails -> triggers; restoreAnalysisSession fails -> triggers
    startedCalls.length = 0;
    const s1 = makeFakeApp({ ensureFails: true });
    s1.store.set({ fileInfo: { name: 'fat.bin', slices: [{ info: { isArm64: true } }, { info: { isArm64: true } }] } });
    await s1.selectSlice(1);
    await s1.analysisResumeReady;
    assert.equal(startedCalls.length, 1, 'selectSlice must fallback-start v6 auto analysis when ensureBinaryId fails');

    startedCalls.length = 0;
    const s2 = makeFakeApp({ restoreAnalysisFails: true, restoreDeltaFails: true });
    s2.store.set({ fileInfo: { name: 'fat.bin', slices: [{ info: { isArm64: true } }, { info: { isArm64: true } }] } });
    await s2.selectSlice(1);
    await s2.analysisResumeReady;
    assert.equal(startedCalls.length, 1, 'selectSlice must start v6 auto analysis when session/delta restore fail');
  } finally {
    globalThis.document = origDoc;
    globalThis.CustomEvent = origCE;
  }
});

test('sliceIndex/epoch guard, pre-mounted hexsigManifestUrl fallback, TIL timeout continuation, STL commit:false zero cache pollution, and DOM activeCard refresh', async () => {
  const fnBytes = makeFakeArm64FuncBytes(0x77);
  const packBytes = makeFakeHsigPack('premounted_fn', fnBytes);

  // 1. sliceIndex & epoch guard + SymbolIndex existing stripped addr consistency
  const syms = new SymbolIndex({ regions: [] });
  syms.addNames([{ addr: 0x9000n, name: 'sub_9000' }]);
  let curSlice = 0;
  const fakeApp = Object.create(App.prototype);
  fakeApp.backend = { gen: 5, readAt: async () => ({ found: true, bytes: fnBytes }) };
  fakeApp.store = { get: (k) => (k === 'sliceIndex' ? curSlice : null) };
  fakeApp.executableRegionFor = () => ({ vmAddr: 0x1000n, size: 0x10000n });
  fakeApp.symbols = syms;
  fakeApp.notes = new NoteStore('guard-test', []);
  fakeApp.viewer = { setSymbols() {}, invalidate() {} };
  fakeApp.v6Workbench = new V6Workbench(fakeApp);

  const providers = fakeApp._buildV6AutoProviders(5, 0);
  // Existing addrs entry 'sub_9000' is skipped by SymbolIndex.addNames -> must NOT be returned in accepted
  const skippedExisting = providers.onAutoNamedBatch([{ vaHex: '0x9000', newName: 'renamed_by_hexsig', score: 950 }]);
  assert.deepEqual(skippedExisting, [], 'entries skipped by SymbolIndex.addNames must not be returned as accepted');

  // Change sliceIndex -> all provider methods blocked
  curSlice = 1;
  assert.deepEqual(providers.getFunctions(), []);
  assert.equal(await providers.readFunctionBytes(0x1000n, 40), null);
  assert.deepEqual(providers.onAutoNamedBatch([{ vaHex: '0x1000', newName: 'blocked_slice', score: 950 }]), []);

  // Restore sliceIndex, advance epoch -> blocked
  curSlice = 0;
  fakeApp.backend.gen = 6;
  assert.deepEqual(providers.getFunctions(), []);
  assert.equal(await providers.readFunctionBytes(0x1000n, 40), null);
  assert.deepEqual(providers.onAutoNamedBatch([{ vaHex: '0x1000', newName: 'blocked_epoch', score: 950 }]), []);
  fakeApp.v6Workbench.dispose();

  // 2. Pre-mounted HexSig index continues as DONE when hexsigManifestUrl fails + TIL timeout does not stop Phase 2/3
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline_manifest'); };
  try {
    const wb = new V6Workbench(null, {
      autoAnalysis: {
        tilTimeoutMs: 20,
        tilManifestUrl: 'https://example.com/til-hub/manifest.json',
        tilFetchManifest: async (_u, { signal }) => new Promise((_r, rej) => {
          signal.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            rej(e);
          }, { once: true });
        }),
      },
    });
    // Pre-mount a HexSig pack on initial binary (Case 3 preserves pre-mounted index!)
    const mountRes = wb.mountHexSigPack(packBytes, { packId: 'premounted', libId: 1, libName: 'PreLib' });
    assert.equal(mountRes.ok, true);

    wb.onBinaryReady({ sha256: 'premountedBin', sliceIndex: 0 }, {
      hexsigManifestUrl: 'https://example.com/hexsig-hub/manifest.json',
      getBinaryMeta: () => ({ platform: 'ios', arch: 'arm64' }),
      getFunctions: () => [{ va: 0x1000n, name: 'sub_1000', size: fnBytes.length }],
      readFunctionBytes: async () => fnBytes,
      getDeobfCandidates: () => [],
    });
    await waitTick(90);
    const st = wb.getAutoAnalysisState();
    assert.equal(st.til.status, AUTO_ANALYSIS_STATUS.ABORTED, 'TIL phase timed out as ABORTED');
    assert.equal(st.hexsig.status, AUTO_ANALYSIS_STATUS.DONE, 'pre-mounted HexSig pack must continue as DONE despite offline manifest');
    assert.equal(wb._autoNamedFunctions.get('0x1000')?.newName, 'premounted_fn');
    wb.dispose();
  } finally {
    globalThis.fetch = origFetch;
  }

  // 3. recognizeStlPattern({ commit: false }) leaves this.stlRecognizer cache untouched
  const wbStl = new V6Workbench(null);
  const stlRes = wbStl.recognizeStlPattern({
    funcVa: '0x1000',
    fields: [{ offset: 0, size: 8 }, { offset: 8, size: 8 }, { offset: 16, size: 8 }],
    symbols: ['std::vector<int>::push_back(int const&)'],
    structSize: 24,
    ptrSize: 8,
  }, { commit: false });
  assert.equal(stlRes.recognized, true);
  assert.equal(wbStl._stlByFunc.size, 0, 'commit: false must not write _stlByFunc');
  assert.equal(wbStl.stlRecognizer.cacheSize ?? wbStl.stlRecognizer._cache?.size ?? 0, 0, 'commit: false must not pollute stlRecognizer cache');

  // 4. 64 clean functions do not starve getBeginnerAutoGuide when a high-value function is at index 70
  const manyFns = [];
  for (let i = 0; i < 70; i++) {
    manyFns.push({ vaHex: `0x${(0x1000 + i * 0x10).toString(16)}`, name: `sub_${i}` });
  }
  manyFns.push({ vaHex: '0x9000', name: 'main', isEntry: true });
  const guide = wbStl.getBeginnerAutoGuide({ limit: 5, functions: manyFns });
  assert.equal(guide.starterFunctions[0]?.vaHex, '0x9000', 'high-score starter function beyond index 64 must not be starved');

  // 5. notifyAutoAnalysisUpdate refreshes activeCard DOM in mountBeginnerWorkflowPanel
  const doc = makeMockDocument();
  const container = doc.createElement('div');
  const collectText = (node) => [node.textContent || '', ...(node.children || []).flatMap(collectText)].join(' ');
  const handle = wbStl.mountBeginnerWorkflowPanel(container, { doc, activeFuncVa: '0x1000' });
  const beforeText = collectText(container);
  wbStl.deobfOverlay.setAnnotation({ insnVa: '0x1000', kind: 1, source: 'bounded_abstract_vm', text: 'CFF recovered' });
  wbStl.notifyAutoAnalysisUpdate({ deobfHit: true });
  const afterText = collectText(container);
  assert.notEqual(afterText, beforeText, 'notifyAutoAnalysisUpdate must refresh activeCard DOM with latest v6Enrichment');
  handle.destroy();
  wbStl.dispose();
});
