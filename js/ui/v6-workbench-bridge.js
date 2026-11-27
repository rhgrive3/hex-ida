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
import { ManualSegmentMap } from '../analysis/recovery/manual-segment-map.js';
import { FuncChunkTable } from '../analysis/recovery/func-chunk-table.js';
import { CustomAbiStore } from '../analysis/recovery/custom-abi-spec.js';
import { StackSlotOverrideRegistry } from '../analysis/recovery/stack-slot-override.js';
import { ShiftedPtrRegistry } from '../analysis/recovery/shifted-ptr-spec.js';
import { HexSigIndex } from '../analysis/signature/hex-sig-index.js';
import { DeobfOverlayStore } from '../analysis/deobf/deobf-overlay-store.js';
import { SliceService } from '../analysis/slicing/slice-service.js';
import { JevQueryOverlay } from '../analysis/query/jev-overlay.js';
import { createTypeEditPopoverController, renderTypeEditPopover } from './type-edit-popover.js';
import { createSlicePanelController, renderSlicePanel } from './slice-panel.js';
import { createExportInteropController, renderExportInteropModal } from './export-interop.js';
import { createManualRecoveryPopoverController, renderManualRecoveryPopover } from './manual-recovery-popover.js';
import { refineAppleSwiftDecompile } from '../decompiler/apple-arc-swift-pass.js';

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

    this._activePopoverCleanup = null;
    this._activePopoverKind = null;
    this._binaryKey = null;
    this._idleTimer = null;
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
