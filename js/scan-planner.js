/*
 * Bit-exact chunk planner, adaptive wave scheduler, and memory-safe
 * field-by-field merger for parallel ARM64 scanProgram and scanValueShapes.
 */
import './words.js';

export const DEFAULT_PARALLEL_THRESHOLD_BYTES = 16 * 1024 * 1024;
export const PROGRAM_INDEX_BUDGET_BYTES = 96 * 1024 * 1024;
export const MAX_EDGES = 8_000_000;
export const MAX_REFS = 8_000_000;
export const MAX_KIND_WORDS = 16 * 1024 * 1024;
export const MAX_SHAPE_EVENTS = 200_000;
export const MOBILE_CHUNK_BYTES = 24 * 1024 * 1024;
export const DESKTOP_CHUNK_BYTES = 12 * 1024 * 1024;
export const MIN_PER_WORKER_WAVE_BUDGET_BYTES = 24 * 1024 * 1024;
export const PROGRAM_SPLIT_WINDOW_BYTES = 512 * 1024;
export const SHAPE_SPLIT_BACKWARD_WINDOW_BYTES = 64 * 1024;

export function isMobileDevice(env) {
  const nav = env && Object.prototype.hasOwnProperty.call(env, 'navigator')
    ? env.navigator
    : (typeof navigator !== 'undefined' ? navigator : null);
  if (!nav) return false;
  if (nav.userAgentData && nav.userAgentData.mobile === true) return true;
  const ua = String(nav.userAgent || '');
  if (/iPad|iPhone|iPod|Android|Mobile/i.test(ua)) return true;
  const platform = String(nav.platform || '');
  const maxTouchPoints = Number(nav.maxTouchPoints) || 0;
  if (maxTouchPoints > 1 && (/MacIntel/i.test(platform) || /Macintosh/i.test(ua))) return true;
  return false;
}

export function computeMaxScanWorkers(env) {
  const doc = env && Object.prototype.hasOwnProperty.call(env, 'document')
    ? env.document
    : (typeof document !== 'undefined' ? document : null);
  if (doc && doc.hidden) return 1;
  if (isMobileDevice(env)) return 2;
  const nav = env && Object.prototype.hasOwnProperty.call(env, 'navigator')
    ? env.navigator
    : (typeof navigator !== 'undefined' ? navigator : null);
  const hc = Number(nav && nav.hardwareConcurrency) || 2;
  return Math.min(4, Math.max(1, Math.floor(hc)));
}

export function computeWaveConcurrency({ remainingBudget, maxWaveWorkers, isMobile = false, hidden = false } = {}) {
  if (hidden) return 1;
  const cap = isMobile ? 2 : 4;
  let active = Math.max(1, Math.min(cap, Math.floor(Number(maxWaveWorkers) || 1)));
  const budget = Math.max(0, Math.floor(Number(remainingBudget) || 0));
  while (active > 1 && Math.floor(budget / active) < MIN_PER_WORKER_WAVE_BUDGET_BYTES) {
    active = active > 2 ? 2 : 1;
  }
  return active;
}

function targetChunkCount(alignedBytes, maxWorkers, isMobile) {
  if (isMobile || maxWorkers <= 2) {
    return Math.min(8, Math.max(2, Math.ceil(alignedBytes / MOBILE_CHUNK_BYTES)));
  }
  return Math.min(maxWorkers * 2, Math.max(2, Math.ceil(alignedBytes / DESKTOP_CHUNK_BYTES)));
}

