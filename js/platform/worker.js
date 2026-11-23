import { asByteSource, detectBinary, openBinarySource, parseMachOSource } from '../binary/index.js';
import { CachedByteSource } from '../bytesource/cached.js';
import { describeBinaryImage } from './describe.js';
import { fingerprintVendors } from '../knowledge/index.js';
import { hashByteSource } from './hash.js';
import { IncrementalSha256 } from '../cache/content-identity.js';
import { compileBytePattern } from './byte-search.js';
import { boundedOffset, checkedChunkIndex, chunkLength, exactExternalInteger, regionSize, utf8Len, isExactFunctionSeed } from './worker-validation.js';
import { analysisFromBinaryImage, emptyAnalysis } from './analysis-result.js';
import { analyzeDecodedSemanticFunction, releaseDecoderRevalidationWorker } from '../targets/architecture/x86_64/semantic-function.js';
import { analyzeSemanticFunction } from '../analysis/semantic-function.js';
import { resolveMachOPointer } from '../binary/macho-dyld.js';

const ROW_BYTES = 4;
const CHUNK_ROWS = 1024;
const CHUNK_BYTES = CHUNK_ROWS * ROW_BYTES;
const SCAN_BLOCK = 256 * 1024;
const SEARCH_LIMIT = 1000;
const STRINGS_LIMIT = 500_000;
const MAX_STRING_CHARS = 400;
const SUBTLE_SHA256_MAX_BYTES = 64 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: false });

let file = null;
let source = null;
let image = null;
let descriptor = null;
let regions = new Map();
let vmRegionIndex = [];
let vmRegionList = [];
let vmRegionIndexDisjoint = true;
let pointerImages = new Map();
let currentEpoch = 0;
let openChain = Promise.resolve();
const active = new Map();
const scheduled = new Set();
const foregroundWaiters = new Set();

function hasActiveForeground(epoch) {
  for (const entry of active.values()) {
    if (entry.epoch === epoch && entry.priority !== 'background') return true;
  }
  return false;
}

function notifyForegroundWaiters() {
  if (!foregroundWaiters.size) return;
  const waiters = [...foregroundWaiters];
  foregroundWaiters.clear();
  for (const wake of waiters) wake();
}

function isNonAllocableRegion(region) {
  if (!region) return true;
  if (region.alloc === true) return false;
  if (region.alloc === false || region.source === 'unmapped-section') return true;
  if (region.source === 'section-header' && region.flags != null) {
    return (BigInt(region.flags) & 0x2n) === 0n;
  }
  if (image?.format === 'elf' && region.kind === 'section' && Array.isArray(image.sections)) {
    const start = BigInt(region.vmAddr ?? 0);
    const size = BigInt(region.size ?? 0);
    const fileOffset = BigInt(region.fileOffset ?? 0);
    const matched = image.sections.find((sec) =>
      sec?.name === region.name
      && BigInt(sec.address ?? 0) === start
      && BigInt(sec.fileOffset ?? 0) === fileOffset
      && BigInt(sec.fileSize ?? sec.size ?? 0) === size);
    if (matched) {
      if (matched.source === 'unmapped-section') return true;
      if (matched.source === 'section-header') return (BigInt(matched.flags || 0) & 0x2n) === 0n;
    }
  }
  if (region.kind === 'section' && region.read === false && region.write === false && region.exec === false) {
    return true;
  }
  if (region.kind === 'section' && BigInt(region.vmAddr ?? 0) === 0n
    && region.read !== true && region.write !== true && region.exec !== true) {
    const name = String(region.section || region.name || '');
    if (/^\.(?:symtab|strtab|shstrtab|comment|debug(?:_|$)|gnu_debug|note\.)/i.test(name)) {
      return true;
    }
  }
  return false;
}

function rebuildVmRegionIndex() {
  const list = [];
  for (const region of regions.values()) {
    if (!region || region.id === 'raw' || region.zerofill) continue;
    if (isNonAllocableRegion(region)) continue;
    const start = BigInt(region.vmAddr);
    const size = BigInt(region.size);
    if (size <= 0n) continue;
    list.push({ start, end: start + size, fileOffset: BigInt(region.fileOffset), region });
  }
  vmRegionList = list;
  const sorted = [...list].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  let disjoint = true;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) { disjoint = false; break; }
  }
  vmRegionIndex = sorted;
  vmRegionIndexDisjoint = disjoint;
}

