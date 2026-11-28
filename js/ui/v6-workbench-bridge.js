/*
 * Hex-IDA v6 E2E Workbench Bridge.
 *
 * Connects js/app.js and js/ui/product-base.js to all v6 engines and contextual
 * UI popovers without adding top-level navigation tabs (PRIMARY_NAV.length === 4)
 * and without blocking initial binary load (loaderOpenLatency +0 ms).
 */

import { detectRuntimeProfile } from '../core/budgets/runtime-profile.js';
import { MemoryBudget } from '../core/budgets/memory-budget.js';
import { HexDbClient } from '../cache/hexdb/hexdb-client.js';
import {
  STAGED_AUTO_ANALYSIS_STAGES,
  normalizeStagedAutoAnalysis,
} from '../cache/delta-session.js';
import { pick } from '../i18n.js';
import { TilLiteResolver } from '../analysis/types/core/til-lite-resolver.js';
import {
  TilPackManager,
  PACK_LIMITS,
  validateCommunityMirrorUrl,
  validateManifestPayload,
} from '../analysis/types/core/til-pack-manager.js';
import {
  AUTO_ANALYSIS_STATUS,
  isSafeAssetUrl,
  isStrippedFunctionName,
  normalizeVaHex,
  safeInvokeCallback,
} from '../analysis/common/v6-auto-contracts.js';
import { buildAutoAnalysisProgressModel, rankStarterFunctions } from './beginner/auto-analysis-guide.js';
import { narrateV6Enrichment } from './beginner/enrichment-narrator.js';
import { assessPatchRisk } from './beginner/patch-risk-advisor.js';
import { annotateGlossaryTerms, getGlossaryEntry } from './beginner/glossary-translator.js';
import { renderBeginnerWorkflowPanel } from './beginner/beginner-workflow-panel.js';
import { buildBeginnerFunctionCard } from './function-analysis-presentation.js';
import { DirtyConeIndex } from '../analysis/types/core/dirty-cone.js';
import { TypeTransactionManager } from '../analysis/types/core/type-transaction.js';
import { GlobalTypeMap } from '../analysis/types/core/global-type-map.js';
import { demangleSymbol, detectMangleKind, DEMANGLE_KIND } from '../analysis/types/core/symbol-demangler.js';
import { demangleSwift } from '../rtti.js';
import { ManualSegmentMap } from '../analysis/recovery/manual-segment-map.js';
import { FuncChunkTable } from '../analysis/recovery/func-chunk-table.js';
import { CustomAbiStore } from '../analysis/recovery/custom-abi-spec.js';
import { StackSlotOverrideRegistry } from '../analysis/recovery/stack-slot-override.js';
import { ShiftedPtrRegistry } from '../analysis/recovery/shifted-ptr-spec.js';
import { HexSigIndex } from '../analysis/signature/hex-sig-index.js';
import { decodeHsig1Pack } from '../analysis/signature/hex-sig-pack.js';
import {
  HEXSIG_HUB_SCHEMA,
  createHexSigHubLoader,
  gunzipBounded,
  mountHexSigPackToWasm,
} from '../analysis/signature/hexsig-hub-loader.js';
import { DeobfOverlayStore, DEOBF_RECORD_KIND } from '../analysis/deobf/deobf-overlay-store.js';
import { unflattenCffIr, CFF_STATUS } from '../analysis/deobf/cff-unflatten.js';
import { simplifyMbaDag } from '../analysis/deobf/mba-simplifier.js';
import { createStlPatternRecognizer } from '../analysis/cxx/stl-pattern-recognizer.js';
import { SliceService } from '../analysis/slicing/slice-service.js';
import { JevQueryOverlay } from '../analysis/query/jev-overlay.js';
import { createTypeEditPopoverController, renderTypeEditPopover } from './type-edit-popover.js';
import { createSlicePanelController, renderSlicePanel } from './slice-panel.js';
import { createExportInteropController, renderExportInteropModal } from './export-interop.js';
import { createManualRecoveryPopoverController, renderManualRecoveryPopover } from './manual-recovery-popover.js';
import { refineAppleSwiftDecompile } from '../decompiler/apple-arc-swift-pass.js';
import { formatCleanViewLines, formatCleanViewText } from '../decompiler/clean-view.js';

const CALLGRAPH_ROLE_NAMES = Object.freeze({
  0: 'normal',
  1: 'leaf_compute',
  2: 'dispatcher',
  3: 'utility_hub',
  4: 'recursive_scc',
});

const DEFAULT_HEXSIG_HUB_MANIFEST = Object.freeze({
  schema: HEXSIG_HUB_SCHEMA,
  format: 'HSIG1',
  packs: [],
});

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_HEXSIG_MANIFEST_MAX_BYTES = 1024 * 1024;
const DEFAULT_HEXSIG_PACK_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIL_AUTO_TIMEOUT_MS = 8_000;

async function _fetchBoundedBytes(url, {
  signal = null,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  maxBytes = PACK_LIMITS.MAX_PACK_BYTES,
} = {}) {
  if (!isSafeAssetUrl(url)) {
    throw new Error('unsafe_asset_url');
  }
  const fetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch : null;
  if (!fetchImpl) {
    throw new Error('fetch_unavailable');
  }
  if (signal?.aborted) {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    throw abortErr;
  }

  const ctrl = new AbortController();
  let timer = null;
  const onParentAbort = () => {
    try { ctrl.abort(); } catch { /* ignore */ }
  };
  if (signal && typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', onParentAbort, { once: true });
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      try { ctrl.abort(); } catch { /* ignore */ }
    }, timeoutMs);
    timer.unref?.();
  }

  try {
    const resp = await fetchImpl(url, { signal: ctrl.signal, redirect: 'error' });
    if (!resp || !resp.ok) {
      await resp?.body?.cancel?.().catch(() => {});
      throw new Error(`http_${resp?.status ?? 'error'}`);
    }
    const contentLen = resp.headers?.get?.('content-length');
    if (contentLen != null) {
      const parsedLen = Number(contentLen);
      if (Number.isFinite(parsedLen) && parsedLen > maxBytes) {
        await resp.body?.cancel?.().catch(() => {});
        throw new Error('response_too_large');
      }
    }
    if (resp.body && typeof resp.body.getReader === 'function') {
      const reader = resp.body.getReader();
      const chunks = [];
      let total = 0;
      try {
        for (;;) {
          if (ctrl.signal.aborted) {
            await reader.cancel().catch(() => {});
            const abortErr = new Error('aborted');
            abortErr.name = 'AbortError';
            throw abortErr;
          }
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          total += chunk.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new Error('response_too_large');
          }
          chunks.push(chunk);
        }
      } catch (err) {
        await reader.cancel().catch(() => {});
        throw err;
      }
      const out = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.byteLength;
      }
      return out;
    }
    if (typeof resp.arrayBuffer === 'function') {
      const buf = await resp.arrayBuffer();
      if (ctrl.signal.aborted) {
        const abortErr = new Error('aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      if (buf.byteLength > maxBytes) {
        throw new Error('response_too_large');
      }
      return new Uint8Array(buf);
    }
    throw new Error('response_unreadable');
  } finally {
    if (timer != null) clearTimeout(timer);
    if (signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onParentAbort);
    }
  }
}

function createBoundedTilFetcher(signal = null, {
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  maxBytes = PACK_LIMITS.MAX_PACK_BYTES,
} = {}) {
  return async (url) => {
    const bytes = await _fetchBoundedBytes(url, { signal, timeoutMs, maxBytes });
    return {
      ok: true,
      status: 200,
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  };
}

export { STAGED_AUTO_ANALYSIS_STAGES };

function makeInitialStagedState(initialStatus = AUTO_ANALYSIS_STATUS.IDLE) {
  return {
    status: initialStatus,
    activeStage: null,
    restoredFromCache: false,
    stages: {
      names: {
        status: initialStatus,
        completed: 0,
        total: 0,
        objcCount: 0,
        swiftCount: 0,
        hexsigCount: 0,
        restoredFromCache: false,
        completedAt: null,
        detail: '',
      },
      strings: {
        status: initialStatus,
        completed: 0,
        total: 0,
        count: 0,
        restoredFromCache: false,
        completedAt: null,
        detail: '',
      },
      callgraph: {
        status: initialStatus,
        completed: 0,
        total: 0,
        functionCount: 0,
        callCount: 0,
        refCount: 0,
        restoredFromCache: false,
        completedAt: null,
        detail: '',
      },
      goals: {
        status: initialStatus,
        completed: 0,
        total: 0,
        count: 0,
        restoredFromCache: false,
        completedAt: null,
        detail: '',
      },
    },
    recoveredNamesSummary: {
      named: 0,
      total: 0,
      objc: 0,
      swift: 0,
      hexsig: 0,
      entries: [],
    },
    goalCandidatesSummary: [],
  };
}

function cloneStagedState(staged) {
  if (!staged || typeof staged !== 'object') return makeInitialStagedState(AUTO_ANALYSIS_STATUS.IDLE);
  return {
    status: staged.status,
    activeStage: staged.activeStage ?? null,
    restoredFromCache: Boolean(staged.restoredFromCache),
    stages: {
      names: { ...staged.stages.names },
      strings: { ...staged.stages.strings },
      callgraph: { ...staged.stages.callgraph },
      goals: { ...staged.stages.goals },
    },
    recoveredNamesSummary: {
      ...staged.recoveredNamesSummary,
      entries: Array.isArray(staged.recoveredNamesSummary?.entries)
        ? staged.recoveredNamesSummary.entries.map((e) => ({ ...e }))
        : [],
    },
    goalCandidatesSummary: Array.isArray(staged.goalCandidatesSummary)
      ? staged.goalCandidatesSummary.map((g) => ({ ...g }))
      : [],
  };
}

function formatNumberEn(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num < 0) return '0';
  return Math.trunc(num).toLocaleString('en-US');
}

export function formatStagedAutoAnalysisStatus(stateOrStaged, { lang = null } = {}) {
  const staged = stateOrStaged?.staged || stateOrStaged;
  const choose = (ja, en) => (lang === 'en' ? en : (lang === 'ja' ? ja : pick(ja, en)));
  if (!staged || typeof staged !== 'object' || !staged.stages) {
    return {
      visible: false,
      running: false,
      done: false,
      cancelled: false,
      restored: false,
      activeStage: null,
      text: '',
      cancelLabel: choose('停止', 'Stop'),
      canCancel: false,
    };
  }
  const status = staged.status;
  const activeStage = staged.activeStage || null;
  const names = staged.stages.names || {};
  const running = status === AUTO_ANALYSIS_STATUS.RUNNING || Boolean(activeStage);
  const done = status === AUTO_ANALYSIS_STATUS.DONE;
  const cancelled = status === AUTO_ANALYSIS_STATUS.ABORTED;
  const restored = Boolean(staged.restoredFromCache);

  let text = '';
  if (running) {
    if (activeStage === 'names' || names.status === AUTO_ANALYSIS_STATUS.RUNNING) {
      const completed = Number(names.completed || 0);
      const total = Number(names.total || 0);
      if (total > 0) {
        text = choose(
          `名前 ${formatNumberEn(completed)} / ${formatNumberEn(total)}`,
          `Names ${formatNumberEn(completed)} / ${formatNumberEn(total)}`,
        );
      } else {
        text = choose('名前を復元中…', 'Recovering names…');
      }
    } else if (activeStage === 'strings' || staged.stages.strings?.status === AUTO_ANALYSIS_STATUS.RUNNING) {
      text = choose('文字列の参照を索引中…', 'Indexing string references…');
    } else if (activeStage === 'callgraph' || staged.stages.callgraph?.status === AUTO_ANALYSIS_STATUS.RUNNING) {
      text = choose('呼び出しグラフを構築中…', 'Building call graph…');
    } else if (activeStage === 'goals' || staged.stages.goals?.status === AUTO_ANALYSIS_STATUS.RUNNING) {
      text = choose('目的ごとの候補を整理中…', 'Ranking goal candidates…');
    } else {
      text = choose('バックグラウンド解析中…', 'Running background analysis…');
    }
  } else if (done) {
    const named = Number(staged.recoveredNamesSummary?.named ?? names.completed ?? 0);
    const total = Number(staged.recoveredNamesSummary?.total ?? names.total ?? 0);
    if (total > 0) {
      text = choose(
        `自動解析完了 · 名前 ${formatNumberEn(named)} / ${formatNumberEn(total)}`,
        `Auto-analysis done · Names ${formatNumberEn(named)} / ${formatNumberEn(total)}`,
      );
    } else {
      text = choose('自動解析完了', 'Auto-analysis done');
    }
  } else if (cancelled) {
    text = choose('自動解析を停止しました', 'Auto-analysis stopped');
  }

  return {
    visible: Boolean(text),
    running,
    done,
    cancelled,
    restored,
    activeStage,
    text,
    cancelLabel: choose('停止', 'Stop'),
    canCancel: running,
  };
}

function makeInitialAutoAnalysisState(initialStatus = AUTO_ANALYSIS_STATUS.IDLE, binaryKey = null) {
  return {
    binaryKey,
    generation: 0,
    til: { status: initialStatus, completed: 0, total: 0, loadedPacks: [], errors: [], detail: '' },
    hexsig: { status: initialStatus, completed: 0, total: 0, scanned: 0, named: 0, detail: '' },
    deobf: { status: initialStatus, completed: 0, total: 0, processed: 0, deobfHits: 0, stlHits: 0, detail: '' },
    staged: makeInitialStagedState(initialStatus),
  };
}

function toBigIntVa(va) {
  if (va == null) return null;
  if (typeof va === 'bigint') return va >= 0n ? va : null;
  if (typeof va === 'number') return Number.isSafeInteger(va) && va >= 0 ? BigInt(va) : null;
  if (typeof va === 'string') {
    const t = va.trim();
    if (!t) return null;
    try {
      const b = BigInt(t);
      return b >= 0n ? b : null;
    } catch {
      return null;
    }
  }
  return null;
}

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return null;
}

function isGzipBytes(bytes) {
  return bytes instanceof Uint8Array && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function incrementMapCount(map, key, delta = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + delta);
}

function pushMapList(map, key, item) {
  if (!key) return;
  let list = map.get(key);
  if (!list) {
    list = [];
    map.set(key, list);
  }
  list.push(item);
}