function normalizeSortedFunctionStarts(functionStarts, regionVm, regionEndVm) {
  if (!functionStarts) return [];
  const out = [];
  const len = functionStarts.length;
  if (typeof len === 'number') {
    for (let i = 0; i < len; i++) {
      const raw = functionStarts[i];
      if (raw == null) continue;
      const v = typeof raw === 'bigint' ? raw : BigInt(raw);
      if (v >= regionVm && v < regionEndVm) out.push(v);
    }
  } else {
    for (const raw of functionStarts) {
      if (raw == null) continue;
      const v = typeof raw === 'bigint' ? raw : BigInt(raw);
      if (v >= regionVm && v < regionEndVm) out.push(v);
    }
  }
  if (out.length > 1) {
    let sorted = true;
    for (let i = 1; i < out.length; i++) {
      if (out[i] < out[i - 1]) { sorted = false; break; }
    }
    if (!sorted) out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
  return out;
}

function findNearestOffsetWithinWindow(candidates, idealOff, windowBytes) {
  if (!candidates.length) return -1;
  let lo = 0;
  let hi = candidates.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candidates[mid] < idealOff) lo = mid + 1;
    else hi = mid;
  }
  let best = -1;
  let bestDist = windowBytes + 1;
  for (const idx of [lo - 1, lo, lo + 1]) {
    if (idx < 0 || idx >= candidates.length) continue;
    const dist = Math.abs(candidates[idx] - idealOff);
    if (dist <= windowBytes && dist < bestDist) {
      bestDist = dist;
      best = candidates[idx];
    }
  }
  return best;
}

export function planProgramChunks({
  region,
  functionStarts,
  maxWorkers = 2,
  isMobile = false,
  parallelThresholdBytes = DEFAULT_PARALLEL_THRESHOLD_BYTES,
} = {}) {
  if (!region) return [];
  const regionSize = Number(region.size ?? 0);
  const words = Math.floor(regionSize / 4);
  const alignedBytes = words * 4;
  if (!Number.isSafeInteger(alignedBytes) || alignedBytes < 8) return [];
  if (regionSize < parallelThresholdBytes || maxWorkers <= 1) return [];

  const regionVm = BigInt(region.vmAddr ?? 0);
  const regionEndVm = regionVm + BigInt(regionSize);
  const alignedEndVm = regionVm + BigInt(alignedBytes);

  const allStarts = normalizeSortedFunctionStarts(functionStarts, regionVm, regionEndVm);
  if (allStarts.length === 0) return [];

  // Candidate split points must be strictly 4-byte aligned inside (regionVm, alignedEndVm).
  const splitCandidates = [];
  let prevOff = -1;
  for (let i = 0; i < allStarts.length; i++) {
    const fs = allStarts[i];
    if (fs <= regionVm || fs >= alignedEndVm) continue;
    const delta = fs - regionVm;
    if ((delta & 3n) !== 0n) continue;
    const off = Number(delta);
    if (off !== prevOff) {
      splitCandidates.push(off);
      prevOff = off;
    }
  }
  if (splitCandidates.length === 0) return [];

  const targetChunks = targetChunkCount(alignedBytes, maxWorkers, isMobile);
  const splits = [];
  let prevSplit = 0;
  for (let k = 1; k < targetChunks; k++) {
    const idealOff = Math.floor(Math.floor((alignedBytes * k) / targetChunks) / 4) * 4;
    const snapped = findNearestOffsetWithinWindow(splitCandidates, idealOff, PROGRAM_SPLIT_WINDOW_BYTES);
    if (snapped > prevSplit && snapped < alignedBytes) {
      splits.push(snapped);
      prevSplit = snapped;
    }
  }

  if (splits.length === 0) return [];

  const boundaries = [0, ...splits, alignedBytes];
  const chunks = [];
  let fnCursor = 0;

  for (let i = 0; i < boundaries.length - 1; i++) {
    const chunkStart = boundaries[i];
    const chunkEnd = boundaries[i + 1];
    const startVm = regionVm + BigInt(chunkStart);
    const endVm = regionVm + BigInt(chunkEnd);

    while (fnCursor < allStarts.length && allStarts[fnCursor] < startVm) fnCursor++;
    const sliceStart = fnCursor;
    while (fnCursor < allStarts.length && allStarts[fnCursor] < endVm) fnCursor++;
    const sliceCount = fnCursor - sliceStart;
    const chunkFunctionStarts = new BigUint64Array(sliceCount);
    for (let j = 0; j < sliceCount; j++) {
      chunkFunctionStarts[j] = allStarts[sliceStart + j];
    }

    chunks.push({
      chunkIndex: i,
      chunkStart,
      chunkEnd,
      startVm,
      endVm,
      wordBase: Math.floor(chunkStart / 4),
      words: Math.floor((chunkEnd - chunkStart) / 4),
      functionStarts: chunkFunctionStarts,
    });
  }

  return chunks;
}

