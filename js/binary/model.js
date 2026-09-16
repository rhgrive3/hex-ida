import { inRange } from './reader.js';

export function sectionHasMappedAddress(sec) {
  if (sec?.source === 'section-header') return (BigInt(sec.flags || 0) & 0x2n) !== 0n; // ELF SHF_ALLOC
  if (sec?.source === 'unmapped-section') return false;
  return true;
}

// Loader/provider output is fixed into canonical BinaryImage mappings here.
// Raw BigInt() is a conversion API (BigInt(true) === 1n, BigInt(['16']) === 16n),
// so a structured value would fabricate a real segment/section mapping (#5195).
// Accept only exact integers: bigint, safe-integer number, or a strict
// decimal/hex string — the same shared exact-integer grammar the canonical
// address surface applies (/^-?(?:0x[0-9a-f]+|\d+)$/i). Anything else, and
// BigInt() success in general, is not schema validation.
function canonicalMappingBigInt(value, fallback, field) {
  if (value == null) return fallback;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`${field} must be an exact integer`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?(?:0x[0-9a-f]+|\d+)$/i.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw new TypeError(`${field} must be an exact integer`);
}

function strictBigIntOrNull(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  try { return BigInt(value.trim()); } catch { return null; }
}

function finiteConfidence(value, fallback = 0.5) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

// Permissions are a canonical R/W/X authority consumed by memory-region
// derivation: only real booleans may become true. Truthiness would promote
// schema-invalid values ('false', [], {}) to execute/write authority (#5886).
function normalizePerms(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { read: false, write: false, execute: false };
  return {
    read: p.read === true,
    write: p.write === true,
    execute: p.execute === true,
  };
}

function minBigInt(a, b) { return a < b ? a : b; }

function identityKeyPart(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

function identityTextKeyPart(value) {
  if (value == null) return '';
  return typeof value === 'string' ? value : null;
}

function identityFlagKeyPart(value) {
  if (value == null) return '0';
  return typeof value === 'boolean' ? (value ? '1' : '0') : null;
}

function importIdentityKey(i) {
  if (i == null || typeof i !== 'object' || Array.isArray(i)) return null;
  const parts = [
    identityTextKeyPart(i.library),
    identityTextKeyPart(i.name),
    identityKeyPart(i.ordinal),
    identityFlagKeyPart(i.weak),
    identityKeyPart(i.addend ?? 0n),
    identityKeyPart(i.pointerFormat),
    identityKeyPart(i.type),
    identityKeyPart(i.version),
    identityTextKeyPart(i.versionLibrary),
  ];
  return parts.includes(null) ? null : parts.join('\0');
}

function siteIdentityKey(s) {
  if (s == null || typeof s !== 'object' || Array.isArray(s)) return null;
  const parts = [
    identityKeyPart(s.address),
    identityKeyPart(s.offset),
    identityTextKeyPart(s.kind),
    identityKeyPart(s.type),
    identityKeyPart(s.addend),
    identityKeyPart(s.pointerFormat),
    identityFlagKeyPart(s.weak),
    identityKeyPart(s.recordFileOffset),
    identityKeyPart(s.recordIndex),
    identityTextKeyPart(s.recordEncoding),
  ];
  return parts.includes(null) ? null : parts.join(':');
}

function buildVirtualMappingLookup(sections, segments) {
  const items = [];
  let order = 0;
  for (const mapping of sections) {
    if (sectionHasMappedAddress(mapping) && mapping.size > 0n) {
      items.push({
        mapping,
        order,
        start: mapping.address,
        size: mapping.size,
        end: mapping.address + mapping.size,
      });
    }
    order++;
  }
  for (const mapping of segments) {
    if (mapping.size > 0n) {
      items.push({
        mapping,
        order,
        start: mapping.address,
        size: mapping.size,
        end: mapping.address + mapping.size,
      });
    }
    order++;
  }
  items.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : a.order - b.order);
  const starts = new Array(items.length);
  const prefixEnds = new Array(items.length);
  let maxEnd = null;
  for (let i = 0; i < items.length; i++) {
    starts[i] = items[i].start;
    if (maxEnd === null || items[i].end > maxEnd) maxEnd = items[i].end;
    prefixEnds[i] = maxEnd;
  }
  return { items, starts, prefixEnds, runs: buildVirtualMappingRuns(items) };
}

// Owner selection for overlapping mappings is "smallest size wins, earliest source
// order breaks ties" and is queried while sweeping interval boundaries in ascending
// order. One heap implements that comparator for both the virtual-mapping run index and
// the function-seed region sweep so the two boundaries cannot drift apart.
function createSizeOrderMinHeap() {
  const heap = [];
  const before = (a, b) => a.size < b.size || (a.size === b.size && a.order < b.order);

  const push = (item) => {
    heap.push(item);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (!before(heap[index], heap[parent])) break;
      [heap[index], heap[parent]] = [heap[parent], heap[index]];
      index = parent;
    }
  };

  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < heap.length && before(heap[left], heap[smallest])) smallest = left;
        if (right < heap.length && before(heap[right], heap[smallest])) smallest = right;
        if (smallest === index) break;
        [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
        index = smallest;
      }
    }
    return top;
  };

  return { push, pop, clear: () => { heap.length = 0; }, top: () => heap[0], size: () => heap.length };
}

