import { asByteSource } from '../binary/source.js';

const TEXT_DECODERS = {
  utf8: new TextDecoder('utf-8', { ignoreBOM: true }),
  utf16le: new TextDecoder('utf-16le', { ignoreBOM: true }),
  utf16be: new TextDecoder('utf-16be', { ignoreBOM: true }),
};

function printableAscii(c) {
  return c === 9 || (c >= 0x20 && c <= 0x7e);
}

function printableCodePoint(cp) {
  if (cp === 9) return true;
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return false;
  if (cp >= 0xd800 && cp <= 0xdfff) return false;
  return cp <= 0x10ffff;
}

function utf8AtPacked(bytes, p, end = bytes.length) {
  const b0 = bytes[p];
  if (b0 < 0x80) return (b0 << 3) | 1;
  let n;
  let min;
  let cp;
  if (b0 >= 0xc2 && b0 <= 0xdf) { n = 2; min = 0x80; cp = b0 & 0x1f; }
  else if (b0 >= 0xe0 && b0 <= 0xef) { n = 3; min = 0x800; cp = b0 & 0x0f; }
  else if (b0 >= 0xf0 && b0 <= 0xf4) { n = 4; min = 0x10000; cp = b0 & 0x07; }
  else return -1;
  if (p + n > end) return -1;
  for (let i = 1; i < n; i++) {
    const b = bytes[p + i];
    if ((b & 0xc0) !== 0x80) return -1;
    cp = (cp << 6) | (b & 0x3f);
  }
  if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return -1;
  return (cp << 3) | n;
}

function incompleteUtf8Prefix(bytes, p, end = bytes.length) {
  const b0 = bytes[p];
  let n = 0;
  if (b0 >= 0xc2 && b0 <= 0xdf) n = 2;
  else if (b0 >= 0xe0 && b0 <= 0xef) n = 3;
  else if (b0 >= 0xf0 && b0 <= 0xf4) n = 4;
  if (!n || p + n <= end) return false;
  for (let i = p + 1; i < end; i++) {
    if ((bytes[i] & 0xc0) !== 0x80) return false;
  }
  return true;
}

function utf16AtPacked(bytes, p, end = bytes.length, be = false) {
  if (p + 2 > end) return -1;
  const unit = be ? (bytes[p] << 8) | bytes[p + 1] : bytes[p] | (bytes[p + 1] << 8);
  if (unit >= 0xd800 && unit <= 0xdbff) {
    if (p + 4 > end) return -1;
    const next = be ? (bytes[p + 2] << 8) | bytes[p + 3] : bytes[p + 2] | (bytes[p + 3] << 8);
    if (next < 0xdc00 || next > 0xdfff) return -1;
    return ((0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00)) << 3) | 4;
  }
  if (unit >= 0xdc00 && unit <= 0xdfff) return -1;
  return (unit << 3) | 2;
}

function incompleteUtf16Prefix(bytes, p, end = bytes.length, be = false) {
  if (p >= end) return false;
  if (p + 2 > end) return true;
  const unit = be ? (bytes[p] << 8) | bytes[p + 1] : bytes[p] | (bytes[p + 1] << 8);
  return unit >= 0xd800 && unit <= 0xdbff && p + 4 > end;
}

