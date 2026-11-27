// C++ Multiple-Inheritance & Virtual-Inheritance `this`-adjuster Thunk Evidence Aggregator (§12.2).
// INV-005: ZERO direct imports from js/targets/architecture/ or js/targets/abi/.

export const CXX_THUNK_KIND = Object.freeze({
  NONE: 0,
  NON_VIRTUAL: 1,
  VIRTUAL: 2,
  VIRTUAL_MIXED: 3,
  COVARIANT: 4,
});

export function resolvePrimaryObjectOffset({ localOffset, offsetToTop = 0, observationOrigin }) {
  const local = Number(localOffset);
  const top = Number(offsetToTop);
  if (observationOrigin === 'non_virtual_thunk_target') {
    return {
      primaryOffset: local,
      needsRebase: false,
      doubleShiftPrevented: top !== 0,
    };
  }
  if (observationOrigin === 'secondary_base_direct_method' || observationOrigin === 'caller_base_ptr') {
    return {
      primaryOffset: local - top,
      needsRebase: top !== 0,
      doubleShiftPrevented: false,
    };
  }
  return {
    primaryOffset: local,
    needsRebase: false,
    doubleShiftPrevented: false,
  };
}

function toVaKey(va) {
  if (typeof va === 'bigint') return `0x${va.toString(16)}`;
  if (typeof va === 'number' && Number.isFinite(va)) return `0x${BigInt(Math.trunc(va)).toString(16)}`;
  if (typeof va === 'string') {
    const trimmed = va.trim();
    if (/^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(trimmed)) {
      return `0x${BigInt(trimmed).toString(16)}`;
    }
    return trimmed.toLowerCase();
  }
  return String(va);
}

export class CxxThunkEvidenceStore {
  constructor() {
    this.thunkMap = new Map();
    this.byTarget = new Map();
  }

  ingestCandidates(candidates = [], thunkPatternAdapter, opts = {}) {
    if (!thunkPatternAdapter || typeof thunkPatternAdapter.matchThunk !== 'function') {
      throw new TypeError('ingestCandidates requires an injected thunkPatternAdapter DI object');
    }
    const vtableInfoByVa = new Map();
    if (opts.vtableInfoByVa instanceof Map) {
      for (const [k, v] of opts.vtableInfoByVa.entries()) vtableInfoByVa.set(toVaKey(k), v);
    }
    const added = [];

    for (const cand of candidates) {
      const match = thunkPatternAdapter.matchThunk(cand.codeBytes, cand.va);
      if (!match || !match.kind) continue;

      const thunkKey = toVaKey(cand.va);
      const targetKey = match.targetVa !== null && match.targetVa !== undefined
        ? toVaKey(match.targetVa)
        : null;

      let resolutionState = 'resolved';
      let resolvedDelta = match.fixedDelta ?? 0;

      if (match.kind === CXX_THUNK_KIND.VIRTUAL || match.kind === CXX_THUNK_KIND.VIRTUAL_MIXED) {
        const vtInfo = cand.vtableVa !== undefined ? vtableInfoByVa.get(toVaKey(cand.vtableVa)) : null;
        if (vtInfo && vtInfo.closureProven === true && typeof vtInfo.vcallMap?.[match.vcallOffset] === 'number') {
          resolvedDelta = (match.fixedDelta ?? 0) + vtInfo.vcallMap[match.vcallOffset];
          resolutionState = 'resolved_closed_world';
        } else {
          resolutionState = 'annotation_only';
        }
      }

      const evidence = {
        thunkVa: thunkKey,
        targetVa: targetKey,
        kind: match.kind,
        arch: match.arch ?? 'unknown',
        fixedDelta: match.fixedDelta ?? 0,
        vcallOffset: match.vcallOffset ?? 0,
        resolvedDelta,
        insnCount: match.insnCount ?? 0,
        resolutionState,
        targetRunsAsPrimaryThis: match.kind === CXX_THUNK_KIND.NON_VIRTUAL,
        eligibleForPrimaryMemberIndex: match.kind === CXX_THUNK_KIND.NON_VIRTUAL && targetKey !== null,
      };

      this.thunkMap.set(thunkKey, evidence);
      if (targetKey) {
        if (!this.byTarget.has(targetKey)) this.byTarget.set(targetKey, []);
        this.byTarget.get(targetKey).push(evidence);
      }
      added.push(evidence);
    }

    return added;
  }

  getThunk(thunkVa) {
    return this.thunkMap.get(toVaKey(thunkVa)) || null;
  }

  getThunksForTarget(targetVa) {
    return this.byTarget.get(toVaKey(targetVa)) || [];
  }

  resolveTransparentTarget(funcVa) {
    const ev = this.getThunk(funcVa);
    if (!ev || !ev.targetVa) return { va: toVaKey(funcVa), throughThunk: false, evidence: null };
    if (ev.resolutionState === 'annotation_only') {
      return { va: toVaKey(funcVa), throughThunk: false, evidence: ev };
    }
    return { va: ev.targetVa, throughThunk: true, evidence: ev };
  }

  clear() {
    this.thunkMap.clear();
    this.byTarget.clear();
  }
}

export function createCxxThunkEvidenceStore() {
  return new CxxThunkEvidenceStore();
}