function buildVirtualMappingRuns(items) {
  const events = [];
  for (const item of items) {
    events.push({ point: item.start, kind: 1, item });
    events.push({ point: item.end, kind: -1, item });
  }
  events.sort((a, b) => a.point < b.point ? -1 : a.point > b.point ? 1 : a.kind - b.kind);
  const starts = [];
  const owners = [];
  // The owner of an interval is the smallest live mapping, so the minimum is carried
  // across boundaries in a lazy-deletion heap. Rescanning the whole live set at every
  // boundary made index construction Θ(N^2) on nested mappings, which let a small file
  // spend far beyond the parser's advertised deadline in the first mapping query (#8880).
  const live = new Set();
  const heap = createSizeOrderMinHeap();
  const bestActive = () => {
    while (heap.size() > 0 && !live.has(heap.top())) heap.pop();
    const best = heap.top();
    return best ? best.mapping : null;
  };
  let previous = null;
  let cursor = 0;
  while (cursor < events.length) {
    const point = events[cursor].point;
    if (previous !== null && previous < point) {
      starts.push(previous);
      owners.push(bestActive());
    }
    const groupEnd = cursor;
    while (cursor < events.length && events[cursor].point === point) cursor++;
    for (let i = groupEnd; i < cursor; i++) {
      if (events[i].kind < 0) live.delete(events[i].item);
    }
    for (let i = groupEnd; i < cursor; i++) {
      if (events[i].kind > 0) { live.add(events[i].item); heap.push(events[i].item); }
    }
    previous = point;
  }
  if (previous !== null) {
    starts.push(previous);
    owners.push(bestActive());
  }
  return { starts, owners };
}

function lookupVirtualMapping(lookup, address) {
  const runs = lookup.runs;
  let lo = 0;
  let hi = runs ? runs.starts.length : lookup.starts.length;
  const starts = runs ? runs.starts : lookup.starts;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] <= address) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return null;
  if (runs) return runs.owners[lo - 1] || null;
  const upper = lo;
  let best = null;
  for (let i = upper - 1; i >= 0 && lookup.prefixEnds[i] > address; i--) {
    const item = lookup.items[i];
    if (item.end <= address) continue;
    if (!best || item.size < best.size || (item.size === best.size && item.order < best.order)) best = item;
  }
  return best?.mapping || null;
}

// #8772: file-offset resolution is a mapping query, not a display scan. Sections and
// segments are indexed by their file range so a lookup costs O(log N + the ranges that
// actually contain the offset) instead of O(sections + segments) per call, and the
// containing window is answered from its first resolution-order candidate instead of a
// per-call sort. The candidate order is preserved exactly: ascending virtual size, ties
// broken by the original enumeration order (sections first, then segments).
function buildFileOffsetLookup(sections, segments) {
  const items = [];
  let rank = 0;
  for (const mapping of sections) {
    if (!sectionHasMappedAddress(mapping) || mapping.address == null) continue;
    // Validate the raw range the same way the per-query scan did, so malformed
    // provider output still fails closed at the identical boundary.
    inRange(0n, mapping.fileOffset, mapping.fileSize);
    const start = BigInt(mapping.fileOffset);
    const end = start + BigInt(mapping.fileSize);
    if (end > start) items.push({ mapping, rank, start, end, size: mapping.size });
    rank++;
  }
  for (const mapping of segments) {
    inRange(0n, mapping.fileOffset, mapping.fileSize);
    const start = BigInt(mapping.fileOffset);
    const end = start + BigInt(mapping.fileSize);
    if (end > start) items.push({ mapping, rank, start, end, size: mapping.size });
    rank++;
  }
  items.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.rank - b.rank));
  const starts = new Array(items.length);
  const prefixEnds = new Array(items.length);
  let maxEnd = null;
  for (let i = 0; i < items.length; i++) {
    starts[i] = items[i].start;
    if (maxEnd === null || items[i].end > maxEnd) maxEnd = items[i].end;
    prefixEnds[i] = maxEnd;
  }
  return { items, starts, prefixEnds };
}

function fileOffsetCandidateWindow(lookup, offset) {
  const { items, starts, prefixEnds } = lookup;
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] <= offset) lo = mid + 1;
    else hi = mid;
  }
  const upper = lo;
  if (upper === 0) return null;
  lo = 0;
  hi = upper;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (prefixEnds[mid] > offset) hi = mid;
    else lo = mid + 1;
  }
  return { lo, hi: upper };
}

const beforeCandidate = (a, b) => (a.size < b.size ? true : a.size > b.size ? false : a.rank < b.rank);

// The first candidate in resolution order, without materializing or sorting the window.
// Alias-heavy images (every section mapping the same bytes) have windows as wide as the
// section count, so a per-call sort made each resolution Θ(N log N) even though the
// earliest smallest mapping answers it; this keeps the common answer at one probe.
function firstFileOffsetCandidate(lookup, window, offset) {
  const { items } = lookup;
  let best = null;
  for (let i = window.lo; i < window.hi; i++) {
    const item = items[i];
    if (item.end <= offset) continue;
    if (best === null || beforeCandidate(item, best)) best = item;
  }
  return best;
}

function orderedFileOffsetCandidates(lookup, window, offset) {
  const { items } = lookup;
  const candidates = [];
  for (let i = window.lo; i < window.hi; i++) {
    if (items[i].end > offset) candidates.push(items[i]);
  }
  candidates.sort((a, b) => (a.size < b.size ? -1 : a.size > b.size ? 1 : a.rank - b.rank));
  return candidates;
}

function isAddressSorted(items) {
  for (let i = 1; i < items.length; i++) {
    if (items[i - 1].address > items[i].address) return false;
  }
  return true;
}

function isDataInCodeAddressSorted(entries) {
  let previous = null;
  for (const entry of entries) {
    if (entry.address == null) continue;
    if (previous !== null && entry.address < previous) return false;
    previous = entry.address;
  }
  return true;
}

function buildMappingLookup(items) {
  const starts = new Array(items.length);
  const prefixEnds = new Array(items.length);
  let maxEnd = null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const start = item.address;
    const end = start + item.size;
    starts[i] = start;
    if (maxEnd === null || end > maxEnd) maxEnd = end;
    prefixEnds[i] = maxEnd;
  }
  return { items, starts, prefixEnds };
}

function lookupMapping(lookup, address) {
  let lo = 0;
  let hi = lookup.starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lookup.starts[mid] <= address) lo = mid + 1;
    else hi = mid;
  }
  const upper = lo;
  if (upper === 0) return null;

  lo = 0;
  hi = upper;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lookup.prefixEnds[mid] > address) hi = mid;
    else lo = mid + 1;
  }
  if (lo >= upper) return null;
  const item = lookup.items[lo];
  return address < item.address + item.size ? item : null;
}