function finiteNumberOption(value, fallback, { zeroUsesDefault = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (zeroUsesDefault && value === 0) return fallback;
  return value;
}

export async function scanSourceStrings(image, input, opts = {}) {
  const source = asByteSource(input);
  const min = Math.max(2, finiteNumberOption(opts.minLength, 4, { zeroUsesDefault: true }));
  const max = Math.max(min, Math.min(64 * 1024, finiteNumberOption(opts.maxLength, 4096, { zeroUsesDefault: true })));
  const rawLimit = finiteNumberOption(opts.limit, 200_000);
  const limit = Math.max(1, Math.min(1_000_000, Math.floor(rawLimit)));
  const utf16Encodings = chooseUtf16Encodings(image, opts.utf16);
  const includeExecutable = opts.includeExecutable === true;
  const chunkSize = Math.floor(Math.min(source.maxReadLength, Math.max(64 * 1024, finiteNumberOption(opts.chunkSize, 256 * 1024, { zeroUsesDefault: true }))));
  const ranges = mappedRanges(image, source.size, includeExecutable);
  const out = [];
  const seen = new Set();
  let capped = false;

  for (const range of ranges) {
    let offset = range.start;
    let utf8Carry = new Uint8Array(0);
    const utf16Carries = new Map(utf16Encodings.map((enc) => [enc, new Uint8Array(0)]));

    while (offset < range.end && !capped) {
      if (opts.signal?.aborted) return { results: out, cancelled: true, capped: false };
      const remaining = range.end - offset;
      const length = Number(remaining < BigInt(chunkSize) ? remaining : BigInt(chunkSize));
      let block;
      try { block = await source.readExactly(offset, length, { signal: opts.signal }); }
      catch (error) {
        if (opts.signal?.aborted || error?.name === 'AbortError' || error?.code === 'BYTE_SOURCE_CANCELLED') return { results: out, cancelled: true, capped: false };
        throw error;
      }
      const isFinalBlock = offset + BigInt(block.length) >= range.end || !block.length;

      const utf8Bytes = utf8Carry.length ? concat(utf8Carry, block) : block;
      const utf8Base = offset - BigInt(utf8Carry.length);
      const utf8Res = scanUtf8(image, utf8Bytes, utf8Base, range, min, max, out, seen, limit, isFinalBlock);
      if (utf8Res.capped) {
        capped = true;
        break;
      }
      utf8Carry = utf8Bytes.slice(utf8Res.unfinishedStart);

      for (const encoding of utf16Encodings) {
        const carry = utf16Carries.get(encoding);
        const utf16Bytes = carry.length ? concat(carry, block) : block;
        const utf16Base = offset - BigInt(carry.length);
        const utf16Res = scanUtf16(image, utf16Bytes, utf16Base, range, min, max, out, seen, limit, encoding, isFinalBlock);
        if (utf16Res.capped) {
          capped = true;
          break;
        }
        utf16Carries.set(encoding, utf16Bytes.slice(utf16Res.unfinishedStart));
      }
      if (capped) break;

      offset += BigInt(block.length);
      if (typeof opts.onProgress === 'function') opts.onProgress({ done: offset - range.start, total: range.end - range.start, strings: out.length, section: range.section });
      if (!block.length) break;
    }
    if (capped) break;
  }
  return { results: out, cancelled: false, capped };
}

function normalizeRange(item, sourceSize) {
  const size = BigInt(item.fileSize ?? 0);
  const start = BigInt(item.fileOffset ?? 0);
  if (size <= 0n || start < 0n || start >= sourceSize) return null;
  const bounded = size > sourceSize - start ? sourceSize - start : size;
  return bounded > 0n ? { start, end: start + bounded } : null;
}

function mergeCoverage(ranges) {
  const sorted = ranges.map((range) => ({ ...range })).sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : 0);
  const out = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (!last || range.start > last.end) out.push(range);
    else if (range.end > last.end) last.end = range.end;
  }
  return out;
}

function subtractCoverage(range, coverage) {
  const out = [];
  let cursor = range.start;
  for (const covered of coverage) {
    if (covered.end <= cursor) continue;
    if (covered.start >= range.end) break;
    if (covered.start > cursor) out.push({ start: cursor, end: covered.start < range.end ? covered.start : range.end });
    if (covered.end > cursor) cursor = covered.end < range.end ? covered.end : range.end;
    if (cursor >= range.end) break;
  }
  if (cursor < range.end) out.push({ start: cursor, end: range.end });
  return out;
}

// #8736: one scan range per eligible mapping made N sections aliasing the same bytes
// issue N independent chunked reads over one physical range, so a counting ByteSource
// observed O(sections) traffic (gigabytes of logical reads for a megabyte file) while the
// result cap could never be reached because `seen` only suppressed duplicate results after
// the work was done. The eligible domain is a union now: each byte is claimed by the first
// mapping that covers it in the previous scan order (start, then end, then enumeration
// rank), so attribution stays deterministic and every eligible byte is read at most once.
function unionizeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => (
    a.start < b.start ? -1 : a.start > b.start ? 1
      : (a.end - a.start) < (b.end - b.start) ? -1 : (a.end - a.start) > (b.end - b.start) ? 1
        : a.rank - b.rank
  ));
  const out = [];
  const claimed = [];
  let cursor = 0;
  for (const range of sorted) {
    let pos = range.start;
    while (cursor < claimed.length && claimed[cursor].end <= pos) cursor++;
    for (let i = cursor; i < claimed.length && claimed[i].start < range.end; i++) {
      const covered = claimed[i];
      if (covered.start > pos) out.push({ start: pos, end: covered.start, section: range.section });
      if (covered.end > pos) pos = covered.end;
    }
    if (pos < range.end) out.push({ start: pos, end: range.end, section: range.section });
    const last = claimed[claimed.length - 1];
    if (last && range.start <= last.end) { if (range.end > last.end) last.end = range.end; }
    else claimed.push({ start: range.start, end: range.end });
  }
  return out;
}