function selectedFatSliceIndex(binaryImage) {
  const fat = binaryImage?.metadata?.fat;
  const selected = fat?.selected;
  const slices = fat?.slices;
  if (!selected || !Array.isArray(slices)) return -1;
  return slices.findIndex((slice) =>
    BigInt(slice.offset) === BigInt(selected.offset)
    && BigInt(slice.size) === BigInt(selected.size)
    && slice.cpu === selected.cpu
    && slice.subtype === selected.subtype);
}
async function waitForForegroundDrain(epoch, { scheduledEntry = null, signal = null } = {}) {
  // Background metadata performs many small paged reads. Do not enqueue the
  // next page while any interactive request for the same binary epoch is live.
  // A currently executing page is bounded, so foreground work is never held
  // behind an unbounded metadata scan. Exit early on cancellation or epoch change.
  while (
    epoch === currentEpoch
    && !scheduledEntry?.cancelled
    && !signal?.aborted
    && hasActiveForeground(epoch)
  ) {
    await new Promise((resolve) => {
      const wake = () => {
        foregroundWaiters.delete(wake);
        signal?.removeEventListener?.('abort', wake);
        resolve();
      };
      foregroundWaiters.add(wake);
      signal?.addEventListener?.('abort', wake, { once: true });
      if (
        epoch !== currentEpoch
        || scheduledEntry?.cancelled
        || signal?.aborted
        || !hasActiveForeground(epoch)
      ) {
        wake();
      }
    });
  }
}

function cancellationMatches(msg, entry) {
  return (msg.requestId == null || msg.requestId === entry.id)
    && (msg.epoch == null || msg.epoch === entry.epoch);
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (!msg || typeof msg.t !== 'string') return;
  if (msg.t === 'cancel') {
    for (const entry of scheduled) {
      if (cancellationMatches(msg, entry)) entry.cancelled = true;
    }
    for (const entry of active.values()) {
      if (cancellationMatches(msg, entry)) entry.controller.abort();
    }
    notifyForegroundWaiters();
    return;
  }
  const serialized = msg.t === 'open' || msg.t === 'detect';
  if (serialized) {
    currentEpoch = msg.epoch;
    for (const entry of active.values()) if (entry.epoch !== currentEpoch) entry.controller.abort();
    notifyForegroundWaiters();
  }
  const scheduledEntry = { id:msg.id, epoch:msg.epoch, cancelled:false };
  scheduled.add(scheduledEntry);
  const execute = async () => {
    if (msg.epoch !== currentEpoch) throw new Error('Stale platform request.');
    if (scheduledEntry.cancelled) throw new Error('Platform request cancelled.');
    const priority = msg.priority === 'background' ? 'background' : 'current';
    if (priority === 'background') await waitForForegroundDrain(msg.epoch, { scheduledEntry });
    if (msg.epoch !== currentEpoch) throw new Error('Stale platform request.');
    if (scheduledEntry.cancelled) throw new Error('Platform request cancelled.');
    const controller = new AbortController();
    const requestKey = msg.id == null ? null : `${msg.epoch}:${msg.id}`;
    if (requestKey != null && active.has(requestKey)) throw new Error(`Duplicate active request id ${msg.id} for epoch ${msg.epoch}.`);
    if (requestKey != null) active.set(requestKey, { id: msg.id, epoch: msg.epoch, controller, priority });
    try { return await handle(msg, controller.signal); }
    finally {
      if (requestKey != null && active.get(requestKey)?.controller === controller) {
        active.delete(requestKey);
        if (priority !== 'background') notifyForegroundWaiters();
      }
    }
  };
  try {
    const result = serialized ? openChain.then(execute, execute) : openChain.then(execute);
    if (serialized) openChain = result.then(() => undefined, () => undefined);
    const resolved = await result.finally(() => scheduled.delete(scheduledEntry));
    post({ t: 'ok', id: msg.id, epoch: msg.epoch, result: resolved }, resolved?.__transfer);
  } catch (error) {
    post({ t: 'err', id: msg.id, epoch: msg.epoch, error: error?.message || String(error) });
  }
};

function post(message, transfer) {
  if (message.result) delete message.result.__transfer;
  if (transfer?.length) self.postMessage(message, transfer);
  else self.postMessage(message);
}

function progress(msg, phase, done, total, extra = {}) {
  self.postMessage({ t: 'analysisProgress', requestId: msg.id, epoch: msg.epoch, phase, done, total, ...extra });
}

