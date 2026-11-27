'use strict';

// AArch64 ELF mapping symbols are delivered as region.dataInCode intervals.
// Keep those bytes out of every instruction-derived public worker result.
const __dicGetChunk = getChunk;
const __dicScanProgram = scanProgram;
const __dicFindXrefs = findXrefs;
const __dicGuessFunctions = guessFunctions;
const __dicRunSearch = runSearch;

const __dicRangeCache = new WeakMap();
function __dicRanges(region) {
  const raw = region?.dataInCode;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const cached = __dicRangeCache.get(raw);
  if (cached && cached.length === raw.length) return cached.ranges;
  const sorted = raw
    .filter((entry) => entry?.address != null && Number(entry.length) > 0)
    .map((entry) => ({ start:BigInt(entry.address), end:BigInt(entry.address) + BigInt(entry.length) }))
    .sort((a,b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
  const merged = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      if (r.end > last.end) last.end = r.end;
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }
  __dicRangeCache.set(raw, { length: raw.length, ranges: merged });
  return merged;
}
function __dicContains(region, address, width = 1n) {
  const ranges = __dicRanges(region);
  if (ranges.length === 0) return false;
  const start = BigInt(address), end = start + BigInt(width);
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const range = ranges[mid];
    if (end <= range.start) hi = mid - 1;
    else if (start >= range.end) lo = mid + 1;
    else return true;
  }
  return false;
}
function __dicCodeSpans(region, reasons = null) {
  const lo = BigInt(region.vmAddr), hi = lo + BigInt(region.size);
  const rawSpans = [];
  let cursor = lo;
  for (const range of __dicRanges(region)) {
    const start = range.start < lo ? lo : range.start;
    const end = range.end > hi ? hi : range.end;
    if (end <= lo || start >= hi) continue;
    if (cursor < start) rawSpans.push({ start:cursor, end:start });
    if (end > cursor) cursor = end;
  }
  if (cursor < hi) rawSpans.push({ start:cursor, end:hi });
  const spans = [];
  for (const span of rawSpans) {
    const startDelta = span.start - lo;
    const startRem = startDelta % 4n;
    const alignedStart = startRem === 0n ? span.start : span.start + (4n - startRem);
    const endDelta = span.end - lo;
    const endRem = endDelta % 4n;
    const alignedEnd = endRem === 0n ? span.end : span.end - endRem;
    if ((startRem !== 0n || endRem !== 0n || alignedEnd - alignedStart < 4n)
        && reasons && !reasons.includes('aarch64-code-span-not-word-aligned')) {
      reasons.push('aarch64-code-span-not-word-aligned');
    }
    if (alignedEnd - alignedStart >= 4n) {
      spans.push({ start: alignedStart, end: alignedEnd });
    }
  }
  return spans;
}

getChunk = async function getChunkDataInCode(args) {
  const result = await __dicGetChunk(args);
  const region = regions.get(args.regionId);
  if (!region || !args.wantAsm || !result?.bytes?.length || !__dicRanges(region).length) return result;
  const mn = String(result.mn || '').split('\n');
  const ops = String(result.ops || '').split('\n');
  const base = region.vmAddr + BigInt(args.chunk) * BigInt(CHUNK_BYTES);
  const view = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
  for (let i = 0; i < mn.length; i++) {
    const pc = base + BigInt(i * INSN_SIZE);
    if (!__dicContains(region, pc, BigInt(INSN_SIZE))) continue;
    const off = i * INSN_SIZE;
    const word = off + 4 <= result.bytes.length ? view.getUint32(off, true) : null;
    mn[i] = '.word';
    ops[i] = word == null ? '' : `0x${word.toString(16).padStart(8, '0')}`;
  }
  return { ...result, mn:mn.join('\n'), ops:ops.join('\n') };
};

let __dicTempRegionSeq = 0;
function __dicTempRegionKey(regionId) {
  let key;
  do {
    __dicTempRegionSeq += 1;
    key = `${regionId}:__dic:${__dicTempRegionSeq}`;
  } while (regions.has(key));
  return key;
}