export async function planShapeChunks({
  file,
  region,
  maxWorkers = 2,
  isMobile = false,
  parallelThresholdBytes = DEFAULT_PARALLEL_THRESHOLD_BYTES,
} = {}) {
  if (!file || typeof file.slice !== 'function' || !region) return [];
  const regionSize = Number(region.size ?? 0);
  const words = Math.floor(regionSize / 4);
  const alignedBytes = words * 4;
  if (!Number.isSafeInteger(alignedBytes) || alignedBytes < 8) return [];
  if (regionSize < parallelThresholdBytes || maxWorkers <= 1) return [];

  const Words = globalThis.Words;
  if (!Words) throw new Error('planShapeChunks requires Words');

  const regionFileOffset = Number(region.fileOffset ?? 0);
  const regionVm = BigInt(region.vmAddr ?? 0);
  const targetChunks = targetChunkCount(alignedBytes, maxWorkers, isMobile);

  const splits = [];
  let prevChunkStart = 0;

  for (let k = 1; k < targetChunks; k++) {
    const idealOff = Math.floor(Math.floor((alignedBytes * k) / targetChunks) / 4) * 4;
    const winEnd = Math.min(alignedBytes, idealOff);
    const winStart = Math.max(prevChunkStart, Math.floor(Math.max(0, winEnd - SHAPE_SPLIT_BACKWARD_WINDOW_BYTES) / 4) * 4);
    if (winEnd - winStart < 4) continue;

    const buf = await file.slice(regionFileOffset + winStart, regionFileOffset + winEnd).arrayBuffer();
    const byteLen = Math.floor(buf.byteLength / 4) * 4;
    if (byteLen < 4) continue;

    const dv = new DataView(buf, 0, byteLen);
    for (let off = byteLen - 4; off >= 0; off -= 4) {
      const w = dv.getUint32(off, true);
      if (Words.isBranchImm(w) || Words.isRet(w) || Words.isBr(w)) {
        const snappedStart = winStart + off + 4;
        if (snappedStart > prevChunkStart && snappedStart < alignedBytes) {
          splits.push(snappedStart);
          prevChunkStart = snappedStart;
        }
        break;
      }
    }
  }

  if (splits.length === 0) return [];

  const boundaries = [0, ...splits, alignedBytes];
  const chunks = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const chunkStart = boundaries[i];
    const chunkEnd = boundaries[i + 1];
    chunks.push({
      chunkIndex: i,
      chunkStart,
      chunkEnd,
      startVm: regionVm + BigInt(chunkStart),
      endVm: regionVm + BigInt(chunkEnd),
      wordBase: Math.floor(chunkStart / 4),
      words: Math.floor((chunkEnd - chunkStart) / 4),
    });
  }
  return chunks;
}