function mappedRanges(image, sourceSize, includeExecutable) {
  const sections = Array.isArray(image.sections) ? image.sections : [];
  const segments = Array.isArray(image.segments) ? image.segments : [];
  if (!sections.length && !segments.length) return [{ start: 0n, end: sourceSize, section: null }];

  const sectionRanges = sections.map((item) => ({ item, range: normalizeRange(item, sourceSize) })).filter(({ range }) => range);
  const sectionCoverage = mergeCoverage(sectionRanges.map(({ range }) => range));
  const candidates = [];
  let rank = 0;

  for (const { item, range } of sectionRanges) {
    if (!includeExecutable && item.perms?.execute) continue;
    candidates.push({ start: range.start, end: range.end, section: item.name || null, rank: rank++ });
  }
  for (const item of segments) {
    if (!includeExecutable && item.perms?.execute) continue;
    const range = normalizeRange(item, sourceSize);
    if (!range) continue;
    // #3766: a segment only contributes the file bytes no section already covers.
    for (const gap of subtractCoverage(range, sectionCoverage)) {
      candidates.push({ start: gap.start, end: gap.end, section: null, rank: rank++ });
    }
  }

  const ranges = unionizeRanges(candidates);
  ranges.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : 0);
  return ranges;
}

function scanUtf8(image, bytes, base, range, min, max, out, seen, limit, isFinalBlock) {
  const len = bytes.length;
  let unfinishedStart = len;
  for (let p = 0; p < len;) {
    const b0 = bytes[p];
    if (b0 < 0x80) {
      if (b0 !== 9 && (b0 < 0x20 || b0 > 0x7e)) {
        p++;
        continue;
      }
    } else {
      const first = utf8AtPacked(bytes, p, len);
      if (first < 0 || !printableCodePoint(first >>> 3)) {
        if (!isFinalBlock && first < 0 && incompleteUtf8Prefix(bytes, p, len) && base + BigInt(len) < range.end) {
          unfinishedStart = p;
          break;
        }
        p++;
        continue;
      }
    }
    const start = p;
    let q = p;
    let chars = 0;
    while (q < len && chars < max) {
      const b = bytes[q];
      if (b < 0x80) {
        if (b !== 9 && (b < 0x20 || b > 0x7e)) break;
        q++;
        chars++;
      } else {
        const x = utf8AtPacked(bytes, q, len);
        if (x < 0 || !printableCodePoint(x >>> 3)) break;
        q += x & 7;
        chars++;
      }
    }
    if (!isFinalBlock && chars < max && base + BigInt(len) < range.end
      && (q === len || incompleteUtf8Prefix(bytes, q, len))) {
      unfinishedStart = start;
      break;
    }
    if (chars >= min) {
      const { capped } = tryEmit(image, bytes, base, start, q - start, 'utf8', range, out, seen, limit);
      if (capped) return { unfinishedStart: len, capped: true };
    }
    p = chars >= max ? q : Math.max(q + (q < len ? 1 : 0), p + 1);
  }
  return { unfinishedStart, capped: false };
}

function chooseUtf16Encodings(image, option) {
  if (option === false) return [];
  if (option === 'be' || option === 'utf16be' || option === 'utf-16be') return ['utf16be'];
  if (option === 'le' || option === 'utf16le' || option === 'utf-16le') return ['utf16le'];
  if (option === 'both') return ['utf16le', 'utf16be'];
  return [image?.endian === 'big' ? 'utf16be' : 'utf16le'];
}

