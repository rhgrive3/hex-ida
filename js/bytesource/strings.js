import { asByteSource } from '../binary/source.js';

function printableAscii(c) {
  return c === 9 || (c >= 0x20 && c <= 0x7e);
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
    let asciiCarry = new Uint8Array(0);
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

      const asciiBytes = asciiCarry.length ? concat(asciiCarry, block) : block;
      const asciiBase = offset - BigInt(asciiCarry.length);
      const asciiRes = scanAscii(image, asciiBytes, asciiBase, range, min, max, out, seen, limit, isFinalBlock);
      if (asciiRes.capped) {
        capped = true;
        break;
      }
      asciiCarry = asciiBytes.slice(asciiRes.unfinishedStart);

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

function mappedRanges(image, sourceSize, includeExecutable) {
  const items = image.sections?.length ? image.sections : image.segments || [];
  const ranges = [];
  const dedupe = new Set();
  for (const item of items) {
    const size = BigInt(item.fileSize ?? 0);
    const start = BigInt(item.fileOffset ?? 0);
    if (size <= 0n || start < 0n || start >= sourceSize) continue;
    if (!includeExecutable && item.perms?.execute) continue;
    const bounded = size > sourceSize - start ? sourceSize - start : size;
    if (bounded <= 0n) continue;
    const key = `${start}:${bounded}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    ranges.push({ start, end: start + bounded, section: item.name || null });
  }
  if (!items.length && !ranges.length) ranges.push({ start: 0n, end: sourceSize, section: null });
  ranges.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
  return ranges;
}

function scanAscii(image, bytes, base, range, min, max, out, seen, limit, isFinalBlock) {
  let unfinishedStart = bytes.length;
  for (let p = 0; p < bytes.length;) {
    if (!printableAscii(bytes[p])) { p++; continue; }
    const start = p;
    let q = p;
    while (q < bytes.length && q - start < max && printableAscii(bytes[q])) q++;
    if (!isFinalBlock && q === bytes.length && q - start < max && base + BigInt(q) < range.end) {
      unfinishedStart = start;
      break;
    }
    if (q - start >= min) {
      const { capped } = tryEmit(image, bytes, base, start, q - start, 'utf8', range, out, seen, limit);
      if (capped) return { unfinishedStart: bytes.length, capped: true };
    }
    p = q < bytes.length && printableAscii(bytes[q]) ? q : Math.max(q + 1, p + 1);
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
  const printableAt = (p) => p + 1 < bytes.length && (be ? bytes[p] === 0 && printableAscii(bytes[p + 1]) : printableAscii(bytes[p]) && bytes[p + 1] === 0);
  let unfinishedStart = bytes.length;
  let lastCovered = 0;
  for (let p = 0; p + 1 < bytes.length;) {
    if (!printableAt(p)) { p++; continue; }
    const start = p;
    let q = p;
    let chars = 0;
    while (q + 1 < bytes.length && chars < max && printableAt(q)) { chars++; q += 2; }
    if (!isFinalBlock && q + 1 >= bytes.length && chars < max && base + BigInt(q) < range.end) {
      unfinishedStart = start;
      break;
    }
    if (chars >= min) {
      const { capped } = tryEmit(image, bytes, base, start, q - start, encoding, range, out, seen, limit);
      if (capped) return { unfinishedStart: bytes.length, capped: true };
    }
    lastCovered = q;
    p = chars === max && printableAt(q) ? q : Math.max(q + 1, p + 1);
  }
  if (unfinishedStart === bytes.length && !isFinalBlock && bytes.length > 0 && base + BigInt(bytes.length) < range.end) {
    if (lastCovered < bytes.length) {
      unfinishedStart = bytes.length - 1;
    }
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
