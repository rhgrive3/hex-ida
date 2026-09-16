import { sectionHasMappedAddress } from './audit.js';
import { fnv64ByteView } from '../core/identity/fnv64.js';

const FNV_OFFSET_HI = 0xcbf29ce4;
const FNV_OFFSET_LO = 0x84222325;

/*
 * FNV-1a 64-bit without a BigInt operation per byte.
 * The two uint32 limbs produce the exact canonical 64-bit digest but avoid
 * millions of BigInt multiplications on large mobile binaries.
 */
function fnv1a64State(bytes, seed = null) {
  let hi, lo;
  if (seed == null) {
    hi = FNV_OFFSET_HI;
    lo = FNV_OFFSET_LO;
  } else if (typeof seed === 'bigint') {
    hi = Number((seed >> 32n) & 0xffffffffn) >>> 0;
    lo = Number(seed & 0xffffffffn) >>> 0;
  } else if (typeof seed === 'object' && seed) {
    // Only a record with own data properties may supply resumable limbs.
    // Do not invoke accessors or coerce structured values while validating
    // this hash identity boundary (#5922).
    let proto, hiDescriptor, loDescriptor;
    try {
      proto = Object.getPrototypeOf(seed);
      hiDescriptor = Object.getOwnPropertyDescriptor(seed, 'hi');
      loDescriptor = Object.getOwnPropertyDescriptor(seed, 'lo');
    } catch {
      throw new TypeError('FNV seed must be BigInt or {hi, lo}');
    }
    if (Array.isArray(seed) || (proto !== Object.prototype && proto !== null)
      || !hiDescriptor || !loDescriptor
      || !Object.hasOwn(hiDescriptor, 'value') || !Object.hasOwn(loDescriptor, 'value')) {
      throw new TypeError('FNV seed must be BigInt or {hi, lo}');
    }
    const hiLimb = hiDescriptor.value, loLimb = loDescriptor.value;
    if (!Number.isSafeInteger(hiLimb) || hiLimb < 0 || hiLimb > 0xffffffff
      || !Number.isSafeInteger(loLimb) || loLimb < 0 || loLimb > 0xffffffff) {
      throw new TypeError('FNV seed must be BigInt or {hi, lo}');
    }
    hi = hiLimb >>> 0;
    lo = loLimb >>> 0;
  } else throw new TypeError('FNV seed must be BigInt or {hi, lo}');

  // Keep the seed boundary and indexed byte coercion unchanged; the
  // shared integer-carry multiply computes the same limbs without divisions.
  const state = fnv64ByteView(bytes, lo, hi);
  return { hi: state.high, lo: state.low };
}

export function fnv1a64(bytes, seed = null) {
  const x = fnv1a64State(bytes, seed);
  return (BigInt(x.hi) << 32n) | BigInt(x.lo);
}

export const fnv1a64BigInt = fnv1a64;

export function fingerprintBytes(bytes) {
  return digestHex(fnv1a64State(bytes));
}

function functionFingerprintResult(bytes, fn) {
  if (!bytes || !bytes.length) return null;
  return {
    algorithm: 'fnv1a64',
    hash: fingerprintBytes(bytes),
    bytes: bytes.length,
    truncated: fn.size != null && BigInt(fn.size) > BigInt(bytes.length),
  };
}

function byteCountOption(value, fallback, minimum = 1) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return fallback;
  return Math.max(minimum, value);
}

/**
 * Keep the historical synchronous API for resident BinaryImage instances while
 * allowing source-backed images to perform the same bounded read asynchronously.
 * Callers that need to support both forms may simply `await` the result.
 */
export function fingerprintFunction(image, fn, opts = {}) {
  const maxBytes = byteCountOption(opts.maxBytes, 1 << 20, 16);
  let size = fn.size == null ? BigInt(byteCountOption(opts.fallbackBytes, 64)) : BigInt(fn.size);
  if (size <= 0n) return null;
  if (size > BigInt(maxBytes)) size = BigInt(maxBytes);
  const length = Number(size);

  if (image.bytes && typeof image.readVirtual === 'function') {
    return functionFingerprintResult(image.readVirtual(fn.address, length), fn);
  }
  if (typeof image.readVirtualAsync === 'function') {
    return Promise.resolve(image.readVirtualAsync(fn.address, length))
      .then((bytes) => functionFingerprintResult(bytes, fn));
  }
  if (typeof image.readVirtual === 'function') {
    return functionFingerprintResult(image.readVirtual(fn.address, length), fn);
  }
  return null;
}

function residentMappingChunk(image, mapping, offset, length) {
  const fileOffset = BigInt(mapping.fileOffset) + BigInt(offset);
  const start = Number(fileOffset);
  if (!Number.isSafeInteger(start) || start < 0 || start + length > image.bytes.length) return null;
  return image.bytes.subarray(start, start + length);
}

async function sourceMappingChunk(image, mapping, offset, length) {
  const fileOffset = BigInt(mapping.fileOffset) + BigInt(offset);
  if (image.source) return image.source.readExactly(fileOffset, length);
  if (mapping.address != null && typeof image.readVirtualAsync === 'function') {
    return image.readVirtualAsync(BigInt(mapping.address) + BigInt(offset), length);
  }
  return null;
}

