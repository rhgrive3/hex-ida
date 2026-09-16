import { asAddress, DebugAdapterError } from '../debug/adapter.js';

export const MEMORY_KINDS = Object.freeze(['object','stack','heap','global','mapped','mmio','unknown']);
export const RUNTIME_HEAP_BASE = 0x0000620000000000n;
export const RUNTIME_HEAP_SIZE = 4 * 1024 * 1024;
const MAX_REGION_SIZE = 64 * 1024 * 1024;
const MAX_TRANSFER = 4 * 1024 * 1024;
// #8983: sandbox `globals` / `memoryMappings` had no cardinality ceiling, and every region
// insertion re-scanned and re-sorted the whole list, so a caller-supplied iterable monopolized
// the launch thread (and an infinite iterable never returned). This is the admission bound for
// the synchronous sandbox memory-map build.
export const MAX_SANDBOX_REGIONS = 65_536;

function positiveCount(value, fallback, max, name) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new MemoryAccessError('invalid-argument', `${name} must be a positive safe integer`, { value });
  return n > max ? max : n;
}

function normalizePermissions(value) {
  if (value == null) value = 'rw';
  if (typeof value !== 'string' || !/^[rwx]*$/.test(value)) {
    throw new MemoryAccessError('invalid-permissions', 'memory permissions must contain only r, w, and x', { value });
  }
  return Object.freeze({ read: value.includes('r'), write: value.includes('w'), execute: value.includes('x') });
}

function strictSize(value, fallback, max, name) {
  const candidate = value == null ? fallback : value;
  let n;
  if (typeof candidate === 'number') n = candidate;
  else if (typeof candidate === 'string') {
    const text = candidate.trim();
    if (!/^\d+$/.test(text)) throw new MemoryAccessError('invalid-size', `${name} must be a positive safe integer`, { value });
    n = Number(text);
  } else {
    throw new MemoryAccessError('invalid-size', `${name} must be a positive safe integer`, { value });
  }
  if (!Number.isSafeInteger(n) || n < 1) throw new MemoryAccessError('invalid-size', `${name} must be a positive safe integer`, { value });
  if (n > max) throw new MemoryAccessError('too-large', `${name} exceeds ${max} bytes`, { value:n, max });
  return n;
}

export class MemoryAccessError extends DebugAdapterError {
  constructor(code, message, details) { super(code, message, details); this.name = 'MemoryAccessError'; }
}

function regionCollection(value, name) {
  if (value == null) return [];
  if (typeof value[Symbol.iterator] !== 'function') {
    throw new MemoryAccessError('invalid-argument', `${name} must be an iterable collection`, { name, value });
  }
  return value;
}

export class MemoryRegion {
  constructor(spec = {}) {
    this.start = asAddress(spec.start);
    this.size = strictSize(spec.size, 1, MAX_REGION_SIZE, 'region size');
    this.end = this.start + BigInt(this.size);
    if (spec.kind == null) this.kind = 'mapped';
    else if (MEMORY_KINDS.includes(spec.kind)) this.kind = spec.kind;
    else throw new MemoryAccessError('invalid-region-kind', `unsupported memory region kind: ${spec.kind}`, { kind:spec.kind, allowed:MEMORY_KINDS });
    this.name = spec.name == null ? null : String(spec.name).slice(0, 256);
    this.permissions = normalizePermissions(spec.permissions);
    this.objectId = spec.objectId == null ? null : String(spec.objectId).slice(0, 256);
    Object.freeze(this);
  }
  contains(address, size = 1) {
    const a = asAddress(address); const n = BigInt(strictSize(size, 1, MAX_REGION_SIZE, 'memory size'));
    return a >= this.start && a + n <= this.end;
  }
  toJSON() { return { start:this.start, size:this.size, kind:this.kind, name:this.name, permissions:this.permissions, objectId:this.objectId }; }
}

function startCompare(a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; }
// Index of the first region whose start >= target (regions kept sorted by start).
function lowerBoundStart(regions, target) {
  let lo = 0, hi = regions.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (regions[mid].start < target) lo = mid + 1; else hi = mid; }
  return lo;
}

