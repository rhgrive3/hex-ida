import { asByteSource } from '../binary/source.js';

function printableAscii(c) {
  return c === 9 || (c >= 0x20 && c <= 0x7e);
}

function printableCodePoint(cp) {
  if (cp === 9) return true;
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return false;
  if (cp >= 0xd800 && cp <= 0xdfff) return false;
  return cp <= 0x10ffff;
}

function utf8At(bytes, p, end = bytes.length) {
  const b0 = bytes[p];
  if (b0 < 0x80) return { cp: b0, bytes: 1 };
  let n;
  let min;
  let cp;
  if (b0 >= 0xc2 && b0 <= 0xdf) { n = 2; min = 0x80; cp = b0 & 0x1f; }
  else if (b0 >= 0xe0 && b0 <= 0xef) { n = 3; min = 0x800; cp = b0 & 0x0f; }
  else if (b0 >= 0xf0 && b0 <= 0xf4) { n = 4; min = 0x10000; cp = b0 & 0x07; }
  else return null;
  if (p + n > end) return null;
  for (let i = 1; i < n; i++) {
    const b = bytes[p + i];
    if ((b & 0xc0) !== 0x80) return null;
    cp = (cp << 6) | (b & 0x3f);
  }
  if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
  return { cp, bytes: n };
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

function utf16At(bytes, p, end = bytes.length, be = false) {
  if (p + 2 > end) return null;
  const unit = be ? (bytes[p] << 8) | bytes[p + 1] : bytes[p] | (bytes[p + 1] << 8);
  if (unit >= 0xd800 && unit <= 0xdbff) {
    if (p + 4 > end) return null;
    const next = be ? (bytes[p + 2] << 8) | bytes[p + 3] : bytes[p + 2] | (bytes[p + 3] << 8);
    if (next < 0xdc00 || next > 0xdfff) return null;
    return { cp: 0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00), bytes: 4 };
  }
  if (unit >= 0xdc00 && unit <= 0xdfff) return null;
  return { cp: unit, bytes: 2 };
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

function mappedRanges(image, sourceSize, includeExecutable) {
  const sections = Array.isArray(image.sections) ? image.sections : [];
  const segments = Array.isArray(image.segments) ? image.segments : [];
  if (!sections.length && !segments.length) return [{ start: 0n, end: sourceSize, section: null }];

  const sectionRanges = sections.map((item) => ({ item, range: normalizeRange(item, sourceSize) })).filter(({ range }) => range);
  const sectionCoverage = mergeCoverage(sectionRanges.map(({ range }) => range));
  const ranges = [];

  for (const { item, range } of sectionRanges) {
    if (!includeExecutable && item.perms?.execute) continue;
    ranges.push({ start: range.start, end: range.end, section: item.name || null });
  }
  for (const item of segments) {
    if (!includeExecutable && item.perms?.execute) continue;
    const range = normalizeRange(item, sourceSize);
    if (!range) continue;
    for (const gap of subtractCoverage(range, sectionCoverage)) ranges.push({ ...gap, section: null });
  }

  ranges.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : 0);
  return ranges;
}

function scanUtf8(image, bytes, base, range, min, max, out, seen, limit, isFinalBlock) {
  let unfinishedStart = bytes.length;
  for (let p = 0; p < bytes.length;) {
    const first = utf8At(bytes, p);
    if (!first || !printableCodePoint(first.cp)) {
      if (!isFinalBlock && !first && incompleteUtf8Prefix(bytes, p) && base + BigInt(bytes.length) < range.end) {
        unfinishedStart = p;
        break;
      }
      p++;
      continue;
    }
    const start = p;
    let q = p;
    let chars = 0;
    while (q < bytes.length && chars < max) {
      const x = utf8At(bytes, q);
      if (!x || !printableCodePoint(x.cp)) break;
      q += x.bytes;
      chars++;
    }
    if (!isFinalBlock && chars < max && base + BigInt(bytes.length) < range.end
      && (q === bytes.length || incompleteUtf8Prefix(bytes, q))) {
      unfinishedStart = start;
      break;
    }
    if (chars >= min) {
      const { capped } = tryEmit(image, bytes, base, start, q - start, 'utf8', range, out, seen, limit);
      if (capped) return { unfinishedStart: bytes.length, capped: true };
    }
    p = chars >= max ? q : Math.max(q + (q < bytes.length ? 1 : 0), p + 1);
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
  let unfinishedStart = bytes.length;
  for (let p = 0; p < bytes.length;) {
    const first = utf16At(bytes, p, bytes.length, be);
    if (!first || !printableCodePoint(first.cp)) {
      if (!isFinalBlock && !first && incompleteUtf16Prefix(bytes, p, bytes.length, be)
        && base + BigInt(bytes.length) < range.end) {
        unfinishedStart = p;
        break;
      }
      p++;
      continue;
    }
    const start = p;
    let q = p;
    let chars = 0;
    while (q < bytes.length && chars < max) {
      const x = utf16At(bytes, q, bytes.length, be);
      if (!x || !printableCodePoint(x.cp)) break;
      q += x.bytes;
      chars++;
    }
    if (!isFinalBlock && chars < max && base + BigInt(bytes.length) < range.end
      && (q === bytes.length || incompleteUtf16Prefix(bytes, q, bytes.length, be))) {
      unfinishedStart = start;
      break;
    }
    if (chars >= min) {
      const { capped } = tryEmit(image, bytes, base, start, q - start, encoding, range, out, seen, limit);
      if (capped) return { unfinishedStart: bytes.length, capped: true };
    }
    p = chars >= max ? q : Math.max(q + (q < bytes.length ? 1 : 0), p + 1);
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
  try { text = new TextDecoder(encoding === 'utf16le' ? 'utf-16le' : encoding === 'utf16be' ? 'utf-16be' : 'utf-8').decode(raw); }
  catch { text = ''; }
  out.push({ text, encoding, fileOffset, address: image.offsetToAddress(fileOffset), byteLength, section: range.section });
  return { emitted: true, capped: false };
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}