export class V6Workbench {
  constructor(app, options = {}) {
    this.app = app || null;
    this.runtimeProfile = options.runtimeProfile || detectRuntimeProfile();
    this.memoryBudget = options.memoryBudget || new MemoryBudget({
      profile: this.runtimeProfile,
    });
    this.hexdb = options.hexdb || null;
    this._hexdbFactory = options.hexdbFactory || (() => new HexDbClient({
      profile: this.runtimeProfile,
      memoryBudget: this.memoryBudget,
    }));

    this.tilResolver = new TilLiteResolver();
    this.tilPackManager = new TilPackManager({
      resolver: this.tilResolver,
      fetcher: options.tilFetcher || createBoundedTilFetcher(null, {
        timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
        maxBytes: PACK_LIMITS.MAX_PACK_BYTES,
      }),
    });
    this.dirtyCone = new DirtyConeIndex();
    this.globalTypeMap = new GlobalTypeMap();
    this.manualSegments = new ManualSegmentMap();
    this.funcChunks = new FuncChunkTable();
    this.customAbis = new CustomAbiStore();
    this.stackOverrides = new StackSlotOverrideRegistry();
    this.shiftedPtrs = new ShiftedPtrRegistry();
    this.hexsigIndex = new HexSigIndex();
    this.deobfOverlay = new DeobfOverlayStore();
    this.stlRecognizer = createStlPatternRecognizer(options.stlCacheCapacity);
    this.sliceService = new SliceService();
    this.jevOverlay = new JevQueryOverlay({
      globalTypeMap: this.globalTypeMap,
    });

    this.displayHints = Object.create(null);
    this.pinnedMasks = Object.create(null);

    this.typeTx = new TypeTransactionManager({
      dirtyCone: this.dirtyCone,
      captureSnapshot: () => this.exportV2DeltaFields(),
      restoreSnapshot: (snap) => {
        if (snap && typeof snap === 'object') {
          this.importV2DeltaFields(snap);
        }
      },
    });

    this.typeEditController = createTypeEditPopoverController({
      transactionManager: this.typeTx,
    });
    this.slicePanelController = createSlicePanelController();
    this.exportInteropController = createExportInteropController();
    this.manualRecoveryController = createManualRecoveryPopoverController({
      transactionManager: this.typeTx,
    });

    this._injectedHexSigHubLoader = options.hexsigHubLoader || null;
    this._hexsigHubLoader = this._injectedHexSigHubLoader;
    this._hexsigHubConfig = options.hexsigHubConfig || null;
    this._mountedHexSigPacks = new Map();
    this._deobfSummaries = new Map();
    this._stlByFunc = new Map();
    this._wasmAnalysis = null;
    this._wasmIndex = null;

    this._activePopoverCleanup = null;
    this._activePopoverKind = null;
    this._binaryKey = null;
    this._idleTimer = null;

    this._autoAnalysisConfig = options.autoAnalysis && typeof options.autoAnalysis === 'object'
      ? { ...options.autoAnalysis }
      : {};
    this._autoGen = 0;
    this._autoAbortController = null;
    this._activeTilAbortController = null;
    this._autoAnalysisListeners = new Set();
    this._mountedWorkflowPanels = new Set();
    this._autoNamedFunctions = new Map();
    this._autoMountedTilSlots = new Map();
    this._autoAnalysisState = makeInitialAutoAnalysisState(AUTO_ANALYSIS_STATUS.IDLE);
  }

  refineDecompiledCode(pseudoC, opts = {}) {
    const hints = this.displayHints && typeof this.displayHints === 'object' ? this.displayHints : {};
    const cleanViewHints = hints.cleanView && typeof hints.cleanView === 'object' ? hints.cleanView : {};
    const safeOpts = opts && typeof opts === 'object' ? opts : {};
    const mergedOpts = {
      hideTypedefPrelude: safeOpts.hideTypedefPrelude ?? cleanViewHints.hideTypedefPrelude ?? hints.hideTypedefPrelude ?? true,
      elideDeadSpills: safeOpts.elideDeadSpills ?? cleanViewHints.elideDeadSpills ?? hints.elideDeadSpills ?? true,
      foldCalleeSavedSpills: safeOpts.foldCalleeSavedSpills ?? cleanViewHints.foldCalleeSavedSpills ?? hints.foldCalleeSavedSpills ?? true,
      refineAppleSwift: safeOpts.refineAppleSwift ?? cleanViewHints.refineAppleSwift ?? hints.refineAppleSwift ?? true,
      collapseDuplicateAsm: safeOpts.collapseDuplicateAsm ?? cleanViewHints.collapseDuplicateAsm ?? hints.collapseDuplicateAsm ?? true,
      ...safeOpts,
    };
    return formatCleanViewText(pseudoC, mergedOpts);
  }

  demangleDisplayName(rawName, opts = null) {
    if (typeof rawName !== 'string') return rawName == null ? '' : String(rawName);
    if (!rawName) return '';

    const kind = detectMangleKind(rawName);
    if (kind !== DEMANGLE_KIND.NONE) {
      const demangled = demangleSymbol(rawName, opts);
      if (typeof demangled === 'string' && demangled.length > 0) {
        return demangled;
      }
    }

    const swift = demangleSwift(rawName);
    if (typeof swift === 'string' && swift.length > 0) {
      return swift;
    }

    return rawName;
  }

  getHexSigHubLoader(opts = null) {
    if (this._hexsigHubLoader && !(opts && opts.manifest)) {
      return this._hexsigHubLoader;
    }
    const cfg = {
      ...(this._hexsigHubConfig || {}),
      ...(opts || {}),
    };
    const manifest = cfg.manifest || DEFAULT_HEXSIG_HUB_MANIFEST;
    const loader = createHexSigHubLoader({
      manifest,
      baseUrl: cfg.baseUrl || '',
      fetchBytes: cfg.fetchBytes || null,
      verifySha256: cfg.verifySha256 ?? true,
    });
    this._hexsigHubLoader = loader;
    return loader;
  }

  mountHexSigPack(packBytes, meta = {}) {
    const inputBytes = toUint8Array(packBytes);
    if (!inputBytes || inputBytes.length === 0) {
      return { ok: false, reason: 'invalid_pack_bytes', entryCount: 0, wasmMounted: false };
    }

    let rawBytes = inputBytes;
    try {
      if (isGzipBytes(inputBytes)) {
        rawBytes = gunzipBounded(inputBytes, meta?.maxBytes, meta?.maxCompressedBytes);
      }
    } catch (err) {
      return { ok: false, reason: err?.message || 'gunzip_failed', entryCount: 0, wasmMounted: false };
    }

    let decoded;
    try {
      decoded = decodeHsig1Pack(rawBytes);
    } catch (err) {
      return { ok: false, reason: err?.message || 'decode_failed', entryCount: 0, wasmMounted: false };
    }

    const packId = String(meta?.packId || `pack_${this._mountedHexSigPacks.size + 1}`);
    if (this._mountedHexSigPacks.has(packId)) {
      const existing = this._mountedHexSigPacks.get(packId);
      return {
        ok: true,
        packId: existing.packId,
        entryCount: existing.entryCount,
        archMask: existing.archMask,
        wasmMounted: existing.wasmMounted,
        wasmMount: existing.wasmMount,
        decoded: existing.decoded,
        alreadyMounted: true,
      };
    }
    if (meta && meta.libId != null && Number.isInteger(meta.libId) && meta.libId >= 0) {
      this.hexsigIndex.libs[meta.libId] = {
        libId: meta.libId,
        packId,
        vendor: meta.vendor || '',
        kind: meta.libKind ?? meta.kind ?? 0,
        libName: meta.libName || packId,
      };
    }

    for (const entry of decoded.entries) {
      this.hexsigIndex.addEntry(entry);
    }

    let wasmMount = null;
    if (meta?.preferWasm !== false && meta?._engine !== 'js') {
      wasmMount = mountHexSigPackToWasm(rawBytes, decoded, meta || {});
    }

    const record = {
      packId,
      meta: meta && typeof meta === 'object' ? { ...meta } : {},
      entryCount: decoded.entryCount,
      archMask: decoded.archMask,
      wasmMounted: Boolean(wasmMount),
      wasmMount,
      decoded,
    };
    this._mountedHexSigPacks.set(packId, record);

    return {
      ok: true,
      packId,
      entryCount: decoded.entryCount,
      archMask: decoded.archMask,
      wasmMounted: Boolean(wasmMount),
      wasmMount,
      decoded,
    };
  }

  runDeobfuscationPass({ funcVa, cfg = null, mbaNodes = null, opts = {} } = {}) {
    const vaHex = normalizeVaHex(funcVa) || (funcVa != null ? String(funcVa) : null);
    const passOpts = opts && typeof opts === 'object' ? opts : {};
    const shouldCommit = passOpts.commit !== false;

    let cffResult = null;
    let cffRecovered = false;
    if (cfg && typeof cfg === 'object') {
      cffResult = unflattenCffIr(cfg, passOpts);
      cffRecovered = cffResult?.statusCode === CFF_STATUS.RECOVERED;
    }

    const mbaResults = [];
    const pendingAnnotations = [];
    const writtenVas = new Set();
    let simplifiedCount = 0;
    let nodesEliminated = 0;
    if (Array.isArray(mbaNodes)) {
      for (let i = 0; i < mbaNodes.length; i++) {
        const item = mbaNodes[i];
        if (!item || typeof item !== 'object') continue;
        const dag = item.dag || item.expr || item;
        const nodeVa = normalizeVaHex(item.insnVa ?? item.va);
        const res = simplifyMbaDag(dag, passOpts);
        mbaResults.push({
          index: i,
          insnVa: nodeVa,
          ...res,
        });
        if (res?.simplified) {
          simplifiedCount++;
          nodesEliminated += Number(res.stats?.nodesEliminated ?? Math.max(0, (res.origCost ?? 0) - (res.newCost ?? 0)));
          if (nodeVa) {
            const ann = {
              insnVa: nodeVa,
              kind: DEOBF_RECORD_KIND.LOOP_DEOBF,
              source: 'bounded_abstract_vm',
              text: `MBA simplified (${res.stage || res.engine}, cost ${res.origCost ?? '?'}->${res.newCost ?? '?'})`,
            };
            pendingAnnotations.push(ann);
            if (shouldCommit) {
              if (this.deobfOverlay.setAnnotation(ann)) {
                writtenVas.add(nodeVa);
              }
            } else {
              writtenVas.add(nodeVa);
            }
          }
        }
      }
    }

    const summaryParts = [];
    if (cffRecovered) {
      summaryParts.push(`CFF recovered (real=${cffResult.stats?.realBlocks ?? 0}, spine=${cffResult.stats?.spineBlocks ?? 0})`);
    }
    if (simplifiedCount > 0) {
      summaryParts.push(`MBA simplified (${simplifiedCount}/${mbaResults.length}, -${nodesEliminated} cost)`);
    }

    if (vaHex && summaryParts.length > 0) {
      const fnAnn = {
        insnVa: vaHex,
        kind: DEOBF_RECORD_KIND.LOOP_DEOBF,
        source: 'bounded_abstract_vm',
        text: summaryParts.join(' + '),
      };
      pendingAnnotations.push(fnAnn);
      if (shouldCommit) {
        if (this.deobfOverlay.setAnnotation(fnAnn)) {
          writtenVas.add(vaHex);
        }
      } else {
        writtenVas.add(vaHex);
      }
    }
    const overlayCount = writtenVas.size;

    const summary = {
      funcVa: vaHex,
      cff: cffResult,
      cffRecovered,
      mba: {
        total: mbaResults.length,
        simplifiedCount,
        nodesEliminated,
        results: mbaResults,
      },
      overlayCount,
      overlayRevision: this.deobfOverlay.revision,
      ...(shouldCommit ? {} : { pendingAnnotations }),
    };

    if (shouldCommit && vaHex) {
      this._deobfSummaries.set(vaHex, summary);
    }

    return summary;
  }

  recognizeStlPattern(input = {}, opts = {}) {
    const safeInput = input && typeof input === 'object' ? input : {};
    const safeOpts = opts && typeof opts === 'object' ? opts : {};
    const shouldCommit = safeOpts.commit !== false && safeInput.commit !== false;
    const vaHex = normalizeVaHex(safeInput.funcVa ?? safeInput.va);
    const funcKey = vaHex || (safeInput.funcKey != null ? String(safeInput.funcKey) : 'anonymous');

    let normalizedInput = safeInput;
    if (Array.isArray(safeInput.symbols) && safeInput.symbols.length > 0) {
      const expanded = [];
      for (const sym of safeInput.symbols) {
        const s = String(sym);
        expanded.push(s);
        const demangled = this.demangleDisplayName(s);
        if (demangled && demangled !== s) expanded.push(demangled);
      }
      normalizedInput = { ...safeInput, symbols: expanded };
    }

    const recognizer = shouldCommit ? this.stlRecognizer : createStlPatternRecognizer(4);
    const result = recognizer.recognize(funcKey, normalizedInput);
    if (shouldCommit && vaHex) {
      this._stlByFunc.set(vaHex, result);
    }
    return result;
  }

