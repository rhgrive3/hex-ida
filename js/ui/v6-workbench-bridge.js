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
import { TilLiteResolver } from '../analysis/types/core/til-lite-resolver.js';
import { TilPackManager } from '../analysis/types/core/til-pack-manager.js';
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

function normalizeVaHex(va) {
  if (va == null) return null;
  if (typeof va === 'bigint') return va >= 0n ? `0x${va.toString(16)}` : null;
  if (typeof va === 'number') {
    if (!Number.isSafeInteger(va) || va < 0) return null;
    return `0x${va.toString(16)}`;
  }
  if (typeof va === 'string') {
    const t = va.trim();
    if (!t) return null;
    try {
      const b = BigInt(t);
      return b >= 0n ? `0x${b.toString(16)}` : null;
    } catch {
      return null;
    }
  }
  return null;
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
    this.tilPackManager = new TilPackManager({ resolver: this.tilResolver });
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

    this._hexsigHubLoader = options.hexsigHubLoader || null;
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

    let cffResult = null;
    let cffRecovered = false;
    if (cfg && typeof cfg === 'object') {
      cffResult = unflattenCffIr(cfg, passOpts);
      cffRecovered = cffResult?.statusCode === CFF_STATUS.RECOVERED;
    }

    const mbaResults = [];
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
            this.deobfOverlay.setAnnotation({
              insnVa: nodeVa,
              kind: DEOBF_RECORD_KIND.LOOP_DEOBF,
              source: 'bounded_abstract_vm',
              text: `MBA simplified (${res.stage || res.engine}, cost ${res.origCost ?? '?'}->${res.newCost ?? '?'})`,
            });
          }
        }
      }
    }

    let overlayCount = 0;
    const summaryParts = [];
    if (cffRecovered) {
      summaryParts.push(`CFF recovered (real=${cffResult.stats?.realBlocks ?? 0}, spine=${cffResult.stats?.spineBlocks ?? 0})`);
    }
    if (simplifiedCount > 0) {
      summaryParts.push(`MBA simplified (${simplifiedCount}/${mbaResults.length}, -${nodesEliminated} cost)`);
    }

    if (vaHex && summaryParts.length > 0) {
      const wrote = this.deobfOverlay.setAnnotation({
        insnVa: vaHex,
        kind: DEOBF_RECORD_KIND.LOOP_DEOBF,
        source: 'bounded_abstract_vm',
        text: summaryParts.join(' + '),
      });
      if (wrote) overlayCount++;
    }
    for (const r of mbaResults) {
      if (r.simplified && r.insnVa && r.insnVa !== vaHex) overlayCount++;
    }

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
    };

    if (vaHex) {
      this._deobfSummaries.set(vaHex, summary);
    }

    return summary;
  }

  recognizeStlPattern(input = {}) {
    const safeInput = input && typeof input === 'object' ? input : {};
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

    const result = this.stlRecognizer.recognize(funcKey, normalizedInput);
    if (vaHex) {
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

    this._wasmAnalysis = wasmAnalysis;
    this._wasmIndex = {
      rmwHits,
      x86RmwHits,
      vtables: vtableList,
      jumpTables: jumpTableList,
      constTables: constTableList,
      objcSwift,
      xrefByFunc,
      vtablesByFunc,
      rmwCountByFunc,
      jumpTablesByFunc,
      callgraphByFunc,
      textVa: toBigIntVa(wasmAnalysis.textVa),
    };

    const objcSwiftSections = Array.isArray(objcSwift?.sectionsScanned) ? objcSwift.sectionsScanned.length : 0;
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
      },
    };
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
      deobfOverlay: {
        hasOverlay: Boolean(overlayAnnotation || overlaySummary),
        annotation: overlayAnnotation,
        summary: overlaySummary,
      },
      stl,
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
    const mounted = renderFn(controller, {
      document: doc,
      container,
      onClose: () => {
        if (this._activePopoverKind === kind) {
          this._activePopoverCleanup = null;
          this._activePopoverKind = null;
        }
      },
      ...options,
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

  exportV2DeltaFields() {
    const segments = typeof this.manualSegments.list === 'function'
      ? this.manualSegments.list().map((s) => ({
        startVa: normalizeVaHex(s.startVa ?? s.baseVa) || '0x0',
        size: Number(s.size ?? 0),
        fileOffset: Number(s.fileOffset ?? 0),
        kind: s.kind ?? 0,
        flags: s.flags ?? 0,
        name: s.name || '',
      }))
      : [];
    const chunks = typeof this.funcChunks.list === 'function'
      ? this.funcChunks.list().map((c) => ({
        ownerVa: normalizeVaHex(c.ownerVa ?? c.ownerFnVa) || '0x0',
        startVa: normalizeVaHex(c.startVa) || '0x0',
        endVa: normalizeVaHex(c.endVa) || '0x0',
        kind: c.kind ?? c.chunkKind ?? 0,
        flags: c.flags ?? 0,
      }))
      : [];
    const customAbis = typeof this.customAbis.list === 'function'
      ? this.customAbis.list().map((a) => ({ ...a }))
      : [];
    const stackSlotOverrides = typeof this.stackOverrides.list === 'function'
      ? this.stackOverrides.list().map((o) => ({ ...o }))
      : [];
    const shiftedPtrs = typeof this.shiftedPtrs.list === 'function'
      ? this.shiftedPtrs.list().map((p) => ({ ...p }))
      : [];

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

    if (typeof this.manualSegments.clear === 'function') this.manualSegments.clear();
    if (Array.isArray(delta.manualSegments) && typeof this.manualSegments.add === 'function') {
      for (const seg of delta.manualSegments) {
        if (!seg || typeof seg !== 'object') continue;
        try {
          this.manualSegments.add(seg);
        } catch {
          // Ignore malformed persisted segment entries.
        }
      }
    }

    if (typeof this.funcChunks.clear === 'function') this.funcChunks.clear();
    if (Array.isArray(delta.funcChunks) && typeof this.funcChunks.add === 'function') {
      for (const chunk of delta.funcChunks) {
        if (!chunk || typeof chunk !== 'object') continue;
        try {
          this.funcChunks.add(chunk);
        } catch {
          // Ignore malformed persisted chunk entries.
        }
      }
    }

    if (typeof this.customAbis.clear === 'function') this.customAbis.clear();
    const abiItems = Array.isArray(delta.customAbis)
      ? delta.customAbis
      : (delta.customAbis && typeof delta.customAbis === 'object' ? Object.values(delta.customAbis) : []);
    if (typeof this.customAbis.set === 'function') {
      for (const abi of abiItems) {
        if (!abi || typeof abi !== 'object') continue;
        try {
          this.customAbis.set(abi.fnVa ?? abi.funcVa, abi);
        } catch {
          // Ignore malformed persisted ABI entries.
        }
      }
    }

    if (typeof this.stackOverrides.clear === 'function') this.stackOverrides.clear();
    const stackItems = Array.isArray(delta.stackSlotOverrides)
      ? delta.stackSlotOverrides
      : (delta.stackSlotOverrides && typeof delta.stackSlotOverrides === 'object' ? Object.values(delta.stackSlotOverrides) : []);
    if (typeof this.stackOverrides.set === 'function') {
      for (const ov of stackItems) {
        if (!ov || typeof ov !== 'object') continue;
        try {
          this.stackOverrides.set(ov.fnVa ?? ov.funcVa, ov);
        } catch {
          // Ignore malformed persisted stack override entries.
        }
      }
    }

    if (typeof this.shiftedPtrs.clear === 'function') this.shiftedPtrs.clear();
    const shiftedItems = Array.isArray(delta.shiftedPtrs)
      ? delta.shiftedPtrs
      : (delta.shiftedPtrs && typeof delta.shiftedPtrs === 'object' ? Object.values(delta.shiftedPtrs) : []);
    if (typeof this.shiftedPtrs.set === 'function') {
      for (const sp of shiftedItems) {
        if (!sp || typeof sp !== 'object') continue;
        try {
          this.shiftedPtrs.set(sp.fnVa ?? sp.funcVa ?? sp.key, sp);
        } catch {
          // Ignore malformed persisted shifted-ptr entries.
        }
      }
    }
  }

  onBinaryReady(fingerprint) {
    if (!fingerprint || typeof fingerprint !== 'object') return;
    const key = [
      String(fingerprint.sha256 || fingerprint.prefix || fingerprint.name || 'unknown'),
      String(fingerprint.sliceIndex ?? ''),
      String(fingerprint.uuid || fingerprint.architecture || ''),
    ].join('|');
    this._binaryKey = key;
    if (this._idleTimer != null) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    // Deferred idle activation so loaderOpenLatency overhead is strictly +0 ms.
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (this._binaryKey !== key) return;
      try {
        if (!this.hexdb) this.hexdb = this._hexdbFactory();
        if (typeof this.hexdb.open === 'function') {
          void Promise.resolve(this.hexdb.open(key)).catch(() => {});
        }
      } catch {
        // Non-fatal fallback to in-memory analysis.
      }
    }, 0);
    if (typeof this._idleTimer?.unref === 'function') this._idleTimer.unref();
  }

  detach() {
    this.closeActivePopover();
    this._binaryKey = null;
    if (this._idleTimer != null) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    this.deobfOverlay?.clear?.();
    this.dirtyCone?.clear?.();
    this.typeTx?.clear?.();
    this.stlRecognizer?.clear?.();
    this._deobfSummaries.clear();
    this._stlByFunc.clear();
    this._mountedHexSigPacks.clear();
    this._wasmAnalysis = null;
    this._wasmIndex = null;
    if (this.hexdb) {
      try {
        if (typeof this.hexdb.close === 'function') void Promise.resolve(this.hexdb.close()).catch(() => {});
      } catch {
        // Ignore close errors during detach.
      }
    }
  }
}

export function attachV6Workbench(app, options = {}) {
  return new V6Workbench(app, options);
}
