import { inRange } from './reader.js';

function bigintOrNull(v) {
  if (v == null) return null;
  return typeof v === 'bigint' ? v : BigInt(v);
}

function strictBigIntOrNull(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  try { return BigInt(value.trim()); } catch { return null; }
}

function finiteConfidence(value, fallback = 0.5) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

function normalizePerms(p) {
  if (!p) return { read: false, write: false, execute: false };
  return { read: !!p.read, write: !!p.write, execute: !!p.execute };
}

function minBigInt(a, b) { return a < b ? a : b; }

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
    this.imageBase = bigintOrNull(meta.imageBase) ?? 0n;
    this.entrypoint = bigintOrNull(meta.entrypoint);
    this.fileOffset = bigintOrNull(meta.fileOffset) ?? 0n;
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
    this.fileSize = bigintOrNull(meta.fileSize) ?? defaultFileSize;
    this.segments = [];
    this.sections = [];
    this.imports = [];
    this.exports = [];
    this.symbols = [];
    this.relocations = [];
    this.functions = [];
    this.unwindEntries = [];
    this.libraries = [];
    this.warnings = [];
    this.metadata = meta.metadata || {};
  }

  addSegment(s) {
    const address = BigInt(s.address ?? 0);
    const size = BigInt(s.size ?? 0);
    const fileOffset = BigInt(s.fileOffset ?? 0);
    const fileSize = BigInt(s.fileSize ?? 0);
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
    return seg;
  }

  addSection(s) {
    const address = BigInt(s.address ?? 0);
    const size = BigInt(s.size ?? 0);
    const fileOffset = BigInt(s.fileOffset ?? 0);
    const fileSize = BigInt(s.fileSize ?? s.size ?? 0);
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
    const candidates = [];
    for (const s of this.sections) {
      if (s.address == null || !inRange(o, s.fileOffset, s.fileSize)) continue;
      candidates.push(s);
    }
    for (const s of this.segments) {
      if (!inRange(o, s.fileOffset, s.fileSize)) continue;
      candidates.push(s);
    }
    candidates.sort((a, b) => (a.size < b.size ? -1 : a.size > b.size ? 1 : 0));
    for (const s of candidates) {
      const a = s.address + (o - s.fileOffset);
      const owner = this._virtualMappingAt(a);
      if (owner) {
        const delta = a - owner.address;
        const fileSize = owner.fileSize ?? 0n;
        if (delta < fileSize && (owner.fileOffset + delta) === o) {
          return a;
        }
      }
    }
    return null;
  }

  sectionAt(address) {
    const a = strictBigIntOrNull(address);
    if (a === null || a < 0n) return null;
    return this.sections.find((s) => inRange(a, s.address, s.size)) || null;
  }

  segmentAt(address) {
    const a = strictBigIntOrNull(address);
    if (a === null || a < 0n) return null;
    return this.segments.find((s) => inRange(a, s.address, s.size)) || null;
  }

  _virtualMappingAt(address) {
    const a = strictBigIntOrNull(address);
    if (a === null || a < 0n) return null;
    let best = null;
    for (const s of this.sections) {
      if (s.size > 0n && inRange(a, s.address, s.size) && (!best || s.size < best.size)) best = s;
    }
    for (const s of this.segments) {
      if (s.size > 0n && inRange(a, s.address, s.size) && (!best || s.size < best.size)) best = s;
    }
    return best;
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
    for (const m of this.sections) consider(m);
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

  _virtualReadPlan(address, size) {
    let current;
    let remaining;
    current = strictBigIntOrNull(address);
    remaining = strictBigIntOrNull(size);
    if (current === null || remaining === null) return null;
    if (current < 0n || remaining < 0n || remaining > BigInt(Number.MAX_SAFE_INTEGER)) return null;
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
    const plan = this._virtualReadPlan(address, size);
    if (!plan) return null;
    const total = plan.reduce((sum, chunk) => sum + Number(chunk.length), 0);
    const out = new Uint8Array(total);
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
    const plan = this._virtualReadPlan(address, size);
    if (!plan) return null;
    const total = plan.reduce((sum, chunk) => sum + Number(chunk.length), 0);
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of plan) {
      const length = Number(chunk.length);
      if (chunk.kind === 'zero') { cursor += length; continue; }
      if (chunk.offset < 0n || chunk.offset > this.fileSize || chunk.length > this.fileSize - chunk.offset) return null;
      const bytes = await this.source.readExactly(chunk.offset, chunk.length);
      if (!bytes || bytes.length !== length) return null;
      out.set(bytes, cursor);
      cursor += length;
    }
    return out;
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
    this.symbols.sort(byAddr);
    this.exports.sort(byAddr);
    this.relocations.sort(byAddr);
    this.functions = mergeFunctionSeeds(this.functions, { sections:this.sections, segments:this.segments });
    this.imports = dedupeImports(this.imports);
    this.libraries = [...new Set(this.libraries.filter(Boolean))];
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

export function functionSeed(address, opts = {}) {
  const source = opts.source || 'heuristic';
  const confidence = finiteConfidence(opts.confidence, 0.5);
  const size = opts.size == null ? null : BigInt(opts.size);
  const end = opts.end == null ? null : BigInt(opts.end);
  const hasExtent = size != null || end != null;
  return {
    address: BigInt(address), size, end, name: opts.name || null,
    source, confidence, kind: opts.kind || 'function',
    exactFunctionStart: opts.exactFunctionStart === true,
    functionStartEvidence: opts.functionStartEvidence || null,
    extentSource: opts.extentSource || (hasExtent ? source : null),
    extentConfidence: opts.extentConfidence == null ? (hasExtent ? confidence : null)
      : finiteConfidence(opts.extentConfidence, 0.5),
    extentInherited: !!opts.extentInherited,
    callingConvention: opts.callingConvention || null,
    abiMetadata: opts.abiMetadata == null ? null : { ...opts.abiMetadata },
  };
}

export function mergeFunctionSeeds(input, context = {}) {
  const rank = { symbol: 5, exception: 4, unwind: 4, function_starts: 4, export: 3, entrypoint: 2, heuristic: 1 };
  const m = new Map();
  for (const f0 of input || []) {
    if (f0 == null || f0.address == null) continue;
    const f = { ...f0, address: BigInt(f0.address), confidence: finiteConfidence(f0.confidence, 0.5), extentConfidence: f0.extentConfidence == null ? null : finiteConfidence(f0.extentConfidence, 0.5) };
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
    best.exactFunctionStart = !!(prev.exactFunctionStart || f.exactFunctionStart);
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
    best.confidence = Math.max(prev.confidence || 0, f.confidence || 0);
    m.set(k, best);
  }
  const out = [...m.values()].sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  const regions = [...(context.sections || []), ...(context.segments || [])]
    .filter((r) => r && r.address != null && r.size != null && BigInt(r.size) > 0n && r.perms?.execute)
    .sort((a,b) => BigInt(a.size) < BigInt(b.size) ? -1 : BigInt(a.size) > BigInt(b.size) ? 1 : 0);
  const regionFor = (addr) => regions.find((r) => BigInt(addr) >= BigInt(r.address) && BigInt(addr) < BigInt(r.address) + BigInt(r.size)) || null;
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
  const m = new Map();
  for (const i of input || []) {
    const scalar = (value) => typeof value === 'bigint' ? value.toString() : value == null ? '' : String(value);
    const key = [i.library || '', i.name || '', scalar(i.ordinal), i.weak ? '1' : '0', scalar(i.addend ?? 0n), scalar(i.pointerFormat), scalar(i.type), scalar(i.version), i.versionLibrary || ''].join('\0');
    const prev = m.get(key);
    if (!prev) {
      m.set(key, { ...i, sites: i.sites ? [...i.sites] : [] });
      continue;
    }
    if (!prev.address && i.address) prev.address = i.address;
    if (!prev.source && i.source) prev.source = i.source;
    if (i.sites) prev.sites.push(...i.sites);
  }
  for (const i of m.values()) {
    if (i.sites) {
      const seen = new Set();
      i.sites = i.sites.filter((s) => {
        const scalar = (value) => typeof value === 'bigint' ? value.toString() : value == null ? '' : String(value);
        const key = [scalar(s.address), scalar(s.offset), s.kind || '', scalar(s.type), scalar(s.addend), scalar(s.pointerFormat), s.weak ? '1' : '0'].join(':');
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
    }
  }
  return [...m.values()];
}