scanProgram = async function scanProgramDataInCode(args) {
  const region = regions.get(args.regionId);
  const reasons = [];
  const spans = region ? __dicCodeSpans(region, reasons) : [];
  if (!region || !__dicRanges(region).length) return __dicScanProgram(args);
  const words = Math.floor(Number(region.size) / 4);
  const capOf = (value, hard) => value == null ? hard : Math.max(0, Math.min(hard, Math.floor(Number(value) || 0)));
  const callCap = capOf(args.callLimit, MAX_EDGES);
  const refCap = capOf(args.refLimit, MAX_REFS);
  const kindCap = capOf(args.kindLimit, MAX_KIND_WORDS);
  const budgetBytes = (typeof PROGRAM_INDEX_BUDGET_BYTES === 'number' && Number.isFinite(PROGRAM_INDEX_BUDGET_BYTES) && PROGRAM_INDEX_BUDGET_BYTES > 0)
    ? PROGRAM_INDEX_BUDGET_BYTES
    : 96 * 1024 * 1024;
  const CALL_ENTRY_BYTES = 16;
  const REF_ENTRY_BYTES = 17;
  const kinds = new Uint8Array(Math.min(words, kindCap)); // OTHER=0 is the fail-closed value.
  const callParts = [];
  const refParts = [];
  let totalCalls = 0, totalRefs = 0;
  let usedBytes = kinds.byteLength;
  let callsCapped = false, refsCapped = false, cancelledResult = false;
  const original = region;
  const ownSlice = (typed, count) => (
    typed.length === count && typed.byteOffset === 0 && typed.byteLength === typed.buffer.byteLength
      ? typed
      : typed.slice(0, count)
  );
  for (let n = 0; n < spans.length; n++) {
    const span = spans[n];
    const delta = span.start - BigInt(original.vmAddr);
    if (delta < 0n || delta % 4n !== 0n) {
      if (!reasons.includes('aarch64-code-span-not-word-aligned')) reasons.push('aarch64-code-span-not-word-aligned');
      continue;
    }
    const wordBase = Number(delta / 4n);
    const remainingKinds = Math.max(0, kinds.length - wordBase);
    const subWords = Math.floor(Number(span.end - span.start) / 4);
    const subKindsBytes = Math.min(subWords, remainingKinds);
    const remainingDataBytes = Math.max(0, budgetBytes - usedBytes - subKindsBytes);
    const remainingCalls = Math.min(Math.max(0, callCap - totalCalls), Math.floor(remainingDataBytes / CALL_ENTRY_BYTES));
    const remainingRefs = Math.min(Math.max(0, refCap - totalRefs), Math.floor(remainingDataBytes / REF_ENTRY_BYTES));
    const sub = { ...original, fileOffset:BigInt(original.fileOffset) + delta, vmAddr:span.start, size:span.end - span.start, dataInCode:[] };
    const tempKey = __dicTempRegionKey(args.regionId);
    regions.set(tempKey, sub);
    let part;
    try {
      part = await __dicScanProgram({
        ...args,
        regionId: tempKey,
        callLimit: remainingCalls,
        refLimit: remainingRefs,
        kindLimit: remainingKinds,
      });
    } finally {
      regions.delete(tempKey);
    }
    if (part?.cancelled) { cancelledResult = true; break; }
    if (part.kinds?.length && wordBase < kinds.length) {
      const copyLen = Math.min(part.kinds.length, kinds.length - wordBase);
      if (copyLen > 0) {
        kinds.set(copyLen === part.kinds.length ? part.kinds : part.kinds.subarray(0, copyLen), wordBase);
      }
      part.kinds = null;
    }
    const partCallCount = Math.min(Number(part.callCount || 0), part.callFrom?.length || 0, part.callTo?.length || 0);
    const maxCallsByBudget = Math.floor(Math.max(0, budgetBytes - usedBytes) / CALL_ENTRY_BYTES);
    const takeCalls = Math.min(partCallCount, Math.max(0, callCap - totalCalls), maxCallsByBudget);
    if (takeCalls < partCallCount) {
      callsCapped = true;
      if (!reasons.includes('call-edge-memory-budget')) reasons.push('call-edge-memory-budget');
    }
    if (takeCalls > 0) {
      callParts.push({
        from: ownSlice(part.callFrom, takeCalls),
        to: ownSlice(part.callTo, takeCalls),
        count: takeCalls,
      });
      totalCalls += takeCalls;
      usedBytes += takeCalls * CALL_ENTRY_BYTES;
    }
    const partRefCount = Math.min(Number(part.refCount || 0), part.refFrom?.length || 0, part.refTo?.length || 0, part.refKind?.length || 0);
    const maxRefsByBudget = Math.floor(Math.max(0, budgetBytes - usedBytes) / REF_ENTRY_BYTES);
    const takeRefs = Math.min(partRefCount, Math.max(0, refCap - totalRefs), maxRefsByBudget);
    if (takeRefs < partRefCount) {
      refsCapped = true;
      if (!reasons.includes('reference-memory-budget')) reasons.push('reference-memory-budget');
    }
    if (takeRefs > 0) {
      refParts.push({
        from: ownSlice(part.refFrom, takeRefs),
        to: ownSlice(part.refTo, takeRefs),
        kind: ownSlice(part.refKind, takeRefs),
        count: takeRefs,
      });
      totalRefs += takeRefs;
      usedBytes += takeRefs * REF_ENTRY_BYTES;
    }
    callsCapped ||= part.callsCapped === true;
    refsCapped ||= part.refsCapped === true;
    for (const reason of part.completeness?.reasons || []) if (!reasons.includes(reason)) reasons.push(reason);
  }
  if (cancelledResult) return { cancelled:true, __transfer:[] };
  if (kinds.length < words && !reasons.includes('kind-stat-budget')) reasons.push('kind-stat-budget');
  let callFrom, callTo;
  if (callParts.length === 1) {
    callFrom = callParts[0].from;
    callTo = callParts[0].to;
    callParts[0] = null;
  } else {
    callFrom = new BigUint64Array(totalCalls);
    callTo = new BigUint64Array(totalCalls);
    let callOff = 0;
    for (let i = 0; i < callParts.length; i++) {
      const p = callParts[i];
      callFrom.set(p.from, callOff);
      callTo.set(p.to, callOff);
      callOff += p.count;
      callParts[i] = null;
    }
  }
  let refFrom, refTo, refKind;
  if (refParts.length === 1) {
    refFrom = refParts[0].from;
    refTo = refParts[0].to;
    refKind = refParts[0].kind;
    refParts[0] = null;
  } else {
    refFrom = new BigUint64Array(totalRefs);
    refTo = new BigUint64Array(totalRefs);
    refKind = new Uint8Array(totalRefs);
    let refOff = 0;
    for (let i = 0; i < refParts.length; i++) {
      const p = refParts[i];
      refFrom.set(p.from, refOff);
      refTo.set(p.to, refOff);
      refKind.set(p.kind, refOff);
      refOff += p.count;
      refParts[i] = null;
    }
  }
  return {
    regionId:args.regionId, vmAddr:original.vmAddr, words,
    callFrom, callTo, callCount:totalCalls,
    refFrom, refTo, refKind, refCount:totalRefs,
    kinds, kindsCovered:kinds.length, callsCapped, refsCapped, cancelled:false,
    complete:reasons.length===0, truncated:reasons.length>0, truncationReason:reasons[0]||null,
    completeness:{ complete:reasons.length===0, reasons, memoryBudgetBytes:budgetBytes, allocatedBytes:usedBytes },
    __transfer:[callFrom.buffer,callTo.buffer,refFrom.buffer,refTo.buffer,refKind.buffer,kinds.buffer],
  };
};