  ingestWasmAnalysis(wasmAnalysis) {
    if (!wasmAnalysis || typeof wasmAnalysis !== 'object') {
      this._wasmAnalysis = null;
      this._wasmIndex = null;
      return {
        ok: false,
        counts: {
          rmw: 0,
          x86Rmw: 0,
          vtables: 0,
          jumpTables: 0,
          constTables: 0,
          xrefFunctions: 0,
          callgraphNodes: 0,
          objcSwiftSections: 0,
          cxxClasses: 0,
          virtualTreeFolders: 0,
          semanticNames: 0,
          classFieldLayouts: 0,
        },
      };
    }

    const rmwHits = Array.isArray(wasmAnalysis.rmw?.hits)
      ? wasmAnalysis.rmw.hits
      : (Array.isArray(wasmAnalysis.rmw) ? wasmAnalysis.rmw : []);
    const x86RmwHits = Array.isArray(wasmAnalysis.x86Rmw?.hits)
      ? wasmAnalysis.x86Rmw.hits
      : (Array.isArray(wasmAnalysis.x86Rmw) ? wasmAnalysis.x86Rmw : []);
    const vtableList = Array.isArray(wasmAnalysis.vtables?.vtables)
      ? wasmAnalysis.vtables.vtables
      : (Array.isArray(wasmAnalysis.vtables) ? wasmAnalysis.vtables : []);
    const jumpTableList = Array.isArray(wasmAnalysis.jumpTables?.tables)
      ? wasmAnalysis.jumpTables.tables
      : (Array.isArray(wasmAnalysis.jumpTables?.jumpTables)
        ? wasmAnalysis.jumpTables.jumpTables
        : (Array.isArray(wasmAnalysis.jumpTables) ? wasmAnalysis.jumpTables : []));
    const constTableList = Array.isArray(wasmAnalysis.constTables?.tables)
      ? wasmAnalysis.constTables.tables
      : (Array.isArray(wasmAnalysis.constTables) ? wasmAnalysis.constTables : []);
    const objcSwift = wasmAnalysis.objcSwift && typeof wasmAnalysis.objcSwift === 'object'
      ? wasmAnalysis.objcSwift
      : null;

    const xrefByFunc = new Map();
    const rawByFunc = wasmAnalysis.xrefLinks?.byFunction;
    if (rawByFunc instanceof Map) {
      for (const [k, entry] of rawByFunc.entries()) {
        const key = normalizeVaHex(entry?.start ?? k);
        if (key && entry && typeof entry === 'object') xrefByFunc.set(key, entry);
      }
    } else if (rawByFunc && typeof rawByFunc === 'object') {
      for (const [k, entry] of Object.entries(rawByFunc)) {
        const key = normalizeVaHex(entry?.start ?? k);
        if (key && entry && typeof entry === 'object') xrefByFunc.set(key, entry);
      }
    }

    const vtablesByFunc = new Map();
    for (const v of vtableList) {
      if (!v || typeof v !== 'object') continue;
      const fnKey = normalizeVaHex(v.firstFnVa ?? v.funcVa);
      if (fnKey) pushMapList(vtablesByFunc, fnKey, v);
    }

    const rmwCountByFunc = new Map();
    for (const hit of rmwHits) {
      if (!hit || typeof hit !== 'object') continue;
      const fnKey = normalizeVaHex(hit.funcVa ?? hit.fnVa);
      if (fnKey) incrementMapCount(rmwCountByFunc, fnKey, 1);
    }
    for (const hit of x86RmwHits) {
      if (!hit || typeof hit !== 'object') continue;
      const fnKey = normalizeVaHex(hit.funcVa ?? hit.fnVa);
      if (fnKey) incrementMapCount(rmwCountByFunc, fnKey, 1);
    }

    const jumpTablesByFunc = new Map();
    for (const jt of jumpTableList) {
      if (!jt || typeof jt !== 'object') continue;
      const fnKey = normalizeVaHex(jt.funcVa ?? jt.fnVa);
      if (fnKey) pushMapList(jumpTablesByFunc, fnKey, jt);
    }

    const callgraphByFunc = new Map();
    const cg = wasmAnalysis.callgraph;
    if (cg && typeof cg === 'object') {
      const nodes = Array.isArray(cg.nodes) ? cg.nodes : [];
      const roles = cg.role;
      const scores = cg.score;
      const sccs = cg.scc;
      for (let i = 0; i < nodes.length; i++) {
        const rawNode = nodes[i];
        const vaHex = normalizeVaHex(
          typeof rawNode === 'object' && rawNode !== null
            ? (rawNode.va ?? rawNode.addr ?? rawNode.address ?? rawNode.start)
            : rawNode
        );
        if (!vaHex) continue;
        const role = roles && i < roles.length ? Number(roles[i]) : 0;
        const score = scores && i < scores.length ? Number(scores[i]) : 0;
        const scc = sccs && i < sccs.length ? Number(sccs[i]) : null;
        callgraphByFunc.set(vaHex, {
          nodeIndex: i,
          role,
          roleName: CALLGRAPH_ROLE_NAMES[role] || 'normal',
          score,
          scc,
        });
      }
    }

    const cxxRtti = wasmAnalysis.cxxRtti && typeof wasmAnalysis.cxxRtti === 'object'
      ? wasmAnalysis.cxxRtti
      : null;
    const unifiedMetadata = wasmAnalysis.unifiedMetadata && typeof wasmAnalysis.unifiedMetadata === 'object'
      ? wasmAnalysis.unifiedMetadata
      : null;
    const virtualTree = wasmAnalysis.virtualTree && typeof wasmAnalysis.virtualTree === 'object'
      ? wasmAnalysis.virtualTree
      : null;
    const semanticNames = wasmAnalysis.semanticNames && typeof wasmAnalysis.semanticNames === 'object'
      ? wasmAnalysis.semanticNames
      : null;
    const classFields = wasmAnalysis.classFields && typeof wasmAnalysis.classFields === 'object'
      ? wasmAnalysis.classFields
      : null;

    const cxxClassByFunc = new Map();
    const rawCxxByFunc = cxxRtti?.byFunction;
    const hasLazyCxxMap = rawCxxByFunc instanceof Map;
    if (!hasLazyCxxMap && rawCxxByFunc && typeof rawCxxByFunc === 'object') {
      for (const [k, entry] of Object.entries(rawCxxByFunc)) {
        const key = normalizeVaHex(entry?.fnVa ?? k);
        if (key && entry && typeof entry === 'object') cxxClassByFunc.set(key, entry);
      }
    }

    const semanticNameByFunc = new Map();
    const rawSemByFunc = semanticNames?.byFunction;
    const hasLazySemMap = rawSemByFunc instanceof Map;
    if (!hasLazySemMap && rawSemByFunc && typeof rawSemByFunc === 'object') {
      for (const [k, entry] of Object.entries(rawSemByFunc)) {
        const key = normalizeVaHex(entry?.addr ?? k);
        if (key && entry && typeof entry === 'object') semanticNameByFunc.set(key, entry);
      }
    }

    const folderPathByFunc = new Map();
    const rawFnToFolder = virtualTree?.functionToFolderId;
    const hasLazyFolderMap = rawFnToFolder instanceof Map;
    const treeNodes = virtualTree?.nodes;
    const resolveFolderPath = (folderId) => {
      if (typeof folderId !== 'string' || !folderId) return null;
      const node = treeNodes instanceof Map
        ? treeNodes.get(folderId)
        : (treeNodes && typeof treeNodes === 'object' && Object.hasOwn(treeNodes, folderId) ? treeNodes[folderId] : null);
      if (node && typeof node === 'object') {
        if (typeof node.fullPath === 'string' && node.fullPath) return node.fullPath;
        if (typeof node.label === 'string' && node.label) return node.label;
      }
      return folderId;
    };
    if (!hasLazyFolderMap && rawFnToFolder && typeof rawFnToFolder === 'object') {
      for (const [k, folderId] of Object.entries(rawFnToFolder)) {
        const key = normalizeVaHex(k);
        const path = resolveFolderPath(folderId);
        if (key && path) folderPathByFunc.set(key, path);
      }
    }

    const classFieldsByName = new Map();
    const rawLayouts = classFields?.layouts;
    if (rawLayouts instanceof Map) {
      for (const [k, layout] of rawLayouts.entries()) {
        const name = typeof layout?.className === 'string' && layout.className ? layout.className : (typeof k === 'string' ? k : null);
        if (name && layout && typeof layout === 'object') classFieldsByName.set(name, layout);
      }
    } else if (rawLayouts && typeof rawLayouts === 'object') {
      for (const [k, layout] of Object.entries(rawLayouts)) {
        const name = typeof layout?.className === 'string' && layout.className ? layout.className : k;
        if (name && layout && typeof layout === 'object') classFieldsByName.set(name, layout);
      }
    }

    this._wasmAnalysis = wasmAnalysis;
    this._wasmIndex = {
      rmwHits,
      x86RmwHits,
      vtables: vtableList,
      jumpTables: jumpTableList,
      constTables: constTableList,
      objcSwift,
      cxxRtti,
      unifiedMetadata,
      virtualTree,
      semanticNames,
      classFields,
      xrefByFunc,
      vtablesByFunc,
      rmwCountByFunc,
      jumpTablesByFunc,
      callgraphByFunc,
      cxxClassByFunc,
      semanticNameByFunc,
      folderPathByFunc,
      resolveFolderPath,
      classFieldsByName,
      textVa: toBigIntVa(wasmAnalysis.textVa),
    };

    const objcSwiftSections = Array.isArray(objcSwift?.sectionsScanned) ? objcSwift.sectionsScanned.length : 0;
    const cxxClassesCount = Array.isArray(cxxRtti?.classes) ? cxxRtti.classes.length : 0;
    const virtualTreeFolders = treeNodes instanceof Map
      ? treeNodes.size
      : (treeNodes && typeof treeNodes === 'object' ? Object.keys(treeNodes).length : 0);
    return {
      ok: true,
      counts: {
        rmw: rmwHits.length,
        x86Rmw: x86RmwHits.length,
        vtables: vtableList.length,
        jumpTables: jumpTableList.length,
        constTables: constTableList.length,
        xrefFunctions: xrefByFunc.size,
        callgraphNodes: callgraphByFunc.size,
        objcSwiftSections,
        cxxClasses: cxxClassesCount,
        virtualTreeFolders,
        semanticNames: hasLazySemMap ? rawSemByFunc.size : semanticNameByFunc.size,
        classFieldLayouts: classFieldsByName.size,
      },
    };
  }

  getCxxRtti() {
    return this._wasmIndex?.cxxRtti ?? this._wasmAnalysis?.cxxRtti ?? null;
  }

  getVirtualTree() {
    return this._wasmIndex?.virtualTree ?? this._wasmAnalysis?.virtualTree ?? null;
  }

  getSemanticName(va) {
    const idx = this._wasmIndex;
    if (!idx || va == null) return null;
    const vaHex = normalizeVaHex(va);
    if (vaHex && idx.semanticNameByFunc?.has(vaHex)) {
      return idx.semanticNameByFunc.get(vaHex) || null;
    }
    const rawMap = idx.semanticNames?.byFunction;
    if (rawMap instanceof Map) {
      const vaBig = toBigIntVa(va);
      if (vaBig != null && rawMap.has(vaBig)) return rawMap.get(vaBig) || null;
      if (vaHex && rawMap.has(vaHex)) return rawMap.get(vaHex) || null;
    }
    return null;
  }

  getClassFields(className) {
    if (typeof className !== 'string') return null;
    const trimmed = className.trim();
    if (!trimmed) return null;
    const byName = this._wasmIndex?.classFieldsByName;
    if (!byName) return null;
    return byName.get(className) ?? byName.get(trimmed) ?? null;
  }

  _countRmwInRange(vaHex, startBig, endBig, textVaBig) {
    const idx = this._wasmIndex;
    if (!idx) return 0;
    let count = idx.rmwCountByFunc.get(vaHex) || 0;
    if (startBig == null || endBig == null || endBig <= startBig) return count;

    const countHits = (hits) => {
      let n = 0;
      for (let i = 0; i < hits.length; i++) {
        const h = hits[i];
        if (!h || typeof h !== 'object') continue;
        if (h.funcVa != null || h.fnVa != null) continue;
        let hitVa = toBigIntVa(h.va ?? h.insnVa ?? h.loadVa ?? h.storeVa);
        if (hitVa == null && textVaBig != null) {
          const off = h.loadOff ?? h.storeOff ?? h.off;
          if (typeof off === 'number' && Number.isFinite(off) && off >= 0) {
            hitVa = textVaBig + BigInt(Math.trunc(off));
          }
        }
        if (hitVa != null && hitVa >= startBig && hitVa < endBig) n++;
      }
      return n;
    };

    count += countHits(idx.rmwHits);
    count += countHits(idx.x86RmwHits);
    return count;
  }

  getFunctionEnrichment(funcVa, opts = {}) {
    const vaHex = normalizeVaHex(funcVa);
    const vaBig = toBigIntVa(funcVa);
    const safeOpts = opts && typeof opts === 'object' ? opts : {};
    const idx = this._wasmIndex;
    const xref = vaHex && idx ? (idx.xrefByFunc.get(vaHex) || null) : null;

    let rawName = typeof safeOpts.rawName === 'string' && safeOpts.rawName
      ? safeOpts.rawName
      : (typeof safeOpts.name === 'string' && safeOpts.name ? safeOpts.name : null);

    if (!rawName && vaBig != null) {
      try {
        const fromSyms = this.app?.symbols?.nameAt?.(vaBig);
        if (typeof fromSyms === 'string' && fromSyms) rawName = fromSyms;
      } catch {
        // Ignore symbol lookup errors on partial mocks.
      }
    }
    if (!rawName && vaHex) {
      const decKey = vaBig != null ? vaBig.toString() : null;
      const fromNotes = this.app?.notes?.names?.get?.(vaHex)
        ?? (decKey ? this.app?.notes?.names?.get?.(decKey) : null);
      if (typeof fromNotes === 'string' && fromNotes) rawName = fromNotes;
    }
    if (!rawName && typeof xref?.name === 'string' && xref.name) {
      rawName = xref.name;
    }
    const hexsigMatch = vaHex ? (this._autoNamedFunctions.get(vaHex) || null) : null;
    if (!rawName && typeof hexsigMatch?.newName === 'string' && hexsigMatch.newName) {
      rawName = hexsigMatch.newName;
    }

    const demangledName = rawName ? this.demangleDisplayName(rawName, safeOpts.demangleOpts || null) : null;
    const displayName = demangledName || rawName || (vaHex ? `sub_${vaHex.slice(2)}` : null);

    let tilSignature = null;
    if (rawName && typeof this.tilResolver?.resolveSymbol === 'function') {
      tilSignature = this.tilResolver.resolveSymbol(rawName, safeOpts.tilOpts || {}) || null;
      if (!tilSignature && demangledName && demangledName !== rawName) {
        tilSignature = this.tilResolver.resolveSymbol(demangledName, safeOpts.tilOpts || {}) || null;
      }
    }

    const vtableRefs = Array.isArray(xref?.vtableRefs) && xref.vtableRefs.length > 0
      ? xref.vtableRefs.slice()
      : (vaHex && idx?.vtablesByFunc.get(vaHex) ? idx.vtablesByFunc.get(vaHex).slice() : []);
    const constTableRefs = Array.isArray(xref?.constTableRefs) ? xref.constTableRefs.slice() : [];
    const tags = Array.isArray(xref?.tags) ? xref.tags.slice() : [];
    const callgraph = vaHex && idx ? (idx.callgraphByFunc.get(vaHex) || null) : null;

    const endBig = toBigIntVa(safeOpts.funcEnd ?? xref?.end);
    const textVaBig = toBigIntVa(safeOpts.textVa) ?? idx?.textVa ?? null;
    const rmwHitCount = vaHex ? this._countRmwInRange(vaHex, vaBig, endBig, textVaBig) : 0;
    const jumpTables = vaHex && idx?.jumpTablesByFunc.get(vaHex)
      ? idx.jumpTablesByFunc.get(vaHex).slice()
      : [];

    const overlayAnnotation = vaHex ? (this.deobfOverlay?.getAnnotation?.(vaHex) || null) : null;
    const overlaySummary = vaHex ? (this._deobfSummaries.get(vaHex) || null) : null;

    let stl = null;
    if (safeOpts.stlInput && typeof safeOpts.stlInput === 'object') {
      stl = this.recognizeStlPattern({ funcVa: vaHex, ...safeOpts.stlInput });
    } else if (vaHex) {
      stl = this._stlByFunc.get(vaHex) || null;
    }

    const rawCxxMap = idx?.cxxRtti?.byFunction instanceof Map ? idx.cxxRtti.byFunction : null;
    const cxxClass = (vaHex && idx?.cxxClassByFunc?.get(vaHex))
      || (rawCxxMap && ((vaBig != null ? rawCxxMap.get(vaBig) : null) || (vaHex ? rawCxxMap.get(vaHex) : null)))
      || (xref?.cxxClass && typeof xref.cxxClass === 'object' ? xref.cxxClass : null);
    const rawSemMap = idx?.semanticNames?.byFunction instanceof Map ? idx.semanticNames.byFunction : null;
    const semanticName = (vaHex && idx?.semanticNameByFunc?.get(vaHex))
      || (rawSemMap && ((vaBig != null ? rawSemMap.get(vaBig) : null) || (vaHex ? rawSemMap.get(vaHex) : null)))
      || null;
    const rawFolderMap = idx?.virtualTree?.functionToFolderId instanceof Map ? idx.virtualTree.functionToFolderId : null;
    const rawFolderId = rawFolderMap
      ? ((vaBig != null ? rawFolderMap.get(vaBig) : null) || (vaHex ? rawFolderMap.get(vaHex) : null))
      : null;
    const virtualFolderPath = (vaHex && idx?.folderPathByFunc?.get(vaHex))
      || (rawFolderId && typeof idx?.resolveFolderPath === 'function' ? idx.resolveFolderPath(rawFolderId) : null)
      || (typeof semanticName?.folderPath === 'string' && semanticName.folderPath ? semanticName.folderPath : null);

    return {
      funcVa: vaHex,
      rawName,
      displayName,
      demangledName,
      tilSignature,
      wasmHints: {
        available: Boolean(idx),
        vtableRefs,
        constTableRefs,
        tags,
        callgraph,
        rmwHitCount,
        jumpTableCount: jumpTables.length,
        jumpTables,
        hasObjcSwift: Boolean(idx?.objcSwift),
      },
      hexsigMatch,
      deobfOverlay: {
        hasOverlay: Boolean(
          overlayAnnotation
          || overlaySummary?.cffRecovered
          || (overlaySummary?.mba?.simplifiedCount > 0)
          || (overlaySummary?.overlayCount > 0)
        ),
        annotation: overlayAnnotation,
        summary: overlaySummary,
      },
      stl,
      cxxClass,
      semanticName,
      virtualFolderPath,
    };
  }