function requireMappingChunk(bytes, expectedLength) {
  if (!bytes || bytes.length !== expectedLength) {
    throw new RangeError('binary-fingerprint-short-read');
  }
  return bytes;
}

function compareFingerprintSpans(a, b) {
  if (a.start < b.start) return -1;
  if (a.start > b.start) return 1;
  if (a.end < b.end) return -1;
  if (a.end > b.end) return 1;
  if (a.bias == null) return b.bias == null ? 0 : 1;
  if (b.bias == null) return -1;
  if (a.bias < b.bias) return -1;
  if (a.bias > b.bias) return 1;
  return 0;
}

function collectFingerprintSpans(mappings, spans, unrepresentable) {
  for (const mapping of mappings) {
    if (mapping.fileOffset == null) {
      unrepresentable.push(mapping);
      continue;
    }
    const start = BigInt(mapping.fileOffset);
    spans.push({
      start,
      end: start + BigInt(mapping.fileSize),
      bias: mapping.address == null ? null : start - BigInt(mapping.address),
      name: mapping.name,
      perms: mapping.perms,
    });
  }
}

function fingerprintRanges(image, executableOnly) {
  const sections = (image.sections || []).filter((x) => BigInt(x.fileSize ?? 0) > 0n && (!executableOnly || (x.perms?.execute && sectionHasMappedAddress(x))));
  const segments = (image.segments || []).filter((x) => BigInt(x.fileSize ?? 0) > 0n && (!executableOnly || x.perms?.execute));

  const spans = [];
  const unrepresentable = [];
  collectFingerprintSpans(sections, spans, unrepresentable);
  collectFingerprintSpans(segments, spans, unrepresentable);
  if (!spans.length) return unrepresentable;

  spans.sort(compareFingerprintSpans);

  // `spans` is ordered by file offset, so one frontier is enough to build the
  // canonical file-range union. Each span is visited once after the sort; no
  // accumulated prefix is rescanned or re-sorted as the union grows.
  const ranges = [];
  let coveredEnd = null;
  for (const span of spans) {
    const start = coveredEnd != null && span.start < coveredEnd ? coveredEnd : span.start;
    if (start >= span.end) continue;
    ranges.push({
      name: span.name,
      address: span.bias == null ? null : start - span.bias,
      fileOffset: start,
      fileSize: span.end - start,
      perms: span.perms,
    });
    coveredEnd = span.end;
  }

  for (const mapping of unrepresentable) ranges.push(mapping);
  return ranges;
}

function fingerprintImageResult(state, total, executableOnly) {
  return {
    algorithm: 'fnv1a64',
    hash: digestHex(state),
    bytes: total,
    scope: executableOnly ? 'executable-mappings' : 'all-mappings',
  };
}

/**
 * Resident images remain synchronous for API compatibility. Source-backed
 * images return a Promise and stream bounded chunks without materializing the
 * complete binary in memory (#387).
 */
export function fingerprintImage(image, opts = {}) {
  const executableOnly = opts.executableOnly !== false;
  const chunkBytes = Math.min(1 << 20, byteCountOption(opts.chunkBytes, 256 * 1024, 4096));
  const ranges = fingerprintRanges(image, executableOnly);

  if (image.bytes) {
    let state = { hi: FNV_OFFSET_HI, lo: FNV_OFFSET_LO }, total = 0;
    for (const mapping of ranges) {
      const size = BigInt(mapping.fileSize);
      for (let off = 0n; off < size;) {
        const take = Number(size - off < BigInt(chunkBytes) ? size - off : BigInt(chunkBytes));
        const bytes = requireMappingChunk(residentMappingChunk(image, mapping, off, take), take);
        state = fnv1a64State(bytes, state);
        total += bytes.length;
        off += BigInt(bytes.length);
      }
    }
    return fingerprintImageResult(state, total, executableOnly);
  }

  return (async () => {
    let state = { hi: FNV_OFFSET_HI, lo: FNV_OFFSET_LO }, total = 0;
    const maxReadLength = Number.isSafeInteger(image.source?.maxReadLength) && image.source.maxReadLength > 0
      ? image.source.maxReadLength
      : chunkBytes;
    const sourceChunkBytes = Math.min(chunkBytes, maxReadLength);
    for (const mapping of ranges) {
      const size = BigInt(mapping.fileSize);
      for (let off = 0n; off < size;) {
        const take = Number(size - off < BigInt(sourceChunkBytes) ? size - off : BigInt(sourceChunkBytes));
        const bytes = requireMappingChunk(await sourceMappingChunk(image, mapping, off, take), take);
        state = fnv1a64State(bytes, state);
        total += bytes.length;
        off += BigInt(bytes.length);
      }
    }
    return fingerprintImageResult(state, total, executableOnly);
  })();
}

function digestHex(state) {
  return state.hi.toString(16).padStart(8, '0') + state.lo.toString(16).padStart(8, '0');
}