function buildDataInCodeLookup(entries) {
  const ranges = [];
  for (let order = 0; order < entries.length; order++) {
    const entry = entries[order];
    if (entry.address == null) continue;
    const size = BigInt(entry.length);
    if (size <= 0n) continue;
    ranges.push({ entry, order, address: entry.address, size });
  }
  ranges.sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : a.order - b.order);
  const starts = new Array(ranges.length);
  const prefixEnds = new Array(ranges.length);
  let maxEnd = null;
  for (let i = 0; i < ranges.length; i++) {
    starts[i] = ranges[i].address;
    const end = ranges[i].address + ranges[i].size;
    if (maxEnd === null || end > maxEnd) maxEnd = end;
    prefixEnds[i] = maxEnd;
  }
  return { items: ranges, starts, prefixEnds };
}

function lookupDataInCode(lookup, address) {
  const range = lookupMapping(lookup, address);
  return range?.entry || null;
}

function dataInCodeOverlaps(lookup, address, size) {
  const end = address + size;
  let lo = 0;
  let hi = lookup.starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lookup.starts[mid] < end) lo = mid + 1;
    else hi = mid;
  }
  const upper = lo;
  if (upper === 0) return false;
  lo = 0;
  hi = upper;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lookup.prefixEnds[mid] > address) hi = mid;
    else lo = mid + 1;
  }
  return lo < upper;
}

export const MAX_VIRTUAL_READ_BYTES = 64 * 1024 * 1024;
// Keep the established all-at-once materialization cap as the default. The
// separate name is the configurable resource-budget surface introduced for
// streaming reads; the legacy hard cap remains authoritative for callers that
// materialize one Uint8Array.
export const DEFAULT_MAX_VIRTUAL_READ_BYTES = MAX_VIRTUAL_READ_BYTES;
export const DEFAULT_MAX_VIRTUAL_READ_CHUNK_BYTES = 1024 * 1024;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export class BinaryImageResourceLimitError extends RangeError {
  constructor(requested, limit) {
    const requestedBytes = BigInt(requested);
    const limitBytes = BigInt(limit);
    super(`virtual read materialization ${requestedBytes} bytes exceeds the ${limitBytes}-byte limit; use readVirtualChunks()`);
    this.name = 'BinaryImageResourceLimitError';
    this.code = 'BINARY_VIRTUAL_READ_RESOURCE_LIMIT';
    this.resource = 'residentBytes';
    this.requested = requestedBytes;
    this.limit = limitBytes;
  }
}

function virtualReadLimit(value, fallback, field) {
  if (value == null) return BigInt(fallback);
  let limit = null;
  if (typeof value === 'bigint') limit = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) limit = BigInt(value);
  if (limit === null || limit < 0n || limit > MAX_SAFE_INTEGER_BIGINT) {
    throw new TypeError(`${field} must be a non-negative safe integer or bigint`);
  }
  return limit;
}

function throwIfSignalAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('virtual read was aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  throw error;
}