async function handle(msg, signal) {
  switch (msg.t) {
    case 'detect': return detectFile(msg, signal);
    case 'open': return openFile(msg, signal);
    case 'setRegions': return setRegions(msg.regions);
    case 'chunk': return getChunk(msg, signal);
    case 'analyze': return analyzeImage(msg, signal);
    case 'semanticFunction': {
      const scoped = msg.scopedCanonicalProjection === true || msg.scopedLocalProjection != null;
      if (msg.scopedCanonicalProjection != null && typeof msg.scopedCanonicalProjection !== 'boolean') {
        throw new TypeError('scoped-canonical-projection-flag');
      }
      // Other architectures preserve their original route and defaults.
      if (scoped && msg.input?.architecture !== 'arm64') throw new TypeError('scoped-local-arm64-required');
      const rangeRequest = ['ranges', 'range-values'].includes(msg.scopedLocalProjection?.kind);
      const flowRequest = msg.scopedLocalProjection?.kind === 'flow-inputs';
      const demandRequest = msg.scopedLocalProjection?.kind === 'demand';
      const transformRequest = msg.scopedLocalProjection?.kind === 'transforms';
      let canonicalOwner = null;
      const pending = scoped
        ? analyzeSemanticFunction(msg.input, { signal, canonicalProjectionOnly: true,
          ...(rangeRequest || flowRequest || demandRequest || transformRequest ? { captureCanonicalOwner: (owner) => { canonicalOwner = owner; } } : {}) })
        : analyzeDecodedSemanticFunction(msg.input, { signal });
      if (msg.scopedLocalProjection == null) return pending;
      const result = await pending;
      if (flowRequest || rangeRequest || demandRequest || transformRequest) {
        try {
          if (transformRequest) {
            const { projectScopedTransformOwners } = await import('../analysis/scoped-transform-projection.js');
            return { ...result, scopedLocal: await projectScopedTransformOwners(canonicalOwner, result,
              msg.scopedLocalProjection, { signal, limits: msg.scopedWorkLimits }) };
          }
          if (demandRequest) {
            const { projectScopedDemandOwners } = await import('../analysis/scoped-demand-projection.js');
            return { ...result, scopedLocal: await projectScopedDemandOwners(canonicalOwner, result,
              msg.scopedLocalProjection, { signal, limits: msg.scopedWorkLimits }) };
          }
          if (flowRequest) {
            const { projectScopedFlowInputs } = await import('../analysis/scoped-flow-projection.js');
            return { ...result, scopedLocal: await projectScopedFlowInputs(canonicalOwner, result,
              msg.scopedLocalProjection, { signal, limits: msg.scopedWorkLimits }) };
          }
          const { projectScopedRangeOwner } = await import('../analysis/scoped-range-projection.js');
          return { ...result, scopedLocal: await projectScopedRangeOwner(canonicalOwner, result,
            msg.scopedLocalProjection, { signal, limits: msg.scopedWorkLimits }) };
        } catch (error) {
          const { serializeScopedWorkerStop } = await import('../core/budgets/scoped-worker.js');
          const scopedStop = serializeScopedWorkerStop(error, { kind: msg.scopedLocalProjection.kind,
            worldId: msg.scopedLocalProjection.worldId, snapshotId: msg.scopedLocalProjection.snapshotId,
            binaryId: msg.input.binaryId });
          if (!scopedStop) throw error;
          return { scopedStop }; // no partial pipeline can be cached as success
        }
      }
      // Optional work stays on this existing isolated worker, not Safari's UI
      // thread. Only the result just produced here enters the local owners.
      const { projectScopedLocalOwners } = await import('../analysis/scoped-local-projection.js');
      if (signal.aborted) throw signal.reason ?? new Error('Scoped local projection cancelled.');
      return { ...result, scopedLocal: projectScopedLocalOwners(result, msg.scopedLocalProjection, { signal }) };
    }
    case 'strings': return scanStrings(msg, signal);
    case 'search': return runSearch(msg, signal);
    case 'readAt': return readAtAddress(msg, signal);
    case 'resolvePointer': return resolvePointer(msg, signal);
    case 'scopedApplePointer': return scopedApplePointer(msg, signal);
    case 'guessFunctions': return genericFunctionSeeds();
    case 'xrefs': return { results: [], cancelled: false, capped: false, unsupported: true };
    case 'scanProgram': return emptyProgramScan(msg.regionId);
    case 'fieldAccess': return msg.offsets ? { groups: Object.fromEntries((msg.offsets || []).map((x) => [String(x), []])), unsupported: true } : { results: [], unsupported: true };
    case 'valueShapes': return { groups: [], unsupported: true };
    case 'metadata': return metadataPage(msg, signal);
    case 'hash': return { hash: await hashByteSource(source?.__rawSource || source, { signal, onProgress: ({ done, total }) => self.postMessage({ t: 'analysisProgress', requestId: msg.id, epoch: msg.epoch, phase: 'hash', done, total }) }) };
    case 'sha256':
    case 'digest': return sha256File(msg, signal);
    case 'memoryStats': return memoryStats();
    case 'cleanupMemory': source?.clear?.(); releaseDecoderRevalidationWorker(); return memoryStats();
    case 'probe': return { ok: true, capability: descriptor?.capability || null };
    default: throw new Error(`Unknown platform request: ${msg.t}`);
  }
}