findXrefs = async function findXrefsDataInCode(args) {
  const region = regions.get(args.regionId);
  const spans = region ? __dicCodeSpans(region) : [];
  if (!region || !__dicRanges(region).length) return __dicFindXrefs(args);
  const original = region, results = [], cap = Math.min(Number(args.limit) || 2000, 2000);
  for (const span of spans) {
    const delta = span.start - BigInt(original.vmAddr);
    if (delta < 0n || delta % 4n !== 0n) continue;
    const rowBaseBig = delta / 4n;
    const rowBase = Number(rowBaseBig);
    const sub = { ...original, fileOffset:BigInt(original.fileOffset)+delta, vmAddr:span.start, size:span.end-span.start, dataInCode:[] };
    const tempKey = __dicTempRegionKey(args.regionId);
    regions.set(tempKey, sub);
    let part;
    try {
      part = await __dicFindXrefs({ ...args, regionId: tempKey, limit:Math.max(0, cap-results.length) });
    } finally {
      regions.delete(tempKey);
    }
    if (part?.cancelled) return { results, cancelled:true, capped:false };
    for (const entry of part?.results || []) {
      if (entry && typeof entry.row === 'number') {
        results.push({ ...entry, row: entry.row + rowBase });
      } else if (entry && typeof entry.row === 'bigint') {
        results.push({ ...entry, row: entry.row + rowBaseBig });
      } else {
        results.push(entry);
      }
    }
    if (results.length >= cap) break;
  }
  return { results:results.slice(0,cap), cancelled:false, capped:results.length>=cap };
};