  getActivePopoverKind() {
    return this._activePopoverKind;
  }

  closeActivePopover() {
    if (typeof this._activePopoverCleanup === 'function') {
      try {
        this._activePopoverCleanup();
      } catch {
        // Ignore cleanup errors on detached nodes.
      }
    }
    this._activePopoverCleanup = null;
    this._activePopoverKind = null;
  }

  _mountPopover(kind, renderFn, controller, options = {}) {
    this.closeActivePopover();
    const doc = options.document || (typeof document !== 'undefined' ? document : null);
    const container = options.container || doc?.body || null;
    this._activePopoverKind = kind;
    if (!doc || !container) {
      this._activePopoverCleanup = () => {
        controller?.close?.();
      };
      return { kind, controller, mounted: false };
    }
    const userOnClose = typeof options.onClose === 'function' ? options.onClose : null;
    const mounted = renderFn(controller, {
      document: doc,
      container,
      ...options,
      onClose: () => {
        if (this._activePopoverKind === kind) {
          this._activePopoverCleanup = null;
          this._activePopoverKind = null;
        }
        safeInvokeCallback(userOnClose);
      },
    });
    this._activePopoverCleanup = () => {
      mounted?.destroy?.();
      controller?.close?.();
    };
    return { kind, controller, mounted: true, view: mounted };
  }

  openTypeEditPopover(target = {}, options = {}) {
    const vaHex = normalizeVaHex(target.va ?? target.address);
    this.typeEditController.openForTarget({
      kind: target.kind || 'function',
      va: vaHex || '0x0',
      name: target.name || (vaHex ? `sub_${vaHex.slice(2)}` : 'fn'),
      currentType: target.currentType || 'int64_t (int64_t a1)',
      pinned: Boolean(target.pinned),
    });
    return this._mountPopover('type-edit', renderTypeEditPopover, this.typeEditController, options);
  }

  openManualRecoveryPopover(target = {}, options = {}) {
    const vaHex = normalizeVaHex(target.va ?? target.address) || '0x0';
    this.manualRecoveryController.open({
      tab: target.tab || 'segment',
      va: vaHex,
    });
    return this._mountPopover('manual-recovery', renderManualRecoveryPopover, this.manualRecoveryController, options);
  }

  openSlicePanel(target = {}, options = {}) {
    const vaHex = normalizeVaHex(target.va ?? target.address) || '0x0';
    this.slicePanelController.openSlice({
      anchorVa: vaHex,
      direction: target.direction || 'backward',
      steps: Array.isArray(target.steps) ? target.steps : [],
      deobfBadges: Array.isArray(target.deobfBadges) ? target.deobfBadges : [],
    });
    return this._mountPopover('slice-panel', renderSlicePanel, this.slicePanelController, options);
  }

  openExportInteropModal(options = {}) {
    const state = this._buildInteropState();
    this.exportInteropController.open(state);
    return this._mountPopover('export-interop', renderExportInteropModal, this.exportInteropController, options);
  }

  undoTypeEdit() {
    if (!this.typeTx.canUndo()) return { ok: false, reason: 'nothing-to-undo' };
    return this.typeTx.undo();
  }

  redoTypeEdit() {
    if (!this.typeTx.canRedo()) return { ok: false, reason: 'nothing-to-redo' };
    return this.typeTx.redo();
  }

  _buildInteropState() {
    const notes = this.app?.notes;
    const functions = [];
    if (notes?.names instanceof Map) {
      for (const [va, name] of notes.names.entries()) {
        const vaHex = normalizeVaHex(va);
        if (vaHex) functions.push({ va: vaHex, name: String(name), sig: notes.types?.get?.(va) || '' });
      }
    }
    return {
      functions,
      structs: Array.isArray(notes?.structs) ? notes.structs.slice() : [],
      globals: this.globalTypeMap.list ? this.globalTypeMap.list() : [],
      delta: this.exportV2DeltaFields(),
    };
  }

  _clearRecoveryStores() {
    if (typeof this.manualSegments?.clear === 'function') {
      this.manualSegments.clear();
    } else if (Array.isArray(this.manualSegments?.entries)) {
      this.manualSegments.entries.length = 0;
    }

    if (typeof this.funcChunks?.clear === 'function') {
      this.funcChunks.clear();
    } else if (this.funcChunks) {
      this.funcChunks.byOwner?.clear?.();
      if (Array.isArray(this.funcChunks.globalIndex)) this.funcChunks.globalIndex.length = 0;
      this.funcChunks.detachedBlocklist?.clear?.();
    }

    if (typeof this.customAbis?.clear === 'function') {
      this.customAbis.clear();
    } else {
      this.customAbis?.specs?.clear?.();
    }

    if (typeof this.stackOverrides?.clear === 'function') {
      this.stackOverrides.clear();
    } else {
      this.stackOverrides?.byFunc?.clear?.();
    }

    if (typeof this.shiftedPtrs?.clear === 'function') {
      this.shiftedPtrs.clear();
    } else {
      this.shiftedPtrs?.byFunc?.clear?.();
    }
  }

  _resetBinaryScopedState({ clearInjectedHexSigLoader = false } = {}) {
    this._clearRecoveryStores();
    if (this.globalTypeMap) {
      this.globalTypeMap.entries?.clear?.();
      if (Array.isArray(this.globalTypeMap._sortedVas)) this.globalTypeMap._sortedVas.length = 0;
      this.globalTypeMap._sortedDirty = false;
    }
    this.displayHints = Object.create(null);
    this.pinnedMasks = Object.create(null);
    this._hexsigHubLoader = clearInjectedHexSigLoader ? null : this._injectedHexSigHubLoader;
  }

  exportV2DeltaFields() {
    const rawSegments = typeof this.manualSegments?.list === 'function'
      ? this.manualSegments.list()
      : (Array.isArray(this.manualSegments?.entries) ? this.manualSegments.entries : []);
    const segments = rawSegments.map((s) => ({
      startVa: normalizeVaHex(s.startVa ?? s.baseVa) || '0x0',
      size: Number(s.size ?? s.byteLen ?? 0),
      byteLen: Number(s.byteLen ?? s.size ?? 0),
      fileOffset: Number(s.fileOffset ?? 0),
      kind: s.kind ?? 0,
      flags: s.flags ?? 0,
      name: s.name || '',
    }));

    const chunks = [];
    if (typeof this.funcChunks?.list === 'function') {
      for (const c of this.funcChunks.list()) {
        chunks.push({
          ownerVa: normalizeVaHex(c.ownerVa ?? c.ownerFnVa) || '0x0',
          startVa: normalizeVaHex(c.startVa) || '0x0',
          endVa: normalizeVaHex(c.endVa) || '0x0',
          kind: c.kind ?? c.chunkKind ?? 0,
          flags: c.flags ?? 0,
        });
      }
    } else if (this.funcChunks?.byOwner instanceof Map) {
      for (const [ownerVa, list] of this.funcChunks.byOwner.entries()) {
        const ownerHex = normalizeVaHex(ownerVa) || '0x0';
        for (const c of (Array.isArray(list) ? list : [])) {
          chunks.push({
            ownerVa: normalizeVaHex(c.ownerVa ?? c.ownerFnVa ?? ownerHex) || ownerHex,
            startVa: normalizeVaHex(c.startVa) || '0x0',
            endVa: normalizeVaHex(c.endVa) || '0x0',
            kind: c.kind ?? c.chunkKind ?? 0,
            flags: c.flags ?? 0,
          });
        }
      }
    } else if (Array.isArray(this.funcChunks?.globalIndex)) {
      for (const c of this.funcChunks.globalIndex) {
        chunks.push({
          ownerVa: normalizeVaHex(c.ownerVa ?? c.ownerFnVa) || '0x0',
          startVa: normalizeVaHex(c.startVa) || '0x0',
          endVa: normalizeVaHex(c.endVa) || '0x0',
          kind: c.kind ?? c.chunkKind ?? 0,
          flags: c.flags ?? 0,
        });
      }
    }

    const customAbis = [];
    if (typeof this.customAbis?.list === 'function') {
      for (const a of this.customAbis.list()) customAbis.push({ ...a });
    } else if (this.customAbis?.specs instanceof Map) {
      for (const [funcVa, spec] of this.customAbis.specs.entries()) {
        const vaHex = normalizeVaHex(spec?.funcVa ?? spec?.fnVa ?? funcVa) || '0x0';
        customAbis.push({ ...spec, funcVa: vaHex });
      }
    }

    const stackSlotOverrides = [];
    if (typeof this.stackOverrides?.list === 'function') {
      for (const o of this.stackOverrides.list()) stackSlotOverrides.push({ ...o });
    } else if (this.stackOverrides?.byFunc instanceof Map) {
      for (const [funcVa, list] of this.stackOverrides.byFunc.entries()) {
        const vaHex = normalizeVaHex(funcVa) || '0x0';
        for (const o of (Array.isArray(list) ? list : [])) {
          stackSlotOverrides.push({ ...o, funcVa: normalizeVaHex(o?.funcVa ?? o?.fnVa ?? vaHex) || vaHex });
        }
      }
    }

    const shiftedPtrs = [];
    if (this.shiftedPtrs?.byFunc instanceof Map) {
      for (const [funcVa, fnMap] of this.shiftedPtrs.byFunc.entries()) {
        const vaHex = normalizeVaHex(funcVa) || '0x0';
        const iter = fnMap instanceof Map ? fnMap.values() : (Array.isArray(fnMap) ? fnMap : []);
        for (const p of iter) {
          shiftedPtrs.push({ ...p, funcVa: normalizeVaHex(p?.funcVa ?? p?.fnVa ?? vaHex) || vaHex });
        }
      }
    }

    return {
      displayHints: { ...this.displayHints },
      manualSegments: segments,
      funcChunks: chunks,
      customAbis,
      stackSlotOverrides,
      shiftedPtrs,
      pinnedMasks: { ...this.pinnedMasks },
    };
  }

  importV2DeltaFields(delta) {
    if (!delta || typeof delta !== 'object') return;

    this.displayHints = Object.create(null);
    if (delta.displayHints && typeof delta.displayHints === 'object' && !Array.isArray(delta.displayHints)) {
      for (const [k, v] of Object.entries(delta.displayHints)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        this.displayHints[k] = v;
      }
    }

    this.pinnedMasks = Object.create(null);
    if (delta.pinnedMasks && typeof delta.pinnedMasks === 'object' && !Array.isArray(delta.pinnedMasks)) {
      for (const [k, v] of Object.entries(delta.pinnedMasks)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        this.pinnedMasks[k] = v;
      }
    }

    this._clearRecoveryStores();

    if (Array.isArray(delta.manualSegments) && typeof this.manualSegments?.add === 'function') {
      for (const seg of delta.manualSegments) {
        if (!seg || typeof seg !== 'object') continue;
        try {
          this.manualSegments.add(seg);
        } catch {
          // Ignore malformed persisted segment entries.
        }
      }
    }

    if (Array.isArray(delta.funcChunks)) {
      const attachFn = typeof this.funcChunks?.attachChunk === 'function'
        ? (ownerVa, chunk) => this.funcChunks.attachChunk(ownerVa, chunk)
        : (typeof this.funcChunks?.add === 'function' ? (_ownerVa, chunk) => this.funcChunks.add(chunk) : null);
      if (attachFn) {
        for (const chunk of delta.funcChunks) {
          if (!chunk || typeof chunk !== 'object') continue;
          try {
            attachFn(chunk.ownerVa ?? chunk.ownerFnVa, chunk);
          } catch {
            // Ignore malformed persisted chunk entries.
          }
        }
      }
    }

    const abiItems = Array.isArray(delta.customAbis)
      ? delta.customAbis
      : (delta.customAbis && typeof delta.customAbis === 'object' ? Object.values(delta.customAbis) : []);
    if (typeof this.customAbis?.set === 'function') {
      for (const abi of abiItems) {
        if (!abi || typeof abi !== 'object') continue;
        try {
          this.customAbis.set(abi.fnVa ?? abi.funcVa, abi);
        } catch {
          // Ignore malformed persisted ABI entries.
        }
      }
    }

    const stackItems = Array.isArray(delta.stackSlotOverrides)
      ? delta.stackSlotOverrides
      : (delta.stackSlotOverrides && typeof delta.stackSlotOverrides === 'object' ? Object.values(delta.stackSlotOverrides) : []);
    const setOverrideFn = typeof this.stackOverrides?.setOverride === 'function'
      ? (va, ov) => this.stackOverrides.setOverride(va, ov)
      : (typeof this.stackOverrides?.set === 'function' ? (va, ov) => this.stackOverrides.set(va, ov) : null);
    if (setOverrideFn) {
      for (const ov of stackItems) {
        if (!ov || typeof ov !== 'object') continue;
        try {
          setOverrideFn(ov.fnVa ?? ov.funcVa, ov);
        } catch {
          // Ignore malformed persisted stack override entries.
        }
      }
    }

    const shiftedItems = Array.isArray(delta.shiftedPtrs)
      ? delta.shiftedPtrs
      : (delta.shiftedPtrs && typeof delta.shiftedPtrs === 'object' ? Object.values(delta.shiftedPtrs) : []);
    const registerShiftedFn = typeof this.shiftedPtrs?.register === 'function'
      ? (va, sp) => this.shiftedPtrs.register(va, sp)
      : (typeof this.shiftedPtrs?.set === 'function' ? (va, sp) => this.shiftedPtrs.set(va, sp) : null);
    if (registerShiftedFn) {
      for (const sp of shiftedItems) {
        if (!sp || typeof sp !== 'object') continue;
        try {
          registerShiftedFn(sp.fnVa ?? sp.funcVa ?? sp.key, sp);
        } catch {
          // Ignore malformed persisted shifted-ptr entries.
        }
      }
    }
  }