export class BinaryImage {
  constructor(input, meta = {}) {
    if (input == null) this.bytes = null;
    else if (input instanceof Uint8Array) this.bytes = input;
    else if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) this.bytes = new Uint8Array(input.buffer || input, input.byteOffset || 0, input.byteLength);
    else if (input.__binaryByteBacking === true) this.bytes = input;
    else throw new TypeError('BinaryImage expects bytes or a binary byte backing');
    this.source = meta.source || null;
    this.format = meta.format || 'unknown';
    this.arch = meta.arch || 'unknown';
    this.bits = meta.bits || 0;
    this.endian = meta.endian || 'little';
    this.platform = meta.platform || null;
    this.abi = meta.abi || null;
    this.imageBase = canonicalMappingBigInt(meta.imageBase, 0n, 'Image base');
    this.entrypoint = canonicalMappingBigInt(meta.entrypoint, null, 'Entrypoint');
    this.fileOffset = canonicalMappingBigInt(meta.fileOffset, 0n, 'Image fileOffset');
    let defaultFileSize = 0n;
    if (this.bytes) {
      if (this.bytes instanceof Uint8Array) defaultFileSize = BigInt(this.bytes.length);
      else if (typeof this.bytes.size === 'bigint') defaultFileSize = this.bytes.size;
      else if (Number.isSafeInteger(this.bytes.length)) defaultFileSize = BigInt(this.bytes.length);
      else if (this.source?.size != null) defaultFileSize = this.source.size;
      else throw new TypeError('BinaryImage expects bytes or a valid binary byte backing');
    } else if (this.source?.size != null) {
      defaultFileSize = this.source.size;
    }
    this.fileSize = canonicalMappingBigInt(meta.fileSize, defaultFileSize, 'Image fileSize');
    this.maxVirtualReadBytes = virtualReadLimit(
      meta.maxVirtualReadBytes,
      DEFAULT_MAX_VIRTUAL_READ_BYTES,
      'maxVirtualReadBytes',
    );
    if (meta.resourceBudget != null && typeof meta.resourceBudget?.remaining !== 'function') {
      throw new TypeError('resourceBudget must expose remaining(resource)');
    }
    this.resourceBudget = meta.resourceBudget || null;
    this.segments = [];
    this.sections = [];
    this.imports = [];
    this.exports = [];
    this.symbols = [];
    this.relocations = [];
    this.functions = [];
    this.unwindEntries = [];
    this.libraries = [];
    this.dataInCode = [];
    this.warnings = [];
    this.metadata = meta.metadata || {};
    this._finalized = false;
    this._mappingLookups = { sections: null, segments: null, virtual: null, offsets: null };
    this._mappingSorted = { sections: null, segments: null };
    this._dataInCodeLookup = null;
    this._dataInCodeSorted = null;
  }

  addSegment(s) {
    const address = canonicalMappingBigInt(s.address, 0n, 'Segment address');
    const size = canonicalMappingBigInt(s.size, 0n, 'Segment size');
    const fileOffset = canonicalMappingBigInt(s.fileOffset, 0n, 'Segment fileOffset');
    const fileSize = canonicalMappingBigInt(s.fileSize, 0n, 'Segment fileSize');
    if (address < 0n || size < 0n || fileOffset < 0n || fileSize < 0n) {
      throw new RangeError('Segment address, size, fileOffset, and fileSize must be non-negative');
    }
    const seg = {
      name: s.name || '',
      address,
      size,
      fileOffset,
      fileSize,
      perms: normalizePerms(s.perms),
      flags: s.flags ?? 0,
      source: s.source || this.format,
    };
    this.segments.push(seg);
    this._finalized = false;
    this._mappingLookups.segments = null;
    this._mappingLookups.virtual = null;
    this._mappingLookups.offsets = null;
    this._mappingSorted.segments = null;
    return seg;
  }

  addSection(s) {
    const address = canonicalMappingBigInt(s.address, 0n, 'Section address');
    const size = canonicalMappingBigInt(s.size, 0n, 'Section size');
    const fileOffset = canonicalMappingBigInt(s.fileOffset, 0n, 'Section fileOffset');
    const fileSize = canonicalMappingBigInt(s.fileSize ?? s.size, 0n, 'Section fileSize');
    if (address < 0n || size < 0n || fileOffset < 0n || fileSize < 0n) {
      throw new RangeError('Section address, size, fileOffset, and fileSize must be non-negative');
    }
    const sec = {
      name: s.name || '',
      segment: s.segment || null,
      address,
      size,
      fileOffset,
      fileSize,
      perms: normalizePerms(s.perms),
      flags: s.flags ?? 0,
      type: s.type ?? null,
      index: s.index ?? null,
      source: s.source || this.format,
    };
    this.sections.push(sec);
    this._finalized = false;
    this._mappingLookups.sections = null;
    this._mappingLookups.virtual = null;
    this._mappingLookups.offsets = null;
    this._mappingSorted.sections = null;
    return sec;
  }

  addressToOffset(address) {
    const a = strictBigIntOrNull(address);
    if (a === null || a < 0n) return null;
    const owner = this._virtualMappingAt(a);
    if (!owner) return null;
    const delta = a - owner.address;
    const fileSize = owner.fileSize ?? 0n;
    if (delta < fileSize) {
      return owner.fileOffset + delta;
    }
    return null;
  }

  offsetToAddress(offset) {
    const o = strictBigIntOrNull(offset);
    if (o === null || o < 0n) return null;
    if (!this._mappingLookups.offsets) this._mappingLookups.offsets = buildFileOffsetLookup(this.sections, this.segments);
    const lookup = this._mappingLookups.offsets;
    const window = fileOffsetCandidateWindow(lookup, o);
    if (window === null) return null;
    const resolve = (candidate) => {
      const s = candidate.mapping;
      const a = s.address + (o - s.fileOffset);
      const owner = this._virtualMappingAt(a);
      if (!owner) return null;
      const delta = a - owner.address;
      const fileSize = owner.fileSize ?? 0n;
      return delta < fileSize && (owner.fileOffset + delta) === o ? a : null;
    };
    const first = firstFileOffsetCandidate(lookup, window, o);
    if (first !== null) {
      const resolved = resolve(first);
      if (resolved !== null) return resolved;
    }
    for (const candidate of orderedFileOffsetCandidates(lookup, window, o)) {
      const resolved = resolve(candidate);
      if (resolved !== null) return resolved;
    }
    return null;
  }

  sectionAt(address) {
    const a = strictBigIntOrNull(address);
    if (a === null || a < 0n) return null;
    if (this._mappingSorted.sections === null) this._mappingSorted.sections = isAddressSorted(this.sections);
    if (!this._mappingSorted.sections) return this.sections.find((s) => inRange(a, s.address, s.size)) || null;
    if (!this._mappingLookups.sections) this._mappingLookups.sections = buildMappingLookup(this.sections);
    return lookupMapping(this._mappingLookups.sections, a);
  }

  segmentAt(address) {
    const a = strictBigIntOrNull(address);
    if (a === null || a < 0n) return null;
    if (this._mappingSorted.segments === null) this._mappingSorted.segments = isAddressSorted(this.segments);
    if (!this._mappingSorted.segments) return this.segments.find((s) => inRange(a, s.address, s.size)) || null;
    if (!this._mappingLookups.segments) this._mappingLookups.segments = buildMappingLookup(this.segments);
    return lookupMapping(this._mappingLookups.segments, a);
  }

  _virtualMappingAt(address) {
    const a = strictBigIntOrNull(address);
    if (a === null || a < 0n) return null;
    if (!this._mappingLookups.virtual) this._mappingLookups.virtual = buildVirtualMappingLookup(this.sections, this.segments);
    return lookupVirtualMapping(this._mappingLookups.virtual, a);
  }

  _nextMappingBoundary(current, owner) {
    // Issue #970: a narrower mapping starting inside `owner` (e.g. a zero-fill __bss
    // section inside a broader file-backed segment) ends the current chunk at its start.
    const end = owner.address + owner.size;
    let next = null;
    const consider = (m) => {
      if (m === owner || m.size <= 0n) return;
      if (m.address <= current || m.address >= end) return;
      if (m.size >= owner.size) return;
      if (next === null || m.address < next) next = m.address;
    };
    for (const m of this.sections) {
      if (sectionHasMappedAddress(m)) consider(m);
    }
    for (const m of this.segments) consider(m);
    return next;
  }

  resolveVirtualMapping(address) {
    const a = strictBigIntOrNull(address);
    if (a === null) return null;
    const owner = this._virtualMappingAt(a);
    if (!owner) return null;
    const delta = a - owner.address;
    const fileSize = owner.fileSize ?? 0n;
    const fileBacked = delta < fileSize;
    return {
      kind: fileBacked ? 'file' : 'zero',
      mapping: owner,
      offset: fileBacked ? owner.fileOffset + delta : null,
      available: fileBacked ? minBigInt(fileSize - delta, owner.size - delta) : owner.size - delta,
    };
  }

  addDataInCodeEntry(entry) {
    if (!entry || typeof entry !== 'object') throw new TypeError('DataInCode entry must be an object');
    const offset = Number(entry.offset);
    const length = Number(entry.length);
    const kind = Number(entry.kind);
    const address = entry.address != null ? strictBigIntOrNull(entry.address) : null;
    const normalized = {
      offset,
      length,
      kind,
      kindName: entry.kindName || null,
      address,
    };
    this.dataInCode.push(normalized);
    this._dataInCodeLookup = null;
    this._dataInCodeSorted = null;
    return normalized;
  }

  isDataInCode(address) {
    const a = strictBigIntOrNull(address);
    if (a === null) return false;
    if (this._dataInCodeSorted === null) this._dataInCodeSorted = isDataInCodeAddressSorted(this.dataInCode);
    if (this._dataInCodeSorted) {
      if (!this._dataInCodeLookup) this._dataInCodeLookup = buildDataInCodeLookup(this.dataInCode);
      return lookupDataInCode(this._dataInCodeLookup, a) !== null;
    }
    for (const entry of this.dataInCode) {
      if (entry.address == null) continue;
      if (a >= entry.address && a < entry.address + BigInt(entry.length)) {
        return true;
      }
    }
    return false;
  }

  dataInCodeAt(address) {
    const a = strictBigIntOrNull(address);
    if (a === null) return null;
    if (this._dataInCodeSorted === null) this._dataInCodeSorted = isDataInCodeAddressSorted(this.dataInCode);
    if (this._dataInCodeSorted) {
      if (!this._dataInCodeLookup) this._dataInCodeLookup = buildDataInCodeLookup(this.dataInCode);
      return lookupDataInCode(this._dataInCodeLookup, a);
    }
    for (const entry of this.dataInCode) {
      if (entry.address == null) continue;
      if (a >= entry.address && a < entry.address + BigInt(entry.length)) {
        return entry;
      }
    }
    return null;
  }

  isInstructionAllowed(address) {
    const a = strictBigIntOrNull(address);
    if (a === null || a < 0n) return false;

    const sec = this.sectionAt(a);
    const seg = this.segmentAt(a);
    const isExecutable = Boolean(sec ? sec.perms?.execute : seg?.perms?.execute);
    if (!isExecutable) return false;

    const arch = this.arch;
    const alignment = (arch === 'arm64' || arch === 'arm64e' || arch === 'arm64_32') ? 4n : arch === 'arm' ? 2n : 1n;
    if (a % alignment !== 0n) return false;

    const instructionBytes = (arch === 'arm64' || arch === 'arm64e' || arch === 'arm64_32') ? 4n : arch === 'arm' ? 2n : 1n;
    const offStart = this.addressToOffset(a);
    const offEnd = this.addressToOffset(a + instructionBytes - 1n);
    if (offStart === null || offEnd === null) return false;

    const instEnd = a + instructionBytes;
    if (this._dataInCodeSorted === null) this._dataInCodeSorted = isDataInCodeAddressSorted(this.dataInCode);
    if (this._dataInCodeSorted) {
      if (!this._dataInCodeLookup) this._dataInCodeLookup = buildDataInCodeLookup(this.dataInCode);
      if (dataInCodeOverlaps(this._dataInCodeLookup, a, instructionBytes)) return false;
    } else {
      for (const entry of this.dataInCode) {
        if (entry.address == null) continue;
        const dataStart = entry.address;
        const dataEnd = entry.address + BigInt(entry.length);
        if (a < dataEnd && instEnd > dataStart) {
          return false;
        }
      }
    }

    return true;
  }

  _virtualReadRequest(address, size) {
    const current = strictBigIntOrNull(address);
    const remaining = strictBigIntOrNull(size);
    if (current === null || remaining === null) return null;
    if (current < 0n || remaining < 0n || remaining > MAX_SAFE_INTEGER_BIGINT) return null;
    return { address: current, size: remaining };
  }

  _virtualReadMaterializationLimit() {
    let limit = this.maxVirtualReadBytes;
    if (!this.resourceBudget) return limit;
    const remaining = this.resourceBudget.remaining('residentBytes');
    if (remaining === Infinity) return limit;
    const budgetRemaining = typeof remaining === 'bigint'
      ? remaining
      : (typeof remaining === 'number' && Number.isSafeInteger(remaining) ? BigInt(remaining) : null);
    if (budgetRemaining === null || budgetRemaining < 0n || budgetRemaining > MAX_SAFE_INTEGER_BIGINT) {
      throw new TypeError('resourceBudget.remaining(\'residentBytes\') must return a non-negative safe integer, bigint, or Infinity');
    }
    limit = minBigInt(limit, budgetRemaining);
    return limit;
  }

  _assertVirtualReadMaterialization(size) {
    if (size === 0n) return;
    const limit = this._virtualReadMaterializationLimit();
    if (size > limit) throw new BinaryImageResourceLimitError(size, limit);
  }

  _virtualReadPlan(address, size, { materialize = false } = {}) {
    const request = this._virtualReadRequest(address, size);
    if (!request) return null;
    // Preserve the established fail-closed all-at-once limit while allowing
    // readVirtualChunks() to service larger logical ranges incrementally.
    if (materialize && request.size > BigInt(MAX_VIRTUAL_READ_BYTES)) return null;
    let current = request.address;
    let remaining = request.size;
    if (remaining === 0n) return [];
    const chunks = [];
    while (remaining > 0n) {
      const owner = this._virtualMappingAt(current);
      if (!owner) return null;
      const delta = current - owner.address;
      const vmAvailable = owner.size - delta;
      if (vmAvailable <= 0n) return null;
      const boundary = this._nextMappingBoundary(current, owner);
      const span = boundary === null ? vmAvailable : minBigInt(vmAvailable, boundary - current);
      if (span <= 0n) return null;
      const fileAvailable = delta < owner.fileSize ? minBigInt(owner.fileSize - delta, span) : 0n;
      const length = fileAvailable > 0n ? minBigInt(fileAvailable, remaining) : minBigInt(span, remaining);
      if (length <= 0n) return null;
      if (fileAvailable > 0n) chunks.push({ kind:'file', offset:owner.fileOffset + delta, length });
      else chunks.push({ kind:'zero', length });
      current += length;
      remaining -= length;
    }
    return chunks;
  }

  readVirtual(address, size) {
    if (!this.bytes) return null;
    const request = this._virtualReadRequest(address, size);
    if (!request) return null;
    const plan = this._virtualReadPlan(request.address, request.size, { materialize: true });
    if (!plan) return null;
    this._assertVirtualReadMaterialization(request.size);
    const out = new Uint8Array(Number(request.size));
    let cursor = 0;
    for (const chunk of plan) {
      const length = Number(chunk.length);
      if (chunk.kind === 'zero') { cursor += length; continue; }
      const off = Number(chunk.offset);
      if (!Number.isSafeInteger(off) || off < 0 || off > this.bytes.length || length > this.bytes.length - off) return null;
      out.set(this.bytes.subarray(off, off + length), cursor);
      cursor += length;
    }
    return out;
  }

  async readVirtualAsync(address, size) {
    const resident = this.readVirtual(address, size);
    if (resident) return resident;
    if (!this.source) return null;
    const request = this._virtualReadRequest(address, size);
    if (!request) return null;
    const plan = this._virtualReadPlan(request.address, request.size, { materialize: true });
    if (!plan) return null;
    this._assertVirtualReadMaterialization(request.size);
    const out = new Uint8Array(Number(request.size));
    const sourceReadLimit = Number.isSafeInteger(this.source.maxReadLength) && this.source.maxReadLength > 0
      ? BigInt(this.source.maxReadLength)
      : null;
    let cursor = 0;
    for (const chunk of plan) {
      const length = Number(chunk.length);
      if (chunk.kind === 'zero') { cursor += length; continue; }
      if (chunk.offset < 0n || chunk.offset > this.fileSize || chunk.length > this.fileSize - chunk.offset) return null;
      let done = 0n;
      while (done < chunk.length) {
        const remaining = chunk.length - done;
        const take = sourceReadLimit == null ? remaining : minBigInt(remaining, sourceReadLimit);
        const bytes = await this.source.readExactly(chunk.offset + done, take);
        const expected = Number(take);
        if (!bytes || bytes.length !== expected) return null;
        out.set(bytes, cursor);
        cursor += expected;
        done += take;
      }
    }
    return out;
  }

  async *readVirtualChunks(address, size, options = {}) {
    const request = this._virtualReadRequest(address, size);
    if (!request || (!this.bytes && !this.source)) return;
    const requestedChunkLimit = virtualReadLimit(
      options.maxChunkLength,
      DEFAULT_MAX_VIRTUAL_READ_CHUNK_BYTES,
      'maxChunkLength',
    );
    if (request.size > 0n && requestedChunkLimit === 0n) {
      throw new BinaryImageResourceLimitError(request.size, 0n);
    }
    const materializationLimit = this._virtualReadMaterializationLimit();
    if (request.size > 0n && materializationLimit === 0n) {
      throw new BinaryImageResourceLimitError(request.size, 0n);
    }
    const chunkLimit = minBigInt(requestedChunkLimit, materializationLimit);
    const plan = this._virtualReadPlan(request.address, request.size);
    if (!plan) return;

    // Prove every file-backed span before yielding anything. Streaming must not publish a
    // valid prefix and only later discover that a subsequent virtual chunk points outside
    // the resident/source file backing.
    const residentLength = this.bytes == null
      ? null
      : (Number.isSafeInteger(this.bytes.length)
        ? BigInt(this.bytes.length)
        : (typeof this.bytes.size === 'bigint' ? this.bytes.size : null));
    const sourceLength = typeof this.source?.size === 'bigint' ? this.source.size : null;
    const sourceBackingSize = sourceLength == null ? this.fileSize : minBigInt(this.fileSize, sourceLength);
    for (const chunk of plan) {
      if (chunk.kind !== 'file') continue;
      const backingSize = residentLength ?? sourceBackingSize;
      if (chunk.offset < 0n || backingSize == null || chunk.offset > backingSize || chunk.length > backingSize - chunk.offset) return;
    }

    const sourceReadLimit = !this.bytes && Number.isSafeInteger(this.source?.maxReadLength) && this.source.maxReadLength > 0
      ? BigInt(this.source.maxReadLength)
      : null;
    const signal = options.signal || null;
    for (const chunk of plan) {
      let done = 0n;
      while (done < chunk.length) {
        throwIfSignalAborted(signal);
        const remaining = chunk.length - done;
        let take = minBigInt(remaining, chunkLimit);
        if (sourceReadLimit != null) take = minBigInt(take, sourceReadLimit);
        if (take <= 0n) throw new BinaryImageResourceLimitError(remaining, 0n);
        const length = Number(take);
        if (chunk.kind === 'zero') {
          yield new Uint8Array(length);
          done += take;
          continue;
        }
        const offset = chunk.offset + done;
        if (this.bytes) {
          const off = Number(offset);
          if (!Number.isSafeInteger(off) || off < 0) return;
          const bytes = this.bytes.subarray(off, off + length);
          if (!bytes || bytes.length !== length) return;
          yield bytes;
        } else {
          const bytes = await this.source.readExactly(offset, take, { signal });
          throwIfSignalAborted(signal);
          if (!bytes || bytes.length !== length) return;
          yield bytes;
        }
        done += take;
      }
    }
  }

  attachSource(source, { discardBytes = false } = {}) {
    this.source = source;
    this.fileSize = source.size;
    if (discardBytes) this.bytes = null;
    return this;
  }

  finalize() {
    const byAddr = (a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
    this.segments.sort(byAddr);
    this.sections.sort(byAddr);
    this._mappingLookups.segments = null;
    this._mappingLookups.sections = null;
    this._mappingLookups.virtual = null;
    this._mappingLookups.offsets = null;
    this._mappingSorted.segments = true;
    this._mappingSorted.sections = true;
    this.symbols.sort(byAddr);
    this.exports.sort(byAddr);
    this.relocations.sort(byAddr);
    this.functions = mergeFunctionSeeds(this.functions, { sections:this.sections, segments:this.segments });
    this.imports = dedupeImports(this.imports);
    this.libraries = [...new Set(this.libraries.filter(Boolean))];
    this._finalized = true;
    return this;
  }

  summary() {
    return {
      format: this.format,
      arch: this.arch,
      bits: this.bits,
      endian: this.endian,
      platform: this.platform,
      imageBase: this.imageBase,
      entrypoint: this.entrypoint,
      segments: this.segments.length,
      sections: this.sections.length,
      imports: this.imports.length,
      exports: this.exports.length,
      symbols: this.symbols.length,
      relocations: this.relocations.length,
      functions: this.functions.length,
      libraries: this.libraries.length,
      warnings: [...this.warnings],
    };
  }

  toJSON() {
    const convert = (v) => {
      if (typeof v === 'bigint') return v < 0n ? '-0x' + (-v).toString(16).toUpperCase() : '0x' + v.toString(16).toUpperCase();
      if (Array.isArray(v)) return v.map(convert);
      if (v && typeof v === 'object') {
        const out = {};
        for (const [k, x] of Object.entries(v)) Object.defineProperty(out, k, { value: convert(x), enumerable: true, configurable: true, writable: true });
        return out;
      }
      return v;
    };
    return convert({
      ...this.summary(),
      libraries: this.libraries,
      segments: this.segments,
      sections: this.sections,
      imports: this.imports,
      exports: this.exports,
      symbols: this.symbols,
      relocations: this.relocations,
      functions: this.functions,
      metadata: this.metadata,
    });
  }
}