guessFunctions = async function guessFunctionsDataInCode(args) {
  const result = await __dicGuessFunctions(args);
  const region = regions.get(args.regionId);
  const isTyped = result?.starts instanceof BigUint64Array;
  if (!region || !__dicRanges(region).length || !(Array.isArray(result?.starts) || isTyped)) return result;
  const authoritative = new Set(functionStartsForRegion(region).map((value)=>BigInt(value)));
  const dataTargets = new Set();
  for (const range of __dicRanges(region)) {
    const startOff = Number(range.start - BigInt(region.vmAddr));
    const endOff = Number(range.end - BigInt(region.vmAddr));
    if (!Number.isSafeInteger(startOff) || !Number.isSafeInteger(endOff) || endOff <= startOff) continue;
    try {
      const bytes = await readRange(BigInt(region.fileOffset) + BigInt(startOff), endOff-startOff);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let off=0; off+4<=bytes.length; off+=4) {
        const pc=range.start+BigInt(off), word=view.getUint32(off,true);
        if (Words.isCallImm(word) || Words.isBranchImm(word)) {
          const target=Words.branchImm26(word,pc); if (target!=null) dataTargets.add(target);
        }
      }
    } catch { /* result filtering remains fail-closed without the optional target audit */ }
  }
  const ends = new Set(__dicRanges(region).map((range)=>range.end));
  const keep = (address) => {
    const value = BigInt(address);
    if (authoritative.has(value)) return true;
    return !__dicContains(region, value, 4n) && !ends.has(value) && !dataTargets.has(value);
  };
  if (isTyped) {
    const kept = [];
    for (let i = 0; i < result.starts.length; i++) {
      const value = result.starts[i];
      if (keep(value)) kept.push(value);
    }
    const filtered = new BigUint64Array(kept);
    const oldBuf = result.starts.buffer;
    const transfer = Array.isArray(result.__transfer)
      ? result.__transfer.map((buf) => (buf === oldBuf ? filtered.buffer : buf))
      : [filtered.buffer];
    return { ...result, starts: filtered, __transfer: transfer };
  }
  return { ...result, starts: result.starts.filter(keep) };
};

runSearch = async function runSearchDataInCode(args) {
  const result = await __dicRunSearch(args);
  const region = regions.get(args?.regionId);
  if (!region || args?.kind !== 'asm' || !Array.isArray(result?.results) || !__dicRanges(region).length) return result;
  return { ...result, results:result.results.filter((entry)=>entry?.addr==null || !__dicContains(region,entry.addr,BigInt(INSN_SIZE))) };
};