function createSource(input) {
  const base = asByteSource(input, { maxReadLength: 8 * 1024 * 1024 });
  const cached = new CachedByteSource(base, { pageSize: 256 * 1024, maxCachedBytes: 8 * 1024 * 1024 });
  cached.__rawSource = base;
  return cached;
}

function sha256BytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

async function sha256File(msg, signal) {
  if (!file) throw new Error('No binary is open.');
  if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('SHA-256 cancelled'), { name: 'AbortError' });
  const total = Number(file.size);
  if (!Number.isSafeInteger(total) || total < 0) throw new TypeError('sha256 source must have a safe integer size');
  const subtle = globalThis.crypto?.subtle;
  if (total <= SUBTLE_SHA256_MAX_BYTES && typeof subtle?.digest === 'function' && (typeof file.slice === 'function' || typeof file.arrayBuffer === 'function')) {
    const buffer = total === 0
      ? new ArrayBuffer(0)
      : (typeof file.arrayBuffer === 'function' ? await file.arrayBuffer() : await file.slice(0, total).arrayBuffer());
    if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('SHA-256 cancelled'), { name: 'AbortError' });
    if (buffer.byteLength !== total) throw new Error(`sha256 truncated read: expected ${total}, received ${buffer.byteLength}`);
    const digest = await subtle.digest('SHA-256', buffer);
    if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('SHA-256 cancelled'), { name: 'AbortError' });
    const hex = sha256BytesToHex(new Uint8Array(digest));
    progress(msg, 'sha256', total, total);
    return { hex, sha256: hex, digest: hex, bytesRead: total };
  }
  const chunkBytes = Number.isSafeInteger(msg.chunkBytes) && msg.chunkBytes > 0 ? msg.chunkBytes : 1024 * 1024;
  const raw = source?.__rawSource || asByteSource(file, { maxReadLength: 8 * 1024 * 1024 });
  const hash = new IncrementalSha256();
  let offset = 0;
  while (offset < total) {
    if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('SHA-256 cancelled'), { name: 'AbortError' });
    const take = Math.min(chunkBytes, total - offset);
    let bytes;
    if (typeof file.slice === 'function') {
      const part = file.slice(offset, offset + take);
      bytes = new Uint8Array(await part.arrayBuffer());
      if (bytes.byteLength !== take) throw new Error(`sha256 truncated read: expected ${take}, received ${bytes.byteLength}`);
    } else {
      bytes = await raw.readExactly(BigInt(offset), take, { signal });
    }
    if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('SHA-256 cancelled'), { name: 'AbortError' });
    hash.update(bytes);
    offset += bytes.byteLength;
    progress(msg, 'sha256', offset, total);
  }
  if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('SHA-256 cancelled'), { name: 'AbortError' });
  const hex = hash.hexDigest();
  return { hex, sha256: hex, digest: hex, bytesRead: offset };
}

async function detectFile(msg, signal) {
  const candidate = msg.file;
  if (!candidate || !Number.isSafeInteger(candidate.size) || candidate.size <= 0) throw new Error('This file is empty or has an invalid size.');
  const temporary = createSource(candidate);
  try {
    const length = Math.min(16, candidate.size);
    const prefix = await temporary.readExactly(0n, length, { signal });
    if (signal.aborted) throw new Error('Open cancelled');
    const detected = detectBinary(prefix, { probeLength: BigInt(length), totalSize: BigInt(candidate.size) });
    return { formatId: detected.format, fat: !!detected.fat, size: BigInt(candidate.size), sourceBacked: true };
  } finally { temporary.clear?.(); }
}