  _emitAutoAnalysisUpdate() {
    const snap = this.getAutoAnalysisState();
    for (const listener of [...this._autoAnalysisListeners]) {
      safeInvokeCallback(listener, snap);
    }
  }

  getAutoAnalysisState() {
    const s = this._autoAnalysisState;
    return {
      binaryKey: s.binaryKey ?? this._binaryKey ?? null,
      generation: s.generation,
      til: {
        ...s.til,
        loadedPacks: Array.isArray(s.til.loadedPacks) ? s.til.loadedPacks.slice() : [],
        errors: Array.isArray(s.til.errors) ? s.til.errors.slice() : [],
      },
      hexsig: { ...s.hexsig },
      deobf: { ...s.deobf },
      staged: cloneStagedState(s.staged),
    };
  }

  subscribeAutoAnalysis(fn) {
    if (typeof fn !== 'function') return () => {};
    this._autoAnalysisListeners.add(fn);
    return () => {
      this._autoAnalysisListeners.delete(fn);
    };
  }

  notifyAutoAnalysisUpdate({ deobfHit = false, stlHit = false } = {}) {
    if (deobfHit) this._autoAnalysisState.deobf.deobfHits += 1;
    if (stlHit) this._autoAnalysisState.deobf.stlHits += 1;
    this._emitAutoAnalysisUpdate();
  }

  cancelAutoAnalysis({ resetState = true } = {}) {
    this._autoGen += 1;
    if (this._idleTimer != null) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    if (this._autoAbortController) {
      try { this._autoAbortController.abort(); } catch { /* ignore */ }
      this._autoAbortController = null;
    }
    if (this._activeTilAbortController) {
      try { this._activeTilAbortController.abort(); } catch { /* ignore */ }
      this._activeTilAbortController = null;
    }
    if (resetState) {
      this.deobfOverlay?.clear?.();
      this._deobfSummaries.clear();
      this._stlByFunc.clear();
      this.stlRecognizer?.clear?.();
      this._autoNamedFunctions.clear();
      this._mountedHexSigPacks.clear();
      this.hexsigIndex = new HexSigIndex();
      this._wasmAnalysis = null;
      this._wasmIndex = null;
      this._resetBinaryScopedState({ clearInjectedHexSigLoader: false });

      if (typeof this.tilPackManager?.purgeAllSlots === 'function') {
        try {
          this.tilPackManager.purgeAllSlots({ releaseTidBases: true });
        } catch {
          // Non-fatal purge failure during reset.
        }
        this._autoMountedTilSlots.clear();
      } else if (this._autoMountedTilSlots.size > 0 && typeof this.tilPackManager?.getMountedSlots === 'function') {
        const slots = this.tilPackManager.getMountedSlots();
        for (const [slot, entry] of this._autoMountedTilSlots.entries()) {
          const slotInfo = slots ? slots[slot] : null;
          if (slotInfo && slotInfo.packId === entry.packId && slotInfo.lastAccess === entry.lastAccess) {
            try {
              this.tilPackManager.unmountSlot(slot, { releaseTidBase: true });
            } catch {
              // Non-fatal unmount failure during reset.
            }
          }
        }
        this._autoMountedTilSlots.clear();
      }
    }
  }

  restoreStagedAutoAnalysis(rawCached, { emit = true } = {}) {
    const cached = normalizeStagedAutoAnalysis(rawCached);
    if (!cached) return false;
    if (!this._autoAnalysisState.staged) {
      this._autoAnalysisState.staged = makeInitialStagedState(AUTO_ANALYSIS_STATUS.IDLE);
    }
    const staged = this._autoAnalysisState.staged;
    const cs = cached.stages;

    if (cs.names.completed) {
      staged.stages.names = {
        ...staged.stages.names,
        status: AUTO_ANALYSIS_STATUS.DONE,
        completed: cs.names.recovered,
        total: cs.names.total,
        objcCount: cs.names.objcCount,
        swiftCount: cs.names.swiftCount,
        hexsigCount: cs.names.hexsigCount,
        restoredFromCache: true,
        completedAt: cs.names.completedAt,
      };
    }
    if (cs.strings.completed) {
      staged.stages.strings = {
        ...staged.stages.strings,
        status: AUTO_ANALYSIS_STATUS.DONE,
        completed: cs.strings.count,
        total: cs.strings.count,
        count: cs.strings.count,
        restoredFromCache: true,
        completedAt: cs.strings.completedAt,
      };
    }
    if (cs.callgraph.completed) {
      staged.stages.callgraph = {
        ...staged.stages.callgraph,
        status: AUTO_ANALYSIS_STATUS.DONE,
        completed: cs.callgraph.functionCount,
        total: cs.callgraph.functionCount,
        functionCount: cs.callgraph.functionCount,
        callCount: cs.callgraph.callCount,
        refCount: cs.callgraph.refCount,
        restoredFromCache: true,
        completedAt: cs.callgraph.completedAt,
      };
    }
    if (cs.goals.completed) {
      staged.stages.goals = {
        ...staged.stages.goals,
        status: AUTO_ANALYSIS_STATUS.DONE,
        completed: cs.goals.count,
        total: cs.goals.count,
        count: cs.goals.count,
        restoredFromCache: true,
        completedAt: cs.goals.completedAt,
      };
    }

    staged.recoveredNamesSummary = {
      ...cached.recoveredNamesSummary,
      entries: Array.isArray(cached.recoveredNamesSummary?.entries)
        ? cached.recoveredNamesSummary.entries.map((e) => ({ ...e }))
        : [],
    };
    staged.goalCandidatesSummary = Array.isArray(cached.goalCandidatesSummary)
      ? cached.goalCandidatesSummary.map((g) => ({ ...g }))
      : [];

    const allDone = STAGED_AUTO_ANALYSIS_STAGES.every(
      (id) => staged.stages[id].status === AUTO_ANALYSIS_STATUS.DONE,
    );
    staged.restoredFromCache = true;
    staged.activeStage = null;
    if (allDone) {
      staged.status = AUTO_ANALYSIS_STATUS.DONE;
    }
    if (emit) this._emitAutoAnalysisUpdate();
    return true;
  }

  exportStagedAutoAnalysisCache() {
    const staged = this._autoAnalysisState?.staged;
    if (!staged || !staged.stages) return null;
    const raw = {
      version: 1,
      updatedAt: Date.now(),
      stages: {
        names: {
          completed: staged.stages.names.status === AUTO_ANALYSIS_STATUS.DONE,
          recovered: staged.stages.names.completed,
          total: staged.stages.names.total,
          objcCount: staged.stages.names.objcCount,
          swiftCount: staged.stages.names.swiftCount,
          hexsigCount: staged.stages.names.hexsigCount,
          completedAt: staged.stages.names.completedAt,
        },
        strings: {
          completed: staged.stages.strings.status === AUTO_ANALYSIS_STATUS.DONE,
          count: staged.stages.strings.count,
          completedAt: staged.stages.strings.completedAt,
        },
        callgraph: {
          completed: staged.stages.callgraph.status === AUTO_ANALYSIS_STATUS.DONE,
          functionCount: staged.stages.callgraph.functionCount,
          callCount: staged.stages.callgraph.callCount,
          refCount: staged.stages.callgraph.refCount,
          completedAt: staged.stages.callgraph.completedAt,
        },
        goals: {
          completed: staged.stages.goals.status === AUTO_ANALYSIS_STATUS.DONE,
          count: staged.stages.goals.count,
          completedAt: staged.stages.goals.completedAt,
        },
      },
      recoveredNamesSummary: staged.recoveredNamesSummary,
      goalCandidatesSummary: staged.goalCandidatesSummary,
    };
    return normalizeStagedAutoAnalysis(raw);
  }

  cancelStagedAutoAnalysis() {
    this.cancelAutoAnalysis({ resetState: false });
    const state = this._autoAnalysisState;
    for (const phaseKey of ['til', 'hexsig', 'deobf']) {
      const ph = state?.[phaseKey];
      if (ph && (ph.status === AUTO_ANALYSIS_STATUS.IDLE || ph.status === AUTO_ANALYSIS_STATUS.RUNNING)) {
        ph.status = AUTO_ANALYSIS_STATUS.ABORTED;
      }
    }
    const staged = state?.staged;
    if (staged && staged.stages) {
      for (const stageId of STAGED_AUTO_ANALYSIS_STAGES) {
        const st = staged.stages[stageId];
        if (st && (st.status === AUTO_ANALYSIS_STATUS.IDLE || st.status === AUTO_ANALYSIS_STATUS.RUNNING)) {
          st.status = AUTO_ANALYSIS_STATUS.ABORTED;
        }
      }
      staged.status = AUTO_ANALYSIS_STATUS.ABORTED;
      staged.activeStage = null;
    }
    this._emitAutoAnalysisUpdate();
    return true;
  }