function scanUtf16(image, bytes, base, range, min, max, out, seen, limit, encoding, isFinalBlock) {
  const be = encoding === 'utf16be';
  const len = bytes.length;
  const maxCollect = Number.isFinite(limit) ? Math.max(0, limit - out.length + 1) : Infinity;

  const scanParity = (parity, skipSpans) => {
    const candidates = [];
    const spans = [];
    let unfinishedStart = len;
    let eligibleCount = 0;
    let spanIdx = 0;

    for (let p = parity; p < len;) {
      if (skipSpans && skipSpans.length) {
        while (spanIdx < skipSpans.length && skipSpans[spanIdx].end <= p) spanIdx++;
        if (spanIdx < skipSpans.length && p >= skipSpans[spanIdx].start && p < skipSpans[spanIdx].end) {
          const spanEnd = skipSpans[spanIdx].end;
          p = (spanEnd & 1) === parity ? spanEnd : spanEnd + 1;
          continue;
        }
      }

      const first = utf16AtPacked(bytes, p, len, be);
      if (first < 0 || !printableCodePoint(first >>> 3)) {
        if (!isFinalBlock && first < 0 && incompleteUtf16Prefix(bytes, p, len, be)
          && base + BigInt(len) < range.end) {
          unfinishedStart = p;
          break;
        }
        p += 2;
        continue;
      }
      const start = p;
      let q = p;
      let chars = 0;
      let asciiCount = 0;
      while (q < len && chars < max) {
        const x = utf16AtPacked(bytes, q, len, be);
        const cp = x >>> 3;
        if (x < 0 || !printableCodePoint(cp)) break;
        if (cp <= 0x7f) asciiCount++;
        q += x & 7;
        chars++;
      }
      if (!isFinalBlock && chars < max && base + BigInt(len) < range.end
        && (q === len || incompleteUtf16Prefix(bytes, q, len, be))) {
        unfinishedStart = start;
        break;
      }
      if (chars >= min) {
        candidates.push({ start, end: q, asciiCount });
        const fileOffset = base + BigInt(start);
        const inRange = fileOffset >= range.start && fileOffset < range.end;
        if (inRange) {
          if (!skipSpans && asciiCount > 0) spans.push({ start, end: q });
          if (!seen.has(`${fileOffset}:${encoding}`)) {
            eligibleCount++;
            if (eligibleCount >= maxCollect) break;
          }
        }
      }
      p = chars >= max ? q : Math.max(q + (q < len ? 2 : 0), p + 2);
      if ((p & 1) !== parity) p += 1;
    }

    return { candidates, spans, unfinishedStart };
  };

  const p0 = scanParity(0, null);
  const p1 = scanParity(1, p0.spans);

  const merged = p0.candidates.concat(p1.candidates);
  merged.sort((a, b) => a.start - b.start || b.end - a.end);

  const emitCutoff = Math.min(p0.unfinishedStart, p1.unfinishedStart);
  let lastEmittedEnd = 0;
  for (let i = 0; i < merged.length; i++) {
    const cand = merged[i];
    if (cand.start >= emitCutoff) break;
    if (cand.start < lastEmittedEnd) continue;
    // Avoid letting a 1-byte-shifted NUL-prefixed non-ASCII shadow eclipse a true overlapping ASCII UTF-16 string.
    if (cand.asciiCount === 0 && i + 1 < merged.length) {
      const next = merged[i + 1];
      if (next.start < cand.end && next.asciiCount > 0) continue;
    }
    const fileOffset = base + BigInt(cand.start);
    const inRange = fileOffset >= range.start && fileOffset < range.end;
    const key = `${fileOffset}:${encoding}`;
    const alreadySeen = inRange && seen.has(key);
    const { emitted, capped } = tryEmit(image, bytes, base, cand.start, cand.end - cand.start, encoding, range, out, seen, limit);
    if (capped) return { unfinishedStart: len, capped: true };
    if (emitted || alreadySeen) {
      if (cand.end > lastEmittedEnd) lastEmittedEnd = cand.end;
    }
  }

  let unfinishedStart = len;
  if (p0.unfinishedStart < len && p0.unfinishedStart >= lastEmittedEnd && p0.unfinishedStart < unfinishedStart) {
    unfinishedStart = p0.unfinishedStart;
  }
  if (p1.unfinishedStart < len && p1.unfinishedStart >= lastEmittedEnd && p1.unfinishedStart < unfinishedStart) {
    unfinishedStart = p1.unfinishedStart;
  }
  return { unfinishedStart, capped: false };
}

function tryEmit(image, bytes, base, localStart, byteLength, encoding, range, out, seen, limit) {
  const fileOffset = base + BigInt(localStart);
  if (fileOffset < range.start || fileOffset >= range.end) return { emitted: false, capped: false };
  const key = `${fileOffset}:${encoding}`;
  if (seen.has(key)) return { emitted: false, capped: false };
  if (out.length >= limit) {
    return { emitted: false, capped: true };
  }
  seen.add(key);
  const raw = bytes.subarray(localStart, localStart + byteLength);
  let text;
  try { text = (TEXT_DECODERS[encoding] || TEXT_DECODERS.utf8).decode(raw); }
  catch { text = ''; }
  out.push({ text, encoding, fileOffset, address: image.offsetToAddress(fileOffset), byteLength, section: range.section });
  return { emitted: true, capped: false };
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}
