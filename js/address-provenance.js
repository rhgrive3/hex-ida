/*
 * Control-flow-aware provenance for ARM64 ADR/ADRP address construction.
 *
 * Classic-script shape on purpose: worker-legacy.js is a classic worker, while
 * Node regression tests load this file through vm just like words.js.
 */
(function (global) {
  'use strict';

  const DEFAULT_WINDOW = 4096;
  const CALLER_SAVED_LAST = 18;
  const LINK_REGISTER = 30;

  function asBigInt(value) {
    if (value == null) return null;
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!text || !/^(?:[+-]?[0-9]+|0[xX][0-9a-fA-F]+)$/.test(text)) return null;
    try { return BigInt(text); } catch { return null; }
  }

  function create(options) {
    const opts = options || {};
    const window = Number.isFinite(Number(opts.pairWindow))
      ? Math.max(0, Math.floor(Number(opts.pairWindow)))
      : DEFAULT_WINDOW;
    const words = opts.words || global.Words;
    if (!words || !words.KIND) throw new Error('AddressProvenance requires Words');

    const pageOf = new Array(32).fill(null);
    const pageAt = new Int32Array(32);
    pageAt.fill(-1);
    // A loop-entry kill invalidates the merge state for address construction,
    // but a direct memory access at that first linear visit still observes the
    // incoming value on the preheader path.  Retain that value as an explicit,
    // short-lived fallback instead of silently dropping the memory reference.
    const entryFallbackOf = new Array(32).fill(null);
    const entryFallbackAt = new Int32Array(32);
    entryFallbackAt.fill(-1);
    // enter() advances monotonically, so normalize external boundaries once.
    const functionStarts = Array.from(opts.functionStarts || [], asBigInt)
      .filter((start) => start != null)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const startCount = functionStarts.length;
    let startIndex = 0;
    const rangeStart = asBigInt(opts.rangeStart);
    const rangeEnd = asBigInt(opts.rangeEnd);

    function inRange(target) {
      if (target == null) return false;
      if (rangeStart != null && target < rangeStart) return false;
      if (rangeEnd != null && target >= rangeEnd) return false;
      return true;
    }

    // Full branch entries are retained for the existing forward-target contract.
    const branchEntries = new Set(
      Array.from(opts.branchEntries || [], asBigInt)
        .filter((target) => target != null && inRange(target)),
    );

    // A backward edge is discovered after its target was already visited by a
    // linear scanner. The prepass can seed only the registers that may have
    // been redefined on that loop path. This is strictly more precise than
    // clearing every register at every back-edge target: unchanged bases remain
    // valid, while loop-carried clobbers fail closed on the first visit.
    const entryKills = new Map();
    for (const item of opts.entryKills || []) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const target = asBigInt(item[0]);
      if (target == null || !inRange(target)) continue;
      const regs = new Set();
      for (const value of item[1] || []) {
        const reg = Number(value);
        if (Number.isInteger(reg) && reg >= 0 && reg < 32) regs.add(reg);
      }
      if (regs.size) entryKills.set(target, regs);
    }
    let generation = 0;

    function clear() {
      pageOf.fill(null);
      pageAt.fill(-1);
      entryFallbackOf.fill(null);
      entryFallbackAt.fill(-1);
      generation++;
    }

    function invalidate(reg, preserveEntryFallback = false) {
      const r = Number(reg);
      if (!Number.isInteger(r) || r < 0 || r >= 32) return;
      pageOf[r] = null;
      pageAt[r] = -1;
      if (!preserveEntryFallback) {
        entryFallbackOf[r] = null;
        entryFallbackAt[r] = -1;
      }
    }

    function kill(reg) {
      invalidate(reg);
    }

    function note(reg, value, index) {
      const r = Number(reg), at = Number(index);
      if (!Number.isInteger(r) || r < 0 || r >= 32 || !Number.isInteger(at)) return;
      const v = asBigInt(value);
      if (v == null) { kill(r); return; }
      entryFallbackOf[r] = null;
      entryFallbackAt[r] = -1;
      pageOf[r] = v;
      pageAt[r] = at;
    }

    function base(reg, index, options) {
      const r = Number(reg), at = Number(index);
      if (!Number.isInteger(r) || r < 0 || r >= 32 || !Number.isInteger(at)) return null;
      const born = pageAt[r];
      if (born >= 0 && at >= born && at - born <= window) return pageOf[r];
      if (!options?.allowEntryFallback) return null;
      const fallbackBorn = entryFallbackAt[r];
      if (fallbackBorn < 0 || at < fallbackBorn || at - fallbackBorn > window) return null;
      return entryFallbackOf[r];
    }

    function scanIndexAt(pc) {
      if (rangeStart == null) return null;
      const delta = pc - rangeStart;
      if (delta < 0n || delta % 4n !== 0n) return null;
      const index = delta / 4n;
      return index <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(index) : null;
    }

    function markForwardEntry(target, pc) {
      if (target == null || target <= pc + 4n || !inRange(target)) return;
      branchEntries.add(target);
    }

    function enter(pcValue) {
      const pc = asBigInt(pcValue);
      if (pc == null) return false;
      let fullBoundary = false;
      while (startIndex < startCount) {
        const start = functionStarts[startIndex];
        if (start < pc) { fullBoundary = true; startIndex++; continue; }
        if (start === pc) { fullBoundary = true; startIndex++; continue; }
        break;
      }
      if (branchEntries.delete(pc)) fullBoundary = true;
      if (fullBoundary) {
        clear();
        entryKills.delete(pc);
        return true;
      }
      const kills = entryKills.get(pc);
      if (kills) {
        const scanIndex = scanIndexAt(pc);
        for (const reg of kills) {
          const r = Number(reg);
          // A complete exact address chain immediately before the target is
          // part of the first linear visit to that instruction. Preserve it
          // even when a later loop-carried path redefines the same register;
          // the ordinary #1900 case, where the base is older than the target,
          // remains fail-closed.
          if (scanIndex != null && pageOf[r] != null && pageAt[r] === scanIndex - 1) continue;
          if (Number.isInteger(r) && r >= 0 && r < 32 && pageOf[r] != null) {
            entryFallbackOf[r] = pageOf[r];
            entryFallbackAt[r] = pageAt[r];
          }
          invalidate(r, true);
        }
        entryKills.delete(pc);
        generation++;
        return true;
      }
      return false;
    }

    function killCallClobbered() {
      // AAPCS64 caller-clobbered argument/temporary registers are x0-x18.
      // BL/BLR additionally overwrite x30 architecturally with the return
      // address, so stale address provenance must never survive in LR.
      for (let reg = 0; reg <= CALLER_SAVED_LAST; reg++) kill(reg);
      kill(LINK_REGISTER);
    }

    function control(word, pcValue, kind) {
      const pc = asBigInt(pcValue);
      if (pc == null) { clear(); return { barrier: true, target: null }; }
      const K = words.KIND;
      if (kind === K.CALL || kind === K.INDCALL) {
        const target = kind === K.CALL ? words.branchImm26(word, pc) : null;
        if (kind === K.CALL) markForwardEntry(target, pc);
        killCallClobbered();
        return { barrier: false, call: true, target };
      }
      if (kind === K.CONDBR) {
        const target = words.condBranchTarget(word, pc);
        markForwardEntry(target, pc);
        return { barrier: false, conditional: true, target };
      }
      if (kind === K.BRANCH) {
        const target = words.branchImm26(word, pc);
        markForwardEntry(target, pc);
        clear();
        return { barrier: true, target };
      }
      if (kind === K.RET || kind === K.TRAP) {
        clear();
        return { barrier: true, target: null };
      }
      return { barrier: false, target: null };
    }

    return {
      enter, note, base, kill, clear, control,
      get generation() { return generation; },
      get pendingEntries() { return branchEntries.size + entryKills.size; },
      get pairWindow() { return window; },
    };
  }

  global.AddressProvenance = Object.freeze({ create, DEFAULT_WINDOW, CALLER_SAVED_LAST, LINK_REGISTER });
})(typeof globalThis !== 'undefined' ? globalThis : self);