  onBinaryReady(fingerprint, providers = null) {
    if (!fingerprint || typeof fingerprint !== 'object') return;
    const key = [
      String(fingerprint.sha256 || fingerprint.prefix || fingerprint.name || 'unknown'),
      String(fingerprint.sliceIndex ?? ''),
      String(fingerprint.uuid || fingerprint.architecture || ''),
    ].join('|');
    const isBinarySwitch = Boolean(this._binaryKey !== null && this._binaryKey !== key);
    const hasProviders = Boolean(providers && typeof providers === 'object');

    // 4-case matrix: resetState only on binary switch; initial phase status SKIPPED without providers, IDLE with providers.
    this.cancelAutoAnalysis({ resetState: isBinarySwitch });
    this._binaryKey = key;
    const gen = this._autoGen;
    const initialStatus = hasProviders ? AUTO_ANALYSIS_STATUS.IDLE : AUTO_ANALYSIS_STATUS.SKIPPED;
    this._autoAnalysisState = makeInitialAutoAnalysisState(initialStatus, key);
    this._autoAnalysisState.generation = gen;
    if (hasProviders && providers.cachedStagedAnalysis) {
      this.restoreStagedAutoAnalysis(providers.cachedStagedAnalysis, { emit: false });
    }
    this._emitAutoAnalysisUpdate();

    // Deferred idle activation so loaderOpenLatency overhead is strictly +0 ms.
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (gen !== this._autoGen || this._binaryKey !== key) return;
      try {
        if (!this.hexdb) this.hexdb = this._hexdbFactory();
        if (typeof this.hexdb.open === 'function') {
          void Promise.resolve(this.hexdb.open(key)).catch(() => {});
        }
      } catch {
        // Non-fatal fallback to in-memory analysis.
      }
      if (hasProviders) {
        void this._runAutoAnalysisPipeline(gen, providers).catch(() => {});
      }
    }, 0);
    if (typeof this._idleTimer?.unref === 'function') this._idleTimer.unref();
  }

  async _runAutoAnalysisPipeline(gen, providers) {
    if (gen !== this._autoGen) return;
    const ctrl = new AbortController();
    this._autoAbortController = ctrl;
    const { signal } = ctrl;
    const cfg = this._autoAnalysisConfig || {};
    const staged = this._autoAnalysisState.staged || (this._autoAnalysisState.staged = makeInitialStagedState(AUTO_ANALYSIS_STATUS.IDLE));
    const hasStagedHooks = Boolean(
      typeof providers.recoverNames === 'function'
      || typeof providers.indexStrings === 'function'
      || typeof providers.indexCallGraph === 'function'
      || typeof providers.rankGoalCandidates === 'function',
    );
    const isStillCurrent = () => (
      gen === this._autoGen
      && !signal.aborted
      && (typeof providers.isCurrent !== 'function' || providers.isCurrent() !== false)
    );
    const yieldStage = typeof cfg.yieldFn === 'function'
      ? cfg.yieldFn
      : (typeof providers.yieldFn === 'function'
        ? providers.yieldFn
        : () => new Promise((resolve) => {
          const t = setTimeout(resolve, 0);
          t.unref?.();
        }));
    const namesAlreadyDone = staged.stages.names.status === AUTO_ANALYSIS_STATUS.DONE;
    const callgraphAlreadyDone = staged.stages.callgraph.status === AUTO_ANALYSIS_STATUS.DONE;
    const getFunctionAnchors = typeof providers.getFunctionAnchors === 'function'
      ? providers.getFunctionAnchors
      : (typeof cfg.hexsigGetFunctionAnchors === 'function' ? cfg.hexsigGetFunctionAnchors : null);
    const applyAutoNamedBatch = (batch) => {
      if (gen !== this._autoGen || signal.aborted) return;
      let accepted = batch;
      if (typeof providers.onAutoNamedBatch === 'function') {
        try {
          const res = providers.onAutoNamedBatch(batch);
          if (Array.isArray(res)) accepted = res;
        } catch {
          accepted = [];
        }
      }
      for (const m of accepted) {
        const vaHex = normalizeVaHex(m?.vaHex);
        if (vaHex && m?.newName) {
          this._autoNamedFunctions.set(vaHex, m);
        }
      }
    };
    const syncHexSigToStagedNames = () => {
      const hexsigAdded = this._autoNamedFunctions.size;
      if (hexsigAdded <= 0) return 0;
      const prevHexsigCount = Number.isFinite(staged.stages.names.hexsigCount)
        ? Math.max(0, Math.trunc(staged.stages.names.hexsigCount))
        : 0;
      const nextHexsigCount = Math.max(prevHexsigCount, hexsigAdded);
      const hexsigDelta = nextHexsigCount - prevHexsigCount;

      staged.stages.names.hexsigCount = nextHexsigCount;
      staged.recoveredNamesSummary.hexsig = nextHexsigCount;
      if (hexsigDelta > 0) {
        staged.stages.names.completed = Math.max(0, (staged.stages.names.completed || 0) + hexsigDelta);
        const hexsigTotal = Number.isFinite(this._autoAnalysisState.hexsig?.total)
          ? Math.max(0, Math.trunc(this._autoAnalysisState.hexsig.total))
          : 0;
        if (staged.stages.names.total < staged.stages.names.completed) {
          staged.stages.names.total = Math.max(staged.stages.names.completed, hexsigTotal);
        }
        staged.recoveredNamesSummary.named = Math.max(
          staged.recoveredNamesSummary.named || 0,
          staged.stages.names.completed,
        );
        staged.recoveredNamesSummary.total = Math.max(
          staged.recoveredNamesSummary.total || 0,
          staged.stages.names.total,
        );
      }

      const existingEntries = Array.isArray(staged.recoveredNamesSummary.entries)
        ? staged.recoveredNamesSummary.entries.slice(0, 256)
        : [];
      const seenVas = new Set();
      for (const entry of existingEntries) {
        const normVa = normalizeVaHex(entry?.va ?? entry?.vaHex ?? entry?.addr);
        if (normVa) seenVas.add(normVa);
      }
      for (const [vaHex, matchRec] of this._autoNamedFunctions.entries()) {
        if (existingEntries.length >= 256) break;
        const normVa = normalizeVaHex(vaHex);
        if (!normVa || seenVas.has(normVa) || !matchRec?.newName) continue;
        seenVas.add(normVa);
        existingEntries.push({
          va: normVa,
          name: String(matchRec.newName).slice(0, 160),
          source: 'hexsig',
        });
      }
      staged.recoveredNamesSummary.entries = existingEntries;
      return hexsigDelta;
    };

    try {
      const [
        { createTilAutoLoader },
        { createHexSigAutoScanner },
        { createAutoAnalysisQueue },
      ] = await Promise.all([
        import('../analysis/types/core/til-auto-loader.js'),
        import('../analysis/signature/hexsig-auto-scanner.js'),
        import('../analysis/deobf/auto-analysis-queue.js'),
      ]);
      if (gen !== this._autoGen || signal.aborted) return;

      let binaryMeta = {};
      try {
        binaryMeta = (typeof providers.getBinaryMeta === 'function' ? providers.getBinaryMeta() : providers.binaryMeta) || {};
      } catch {
        binaryMeta = {};
      }

      // ── Stage 1 (names): ObjC / Swift / Symbol Name Recovery ──────────────
      let namesStageFailed = false;
      if (!isStillCurrent()) return;
      if (hasStagedHooks && !namesAlreadyDone) {
        staged.status = AUTO_ANALYSIS_STATUS.RUNNING;
        staged.activeStage = 'names';
        staged.stages.names.status = AUTO_ANALYSIS_STATUS.RUNNING;
        this._emitAutoAnalysisUpdate();
        if (typeof providers.recoverNames === 'function') {
          try {
            const nameRes = await providers.recoverNames({
              signal,
              onProgress: (ev) => {
                if (!isStillCurrent()) return;
                if (Number.isFinite(ev?.completed)) staged.stages.names.completed = Math.max(0, Math.trunc(ev.completed));
                if (Number.isFinite(ev?.total)) staged.stages.names.total = Math.max(0, Math.trunc(ev.total));
                if (typeof ev?.detail === 'string') staged.stages.names.detail = ev.detail;
                staged.recoveredNamesSummary.named = staged.stages.names.completed;
                staged.recoveredNamesSummary.total = staged.stages.names.total;
                this._emitAutoAnalysisUpdate();
              },
            });
            if (!isStillCurrent()) return;
            if (nameRes && typeof nameRes === 'object') {
              const named = Number.isFinite(nameRes.named) ? Math.max(0, Math.trunc(nameRes.named)) : staged.stages.names.completed;
              const total = Number.isFinite(nameRes.total) ? Math.max(0, Math.trunc(nameRes.total)) : staged.stages.names.total;
              staged.stages.names.completed = named;
              staged.stages.names.total = total;
              staged.stages.names.objcCount = Number.isFinite(nameRes.objcCount) ? Math.max(0, Math.trunc(nameRes.objcCount)) : staged.stages.names.objcCount;
              staged.stages.names.swiftCount = Number.isFinite(nameRes.swiftCount) ? Math.max(0, Math.trunc(nameRes.swiftCount)) : staged.stages.names.swiftCount;
              staged.stages.names.hexsigCount = Number.isFinite(nameRes.hexsigCount) ? Math.max(0, Math.trunc(nameRes.hexsigCount)) : staged.stages.names.hexsigCount;
              staged.recoveredNamesSummary = {
                named,
                total,
                objc: staged.stages.names.objcCount,
                swift: staged.stages.names.swiftCount,
                hexsig: staged.stages.names.hexsigCount,
                entries: Array.isArray(nameRes.entries) ? nameRes.entries.slice(0, 256) : staged.recoveredNamesSummary.entries,
              };
            }
          } catch (err) {
            if (!isStillCurrent()) return;
            namesStageFailed = true;
            staged.stages.names.status = AUTO_ANALYSIS_STATUS.ERROR;
            staged.stages.names.detail = err?.message || 'names_recovery_error';
            this._emitAutoAnalysisUpdate();
          }
        }
      }

      // ── Phase 1: TIL Auto-Loader ──────────────────────────────────────────
      if (gen !== this._autoGen || signal.aborted) return;
      const tilCtrl = new AbortController();
      this._activeTilAbortController = tilCtrl;
      const onParentAbortForTil = () => {
        try { tilCtrl.abort(); } catch { /* ignore */ }
      };
      let tilTimer = null;

      try {
        signal.addEventListener('abort', onParentAbortForTil, { once: true });
        const tilTimeoutMs = Number.isFinite(cfg.tilTimeoutMs) ? cfg.tilTimeoutMs : DEFAULT_TIL_AUTO_TIMEOUT_MS;
        if (tilTimeoutMs > 0) {
          tilTimer = setTimeout(() => {
            try { tilCtrl.abort(); } catch { /* ignore */ }
          }, tilTimeoutMs);
          tilTimer.unref?.();
        }

        const isEmbedRoute = typeof location !== 'undefined'
          && typeof location.pathname === 'string'
          && location.pathname.startsWith('/embed/');
        const isDevRoot = typeof document !== 'undefined' && !!document.querySelector?.('script[src="./js/app.js"]');
        const tilIsCommunityMirror = Boolean(providers.tilIsCommunityMirror ?? cfg.tilIsCommunityMirror);
        const rawTilManifestUrl = providers.tilManifestUrl ?? cfg.tilManifestUrl ?? null;
        const tilManifestUrl = rawTilManifestUrl === 'til-hub/manifest.json'
          ? (isEmbedRoute ? '/til-hub/manifest.json' : (isDevRoot ? 'dist/til-hub/manifest.json' : rawTilManifestUrl))
          : rawTilManifestUrl;
        const rawTilBaseUrl = providers.tilBaseUrl ?? cfg.tilBaseUrl ?? '';
        const tilBaseUrl = rawTilBaseUrl === 'til-hub'
          ? (isEmbedRoute ? '/til-hub' : (isDevRoot ? 'dist/til-hub' : rawTilBaseUrl))
          : (rawTilBaseUrl || (tilManifestUrl === '/til-hub/manifest.json' ? '/til-hub' : (tilManifestUrl === 'dist/til-hub/manifest.json' ? 'dist/til-hub' : '')));
        let tilFetchManifest = typeof providers.tilFetchManifest === 'function'
          ? providers.tilFetchManifest
          : (typeof cfg.tilFetchManifest === 'function' ? cfg.tilFetchManifest : null);
        if (!tilFetchManifest && tilManifestUrl) {
          tilFetchManifest = async (url, opts = {}) => {
            if (tilIsCommunityMirror) {
              const check = validateCommunityMirrorUrl(url);
              if (!check.ok) throw new Error(check.error || 'community_mirror_rejected');
            }
            const bytes = await _fetchBoundedBytes(url, {
              signal: opts.signal || tilCtrl.signal,
              timeoutMs: tilTimeoutMs,
              maxBytes: PACK_LIMITS.MAX_MANIFEST_BYTES,
            });
            const text = new TextDecoder().decode(bytes);
            const parsed = JSON.parse(text);
            const validation = validateManifestPayload(parsed);
            if (!validation.ok) throw new Error(validation.error || 'invalid_manifest');
            return parsed;
          };
        }

        // Isolate auto-analysis TilPackManager fetcher signal via Proxy so _accessSeq updates
        // stay on the single underlying tilPackManager instance without prototype shadowing.
        const customTilFetcher = typeof providers.tilFetcher === 'function'
          ? providers.tilFetcher
          : (typeof cfg.tilFetcher === 'function' ? cfg.tilFetcher : null);
        const autoTilFetcher = customTilFetcher
          ? (url, init = {}) => customTilFetcher(url, { ...init, signal: tilCtrl.signal })
          : createBoundedTilFetcher(tilCtrl.signal, {
            timeoutMs: tilTimeoutMs,
            maxBytes: PACK_LIMITS.MAX_PACK_BYTES,
          });
        const autoTilPackManager = new Proxy(this.tilPackManager, {
          get(target, prop) {
            if (prop === 'fetcher') return autoTilFetcher;
            const val = Reflect.get(target, prop, target);
            return typeof val === 'function' ? val.bind(autoTilPackManager) : val;
          },
          set(target, prop, value) {
            return Reflect.set(target, prop, value, target);
          },
        });

        const tilLoader = createTilAutoLoader({
          tilPackManager: autoTilPackManager,
          fetchManifest: tilFetchManifest,
          manifestUrl: tilManifestUrl,
          baseUrl: tilBaseUrl,
          isCommunityMirror: tilIsCommunityMirror,
          maxPacks: cfg.tilMaxPacks ?? 2,
        });
        const tilRes = await tilLoader.run({
          binaryMeta,
          signal: tilCtrl.signal,
          onProgress: (ev) => {
            if (!isStillCurrent()) return;
            this._autoAnalysisState.til = {
              ...this._autoAnalysisState.til,
              status: ev.status,
              completed: ev.completed ?? 0,
              total: ev.total ?? 0,
              detail: ev.detail ?? '',
            };
            this._emitAutoAnalysisUpdate();
          },
        });
        if (!isStillCurrent()) return;
        if (Array.isArray(tilRes.mountedSlots)) {
          for (const entry of tilRes.mountedSlots) {
            if (entry && entry.slot && entry.packId) {
              this._autoMountedTilSlots.set(entry.slot, {
                packId: entry.packId,
                lastAccess: entry.lastAccess,
              });
            }
          }
        }
      this._autoAnalysisState.til = {
        status: tilRes.status,
        completed: tilRes.loadedPacks?.length ?? 0,
        total: tilRes.selectedPacks?.length ?? tilRes.loadedPacks?.length ?? 0,
        loadedPacks: Array.isArray(tilRes.loadedPacks) ? tilRes.loadedPacks.slice() : [],
        errors: Array.isArray(tilRes.errors) ? tilRes.errors.slice() : [],
        detail: tilRes.errors?.length ? String(tilRes.errors[0].reason || '') : '',
      };
      this._emitAutoAnalysisUpdate();
    } catch (err) {
      if (gen !== this._autoGen || (typeof providers.isCurrent === 'function' && providers.isCurrent() === false)) return;
      this._autoAnalysisState.til = {
        ...this._autoAnalysisState.til,
        status: signal.aborted ? AUTO_ANALYSIS_STATUS.ABORTED : AUTO_ANALYSIS_STATUS.ERROR,
        detail: err?.message || 'til_error',
      };
      this._emitAutoAnalysisUpdate();
    } finally {
      if (tilTimer != null) clearTimeout(tilTimer);
      signal.removeEventListener('abort', onParentAbortForTil);
      if (this._activeTilAbortController === tilCtrl) {
        this._activeTilAbortController = null;
      }
    }

    // ── Phase 2: HexSig Auto-Scanner ──────────────────────────────────────
    if (!isStillCurrent()) return;
    if (!(hasStagedHooks && namesAlreadyDone))
    try {
      let hubLoader = providers.hexsigHubLoader ?? cfg.hexsigHubLoader ?? null;
      const isEmbedRoute = typeof location !== 'undefined'
        && typeof location.pathname === 'string'
        && location.pathname.startsWith('/embed/');
      const isDevRoot = typeof document !== 'undefined' && !!document.querySelector?.('script[src="./js/app.js"]');
      const hexsigManifest = providers.hexsigManifest ?? cfg.hexsigManifest ?? null;
      const rawHexsigManifestUrl = providers.hexsigManifestUrl ?? cfg.hexsigManifestUrl ?? null;
      const hexsigManifestUrl = rawHexsigManifestUrl === 'hexsig-hub/manifest.json'
        ? (isEmbedRoute ? '/hexsig-hub/manifest.json' : (isDevRoot ? 'dist/hexsig-hub/manifest.json' : rawHexsigManifestUrl))
        : rawHexsigManifestUrl;
      const rawHexsigBaseUrl = providers.hexsigBaseUrl ?? cfg.hexsigBaseUrl ?? '';
      const hexsigBaseUrl = rawHexsigBaseUrl === 'hexsig-hub'
        ? (isEmbedRoute ? '/hexsig-hub' : (isDevRoot ? 'dist/hexsig-hub' : rawHexsigBaseUrl))
        : (rawHexsigBaseUrl || (hexsigManifestUrl === '/hexsig-hub/manifest.json' ? '/hexsig-hub' : (hexsigManifestUrl === 'dist/hexsig-hub/manifest.json' ? 'dist/hexsig-hub' : '')));
      const hexsigFetchManifest = typeof providers.hexsigFetchManifest === 'function'
        ? providers.hexsigFetchManifest
        : (typeof cfg.hexsigFetchManifest === 'function' ? cfg.hexsigFetchManifest : null);
      const customHexSigFetchBytes = typeof providers.hexsigFetchBytes === 'function'
        ? providers.hexsigFetchBytes
        : (typeof cfg.hexsigFetchBytes === 'function' ? cfg.hexsigFetchBytes : null);
      const makeHexSigFetchBytes = () => (customHexSigFetchBytes || ((url) => _fetchBoundedBytes(url, {
        signal,
        timeoutMs: cfg.hexsigTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
        maxBytes: DEFAULT_HEXSIG_PACK_MAX_BYTES,
      })));

      if (!hubLoader && hexsigManifest) {
        hubLoader = createHexSigHubLoader({
          manifest: hexsigManifest,
          baseUrl: hexsigBaseUrl,
          fetchBytes: makeHexSigFetchBytes(),
          verifySha256: cfg.hexsigVerifySha256 ?? true,
        });
      } else if (!hubLoader && (hexsigFetchManifest || hexsigManifestUrl)) {
        try {
          let manifest;
          if (hexsigFetchManifest) {
            manifest = await hexsigFetchManifest(hexsigManifestUrl, { signal });
          } else {
            const manifestBytes = await _fetchBoundedBytes(hexsigManifestUrl, {
              signal,
              timeoutMs: cfg.hexsigTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
              maxBytes: DEFAULT_HEXSIG_MANIFEST_MAX_BYTES,
            });
            manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
          }
          if (gen !== this._autoGen || signal.aborted) return;
          const derivedBase = hexsigBaseUrl
            || (hexsigManifestUrl ? String(hexsigManifestUrl).replace(/[^/]*$/, '') : '');
          hubLoader = createHexSigHubLoader({
            manifest,
            baseUrl: derivedBase,
            fetchBytes: makeHexSigFetchBytes(),
            verifySha256: cfg.hexsigVerifySha256 ?? true,
          });
        } catch (manifestErr) {
          if (gen !== this._autoGen || signal.aborted) return;
          if (!this.hexsigIndex?.entries?.length) {
            this._autoAnalysisState.hexsig = {
              status: AUTO_ANALYSIS_STATUS.OFFLINE,
              completed: 0,
              total: 0,
              scanned: 0,
              named: 0,
              detail: manifestErr?.message || 'manifest_fetch_failed',
            };
            this._emitAutoAnalysisUpdate();
            hubLoader = null;
          }
        }
      }

      if (this._autoAnalysisState.hexsig.status !== AUTO_ANALYSIS_STATUS.OFFLINE) {
        const functions = typeof providers.getFunctions === 'function'
          ? (providers.getFunctions() || [])
          : (Array.isArray(providers.functions) ? providers.functions : []);
        const readFunctionBytes = typeof providers.readFunctionBytes === 'function'
          ? providers.readFunctionBytes
          : null;

        const scanner = createHexSigAutoScanner({
          hexSigIndex: this.hexsigIndex,
          hubLoader,
          mountPack: (loaded) => this.mountHexSigPack(loaded.rawBytes, loaded.meta),
          isPackMounted: (packId) => this._mountedHexSigPacks.has(packId),
          extractQuery: cfg.hexsigExtractQuery || null,
          getFunctionAnchors,
          chunkSize: cfg.hexsigChunkSize ?? 32,
          maxBudgetMs: cfg.hexsigMaxBudgetMs ?? 800,
          maxPacks: cfg.hexsigMaxPacks ?? 2,
          yieldFn: cfg.yieldFn || null,
          nowFn: cfg.nowFn || (() => Date.now()),
        });

        const hexRes = await scanner.run({
          binaryMeta,
          functions,
          readFunctionBytes,
          signal,
          onBatchNamed: applyAutoNamedBatch,
          onProgress: (ev) => {
            if (!isStillCurrent()) return;
            this._autoAnalysisState.hexsig = {
              ...this._autoAnalysisState.hexsig,
              status: ev.status,
              completed: ev.completed ?? 0,
              total: ev.total ?? 0,
              detail: ev.detail ?? '',
            };
            this._emitAutoAnalysisUpdate();
          },
        });

        if (!isStillCurrent()) return;
        this._autoAnalysisState.hexsig = {
          status: hexRes.status,
          completed: hexRes.scanned ?? 0,
          total: Math.max(functions.length, hexRes.scanned ?? 0),
          scanned: hexRes.scanned ?? 0,
          named: this._autoNamedFunctions.size,
          detail: hexRes.errors?.length ? String(hexRes.errors[0].reason || '') : '',
        };
        this._emitAutoAnalysisUpdate();
      }
    } catch (err) {
      if (gen !== this._autoGen || (typeof providers.isCurrent === 'function' && providers.isCurrent() === false)) return;
      this._autoAnalysisState.hexsig = {
        ...this._autoAnalysisState.hexsig,
        status: signal.aborted ? AUTO_ANALYSIS_STATUS.ABORTED : AUTO_ANALYSIS_STATUS.ERROR,
        detail: err?.message || 'hexsig_error',
      };
      this._emitAutoAnalysisUpdate();
    }

    // ── Complete Stage 1 (names) ──────────────────────────────────────────
    if (!isStillCurrent()) return;
    if (hasStagedHooks && !namesAlreadyDone) {
      syncHexSigToStagedNames();

      if (namesStageFailed) {
        staged.stages.names.status = AUTO_ANALYSIS_STATUS.ERROR;
        this._emitAutoAnalysisUpdate();
      } else {
        staged.stages.names.status = AUTO_ANALYSIS_STATUS.DONE;
        staged.stages.names.completedAt = Date.now();
        this._emitAutoAnalysisUpdate();
        safeInvokeCallback(providers.onStageComplete, 'names', {
          ...staged.stages.names,
          summary: { ...staged.recoveredNamesSummary },
        });
      }
      await yieldStage();
      if (!isStillCurrent()) return;
    }

    // ── Stage 2 (strings): String Table & Reference Indexing ──────────────
    if (hasStagedHooks && staged.stages.strings.status !== AUTO_ANALYSIS_STATUS.DONE) {
      if (typeof providers.indexStrings === 'function') {
        staged.status = AUTO_ANALYSIS_STATUS.RUNNING;
        staged.activeStage = 'strings';
        staged.stages.strings.status = AUTO_ANALYSIS_STATUS.RUNNING;
        this._emitAutoAnalysisUpdate();
        try {
          const strRes = await providers.indexStrings({
            signal,
            onProgress: (ev) => {
              if (!isStillCurrent()) return;
              if (Number.isFinite(ev?.completed)) staged.stages.strings.completed = Math.max(0, Math.trunc(ev.completed));
              if (Number.isFinite(ev?.total)) staged.stages.strings.total = Math.max(0, Math.trunc(ev.total));
              this._emitAutoAnalysisUpdate();
            },
          });
          if (!isStillCurrent()) return;
          const count = Number.isFinite(strRes?.count)
            ? Math.max(0, Math.trunc(strRes.count))
            : (Array.isArray(strRes) ? strRes.length : staged.stages.strings.count);
          staged.stages.strings.count = count;
          staged.stages.strings.completed = count;
          staged.stages.strings.total = count;
          staged.stages.strings.status = AUTO_ANALYSIS_STATUS.DONE;
          staged.stages.strings.completedAt = Date.now();
          this._emitAutoAnalysisUpdate();
          safeInvokeCallback(providers.onStageComplete, 'strings', { ...staged.stages.strings });
        } catch (err) {
          if (!isStillCurrent()) return;
          staged.stages.strings.status = AUTO_ANALYSIS_STATUS.ERROR;
          staged.stages.strings.detail = err?.message || 'strings_index_error';
          this._emitAutoAnalysisUpdate();
        }
      } else {
        staged.stages.strings.status = AUTO_ANALYSIS_STATUS.SKIPPED;
      }
      await yieldStage();
      if (!isStillCurrent()) return;
    }

    // ── Stage 3 (callgraph): Call Graph & Xref Indexing ───────────────────
    if (hasStagedHooks && staged.stages.callgraph.status !== AUTO_ANALYSIS_STATUS.DONE) {
      if (typeof providers.indexCallGraph === 'function') {
        staged.status = AUTO_ANALYSIS_STATUS.RUNNING;
        staged.activeStage = 'callgraph';
        staged.stages.callgraph.status = AUTO_ANALYSIS_STATUS.RUNNING;
        this._emitAutoAnalysisUpdate();
        try {
          const cgRes = await providers.indexCallGraph({
            signal,
            onProgress: (ev) => {
              if (!isStillCurrent()) return;
              if (Number.isFinite(ev?.completed)) staged.stages.callgraph.completed = Math.max(0, Math.trunc(ev.completed));
              if (Number.isFinite(ev?.total)) staged.stages.callgraph.total = Math.max(0, Math.trunc(ev.total));
              this._emitAutoAnalysisUpdate();
            },
          });
          if (!isStillCurrent()) return;
          if (cgRes && typeof cgRes === 'object') {
            staged.stages.callgraph.functionCount = Number.isFinite(cgRes.functionCount) ? Math.max(0, Math.trunc(cgRes.functionCount)) : 0;
            staged.stages.callgraph.callCount = Number.isFinite(cgRes.callCount) ? Math.max(0, Math.trunc(cgRes.callCount)) : 0;
            staged.stages.callgraph.refCount = Number.isFinite(cgRes.refCount) ? Math.max(0, Math.trunc(cgRes.refCount)) : 0;
            staged.stages.callgraph.completed = staged.stages.callgraph.functionCount;
            staged.stages.callgraph.total = staged.stages.callgraph.functionCount;
          }
          staged.stages.callgraph.status = AUTO_ANALYSIS_STATUS.DONE;
          staged.stages.callgraph.completedAt = Date.now();
          this._emitAutoAnalysisUpdate();
          safeInvokeCallback(providers.onStageComplete, 'callgraph', { ...staged.stages.callgraph });
        } catch (err) {
          if (!isStillCurrent()) return;
          staged.stages.callgraph.status = AUTO_ANALYSIS_STATUS.ERROR;
          staged.stages.callgraph.detail = err?.message || 'callgraph_index_error';
          this._emitAutoAnalysisUpdate();
        }
      } else {
        staged.stages.callgraph.status = AUTO_ANALYSIS_STATUS.SKIPPED;
      }
      await yieldStage();
      if (!isStillCurrent()) return;
    }

    // ── Post-Callgraph Anchor-Assisted HexSig Refinement Pass ─────────────
    // Stage 1 (names) runs before Stage 2 (strings) and Stage 3 (callgraph),
    // so string/xref anchors may only become available once callgraph finishes.
    if (
      isStillCurrent()
      && hasStagedHooks
      && !callgraphAlreadyDone
      && staged.stages.callgraph.status === AUTO_ANALYSIS_STATUS.DONE
      && typeof getFunctionAnchors === 'function'
      && this.hexsigIndex?.entries?.length > 0
      && this._autoAnalysisState.hexsig.status !== AUTO_ANALYSIS_STATUS.OFFLINE
    ) {
      try {
        const allFunctions = typeof providers.getFunctions === 'function'
          ? (providers.getFunctions() || [])
          : (Array.isArray(providers.functions) ? providers.functions : []);
        const readFunctionBytes = typeof providers.readFunctionBytes === 'function'
          ? providers.readFunctionBytes
          : null;
        const remainingFunctions = [];
        for (const fn of allFunctions) {
          if (!fn || typeof fn !== 'object') continue;
          const vaHex = normalizeVaHex(fn.vaHex ?? fn.va ?? fn.addr ?? fn.address);
          if (!vaHex || this._autoNamedFunctions.has(vaHex)) continue;
          const fnName = typeof fn.name === 'string'
            ? fn.name
            : (fn.name == null ? null : String(fn.name));
          if (!isStrippedFunctionName(fnName)) continue;
          remainingFunctions.push(fn);
        }

        if (remainingFunctions.length > 0 && readFunctionBytes) {
          const beforeNamedCount = this._autoNamedFunctions.size;
          const refineScanner = createHexSigAutoScanner({
            hexSigIndex: this.hexsigIndex,
            extractQuery: cfg.hexsigExtractQuery || null,
            getFunctionAnchors,
            chunkSize: cfg.hexsigChunkSize ?? 32,
            maxBudgetMs: cfg.hexsigAnchorRefineMaxBudgetMs ?? 1200,
            maxPacks: 0,
            yieldFn: cfg.yieldFn || null,
            nowFn: cfg.nowFn || (() => Date.now()),
          });

          const refineRes = await refineScanner.run({
            binaryMeta,
            functions: remainingFunctions,
            readFunctionBytes,
            signal,
            onBatchNamed: applyAutoNamedBatch,
            onProgress: (ev) => {
              if (gen !== this._autoGen || signal.aborted) return;
              this._autoAnalysisState.hexsig = {
                ...this._autoAnalysisState.hexsig,
                status: ev.status,
                named: this._autoNamedFunctions.size,
                detail: ev.detail || 'anchor_refinement',
              };
              this._emitAutoAnalysisUpdate();
            },
          });

          if (!isStillCurrent()) return;
          const newlyNamed = this._autoNamedFunctions.size - beforeNamedCount;
          this._autoAnalysisState.hexsig = {
            ...this._autoAnalysisState.hexsig,
            status: refineRes.status === AUTO_ANALYSIS_STATUS.DONE
              ? AUTO_ANALYSIS_STATUS.DONE
              : (this._autoAnalysisState.hexsig.status || refineRes.status),
            scanned: (this._autoAnalysisState.hexsig.scanned ?? 0) + (refineRes.scanned ?? 0),
            named: this._autoNamedFunctions.size,
            detail: refineRes.errors?.length ? String(refineRes.errors[0].reason || '') : '',
          };
          if (newlyNamed > 0) {
            syncHexSigToStagedNames();
          }
          this._emitAutoAnalysisUpdate();
        }
      } catch {
        // Non-fatal: anchor refinement must not block downstream goal ranking.
      }
      await yieldStage();
      if (!isStillCurrent()) return;
    }

    // ── Phase 3: CFF/MBA/STL Auto-Analysis Queue ──────────────────────────
    if (!isStillCurrent()) return;
    if (!(hasStagedHooks && staged.stages.goals.status === AUTO_ANALYSIS_STATUS.DONE))
    try {
      const candidates = typeof providers.getDeobfCandidates === 'function'
        ? (providers.getDeobfCandidates() || [])
        : (Array.isArray(providers.deobfCandidates) ? providers.deobfCandidates : []);
      const loadCandidateInput = typeof providers.loadDeobfCandidateInput === 'function'
        ? providers.loadDeobfCandidateInput
        : null;

      const queue = createAutoAnalysisQueue({
        runDeobfuscationPass: (args) => this.runDeobfuscationPass({
          ...args,
          opts: { ...(args?.opts || {}), commit: false },
        }),
        recognizeStlPattern: (input, opts) => this.recognizeStlPattern(input, {
          ...(opts || {}),
          commit: false,
        }),
        maxBudgetMs: cfg.deobfMaxBudgetMs ?? 1200,
        maxFunctions: cfg.deobfMaxFunctions ?? 64,
        maxMemoryBytes: cfg.deobfMaxMemoryBytes ?? (16 * 1024 * 1024),
        estimateMemoryBytes: cfg.deobfEstimateMemoryBytes || null,
        yieldFn: cfg.yieldFn || null,
        nowFn: cfg.nowFn || (() => Date.now()),
      });

      const queueRes = await queue.run({
        candidates,
        loadCandidateInput,
        signal,
        generation: gen,
        getCurrentGeneration: () => this._autoGen,
        onResult: ({ vaHex, deobf, stl, deobfHit, stlHit }) => {
          if (gen !== this._autoGen || signal.aborted || !vaHex) return;
          const hasDeobfHit = Boolean(
            deobfHit
            || deobf?.cffRecovered
            || (deobf?.mba?.simplifiedCount > 0)
            || (deobf?.overlayCount > 0)
            || (deobf?.pendingAnnotations?.length > 0),
          );
          if (hasDeobfHit && deobf && typeof deobf === 'object') {
            if (Array.isArray(deobf.pendingAnnotations)) {
              for (const ann of deobf.pendingAnnotations) {
                this.deobfOverlay.setAnnotation(ann);
              }
            }
            const committed = {
              ...deobf,
              overlayRevision: this.deobfOverlay.revision,
            };
            delete committed.pendingAnnotations;
            this._deobfSummaries.set(vaHex, committed);
          }
          if ((stlHit || stl?.recognized === true) && stl && typeof stl === 'object') {
            this._stlByFunc.set(vaHex, stl);
          }
        },
        onProgress: (ev) => {
          if (!isStillCurrent()) return;
          this._autoAnalysisState.deobf = {
            ...this._autoAnalysisState.deobf,
            status: ev.status,
            completed: ev.completed ?? 0,
            total: ev.total ?? 0,
            detail: ev.detail ?? '',
          };
          this._emitAutoAnalysisUpdate();
        },
      });

      if (!isStillCurrent()) return;
      this._autoAnalysisState.deobf = {
        status: queueRes.status,
        completed: queueRes.processed ?? 0,
        total: Math.max(candidates.length, queueRes.processed ?? 0),
        processed: queueRes.processed ?? 0,
        deobfHits: queueRes.deobfHits ?? 0,
        stlHits: queueRes.stlHits ?? 0,
        detail: queueRes.errors?.length ? String(queueRes.errors[0].reason || '') : '',
      };
      this._emitAutoAnalysisUpdate();
    } catch (err) {
      if (gen !== this._autoGen || (typeof providers.isCurrent === 'function' && providers.isCurrent() === false)) return;
      this._autoAnalysisState.deobf = {
        ...this._autoAnalysisState.deobf,
        status: signal.aborted ? AUTO_ANALYSIS_STATUS.ABORTED : AUTO_ANALYSIS_STATUS.ERROR,
        detail: err?.message || 'deobf_error',
      };
      this._emitAutoAnalysisUpdate();
    }
    // ── Stage 4 (goals): Lightweight Goal Candidate Ranking ───────────────
    if (!isStillCurrent()) return;
    if (hasStagedHooks && staged.stages.goals.status !== AUTO_ANALYSIS_STATUS.DONE) {
      if (typeof providers.rankGoalCandidates === 'function') {
        staged.status = AUTO_ANALYSIS_STATUS.RUNNING;
        staged.activeStage = 'goals';
        staged.stages.goals.status = AUTO_ANALYSIS_STATUS.RUNNING;
        this._emitAutoAnalysisUpdate();
        try {
          const goalRes = await providers.rankGoalCandidates({
            signal,
            onProgress: (ev) => {
              if (!isStillCurrent()) return;
              if (Number.isFinite(ev?.completed)) staged.stages.goals.completed = Math.max(0, Math.trunc(ev.completed));
              if (Number.isFinite(ev?.total)) staged.stages.goals.total = Math.max(0, Math.trunc(ev.total));
              this._emitAutoAnalysisUpdate();
            },
          });
          if (!isStillCurrent()) return;
          const candidates = Array.isArray(goalRes?.candidates)
            ? goalRes.candidates
            : (Array.isArray(goalRes) ? goalRes : []);
          const compact = [];
          for (const item of candidates.slice(0, 32)) {
            if (!item || typeof item !== 'object') continue;
            const vaHex = normalizeVaHex(item.vaHex ?? item.va ?? item.addr ?? item.address);
            if (!vaHex) continue;
            compact.push({
              vaHex,
              name: String(item.name ?? item.displayName ?? `sub_${vaHex.slice(2)}`).slice(0, 160),
              score: Number.isFinite(Number(item.score)) ? Math.round(Number(item.score) * 100) / 100 : 0,
              reason: typeof item.reason === 'string' ? item.reason.slice(0, 200) : '',
              goal: typeof item.goal === 'string' ? item.goal.slice(0, 80) : null,
            });
          }
          staged.goalCandidatesSummary = compact;
          staged.stages.goals.count = compact.length;
          staged.stages.goals.completed = compact.length;
          staged.stages.goals.total = compact.length;
          staged.stages.goals.status = AUTO_ANALYSIS_STATUS.DONE;
          staged.stages.goals.completedAt = Date.now();
          this._emitAutoAnalysisUpdate();
          safeInvokeCallback(providers.onStageComplete, 'goals', {
            ...staged.stages.goals,
            candidates: compact,
          });
        } catch (err) {
          if (!isStillCurrent()) return;
          staged.stages.goals.status = AUTO_ANALYSIS_STATUS.ERROR;
          staged.stages.goals.detail = err?.message || 'goals_rank_error';
          this._emitAutoAnalysisUpdate();
        }
      } else {
        staged.stages.goals.status = AUTO_ANALYSIS_STATUS.SKIPPED;
      }
    }
    } finally {
      if (gen === this._autoGen) {
        if (this._autoAbortController === ctrl) {
          this._autoAbortController = null;
        }
        if (hasStagedHooks) {
          staged.activeStage = null;
          if (signal.aborted || (typeof providers.isCurrent === 'function' && providers.isCurrent() === false)) {
            for (const stageId of STAGED_AUTO_ANALYSIS_STAGES) {
              const st = staged.stages[stageId];
              if (st && (st.status === AUTO_ANALYSIS_STATUS.IDLE || st.status === AUTO_ANALYSIS_STATUS.RUNNING)) {
                st.status = AUTO_ANALYSIS_STATUS.ABORTED;
              }
            }
            staged.status = AUTO_ANALYSIS_STATUS.ABORTED;
            this._emitAutoAnalysisUpdate();
          } else {
            const anyRunning = STAGED_AUTO_ANALYSIS_STAGES.some(
              (id) => staged.stages[id].status === AUTO_ANALYSIS_STATUS.RUNNING,
            );
            const anyDone = STAGED_AUTO_ANALYSIS_STAGES.some(
              (id) => staged.stages[id].status === AUTO_ANALYSIS_STATUS.DONE,
            );
            if (!anyRunning && anyDone) {
              staged.status = AUTO_ANALYSIS_STATUS.DONE;
              this._emitAutoAnalysisUpdate();
            } else if (!anyRunning && !anyDone) {
              const anyError = STAGED_AUTO_ANALYSIS_STAGES.some(
                (id) => staged.stages[id].status === AUTO_ANALYSIS_STATUS.ERROR,
              );
              staged.status = anyError ? AUTO_ANALYSIS_STATUS.ERROR : AUTO_ANALYSIS_STATUS.SKIPPED;
              this._emitAutoAnalysisUpdate();
            }
          }
        }
      }
    }
  }

  getBeginnerAutoGuide({ limit = 5, functions = null } = {}) {
    const progress = buildAutoAnalysisProgressModel(this.getAutoAnalysisState());
    let fnList = Array.isArray(functions) ? functions : null;
    if (!fnList) {
      try {
        const rawList = this.app?.symbols?.functionList?.();
        fnList = Array.isArray(rawList) ? rawList : [];
      } catch {
        fnList = [];
      }
    }

    const enrichmentsByVa = new Map();
    const candidateVas = new Set();
    const maxCandidates = 64;
    const addCandidate = (va) => {
      if (candidateVas.size >= maxCandidates) return;
      const vaHex = normalizeVaHex(va);
      if (vaHex) candidateVas.add(vaHex);
    };

    for (const k of this._deobfSummaries.keys()) addCandidate(k);
    for (const k of this._stlByFunc.keys()) addCandidate(k);
    for (const k of this._autoNamedFunctions.keys()) addCandidate(k);
    if (this._wasmIndex?.xrefByFunc) {
      for (const k of this._wasmIndex.xrefByFunc.keys()) addCandidate(k);
    }
    if (candidateVas.size < maxCandidates && fnList.length > 0) {
      const preRanked = rankStarterFunctions(fnList, { limit: maxCandidates });
      for (const item of preRanked) {
        if (candidateVas.size >= maxCandidates) break;
        addCandidate(item?.vaHex);
      }
      for (let i = 0; i < fnList.length && candidateVas.size < maxCandidates; i++) {
        const fn = fnList[i];
        addCandidate(fn?.vaHex ?? fn?.va ?? fn?.start ?? fn?.startAddr ?? fn?.address ?? fn?.addr);
      }
    }
    for (const vaHex of candidateVas) {
      enrichmentsByVa.set(vaHex, this.getFunctionEnrichment(vaHex));
    }

    const starterFunctions = rankStarterFunctions(fnList, { limit, enrichmentsByVa });
    return { progress, starterFunctions };
  }

  getBeginnerFunctionGuide(funcVa, opts = {}) {
    const vaHex = normalizeVaHex(funcVa);
    const enrichment = this.getFunctionEnrichment(funcVa, opts);
    const narration = narrateV6Enrichment(enrichment, {
      rawName: opts?.rawName ?? enrichment?.rawName ?? null,
    });

    let instructions = Array.isArray(opts?.instructions) ? opts.instructions : null;
    let cfg = opts?.cfg ?? null;
    if (!instructions || !cfg) {
      const semRes = this.app?.semantic?.result || null;
      const curModel = this.app?.semantic?.model || semRes?.model || null;
      const curVa = normalizeVaHex(
        semRes?.model?.startAddress ?? semRes?.startAddress ?? semRes?.startAddr ?? curModel?.startAddress,
      );
      if (vaHex && curVa === vaHex) {
        if (!instructions && Array.isArray(curModel?.instructions)) {
          instructions = curModel.instructions;
        }
        if (!cfg) {
          cfg = semRes?.pipeline?.cfg ?? curModel?.__canonicalCfg ?? null;
        }
      }
    }

    const patchRisk = assessPatchRisk({
      instructions,
      cfg,
      deobfOverlay: enrichment?.deobfOverlay ?? null,
      wasmHints: enrichment?.wasmHints ?? null,
      isSystemLibrary: Boolean(enrichment?.hexsigMatch || enrichment?.tilSignature),
    });

    const keySet = new Set();
    const glossaryEntries = [];
    const addKey = (k) => {
      if (typeof k !== 'string' || !k || keySet.has(k)) return;
      const entry = getGlossaryEntry(k);
      if (entry) {
        keySet.add(k);
        glossaryEntries.push(entry);
      }
    };
    for (const k of narration.glossaryKeys || []) addKey(k);
    for (const k of patchRisk.glossaryKeys || []) addKey(k);
    const textForTerms = [...(narration.summaryLines || []), ...(narration.highlights || [])].join(' ');
    for (const k of annotateGlossaryTerms(textForTerms).matchedKeys || []) addKey(k);

    return {
      vaHex,
      enrichment,
      narration,
      patchRisk,
      glossaryEntries,
    };
  }

  mountBeginnerWorkflowPanel(container, opts = {}) {
    let activeFuncVa = normalizeVaHex(opts?.activeFuncVa ?? null);
    let destroyed = false;

    const buildModel = () => {
      const { progress, starterFunctions } = this.getBeginnerAutoGuide({
        limit: opts?.limit ?? 5,
        functions: opts?.functions ?? null,
      });
      let activeCard = null;
      let patchRisk = null;
      let glossaryEntries = [];
      if (activeFuncVa) {
        const guide = this.getBeginnerFunctionGuide(activeFuncVa);
        patchRisk = guide.patchRisk;
        glossaryEntries = guide.glossaryEntries;
        const semRes = this.app?.semantic?.result || null;
        const curVa = normalizeVaHex(
          semRes?.model?.startAddress ?? semRes?.startAddress ?? semRes?.startAddr ?? this.app?.semantic?.model?.startAddress,
        );
        if (semRes && curVa === activeFuncVa) {
          activeCard = buildBeginnerFunctionCard(semRes, null, { v6Enrichment: guide.enrichment });
        } else {
          activeCard = {
            headline: guide.narration.displayName || activeFuncVa,
            whatItDoes: guide.narration.summaryLines,
            patchImpact: guide.patchRisk?.cautions?.[0] || '',
            v6Highlights: guide.narration.highlights,
            patchRisk: guide.patchRisk,
            glossaryMatches: guide.glossaryEntries.map((e) => e.key),
          };
        }
      }
      return {
        progress,
        starterFunctions,
        activeCard,
        patchRisk,
        glossaryEntries,
      };
    };

    const panelHandle = renderBeginnerWorkflowPanel(container, buildModel(), {
      doc: opts?.doc ?? null,
      onSelectFunction: opts?.onSelectFunction ?? null,
      onSelectGlossary: opts?.onSelectGlossary ?? null,
    });

    const update = () => {
      if (destroyed) return;
      panelHandle.update(buildModel());
    };

    const unsubscribe = this.subscribeAutoAnalysis(() => {
      update();
    });

    const handle = {
      update,
      setActiveFunction(funcVa) {
        if (destroyed) return;
        activeFuncVa = normalizeVaHex(funcVa);
        update();
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        unsubscribe();
        panelHandle.destroy();
        self._mountedWorkflowPanels.delete(handle);
      },
    };
    const self = this;
    this._mountedWorkflowPanels.add(handle);
    return handle;
  }

  detach() {
    this.closeActivePopover();
    this.cancelAutoAnalysis({ resetState: true });
    this._hexsigHubLoader = null;
    this._binaryKey = null;
    this.dirtyCone?.clear?.();
    this.typeTx?.clear?.();
    if (this.hexdb) {
      try {
        if (typeof this.hexdb.close === 'function') void Promise.resolve(this.hexdb.close()).catch(() => {});
      } catch {
        // Ignore close errors during detach.
      }
    }
    this._autoAnalysisState = makeInitialAutoAnalysisState(AUTO_ANALYSIS_STATUS.IDLE);
    this._autoAnalysisState.generation = this._autoGen;
    this._emitAutoAnalysisUpdate();
  }

  dispose() {
    this.detach();
    for (const handle of [...this._mountedWorkflowPanels]) {
      try { handle.destroy(); } catch { /* ignore */ }
    }
    this._mountedWorkflowPanels.clear();
    this._autoAnalysisListeners.clear();
  }
}

export function defaultHubUrls() {
  const isEmbedRoute = typeof location !== 'undefined'
    && typeof location.pathname === 'string'
    && location.pathname.startsWith('/embed/');
  const isDevRoot = typeof document !== 'undefined' && !!document.querySelector?.('script[src="./js/app.js"]');
  const prefix = isEmbedRoute ? '/' : (isDevRoot ? 'dist/' : '');
  return {
    tilManifestUrl: `${prefix}til-hub/manifest.json`,
    tilBaseUrl: `${prefix}til-hub`,
    hexsigManifestUrl: `${prefix}hexsig-hub/manifest.json`,
    hexsigBaseUrl: `${prefix}hexsig-hub`,
  };
}

export function attachV6Workbench(app, options = {}) {
  return new V6Workbench(app, options);
}