export function routeCrossChunkForwardTargets(chunks, stage1Results) {
  const n = chunks.length;
  const incomingSets = Array.from({ length: n }, () => new Set());
  const byIndex = new Map();
  for (let i = 0; i < stage1Results.length; i++) {
    const res = stage1Results[i];
    if (!res) continue;
    const idx = res.chunkIndex != null ? res.chunkIndex : i;
    byIndex.set(idx, res);
  }

  for (let j = 0; j < n - 1; j++) {
    const res = byIndex.get(j);
    const targets = res && res.crossChunkForwardTargets;
    if (!targets || targets.length === 0) continue;

    for (let tIdx = 0; tIdx < targets.length; tIdx++) {
      const target = typeof targets[tIdx] === 'bigint' ? targets[tIdx] : BigInt(targets[tIdx]);
      // Binary search chunks[j + 1 .. n - 1] for chunk[k].startVm <= target < chunk[k].endVm.
      let lo = j + 1;
      let hi = n - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const c = chunks[mid];
        if (target < c.startVm) {
          hi = mid - 1;
        } else if (target >= c.endVm) {
          lo = mid + 1;
        } else {
          incomingSets[mid].add(target);
          break;
        }
      }
    }
  }

  return incomingSets.map((set) => {
    if (set.size === 0) return new BigUint64Array(0);
    const arr = Array.from(set);
    if (arr.length > 1) arr.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const out = new BigUint64Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = arr[i];
    return out;
  });
}

function mergeTypedField(orderedResults, fieldName, Ctor, totalCount, countProp) {
  const out = new Ctor(totalCount);
  let cursor = 0;
  for (let i = 0; i < orderedResults.length; i++) {
    const res = orderedResults[i];
    if (!res) continue;
    const src = res[fieldName];
    const available = res[countProp] != null ? res[countProp] : (src ? src.length : 0);
    if (src && available > 0 && cursor < totalCount) {
      const take = Math.min(available, src.length, totalCount - cursor);
      if (take > 0) {
        out.set(take === src.length ? src : src.subarray(0, take), cursor);
        cursor += take;
      }
    }
    res[fieldName] = null;
  }
  return out;
}

export function mergeChunkProgramScans({
  region,
  chunks,
  chunkResults,
  kinds = null,
  callLimit,
  refLimit,
  kindLimit,
  memoryBudgetBytes = PROGRAM_INDEX_BUDGET_BYTES,
}) {
  const ordered = [...chunkResults].sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0));
  const words = Math.floor(Number(region.size) / 4);
  const capOf = (value, hard) =>
    value == null ? hard : Math.max(0, Math.min(hard, Math.floor(Number(value) || 0)));
  const globalCallCap = capOf(callLimit, MAX_EDGES);
  const globalRefCap = capOf(refLimit, MAX_REFS);
  const globalKindCap = capOf(kindLimit, MAX_KIND_WORDS);

  let totalCalls = 0;
  let totalRefs = 0;
  let anyChunkCallsLimitCapped = false;
  let anyChunkRefsLimitCapped = false;

  for (let i = 0; i < ordered.length; i++) {
    const r = ordered[i];
    totalCalls += r.callCount ?? (r.callFrom ? r.callFrom.length : 0);
    totalRefs += r.refCount ?? (r.refFrom ? r.refFrom.length : 0);
    if (r.callsLimitCapped) anyChunkCallsLimitCapped = true;
    if (r.refsLimitCapped) anyChunkRefsLimitCapped = true;
  }

  const callCount = Math.min(totalCalls, globalCallCap);
  const refCount = Math.min(totalRefs, globalRefCap);
  // Strict > matches js/worker-legacy.js:1605, 1708.
  const callsCapped = totalCalls > globalCallCap || anyChunkCallsLimitCapped;
  const refsCapped = totalRefs > globalRefCap || anyChunkRefsLimitCapped;
  const budgetCapped = ordered.some((c) => Boolean(c?.budgetCapped));

  const targetKindLen = Math.min(words, globalKindCap);
  let outKinds = kinds;
  if (!outKinds) {
    outKinds = new Uint8Array(targetKindLen);
    for (let i = 0; i < ordered.length; i++) {
      const r = ordered[i];
      if (r.kinds && r.kinds.length > 0) {
        const base = r.chunkWordBase != null
          ? r.chunkWordBase
          : (chunks && chunks[r.chunkIndex] ? chunks[r.chunkIndex].wordBase : 0);
        const take = Math.min(r.kinds.length, Math.max(0, outKinds.length - base));
        if (take > 0) {
          outKinds.set(take === r.kinds.length ? r.kinds : r.kinds.subarray(0, take), base);
        }
      }
      r.kinds = null;
    }
  } else {
    for (let i = 0; i < ordered.length; i++) ordered[i].kinds = null;
    if (outKinds.length > words) outKinds = outKinds.slice(0, words);
  }

  // Field-by-field merge, nulling each source array immediately after copying.
  const callFrom = mergeTypedField(ordered, 'callFrom', BigUint64Array, callCount, 'callCount');
  const callTo = mergeTypedField(ordered, 'callTo', BigUint64Array, callCount, 'callCount');
  const refFrom = mergeTypedField(ordered, 'refFrom', BigUint64Array, refCount, 'refCount');
  const refTo = mergeTypedField(ordered, 'refTo', BigUint64Array, refCount, 'refCount');
  const refKind = mergeTypedField(ordered, 'refKind', Uint8Array, refCount, 'refCount');

  const truncationReasons = [];
  if (callsCapped) truncationReasons.push('call-edge-memory-budget');
  if (refsCapped) truncationReasons.push('reference-memory-budget');
  if (budgetCapped) truncationReasons.push('program-index-memory-budget');
  if (outKinds.length < words) truncationReasons.push('kind-stat-budget');

  const allocatedBytes =
    callFrom.byteLength + callTo.byteLength +
    refFrom.byteLength + refTo.byteLength + refKind.byteLength +
    outKinds.byteLength;

  return {
    regionId: region.id,
    vmAddr: BigInt(region.vmAddr),
    words,
    callFrom,
    callTo,
    callCount,
    refFrom,
    refTo,
    refKind,
    refCount,
    kinds: outKinds,
    kindsCovered: Math.min(words, outKinds.length),
    callsCapped,
    refsCapped,
    budgetCapped,
    cancelled: false,
    complete: truncationReasons.length === 0,
    truncated: truncationReasons.length > 0,
    truncationReason: truncationReasons[0] || null,
    completeness: {
      complete: truncationReasons.length === 0,
      reasons: truncationReasons,
      memoryBudgetBytes,
      allocatedBytes,
    },
  };
}