async function openFile(msg, signal) {
  const candidateFile = msg.file;
  if (!candidateFile || !Number.isSafeInteger(candidateFile.size) || candidateFile.size <= 0) throw new Error('This file is empty or has an invalid size.');
  progress(msg, 'header', 0, 7);
  const candidateSource = createSource(candidateFile);
  const cancellable = {
    size: candidateSource.size,
    maxReadLength: candidateSource.maxReadLength,
    read: (offset, length, options = {}) => candidateSource.read(offset, length, { ...options, signal }),
  };
  let candidateImage, candidateDescriptor;
  try {
    candidateImage = await openBinarySource(cancellable, {
      ranges: { pageSize: 64 * 1024, maxPageSize: 2 * 1024 * 1024, maxCachedBytes: 16 * 1024 * 1024, maxReads: 4096 },
    });
    if (signal.aborted) throw new Error('Open cancelled');
    progress(msg, 'sections', 2, 7);
    const engine = {
      arm64: candidateImage.arch === 'arm64' || candidateImage.arch === 'arm64e',
      arm64e: candidateImage.arch === 'arm64e',
      verified: false,
    };
    candidateDescriptor = describeBinaryImage(candidateImage, { name: candidateFile.name || 'binary', engine });
    candidateDescriptor.platform.vendorCandidates = fingerprintVendors({ libraries: candidateImage.libraries, imports: candidateImage.imports, symbols: candidateImage.symbols });
    const candidateRegions = new Map();
    for (const region of candidateDescriptor.slices.flatMap((s) => s.regions)) if (region?.id) candidateRegions.set(region.id, region);
    candidateRegions.set(candidateDescriptor.raw.id, candidateDescriptor.raw);

    progress(msg, 'symbols', 3, 7, { count: candidateImage.symbols.length });
    progress(msg, 'imports', 4, 7, { count: candidateImage.imports.length });
    progress(msg, 'strings', 4, 7, { deferred: true });
    progress(msg, 'functions', 5, 7, { count: candidateImage.functions.length });
    progress(msg, 'expensive', 5, 7, { deferred: true });

    const previousSource = source;
    file = candidateFile;
    source = candidateSource;
    image = candidateImage;
    descriptor = candidateDescriptor;
    regions = candidateRegions;
    rebuildVmRegionIndex();
    pointerImages = new Map();
    const selectedSliceIndex = selectedFatSliceIndex(candidateImage);
    if (selectedSliceIndex >= 0) {
      pointerImages.set(selectedSliceIndex, candidateImage);
      candidateDescriptor.platform.selectedSliceIndex = selectedSliceIndex;
      candidateDescriptor.platform.selectedSliceParseReused = true;
    }
    if (previousSource && previousSource !== candidateSource) previousSource.clear?.();
    return candidateDescriptor;
  } catch (error) {
    candidateSource.clear?.();
    throw error;
  }
}

async function pointerImageForSlice(sliceIndex, signal) {
  if (!image || image.format !== 'macho' || !image.metadata?.fat?.slices?.length || sliceIndex == null) return image;
  const index = Number(sliceIndex);
  if (!Number.isSafeInteger(index) || index < 0 || index >= image.metadata.fat.slices.length) return null;
  if (pointerImages.has(index)) return pointerImages.get(index);
  const selected = await parseMachOSource(source, {
    sliceIndex:index,
    signal,
    ranges:{ pageSize:64 * 1024, maxPageSize:2 * 1024 * 1024, maxCachedBytes:16 * 1024 * 1024, maxReads:4096 },
  });
  if (signal.aborted) throw new Error('Pointer resolution cancelled');
  pointerImages.set(index, selected);
  return selected;
}

async function scopedApplePointer(msg, signal) {
  const index = msg.sliceIndex;
  if (!Number.isSafeInteger(index) || index < 0) throw new TypeError('scoped-pointer-slice-index');
  const ownerImage = image, ownerSource = source, ownerFile = file, epoch = currentEpoch;
  const fatIndex = selectedFatSliceIndex(ownerImage);
  // Never hide a full metadata reparse in an eight-byte query.
  const selected = fatIndex < 0 ? (index === 0 ? ownerImage : null) : pointerImages.get(index) ?? null;
  const { projectScopedWorkerPointer } = await import('../analysis/apple/scoped-worker-pointer.js');
  return projectScopedWorkerPointer(msg.request, { image: selected, source: ownerSource,
    signal, limits: msg.scopedWorkLimits,
    isCurrent: () => !signal.aborted && currentEpoch === epoch && image === ownerImage && file === ownerFile && source === ownerSource,
  });
}

