// Cross-function Slice Service with session binding, freshness checks, and cancellation (§13.1).
// INV-005: ZERO direct imports from js/targets/architecture/ or js/targets/abi/.

import { runCrossFuncSlice, CROSS_SLICE_HARD_BUDGET } from './cross-func-slice.js';

export class SliceService {
  constructor(opts = {}) {
    this._intraAdapters = new Map();
    if (opts.intraAdapters) {
      for (const [arch, adapter] of Object.entries(opts.intraAdapters)) {
        this._intraAdapters.set(arch, adapter);
      }
    }
    this._session = null;
    this._activeAbort = null;
  }

  /**
   * Register an architecture-specific intra-function slice DI adapter.
   */
  registerIntraAdapter(archName, adapter) {
    if (!archName || !adapter || typeof adapter.sliceIntra !== 'function') {
      throw new TypeError('registerIntraAdapter requires (archName, { sliceIntra })');
    }
    this._intraAdapters.set(String(archName), adapter);
  }

  getIntraAdapter(archName) {
    return this._intraAdapters.get(String(archName)) || null;
  }

  /**
   * Check whether the retained slice session is still fresh against the current analysis binding (§13.1).
   */
  isSessionFresh(currentBinding) {
    if (!this._session || !currentBinding) return false;
    const b = this._session.binding;
    return (
      b.epoch === currentBinding.epoch
      && b.sliceIndex === currentBinding.sliceIndex
      && b.symbolsGen === currentBinding.symbolsGen
      && b.recoveredTypesRevision === currentBinding.recoveredTypesRevision
    );
  }

  getSession() {
    return this._session;
  }

  /**
   * Execute a backward or forward cross-function slice and retain it in `sliceSession`.
   */
  executeSlice({ program, seed, direction = 'backward', arch = null, binding = null, budget = null, signal = null }) {
    if (this._activeAbort) {
      this._activeAbort.abort('superseded');
    }
    const controller = new AbortController();
    this._activeAbort = controller;

    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }

    const intraSliceAdapter = arch ? this.getIntraAdapter(arch) : null;
    const result = runCrossFuncSlice(program, seed, {
      direction,
      intraSliceAdapter,
      budget: budget || CROSS_SLICE_HARD_BUDGET,
      signal: controller.signal,
    });

    this._session = {
      binding: binding ? {
        epoch: binding.epoch ?? 0,
        sliceIndex: binding.sliceIndex ?? 0,
        symbolsGen: binding.symbolsGen ?? 0,
        recoveredTypesRevision: binding.recoveredTypesRevision ?? 0,
      } : { epoch: 0, sliceIndex: 0, symbolsGen: 0, recoveredTypesRevision: 0 },
      arch,
      result,
      createdAt: Date.now(),
    };

    if (this._activeAbort === controller) {
      this._activeAbort = null;
    }

    return result;
  }

  /**
   * Clear slice session on `forgetSemantics(true)` and cancel any active slice.
   */
  forgetSemantics() {
    if (this._activeAbort) {
      this._activeAbort.abort('forget_semantics');
      this._activeAbort = null;
    }
    this._session = null;
  }
}

export function createSliceService(opts = {}) {
  return new SliceService(opts);
}