const EXACT_FUNCTION_START_SOURCES = new Set([
  'entrypoint', 'export', 'exception', 'unwind', 'function_starts',
  'tls-callback', 'guard-cf', 'constructor',
]);

export function functionSeed(address, opts = {}) {
  const canonicalAddress = strictBigIntOrNull(address);
  if (canonicalAddress === null) throw new TypeError('function-seed-address-must-be-exact-integer');
  const size = opts.size == null ? null : strictBigIntOrNull(opts.size);
  if (opts.size != null && size === null) throw new TypeError('function-seed-size-must-be-exact-integer');
  const end = opts.end == null ? null : strictBigIntOrNull(opts.end);
  if (opts.end != null && end === null) throw new TypeError('function-seed-end-must-be-exact-integer');
  const source = opts.source || 'heuristic';
  const confidence = finiteConfidence(opts.confidence, 0.5);
  const hasExtent = size != null || end != null;
  return {
    address: canonicalAddress, size, end, name: opts.name || null,
    source, confidence, kind: opts.kind || 'function',
    exactFunctionStart: opts.exactFunctionStart === true,
    exactFunctionStartConfidence: opts.exactFunctionStartConfidence == null
      ? (opts.exactFunctionStart === true || EXACT_FUNCTION_START_SOURCES.has(source) ? confidence : null)
      : finiteConfidence(opts.exactFunctionStartConfidence, 0),
    functionStartEvidence: opts.functionStartEvidence || null,
    extentSource: opts.extentSource || (hasExtent ? source : null),
    extentConfidence: opts.extentConfidence == null ? (hasExtent ? confidence : null)
      : finiteConfidence(opts.extentConfidence, 0.5),
    extentInherited: !!opts.extentInherited,
    callingConvention: opts.callingConvention || null,
    abiMetadata: opts.abiMetadata == null ? null : { ...opts.abiMetadata },
  };
}