async function resolvePointer(msg, signal) {
  if (!image) return null;
  let raw, address = null;
  try {
    raw = BigInt(msg.raw);
    if (msg.address != null) address = BigInt(msg.address);
  } catch { return null; }
  if (raw < 0n || raw > 0xffffffffffffffffn || (address != null && address < 0n)) return null;
  const selected = await pointerImageForSlice(msg.sliceIndex, signal);
  if (!selected) return null;
  if (selected.format === 'macho') return resolveMachOPointer(selected, raw, { address });
  return selected.sectionAt?.(raw) || selected.segmentAt?.(raw) ? raw : null;
}

function setRegions(list) {
  for (const region of list || []) if (region?.id) regions.set(region.id, region);
  rebuildVmRegionIndex();
  return { ok: true };
}

async function readFileRange(offset, length, signal) {
  if (!source) throw new Error('No binary is open.');
  return source.readExactly(offset, length, { signal });
}

async function getChunk({ regionId, chunk }, signal) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const chunkIndex = checkedChunkIndex(chunk);
  const rel = BigInt(chunkIndex) * BigInt(CHUNK_BYTES);
  const remaining = regionSize(region.size) - rel;
  if (remaining <= 0n) return { regionId, chunk, bytes: new Uint8Array(0), mn: '', ops: '', rows: 0 };
  const length = chunkLength(remaining, CHUNK_BYTES);
  const bytes = await readFileRange(BigInt(region.fileOffset) + rel, length, signal);
  const copy = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
  return { regionId, chunk, bytes: copy, mn: '', ops: '', rows: Math.ceil(copy.length / ROW_BYTES), __transfer: [copy.buffer] };
}

async function analyzeImage(msg, signal) {
  if (!image) return emptyAnalysis();
  let selected = image;
  if (image.metadata?.fat?.slices?.length && msg.sliceIndex != null) {
    selected = await pointerImageForSlice(msg.sliceIndex, signal);
    if (!selected) return emptyAnalysis();
  }
  if (signal.aborted) throw new Error('Analysis cancelled');
  return analysisFromBinaryImage(selected);
}

function genericFunctionSeeds() {
  const values = [...new Set((image?.functions || []).map((f) => BigInt(f.address).toString()))].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const starts = new BigUint64Array(values);
  const allSeedsExact = values.length > 0 && (image?.functions || []).every(isExactFunctionSeed);
  return { starts, cancelled: false, exact: allSeedsExact, allSeedsExact,
    complete: false, discoveryComplete: false,
    completeness: { complete:false, capped:false, reasons:['platform-function-discovery-not-exhaustive'] },
    __transfer: [starts.buffer] };
}

function emptyProgramScan(regionId = null) {
  const callFrom = new BigUint64Array(0), callTo = new BigUint64Array(0), refFrom = new BigUint64Array(0), refTo = new BigUint64Array(0);
  const refKind = new Uint8Array(0), kinds = new Uint8Array(0);
  return { regionId, callFrom, callTo, refFrom, refTo, refKind, kinds, kindsCovered: 0,
    callsCapped: false, refsCapped: false, words: 0, unsupported: true,
    architecture: image?.arch || null,
    completeness: { complete:false, reasons:['unsupported-program-analysis'] },
    __transfer: [callFrom.buffer, callTo.buffer, refFrom.buffer, refTo.buffer, refKind.buffer, kinds.buffer] };
}

