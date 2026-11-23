'use strict';

// AArch64 ELF mapping symbols are delivered as region.dataInCode intervals.
// Keep those bytes out of every instruction-derived public worker result.
const __dicGetChunk = getChunk;
const __dicScanProgram = scanProgram;
const __dicFindXrefs = findXrefs;
const __dicGuessFunctions = guessFunctions;
const __dicRunSearch = runSearch;

function __dicRanges(region) {
  return (Array.isArray(region?.dataInCode) ? region.dataInCode : [])
    .filter((entry) => entry?.address != null && Number(entry.length) > 0)
    .map((entry) => ({ start:BigInt(entry.address), end:BigInt(entry.address) + BigInt(entry.length) }))
    .sort((a,b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
}
function __dicContains(region, address, width = 1n) {
  const start = BigInt(address), end = start + BigInt(width);
  return __dicRanges(region).some((range) => start < range.end && end > range.start);
}
function __dicCodeSpans(region, reasons = null) {
  const lo = BigInt(region.vmAddr), hi = lo + BigInt(region.size);
  const spans = [];
  let cursor = lo;
  for (const range of __dicRanges(region)) {
    const start = range.start < lo ? lo : range.start;
    const end = range.end > hi ? hi : range.end;
    if (end <= lo || start >= hi) continue;
    if (cursor < start) spans.push({ start:cursor, end:start });
    if (end > cursor) cursor = end;
  }
  if (cursor < hi) spans.push({ start:cursor, end:hi });
  for (const span of spans) {
    if (span.end - span.start < 4n && reasons && !reasons.includes('aarch64-code-span-not-word-aligned')) reasons.push('aarch64-code-span-not-word-aligned');
  }
  return spans.filter((span) => span.end - span.start >= 4n);
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
  const kinds = new Uint8Array(Math.min(words, kindCap)); // OTHER=0 is the fail-closed value.
  const calls = [], refs = [];
  let callsCapped = false, refsCapped = false, cancelledResult = false;
  const original = region;
  for (let n = 0; n < spans.length; n++) {
    const span = spans[n], delta = span.start - BigInt(original.vmAddr);
    const wordBase = Number(delta / 4n);
    const remainingKinds = Math.max(0, kinds.length - wordBase);
    const remainingCalls = Math.max(0, callCap - calls.length);
    const remainingRefs = Math.max(0, refCap - refs.length);
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
    for (let i = 0; i < Number(part.callCount || 0) && calls.length < callCap; i++) calls.push([part.callFrom[i], part.callTo[i]]);
    for (let i = 0; i < Number(part.refCount || 0) && refs.length < refCap; i++) refs.push([part.refFrom[i], part.refTo[i], part.refKind[i]]);
    for (let i = 0; i < part.kinds.length && wordBase + i < kinds.length; i++) kinds[wordBase + i] = part.kinds[i];
    callsCapped ||= part.callsCapped === true;
    refsCapped ||= part.refsCapped === true;
    for (const reason of part.completeness?.reasons || []) if (!reasons.includes(reason)) reasons.push(reason);
  }
  if (cancelledResult) return { cancelled:true, __transfer:[] };
  if (calls.length > callCap) { calls.length = callCap; callsCapped = true; if (!reasons.includes('call-edge-memory-budget')) reasons.push('call-edge-memory-budget'); }
  if (refs.length > refCap) { refs.length = refCap; refsCapped = true; if (!reasons.includes('reference-memory-budget')) reasons.push('reference-memory-budget'); }
  if (kinds.length < words && !reasons.includes('kind-stat-budget')) reasons.push('kind-stat-budget');
  const callFrom = new BigUint64Array(calls.length), callTo = new BigUint64Array(calls.length);
  for (let i = 0; i < calls.length; i++) { callFrom[i] = calls[i][0]; callTo[i] = calls[i][1]; }
  const refFrom = new BigUint64Array(refs.length), refTo = new BigUint64Array(refs.length), refKind = new Uint8Array(refs.length);
  for (let i = 0; i < refs.length; i++) { refFrom[i] = refs[i][0]; refTo[i] = refs[i][1]; refKind[i] = refs[i][2]; }
  return {
    regionId:args.regionId, vmAddr:original.vmAddr, words,
    callFrom, callTo, callCount:calls.length,
    refFrom, refTo, refKind, refCount:refs.length,
    kinds, kindsCovered:kinds.length, callsCapped, refsCapped, cancelled:false,
    complete:reasons.length===0, truncated:reasons.length>0, truncationReason:reasons[0]||null,
    completeness:{ complete:reasons.length===0, reasons },
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
    results.push(...(part.results || []));
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