export function mergeChunkShapeScans({
  region,
  chunkResults,
  maxEvents = MAX_SHAPE_EVENTS,
}) {
  const ordered = [...chunkResults].sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0));
  let totalEvents = 0;
  let anyChunkCapped = false;
  for (let i = 0; i < ordered.length; i++) {
    const r = ordered[i];
    totalEvents += r.count ?? (r.addr ? r.addr.length : 0);
    if (r.capped) anyChunkCapped = true;
  }

  const count = Math.min(totalEvents, maxEvents);
  // Exact >= match with js/worker-legacy.js:1942, 1984.
  const capped = totalEvents >= maxEvents || anyChunkCapped;

  const addr = mergeTypedField(ordered, 'addr', BigUint64Array, count, 'count');
  const disp = mergeTypedField(ordered, 'disp', Int32Array, count, 'count');
  const size = mergeTypedField(ordered, 'size', Uint8Array, count, 'count');
  const flags = mergeTypedField(ordered, 'flags', Uint8Array, count, 'count');
  const amtKind = mergeTypedField(ordered, 'amtKind', Uint8Array, count, 'count');
  const amtDisp = mergeTypedField(ordered, 'amtDisp', Int32Array, count, 'count');
  const span = mergeTypedField(ordered, 'span', Int32Array, count, 'count');
  const amtSize = mergeTypedField(ordered, 'amtSize', Uint8Array, count, 'count');
  const amtSpan = mergeTypedField(ordered, 'amtSpan', Int32Array, count, 'count');

  return {
    regionId: region.id,
    vmAddr: BigInt(region.vmAddr),
    count,
    capped,
    cancelled: false,
    addr,
    disp,
    size,
    flags,
    amtKind,
    amtDisp,
    span,
    amtSize,
    amtSpan,
  };
}