async function scanStrings(msg, signal) {
  const region = regions.get(msg.regionId);
  if (!region) throw new Error('Unknown region.');
  const minLength = Math.max(2, Number(msg.min) || 4);
  const cap = Math.min(Math.max(1, Number(msg.limit) || STRINGS_LIMIT), STRINGS_LIMIT);
  const regionBytes = regionSize(region.size);
  const total = msg.maxBytes == null ? regionBytes : boundedOffset(msg.maxBytes, regionBytes, 'maxBytes');
  const out = [];
  const runBuf = new Uint8Array(MAX_STRING_CHARS * 4);
  let pos = 0n, runStart = null, runLen = 0, runChars = 0, runDropped = 0;
  const flush = () => {
    if (runStart != null && runLen > 0 && runChars >= minLength) {
      const byteLength = runLen + runDropped;
      const text = decoder.decode(runBuf.subarray(0, runLen)).replace(/\t/g, '\\t').replace(/\n/g, '\\n');
      const entry = { addr: BigInt(region.vmAddr) + runStart, offset: exactExternalInteger(runStart), text, byteLength };
      if (runDropped > 0) entry.truncated = true;
      out.push(entry);
    }
    runStart = null;
    runLen = 0;
    runChars = 0;
    runDropped = 0;
  };
  let carry = new Uint8Array(0), carryAt = 0n;
  while (pos < total && out.length < cap) {
    if (signal.aborted) return { results: out, cancelled: true, capped: false, scannedBytes: exactExternalInteger(pos), complete: false };
    const want = chunkLength(total - pos, SCAN_BLOCK);
    const block = await readFileRange(BigInt(region.fileOffset) + pos, want, signal);
    if (!block.length) break;
    let buffer = block, base = pos;
    if (carry.length) {
      buffer = new Uint8Array(carry.length + block.length);
      buffer.set(carry);
      buffer.set(block, carry.length);
      base = carryAt;
    }
    const last = pos + BigInt(block.length) >= total;
    let i = 0;
    for (; i < buffer.length; i++) {
      const n = utf8Len(buffer, i);
      if (n === -1 && !last) break;
      if (n <= 0) { flush(); if (out.length >= cap) break; continue; }
      if (runStart == null) { runStart = base + BigInt(i); runLen = 0; runDropped = 0; }
      runChars++;
      if (runDropped === 0 && runLen + n <= runBuf.length) {
        for (let k = 0; k < n; k++) runBuf[runLen++] = buffer[i + k];
      } else {
        runDropped += n;
      }
      i += n - 1;
    }
    carry = i < buffer.length ? buffer.slice(i) : new Uint8Array(0);
    carryAt = base + BigInt(i);
    pos += BigInt(block.length);
    self.postMessage({ t: 'scanProgress', requestId: msg.id, epoch: msg.epoch, done: exactExternalInteger(pos), all: exactExternalInteger(total), hits: out.length });
    await Promise.resolve();
  }
  flush();
  return {
    results: out.slice(0, cap), cancelled: false, capped: out.length >= cap,
    truncationReason: out.length >= cap ? 'result-limit' : (total < regionBytes ? 'input-budget' : null),
    scannedBytes: exactExternalInteger(pos), complete: pos >= regionBytes && out.length < cap,
  };
}

async function runSearch(msg, signal) {
  const region = regions.get(msg.regionId);
  if (!region) throw new Error('Unknown region.');
  if (msg.kind !== 'hex' && msg.kind !== 'text') return { cancelled: false, results: [], scanned: 0, capped: false, unsupported: true };
  const total = regionSize(region.size);
  const start = boundedOffset(msg.from ?? 0, total, 'search start');
  let pattern, mask = null;
  if (msg.kind === 'hex') {
    pattern = msg.hex?.bytes;
    mask = msg.hex?.mask;
    if (!pattern?.length) throw new Error('Enter a hex pattern.');
  } else {
    const q = String(msg.query || '');
    if (!q) throw new Error('Enter text to search for.');
    // This is a byte-oriented search, so preserve the query's exact UTF-8
    // encoding. Unicode toLowerCase() can change code points (including
    // supplementary-plane characters) and cannot be mirrored safely on raw
    // haystack bytes without decoding and retaining a byte/address map (#5940).
    // Keep the established ASCII-insensitive contract by folding both byte
    // operands with lower() during comparison; non-ASCII bytes remain exact.
    pattern = new TextEncoder().encode(q);
  }
  const isText = msg.kind === 'text';
  const isHex = msg.kind === 'hex';
  const matcher = compileBytePattern(pattern, mask, isText);
  const results = [];
  let pos = start, carry = new Uint8Array(0), capped = false;
  while (pos < total && !capped) {
    if (signal.aborted) return { cancelled: true, results, scanned: exactExternalInteger(pos - start), capped: false };
    const block = await readFileRange(BigInt(region.fileOffset) + pos, chunkLength(total - pos, SCAN_BLOCK), signal);
    const joined = carry.length ? concat(carry, block) : block;
    const base = pos - BigInt(carry.length);
    for (let i = 0; i <= joined.length - pattern.length; i++) {
      if (matcher) {
        i = matcher.find(joined, i);
        if (i < 0) break;
      } else {
        let ok = true;
        for (let j = 0; j < pattern.length; j++) {
          const actual = isText ? lower(joined[i + j]) : joined[i + j];
          const expected = isText ? lower(pattern[j]) : pattern[j];
          if (isHex ? ((actual & mask[j]) !== expected) : actual !== expected) { ok = false; break; }
        }
        if (!ok) continue;
      }
      const byteOff = base + BigInt(i);
      results.push({ row: exactExternalInteger(byteOff / BigInt(ROW_BYTES)), addr: BigInt(region.vmAddr) + byteOff, byteOff: exactExternalInteger(byteOff) });
      if (results.length >= SEARCH_LIMIT) { capped = true; break; }
    }
    pos += BigInt(block.length);
    carry = pattern.length > 1 ? joined.slice(Math.max(0, joined.length - pattern.length + 1)) : new Uint8Array(0);
    self.postMessage({
      t: 'searchProgress', requestId: msg.id, epoch: msg.epoch,
      done: exactExternalInteger(pos - start), all: exactExternalInteger(total - start), hits: results.length,
    });
  }
  return { cancelled: false, results, scanned: exactExternalInteger(pos - start), capped };
}