function createMonotonicRegionLookup(regions) {
  const ordered = regions.map((region, order) => ({
    region,
    order,
    start: BigInt(region.address),
    size: BigInt(region.size),
    end: BigInt(region.address) + BigInt(region.size),
  })).sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : a.order - b.order);

  const heap = createSizeOrderMinHeap();
  let cursor = 0;
  let lastAddress = null;

  const reset = () => {
    cursor = 0;
    heap.clear();
    lastAddress = null;
  };

  return (address) => {
    const value = BigInt(address);
    if (lastAddress !== null && value < lastAddress) reset();
    lastAddress = value;
    while (cursor < ordered.length && ordered[cursor].start <= value) heap.push(ordered[cursor++]);
    while (heap.size() > 0 && heap.top().end <= value) heap.pop();
    const best = heap.top();
    return best ? best.region : null;
  };
}

export function mergeFunctionSeeds(input, context = {}) {
  const rank = { symbol: 5, 'ifunc-resolver': 5, exception: 4, unwind: 4, function_starts: 4, constructor: 4, export: 3, entrypoint: 2, heuristic: 1 };
  const m = new Map();
  for (const f0 of input || []) {
    if (f0 == null || f0.address == null) continue;
    const confidence = finiteConfidence(f0.confidence, 0.5);
    const exactFunctionStartConfidence = f0.exactFunctionStartConfidence == null
      ? (f0.exactFunctionStart === true || (!Array.isArray(f0.sources) && EXACT_FUNCTION_START_SOURCES.has(f0.source)) ? confidence : null)
      : finiteConfidence(f0.exactFunctionStartConfidence, 0);
    const address = strictBigIntOrNull(f0.address);
    if (address === null) continue;
    const size = f0.size == null ? null : strictBigIntOrNull(f0.size);
    const end = f0.end == null ? null : strictBigIntOrNull(f0.end);
    // Raw providers may use exact numbers or numeric strings, but structured,
    // fractional, unsafe, and malformed extents are not promoted through
    // BigInt() coercion. Drop that seed at the canonical boundary (#5891).
    if ((f0.size != null && size === null) || (f0.end != null && end === null)) continue;
    const f = {
      ...f0,
      address,
      size,
      end,
      confidence,
      exactFunctionStartConfidence,
      extentConfidence: f0.extentConfidence == null ? null : finiteConfidence(f0.extentConfidence, 0.5),
    };
    if ((f.size != null || f.end != null) && !f.extentSource) f.extentSource = f.source || 'unknown';
    if ((f.size != null || f.end != null) && f.extentConfidence == null) f.extentConfidence = Number(f.confidence ?? 0);
    const k = f.address.toString();
    const prev = m.get(k);
    if (!prev) { m.set(k, f); continue; }
    const prevRank = rank[prev.source] || 0;
    const curRank = rank[f.source] || 0;
    const best = curRank > prevRank || (curRank === prevRank && (f.confidence || 0) > (prev.confidence || 0)) ? f : prev;
    const other = best === f ? prev : f;
    if (!best.name && other.name) best.name = other.name;
    if (!best.functionStartEvidence) best.functionStartEvidence = other.functionStartEvidence || null;
    if (!best.callingConvention && other.callingConvention) best.callingConvention = other.callingConvention;
    if (!best.abiMetadata && other.abiMetadata) best.abiMetadata = { ...other.abiMetadata };
    let inheritedExtent = false;
    const bestHasExtent = best.size != null || best.end != null;
    const otherHasExtent = other.size != null || other.end != null;
    if (!bestHasExtent && otherHasExtent) {
      best.size = other.size ?? null;
      best.end = other.end ?? null;
      inheritedExtent = true;
    }
    if (inheritedExtent) {
      best.extentSource = other.extentSource || other.source || 'unknown';
      best.extentConfidence = Number(other.extentConfidence ?? other.confidence ?? 0);
      best.extentInherited = true;
    } else if ((best.size != null || best.end != null) && !best.extentSource) {
      best.extentSource = best.source || 'unknown';
      best.extentConfidence = Number(best.confidence ?? 0);
    }
    best.sources = [...new Set([...(prev.sources || [prev.source]), ...(f.sources || [f.source])])];
    const exactConfidences = [prev.exactFunctionStartConfidence, f.exactFunctionStartConfidence]
      .filter((value) => Number.isFinite(value));
    best.exactFunctionStartConfidence = exactConfidences.length ? Math.max(...exactConfidences) : null;
    // Exactness authority and its confidence must come from the SAME evidence
    // record: adopting the exact marker of one seed while inflating the merged
    // confidence with an unrelated seed's score would synthesize
    // exactFunctionStart+high-confidence evidence that neither input carried
    // (#5950).
    const exactCarrier = prev.exactFunctionStart ? prev : (f.exactFunctionStart ? f : null);
    if (prev.exactFunctionStart && f.exactFunctionStart) {
      // Both records carry the exact marker: their confidences agree in kind.
      best.exactFunctionStart = true;
      best.confidence = Math.max(prev.confidence || 0, f.confidence || 0);
    } else if (exactCarrier) {
      // Only one record proved exactness: the merged confidence is that
      // record's own score, never the unrelated seed's (#5950).
      best.exactFunctionStart = true;
      best.confidence = exactCarrier.confidence || 0;
    } else {
      best.exactFunctionStart = false;
      best.confidence = Math.max(prev.confidence || 0, f.confidence || 0);
    }
    m.set(k, best);
  }
  const out = [...m.values()].sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  const regions = [...(context.sections || []), ...(context.segments || [])]
    .filter((r) => r && r.address != null && r.size != null && BigInt(r.size) > 0n && r.perms?.execute)
    .sort((a,b) => BigInt(a.size) < BigInt(b.size) ? -1 : BigInt(a.size) > BigInt(b.size) ? 1 : 0);
  const regionFor = createMonotonicRegionLookup(regions);
  for (let i = 0; i < out.length; i++) {
    const f = out[i];
    if (f.end == null && f.size != null) f.end = f.address + f.size;
    if (f.size == null && f.end != null && f.end > f.address) f.size = f.end - f.address;
    if (f.size == null && i + 1 < out.length && out[i + 1].address > f.address) {
      const next = out[i + 1];
      const sources = new Set(f.sources || [f.source]);
      const nextSources = new Set(next.sources || [next.source]);
      const provenFunctionStarts = sources.has('function_starts') && nextSources.has('function_starts');
      const delta = next.address - f.address;
      const currentRegion = regionFor(f.address), nextRegion = regionFor(next.address);
      const sameCanonicalRegion = !regions.length || (currentRegion != null && currentRegion === nextRegion);
      const withinRegionEnd = !currentRegion || next.address <= BigInt(currentRegion.address) + BigInt(currentRegion.size);
      if (provenFunctionStarts && sameCanonicalRegion && withinRegionEnd && delta <= 0x1000000n) {
        f.size = delta; f.end = next.address;
        f.extentInferred = true;
        f.extentConfidence = Math.min(0.35, Number(f.confidence ?? 0.35));
        f.extentSource = 'next-function-start';
      }
    }
  }
  return out;
}

function dedupeImports(input) {
  const byKey = new Map();
  const out = [];
  for (const i of input || []) {
    const key = importIdentityKey(i);
    const prev = key === null ? undefined : byKey.get(key);
    if (prev) {
      if (prev.address == null && i.address != null) prev.address = i.address;
      if (!prev.source && i.source) prev.source = i.source;
      if (i.sites) prev.sites.push(...i.sites);
      continue;
    }
    const record = { ...i, sites: i.sites ? [...i.sites] : [] };
    out.push(record);
    if (key !== null) byKey.set(key, record);
  }
  for (const i of out) {
    if (i.sites) {
      const seen = new Set();
      i.sites = i.sites.filter((s) => {
        const key = siteIdentityKey(s);
        if (key === null) return true;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
    }
  }
  return out;
}