export class RuntimeMemoryMap {
  constructor(regions = [], options = {}) {
    this.maxTransfer = strictSize(options.maxTransfer, 1024 * 1024, MAX_TRANSFER, 'maxTransfer');
    this.maxRegions = positiveCount(options.maxRegions, MAX_SANDBOX_REGIONS, MAX_SANDBOX_REGIONS, 'maxRegions');
    this.regions = [];
    for (const region of regionCollection(regions, 'regions')) this.map(region);
  }
  map(spec) {
    if (this.regions.length >= this.maxRegions) {
      throw new MemoryAccessError('region-limit', `memory map exceeds the maximum of ${this.maxRegions} regions`, { maxRegions:this.maxRegions });
    }
    const region = spec instanceof MemoryRegion ? spec : new MemoryRegion(spec);
    // Regions are kept sorted by start and non-overlapping, so any region overlapping the new
    // one must be an immediate neighbour at the insertion point; only the predecessor and the
    // successor need checking. The predecessor is checked first so the reported `existing` matches
    // the smallest-start overlapping region, exactly like the previous full scan.
    const at = lowerBoundStart(this.regions, region.start);
    const prev = at > 0 ? this.regions[at - 1] : null;
    const next = at < this.regions.length ? this.regions[at] : null;
    for (const existing of (prev ? [prev, next] : [next])) {
      if (existing && region.start < existing.end && region.end > existing.start) {
        throw new MemoryAccessError('overlap', 'memory regions may not overlap', { region:region.toJSON(), existing:existing.toJSON() });
      }
    }
    this.regions.splice(at, 0, region);
    return region;
  }
  // Bulk-load already-normalised, individually-valid regions in one sort + one adjacency pass, so
  // building an N-region map is O(N log N) rather than N separate O(N) insert/scan/sort rounds.
  loadAll(regions) {
    const incoming = [...regions];
    if (this.regions.length + incoming.length > this.maxRegions) {
      throw new MemoryAccessError('region-limit', `memory map exceeds the maximum of ${this.maxRegions} regions`, { maxRegions:this.maxRegions, attempted:incoming.length });
    }
    incoming.sort(startCompare);
    for (let i = 1; i < incoming.length; i++) {
      const prev = incoming[i - 1], region = incoming[i];
      if (region.start < prev.end) {
        throw new MemoryAccessError('overlap', 'memory regions may not overlap', { region:region.toJSON(), existing:prev.toJSON() });
      }
    }
    if (!this.regions.length) { this.regions = incoming; return this; }
    for (const region of incoming) this.map(region);
    return this;
  }
  unmap(start) {
    const key = asAddress(start); const before = this.regions.length;
    this.regions = this.regions.filter((r) => r.start !== key);
    return before !== this.regions.length;
  }
  find(address, size = 1) {
    const a = asAddress(address); const n = strictSize(size, 1, this.maxTransfer, 'memory size');
    // Non-overlapping regions sorted by start: at most one can contain [a, a+n) and it is the
    // last region with start <= a. Binary search keeps per-access lookup O(log R) (#8983).
    const at = lowerBoundStart(this.regions, a);
    const candidate = (at < this.regions.length && this.regions[at].start === a)
      ? this.regions[at]
      : (at > 0 ? this.regions[at - 1] : null);
    return candidate && candidate.contains(a, n) ? candidate : null;
  }
  assert(address, size, access = 'read') {
    if (access !== 'read' && access !== 'write' && access !== 'execute') throw new MemoryAccessError('invalid-access', `unsupported memory access: ${access}`, { access });
    const a = asAddress(address); const n = strictSize(size, 1, this.maxTransfer, 'memory size');
    const region = this.find(a, n);
    if (!region) throw new MemoryAccessError('oob', `unmapped ${access} at 0x${a.toString(16)}`, { address:a, size:n, access });
    if (access === 'read' && !region.permissions.read) throw new MemoryAccessError('permission', 'memory region is not readable', { region:region.toJSON() });
    if (access === 'write' && !region.permissions.write) throw new MemoryAccessError('permission', 'memory region is not writable', { region:region.toJSON() });
    if (access === 'execute' && !region.permissions.execute) throw new MemoryAccessError('permission', 'memory region is not executable', { region:region.toJSON() });
    if (region.kind === 'mmio' && access === 'write') throw new MemoryAccessError('mmio-unknown', 'MMIO-like writes require an explicit backend handler', { region:region.toJSON() });
    return region;
  }
  snapshot() { return this.regions.map((r) => r.toJSON()); }
}

export function createSandboxMemoryMap({ objectBase = 0x600000001000n, objectSize = 0x10000, stackTop = 0x700000000000n, stackSize = 1 << 20, heapBase = RUNTIME_HEAP_BASE, heapSize = RUNTIME_HEAP_SIZE, globals = [], mappings = [], signal = null, maxRegions = MAX_SANDBOX_REGIONS } = {}) {
  const cap = positiveCount(maxRegions, MAX_SANDBOX_REGIONS, MAX_SANDBOX_REGIONS, 'maxRegions');
  const normalizedStackSize = strictSize(stackSize, 1, MAX_REGION_SIZE, 'stack size');
  const base = [
    { start:asAddress(objectBase,'objectBase'), size:objectSize, kind:'object', permissions:'rw', name:'fake-object' },
    { start:asAddress(heapBase,'heapBase'), size:heapSize, kind:'heap', permissions:'rw', name:'fake-heap' },
    { start:asAddress(stackTop,'stackTop') - BigInt(normalizedStackSize), size:normalizedStackSize, kind:'stack', permissions:'rw', name:'stack' },
  ];
  // Consume caller iterables under an explicit cardinality bound and observe the launch signal, so
  // an arbitrary/infinite `memoryMappings` iterable can never monopolise the synchronous build past
  // its AbortSignal (#8983). Regions are then normalised once and bulk-loaded (single sort + one
  // adjacency overlap pass) instead of a full scan + full sort per insertion.
  const collected = [];
  let count = 0;
  const consume = (value, name, normalize) => {
    for (const item of regionCollection(value, name)) {
      if (signal && signal.aborted) throw new DebugAdapterError('cancelled', 'sandbox memory map build was cancelled', { kind:'cancelled' });
      if (count >= cap) throw new MemoryAccessError('region-limit', `sandbox memory map exceeds the maximum of ${cap} ${name}`, { maxRegions:cap, name });
      count += 1;
      collected.push(normalize ? normalize(item) : item);
    }
  };
  consume(globals, 'globals', (g) => ({ ...g, kind:g.kind == null ? 'global' : g.kind }));
  consume(mappings, 'mappings', null);
  const map = new RuntimeMemoryMap([], { maxRegions:cap });
  map.loadAll([...base, ...collected].map((spec) => new MemoryRegion(spec)));
  return map;
}
