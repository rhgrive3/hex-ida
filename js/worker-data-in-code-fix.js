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
function __dicCodeSpans(region) {
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

scanProgram = async function scanProgramDataInCode(args) {
  const region = regions.get(args.regionId);
  const spans = region ? __dicCodeSpans(region) : [];
  if (!region || !__dicRanges(region).length) return __dicScanProgram(args);
  const words = Math.floor(Number(region.size) / 4);
  const kinds = new Uint8Array(words); // OTHER=0 is the fail-closed value.
  const calls = [], refs = [];
  const reasons = [];
  let callsCapped = false, refsCapped = false, cancelledResult = false;
  const original = region;
  try {
    for (let n = 0; n < spans.length; n++) {
      const span = spans[n], delta = span.start - BigInt(original.vmAddr);
      const sub = { ...original, fileOffset:BigInt(original.fileOffset) + delta, vmAddr:span.start, size:span.end - span.start, dataInCode:[] };
      regions.set(args.regionId, sub);
      const part = await __dicScanProgram(args);
      if (part?.cancelled) { cancelledResult = true; break; }
      for (let i = 0; i < Number(part.callCount || 0); i++) calls.push([part.callFrom[i], part.callTo[i]]);
      for (let i = 0; i < Number(part.refCount || 0); i++) refs.push([part.refFrom[i], part.refTo[i], part.refKind[i]]);
      const wordBase = Number(delta / 4n);
      for (let i = 0; i < part.kinds.length && wordBase + i < kinds.length; i++) kinds[wordBase + i] = part.kinds[i];
      callsCapped ||= part.callsCapped === true;
      refsCapped ||= part.refsCapped === true;
      for (const reason of part.completeness?.reasons || []) if (!reasons.includes(reason)) reasons.push(reason);
    }
  } finally { regions.set(args.regionId, original); }
  if (cancelledResult) return { cancelled:true, __transfer:[] };
  const callCap = args.callLimit == null ? MAX_EDGES : Math.max(0, Math.min(MAX_EDGES, Math.floor(Number(args.callLimit) || 0)));
  const refCap = args.refLimit == null ? MAX_REFS : Math.max(0, Math.min(MAX_REFS, Math.floor(Number(args.refLimit) || 0)));
  if (calls.length > callCap) { calls.length = callCap; callsCapped = true; if (!reasons.includes('call-edge-memory-budget')) reasons.push('call-edge-memory-budget'); }
  if (refs.length > refCap) { refs.length = refCap; refsCapped = true; if (!reasons.includes('reference-memory-budget')) reasons.push('reference-memory-budget'); }
  const callFrom = new BigUint64Array(calls.map((x)=>x[0])), callTo = new BigUint64Array(calls.map((x)=>x[1]));
  const refFrom = new BigUint64Array(refs.map((x)=>x[0])), refTo = new BigUint64Array(refs.map((x)=>x[1])), refKind = new Uint8Array(refs.map((x)=>x[2]));
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
  try {
    for (const span of spans) {
      const delta = span.start - BigInt(original.vmAddr);
      regions.set(args.regionId, { ...original, fileOffset:BigInt(original.fileOffset)+delta, vmAddr:span.start, size:span.end-span.start, dataInCode:[] });
      const part = await __dicFindXrefs({ ...args, limit:Math.max(0, cap-results.length) });
      if (part?.cancelled) return { results, cancelled:true, capped:false };
      results.push(...(part.results || []));
      if (results.length >= cap) break;
    }
  } finally { regions.set(args.regionId, original); }
  return { results:results.slice(0,cap), cancelled:false, capped:results.length>=cap };
};

guessFunctions = async function guessFunctionsDataInCode(args) {
  const result = await __dicGuessFunctions(args);
  const region = regions.get(args.regionId);
  if (!region || !__dicRanges(region).length || !Array.isArray(result?.starts)) return result;
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
  return { ...result, starts:result.starts.filter((address) => {
    const value=BigInt(address);
    if (authoritative.has(value)) return true;
    return !__dicContains(region,value,4n) && !ends.has(value) && !dataTargets.has(value);
  }) };
};

runSearch = async function runSearchDataInCode(args) {
  const result = await __dicRunSearch(args);
  const region = regions.get(args?.regionId);
  if (!region || args?.kind !== 'asm' || !Array.isArray(result?.results) || !__dicRanges(region).length) return result;
  return { ...result, results:result.results.filter((entry)=>entry?.addr==null || !__dicContains(region,entry.addr,BigInt(INSN_SIZE))) };
};