function lower(byte) { return byte >= 65 && byte <= 90 ? byte + 32 : byte; }
function concat(a, b) { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; }

function vmToFile(address) {
  const at = BigInt(address);
  if (vmRegionIndexDisjoint) {
    let lo = 0, hi = vmRegionIndex.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const entry = vmRegionIndex[mid];
      if (at < entry.start) hi = mid - 1;
      else if (at >= entry.end) lo = mid + 1;
      else if (!isNonAllocableRegion(entry.region)) return { region: entry.region, offset: entry.fileOffset + (at - entry.start) };
      else break;
    }
  } else {
    for (let i = 0; i < vmRegionList.length; i++) {
      const entry = vmRegionList[i];
      if (isNonAllocableRegion(entry.region)) continue;
      if (at >= entry.start && at < entry.end) return { region: entry.region, offset: entry.fileOffset + (at - entry.start) };
    }
  }
  const offset = image?.addressToOffset(at);
  return offset == null ? null : { region: null, offset };
}

async function readAtAddress(msg, signal) {
  const hit = vmToFile(msg.addr);
  if (!hit) return { found: false };
  const requested = Math.min(Math.max(0, Number(msg.len) || 256), 1 << 20);
  let available = image.fileSize - hit.offset;
  if (hit.region) available = BigInt(hit.region.fileOffset) + BigInt(hit.region.size) - hit.offset;
  const length = Number(available < BigInt(requested) ? available : BigInt(requested));
  const rawBytes = await readFileRange(hit.offset, length, signal);
  const bytes = rawBytes.byteOffset === 0 && rawBytes.byteLength === rawBytes.buffer.byteLength ? rawBytes : rawBytes.slice();
  const result = { found: true, region: hit.region?.name || null, fileOffset: hit.offset, bytes,
    transferredOwnedBytes: true };
  if (msg.text) {
    const end = bytes.indexOf(0);
    result.text = decoder.decode(end >= 0 ? bytes.subarray(0, end) : bytes);
    result.terminated = end >= 0;
  }
  result.__transfer = [bytes.buffer];
  return result;
}

function metadataPageInteger(value, fallback, minimum, label) {
  const resolved = value ?? fallback;
  if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < minimum) {
    throw new RangeError(`metadata ${label} must be a ${minimum === 0 ? 'non-negative' : 'positive'} safe integer`);
  }
  return resolved === 0 ? 0 : resolved;
}

async function metadataPage(msg, signal) {
  if (!image) throw new Error('No parsed universal binary is open.');
  const selected = await pointerImageForSlice(msg.sliceIndex, signal);
  if (!selected) throw new Error('Invalid Mach-O slice index.');
  const collections = {
    segments: selected.segments, sections: selected.sections, imports: selected.imports, exports: selected.exports,
    symbols: selected.symbols, relocations: selected.relocations, functions: selected.functions, libraries: selected.libraries,
  };
  if (msg.kind === 'summary') {
    const capability = selected === image
      ? descriptor?.capability || null
      : describeBinaryImage(selected, {
        name:file?.name || 'binary',
        engine:{ arm64:selected.arch === 'arm64' || selected.arch === 'arm64e', arm64e:selected.arch === 'arm64e', verified:false },
      }).capability;
    return { summary:selected.summary(), metadata:selected.metadata, capability };
  }
  const list = collections[msg.kind];
  if (!list) throw new Error(`Unknown metadata kind: ${msg.kind}`);
  const start = metadataPageInteger(msg.start, 0, 0, 'start');
  const limit = Math.min(5000, metadataPageInteger(msg.limit, 500, 1, 'limit'));
  return { kind: msg.kind, start, total: list.length, items: list.slice(start, start + limit), next: start + limit < list.length ? start + limit : null };
}

function memoryStats() {
  const sourceStats = source?.memoryStats?.() || {};
  return {
    ...sourceStats,
    functionsIndexed: image?.functions?.length || 0,
    stringsIndexed: 0,
    estimatedMemory: (sourceStats.bytesCached || 0) + ((image?.functions?.length || 0) * 64) + ((image?.symbols?.length || 0) * 96),
  };
}
