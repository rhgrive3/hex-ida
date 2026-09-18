const MAX_SAFE_BYTES = BigInt(Number.MAX_SAFE_INTEGER);
const AARCH64_NOP = 0xd503201f;
const COVERAGE_READ_CHUNK_BYTES = 256 * 1024;

function asNonNegativeBigInt(value) {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*|0x[0-9a-f]+)$/i.test(value.trim())) {
    try { return BigInt(value.trim()); } catch { return null; }
  }
  return null;
}

function compareRange(left, right) {
  return left.start < right.start ? -1 : left.start > right.start ? 1 : left.end < right.end ? -1 : left.end > right.end ? 1 : 0;
}

function mergeRanges(ranges) {
  const sorted = ranges
    .filter((range) => range && range.end > range.start)
    .map((range) => ({ start:range.start, end:range.end }))
    .sort(compareRange);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end) merged.push(range);
    else if (range.end > last.end) last.end = range.end;
  }
  return merged;
}

function executableRanges(regions) {
  const ranges = [];
  for (const region of regions || []) {
    if (region?.exec !== true) continue;
    const start = asNonNegativeBigInt(region.vmAddr ?? region.address ?? region.start);
    const size = asNonNegativeBigInt(region.size);
    if (start == null || size == null || size <= 0n || region.zerofill === true) continue;
    let fileBackedSize = size;
    if (Object.prototype.hasOwnProperty.call(region, 'fileSize')) {
      const explicitFileSize = asNonNegativeBigInt(region.fileSize);
      if (explicitFileSize == null) continue;
      if (explicitFileSize < fileBackedSize) fileBackedSize = explicitFileSize;
    }
    if (fileBackedSize <= 0n) continue;
    ranges.push({ start, end:start + fileBackedSize });
  }
  return mergeRanges(ranges);
}

function exactFunctionRanges(functions, functionEnds) {
  if (!functions || !functionEnds) return [];
  const count = Math.min(functions.length ?? 0, functionEnds.length ?? 0);
  const ranges = [];
  for (let index = 0; index < count; index++) {
    const start = asNonNegativeBigInt(functions[index]);
    const end = asNonNegativeBigInt(functionEnds[index]);
    // analysisFromBinaryImage uses end=0 as the explicit "extent unknown" marker.
    if (start == null || end == null || end <= start) continue;
    ranges.push({ start, end });
  }
  return mergeRanges(ranges);
}

function intersectRanges(left, right) {
  const out = [];
  let i = 0, j = 0;
  while (i < left.length && j < right.length) {
    const a = left[i], b = right[j];
    const start = a.start > b.start ? a.start : b.start;
    const end = a.end < b.end ? a.end : b.end;
    if (end > start) out.push({ start, end });
    if (a.end < b.end) i++;
    else j++;
  }
  return mergeRanges(out);
}

function subtractRanges(outer, covered) {
  const gaps = [];
  let coveredIndex = 0;
  for (const range of outer) {
    let cursor = range.start;
    while (coveredIndex < covered.length && covered[coveredIndex].end <= cursor) coveredIndex++;
    let index = coveredIndex;
    while (index < covered.length && covered[index].start < range.end) {
      const span = covered[index];
      if (span.start > cursor) gaps.push({ start:cursor, end:span.start < range.end ? span.start : range.end });
      if (span.end > cursor) cursor = span.end;
      if (cursor >= range.end) break;
      index++;
    }
    if (cursor < range.end) gaps.push({ start:cursor, end:range.end });
  }
  return gaps;
}

function sumBytes(ranges) {
  return ranges.reduce((sum, range) => sum + (range.end - range.start), 0n);
}

function safeByteCount(value) {
  if (value < 0n || value > MAX_SAFE_BYTES) throw new RangeError('function-discovery-coverage-byte-count-out-of-range');
  return Number(value);
}

function isAarch64(architecture) {
  const arch = String(architecture || '').toLowerCase();
  return arch === 'arm64' || arch === 'arm64e' || arch === 'arm64ec' || arch === 'aarch64' || arch === 'aarch64_be';
}

function readWord(bytes, offset, endian) {
  if (endian === 'big') {
    return (((bytes[offset] << 24) >>> 0) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
  }
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | ((bytes[offset + 3] << 24) >>> 0)) >>> 0;
}

function appendClassified(out, start, end, klass) {
  if (end <= start) return;
  const last = out[out.length - 1];
  if (last && last.class === klass && last.end === start) last.end = end;
  else out.push({ start, end, class:klass });
}

function classifyWords(out, bytes, start, endian) {
  for (let offset = 0; offset + 4 <= bytes.length; offset += 4) {
    const word = readWord(bytes, offset, endian);
    const wordStart = start + BigInt(offset);
    const klass = word === 0 || word === AARCH64_NOP ? 'padding' : 'unknown';
    appendClassified(out, wordStart, wordStart + 4n, klass);
  }
}

async function classifyGap(gap, options) {
  const out = [];
  const { architecture, endian, readBytes, signal } = options;
  if (!isAarch64(architecture) || typeof readBytes !== 'function') {
    appendClassified(out, gap.start, gap.end, 'unknown');
    return out;
  }

  const alignedStart = (gap.start + 3n) & ~3n;
  const alignedEnd = gap.end & ~3n;
  if (gap.start < alignedStart) appendClassified(out, gap.start, alignedStart < gap.end ? alignedStart : gap.end, 'unknown');
  if (alignedStart < alignedEnd) {
    let cursor = alignedStart;
    while (cursor < alignedEnd) {
      if (signal?.aborted) throw Object.assign(new Error('Function discovery coverage cancelled'), { name:'AbortError' });
      const remaining = alignedEnd - cursor;
      const take = remaining < BigInt(COVERAGE_READ_CHUNK_BYTES) ? remaining : BigInt(COVERAGE_READ_CHUNK_BYTES);
      let bytes = null;
      try { bytes = await readBytes(cursor, take); } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
      }
      const expected = Number(take);
      if (!(bytes instanceof Uint8Array) || bytes.length !== expected) {
        appendClassified(out, cursor, cursor + take, 'unknown');
      } else {
        classifyWords(out, bytes, cursor, endian);
      }
      cursor += take;
    }
  }
  if (alignedEnd < gap.end) {
    const tailStart = alignedEnd > gap.start ? alignedEnd : gap.start;
    appendClassified(out, tailStart, gap.end, 'unknown');
  }
  return out;
}

/**
 * Account for file-backed executable bytes without creating function starts.
 * `functions`/`functionEnds` must be the already-validated exact extent transport;
 * end=0 is treated as unknown. Every byte not covered by one of those extents is
 * reported in `unclassified`, with `padding` used only for positive AArch64
 * all-zero-word or architectural NOP evidence.
 */
export async function executableByteCoverage({
  regions = [], functions = null, functionEnds = null,
  architecture = '', endian = 'little', readBytes = null, signal = null,
} = {}) {
  const executable = executableRanges(regions);
  const exact = exactFunctionRanges(functions, functionEnds);
  const attributed = intersectRanges(executable, exact);
  const gaps = subtractRanges(executable, attributed);
  const unclassified = [];
  for (const gap of gaps) {
    const classified = await classifyGap(gap, { architecture, endian, readBytes, signal });
    for (const range of classified) appendClassified(unclassified, range.start, range.end, range.class);
  }
  return {
    executableBytes:safeByteCount(sumBytes(executable)),
    attributedBytes:safeByteCount(sumBytes(attributed)),
    unclassified,
  };
}

export function attachExecutableCoverage(discovery, coverage) {
  return { ...(discovery || {}), coverage };
}
