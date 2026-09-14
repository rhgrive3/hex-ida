import { BinaryImage } from './model.js';
import { ByteView } from './reader.js';
import { asByteSource } from './source.js';
import { decodeDyldSharedCacheMagic } from './detect.js';

const MIN_HEADER_SIZE = 0x28;
const MODERN_HEADER_SIZE = 0x140;
const MAPPING_INFO_SIZE = 32;
const MAPPING_WITH_SLIDE_SIZE = 56;
const MAX_MAPPINGS = 256;
const MAX_SLIDE_INFO_BYTES = 16 * 1024 * 1024;
const MAX_REBASE_RECORDS = 65536;
const VM_PROT_READ = 1;
const VM_PROT_WRITE = 2;
const VM_PROT_EXECUTE = 4;
const PAGE_ATTR_EXTRA = 0x8000;
const PAGE_ATTR_NO_REBASE = 0x4000;
const PAGE_ATTR_END = 0x8000;

function exactNonNegativeBigInt(value, label) {
  if (value == null) return 0n;
  if (typeof value === 'bigint') {
    if (value < 0n) throw new RangeError(`${label} must be non-negative`);
    return value;
  }
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(?:0x[0-9a-f]+|\d+)$/i.test(value.trim())) return BigInt(value.trim());
  throw new TypeError(`${label} must be a non-negative exact integer`);
}

function checkedRange(offset, size, total, label) {
  const o = exactNonNegativeBigInt(offset, `${label} offset`);
  const n = exactNonNegativeBigInt(size, `${label} size`);
  if (o > total || n > total - o) throw new Error(`${label} is outside dyld shared cache bounds`);
  return { offset: o, size: n };
}

function hexUuid(bytes) {
  if (!bytes || bytes.byteLength !== 16) return null;
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
    if (i === 3 || i === 5 || i === 7 || i === 9) out += '-';
  }
  return out;
}

function parseHeader(bytes, totalSize) {
  const r = new ByteView(bytes, { littleEndian: true });
  if (r.length < MIN_HEADER_SIZE) throw new Error('dyld shared cache header is truncated');
  const magic = decodeDyldSharedCacheMagic(r.slice(0, 16));
  if (!magic) throw new Error('invalid or unsupported dyld shared cache magic');
  const mappingOffset = r.u32(0x10);
  const mappingCount = r.u32(0x14);
  if (mappingOffset < MIN_HEADER_SIZE) throw new Error('invalid dyld shared cache mapping offset');
  if (mappingCount < 1 || mappingCount > MAX_MAPPINGS) throw new Error(`unreasonable dyld shared cache mapping count ${mappingCount}`);
  const mappingBytes = BigInt(mappingCount * MAPPING_INFO_SIZE);
  checkedRange(BigInt(mappingOffset), mappingBytes, totalSize, 'dyld shared cache mapping table');

  const modern = r.length >= MODERN_HEADER_SIZE && mappingOffset >= MODERN_HEADER_SIZE;
  if (!modern && mappingOffset >= 0x48 && r.length >= 0x48) {
    const legacySlideInfoOffset = r.u64(0x38);
    const legacySlideInfoSize = r.u64(0x40);
    if (legacySlideInfoOffset !== 0n || legacySlideInfoSize !== 0n) {
      throw new Error('legacy dyld shared cache slide info is unsupported');
    }
  }
  const sharedRegionStart = modern ? r.u64(0xe0) : 0n;
  const sharedRegionSize = modern ? r.u64(0xe8) : 0n;
  const maxSlide = modern ? r.u64(0xf0) : 0n;
  const mappingWithSlideOffset = modern ? r.u32(0x138) : 0;
  const mappingWithSlideCount = modern ? r.u32(0x13c) : 0;
  if (mappingWithSlideCount > MAX_MAPPINGS) throw new Error(`unreasonable dyld shared cache slide mapping count ${mappingWithSlideCount}`);
  if (mappingWithSlideCount > 0) {
    if (mappingWithSlideOffset === 0) throw new Error('dyld shared cache slide mapping table has a zero offset');
    checkedRange(BigInt(mappingWithSlideOffset), BigInt(mappingWithSlideCount * MAPPING_WITH_SLIDE_SIZE), totalSize, 'dyld shared cache slide mapping table');
  }
  if (sharedRegionSize > 0n && sharedRegionStart > ((1n << 64n) - 1n) - sharedRegionSize) {
    throw new Error('dyld shared cache shared region overflows the address space');
  }
  return {
    ...magic,
    mappingOffset,
    mappingCount,
    dyldBaseAddress: r.u64(0x20),
    uuid: r.length >= 0x68 ? hexUuid(r.slice(0x58, 16)) : null,
    cacheType: r.length >= 0x70 ? r.u64(0x68) : 0n,
    platform: modern ? r.u32(0xd8) : null,
    sharedRegionStart,
    sharedRegionSize,
    maxSlide,
    mappingWithSlideOffset,
    mappingWithSlideCount,
  };
}

function parseMappings(bytes, count, totalSize, label = 'dyld shared cache mapping') {
  const r = new ByteView(bytes, { littleEndian: true });
  if (r.length !== count * MAPPING_INFO_SIZE) throw new Error(`${label} table is truncated`);
  const out = [];
  for (let i = 0; i < count; i++) {
    const p = i * MAPPING_INFO_SIZE;
    const mapping = {
      address: r.u64(p),
      size: r.u64(p + 8),
      fileOffset: r.u64(p + 16),
      maxProt: r.u32(p + 24),
      initProt: r.u32(p + 28),
    };
    if (mapping.size === 0n) throw new Error(`${label} ${i} has zero size`);
    checkedRange(mapping.fileOffset, mapping.size, totalSize, `${label} ${i}`);
    if ((mapping.initProt & ~7) !== 0 || (mapping.maxProt & ~7) !== 0 || (mapping.initProt & ~mapping.maxProt) !== 0) {
      throw new Error(`${label} ${i} has invalid VM protection bits`);
    }
    out.push(mapping);
  }
  validateNonOverlapping(out, 'address', 'size', `overlapping dyld shared cache virtual mappings`);
  validateNonOverlapping(out, 'fileOffset', 'size', `overlapping dyld shared cache file mappings`);
  return out;
}

function parseMappingsWithSlide(bytes, count, totalSize) {
  if (count === 0) return [];
  const r = new ByteView(bytes, { littleEndian: true });
  if (r.length !== count * MAPPING_WITH_SLIDE_SIZE) throw new Error('dyld shared cache slide mapping table is truncated');
  const out = [];
  for (let i = 0; i < count; i++) {
    const p = i * MAPPING_WITH_SLIDE_SIZE;
    const item = {
      address: r.u64(p),
      size: r.u64(p + 8),
      fileOffset: r.u64(p + 16),
      slideInfoFileOffset: r.u64(p + 24),
      slideInfoFileSize: r.u64(p + 32),
      flags: r.u64(p + 40),
      maxProt: r.u32(p + 48),
      initProt: r.u32(p + 52),
    };
    if (item.size === 0n) throw new Error(`dyld shared cache slide mapping ${i} has zero size`);
    checkedRange(item.fileOffset, item.size, totalSize, `dyld shared cache slide mapping ${i}`);
    if (item.slideInfoFileSize > BigInt(MAX_SLIDE_INFO_BYTES)) throw new Error(`dyld shared cache slide info ${i} exceeds bounded parser limit`);
    if (item.slideInfoFileSize > 0n) checkedRange(item.slideInfoFileOffset, item.slideInfoFileSize, totalSize, `dyld shared cache slide info ${i}`);
    out.push(item);
  }
  return out;
}

function validateNonOverlapping(items, startKey, sizeKey, message) {
  const sorted = [...items].sort((a, b) => a[startKey] < b[startKey] ? -1 : a[startKey] > b[startKey] ? 1 : 0);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][startKey] < sorted[i - 1][startKey] + sorted[i - 1][sizeKey]) throw new Error(message);
  }
}

function ctz64(value) {
  if (value === 0n) return 64;
  let n = 0;
  while ((value & 1n) === 0n) { value >>= 1n; n++; }
  return n;
}

function isPowerOfTwo(value) { return Number.isSafeInteger(value) && value > 0 && (value & (value - 1)) === 0; }

function parseSlideInfo2Structure(bytes, mapping, totalSize) {
  const r = new ByteView(bytes, { littleEndian: true });
  if (r.length < 40) throw new Error('dyld shared cache slide info v2 is truncated');
  const version = r.u32(0);
  if (version !== 2) throw new Error(`unsupported dyld shared cache slide info version ${version}`);
  const pageSize = r.u32(4);
  const startsOffset = r.u32(8), startsCount = r.u32(12);
  const extrasOffset = r.u32(16), extrasCount = r.u32(20);
  const deltaMask = r.u64(24), valueAdd = r.u64(32);
  if (!isPowerOfTwo(pageSize) || pageSize < 4096 || pageSize > 65536) throw new Error('invalid dyld shared cache slide info v2 page size');
  if (deltaMask === 0n) throw new Error('invalid dyld shared cache slide info v2 delta mask');
  const deltaShift = ctz64(deltaMask) - 2;
  if (deltaShift < 0 || deltaShift > 62) throw new Error('invalid dyld shared cache slide info v2 delta mask shift');
  if (startsOffset > r.length || startsCount > Math.floor((r.length - startsOffset) / 2)) throw new Error('dyld shared cache slide page starts are out of bounds');
  if (extrasOffset > r.length || extrasCount > Math.floor((r.length - extrasOffset) / 2)) throw new Error('xdyld shared cache slide page extras are out of bounds');
  const expectedPages = Number((mapping.size + BigInt(pageSize) - 1n) / BigInt(pageSize));
  if (startsCount !== expectedPages) throw new Error('dyld shared cache slide page count does not cover its mapping exactly');
  checkedRange(mapping.fileOffset, mapping.size, totalSize, 'dyld shared cache rebased mapping');
  const starts = Array.from({ length: startsCount }, (_, i) => r.u16(startsOffset + i * 2));
  const extras = Array.from({ length: extrasCount }, (_, i) => r.u16(extrasOffset + i * 2));
  return { version, pageSize, starts, extras, deltaMask, valueAdd, deltaShift };
}

function pageStarts(info, pageIndex) {
  const start = info.starts[pageIndex];
  if (start === PAGE_ATTR_NO_REBASE) return [];
  if ((start & PAGE_ATTR_EXTRA) === 0) return [start * 4];
  const offsets = [];
  let index = start & 0x3fff;
  let guard = 0;
  while (true) {
    if (index >= info.extras.length) throw new Error('dyld shared cache slide page extra index is out of bounds');
    const entry = info.extras[index++];
    offsets.push((entry & 0x3fff) * 4);
    if ((entry & PAGE_ATTR_END) !== 0) break;
    if (++guard > info.extras.length) throw new Error('xdyld shared cache slide page extras are cyclic');
  }
  return offsets;
}

function inAnyMapping(address, mappings) {
  return mappings.some((m) => address >= m.address && address < m.address + m.size);
}

function rebaseRecord(mapping, pageOffset, raw, info, slide, mappings) {
  const delta = (raw & info.deltaMask) >> BigInt(info.deltaShift);
  const valueMask = (~info.deltaMask) & ((1n << 64n) - 1n);
  const encoded = raw & valueMask;
  let target = encoded;
  if (target !== 0n) target += info.valueAdd;
  if (target !== 0n && !inAnyMapping(target, mappings)) throw new Error('xdyld shared cache rebase target is outside mapped cache address space');
  const storageAddress = mapping.address + BigInt(pageOffset);
  return {
    delta,
    record: {
      storageAddress,
      runtimeStorageAddress: storageAddress + slide,
      rawValue: raw,
      targetAddress: target,
      runtimeTargetAddress: target === 0n ? 0n : target + slide,
      authenticated: false,
    },
  };
}

function walkSlideInfo2Sync(bytes, mapping, info, slide, mappings, maxRecords) {
  const r = new ByteView(bytes, { littleEndian: true, base: mapping.fileOffset });
  const rebases = [];
  for (let page = 0; page < info.starts.length; page++) {
    for (const initial of pageStarts(info, page)) {
      let offset = page * info.pageSize + initial;
      let chainGuard = 0;
      while (true) {
        if (offset < page * info.pageSize || offset + 8 > Math.min((page + 1) * info.pageSize, bytes.length)) throw new Error('xdyld shared cache rebase chain leaves its page');
        if (rebases.length >= maxRecords) throw new Error(&dyld shared cache rebase record budget exceeded');
        const raw = r.u64(offset);
        const { delta, record } = rebaseRecord(mapping, offset, raw, info, slide, mappings);
        rebases.push(record);
        if (delta === 0n) break;
        if (delta > BigInt(info.pageSize)) throw new Error('dyld shared cache rebase delta exceeds page size');
        offset += Number(delta);
        if (++chainGuard > info.pageSize / 4) throw new Error(&dyld shared cache rebase chain is cyclic');
      }
    }
  }
  return rebases;
}

async function walkSlideInfo2Source(source, mapping, info, slide, mappings, maxRecords, signal) {
  const rebases = [];
  for (let page = 0; page < info.starts.length; page++) {
    for (const initial of pageStarts(info, page)) {
      let offset = page * info.pageSize + initial;
      let chainGuard = 0;
      while (true) {
        const pageEnd = Math.min((page + 1) * info.pageSize, Number(mapping.size));
        if (offset < page * info.pageSize || offset + 8 > pageEnd) throw new Error(&dyld shared cache rebase chain leaves its page');
        if (rebases.length >= maxRecords) throw new Error('xdyld shared cache rebase record budget exceeded');
        const rawBytes = await readBoundedRange(source, mapping.fileOffset + BigInt(offset), 8, signal);
        const raw = new ByteView(rawBytes, { littleEndian: true }).u64(0);
        const { delta, record } = rebaseRecord(mapping, offset, raw, info, slide, mappings);
        rebases.push(record);
        if (delta === 0n) break;
        if (delta > BigInt(info.pageSize)) throw new Error('dyld shared cache rebase delta exceeds page size');
        offset += Number(delta);
        if (++chainGuard > info.pageSize / 4) throw new Error(&dyld shared cache rebase chain is cyclic');
      }
    }
  }
  return rebases;
}

function normalizeSlide(header, opts) {
  const slide = exactNonNegativeBigInt(opts.slide ?? 0n, 'dyld shared cache slide');
  if (header.maxSlide !== 0n && slide > header.maxSlide) throw new Error(`dyld shared cache slide 0x${slide.toString(16)} exceeds declared maxSlide 0x${header.maxSlide.toString(16)}`);
  const alignment = exactNonNegativeBigInt(opts.slideAlignment ?? 0x1000n, 'dyld shared cache slide alignment');
  if (slide !== 0n && alignment !== 0n && (slide % alignment) !== 0n) throw new Error('dyld shared cache slide is not aligned');
  return slide;
}

function makeImage(input, source, header, mappings, slideMappings, slide, slideMetadata) {
  const base = header.sharedRegionStart !== 0n ? header.sharedRegionStart : mappings.reduce((m, x) => x.address < m ? x.address : m, mappings[0].address);
  const fileSize = source?.size ?? BigInt(input?.byteLength ?? 0);
  const image = new BinaryImage(input, {
    source,
    format: 'dyld-shared-cache',
    arch: header.arch,
    bits: header.bits,
    endian: 'little',
    imageBase: base + slide,
    fileOffset: 0n,
    fileSize,
  });
  for (let i = 0; i < mappings.length; i++) {
    const m = mappings[i];
    image.addSegment({
      name: `cache-map-${i}`,
      address: m.address + slide,
      size: m.size,
      fileOffset: m.fileOffset,
      fileSize: m.size,
      perms: { read: (m.initProt & VM_PROT_READ) !== 0, write: (m.initProt & VM_PROT_WRITE) !== 0, execute: (m.initProt & VM_PROT_EXECUTE) !== 0 },
      flags: m.initProt,
      source: 'dyld-shared-cache',
    });
  }
  image.metadata.dyldSharedCache = {
    magicVersion: header.version,
    architecture: header.arch,
    uuid: header.uuid,
    cacheType: header.cacheType,
    platform: header.platform,
    dyldBaseAddress: header.dyldBaseAddress,
    sharedRegionStart: header.sharedRegionStart || base,
    runtimeSharedRegionStart: (header.sharedRegionStart || base) + slide,
    sharedRegionSize: header.sharedRegionSize,
    maxSlide: header.maxSlide,
    slide,
    addressIdentity: 'unslid-cache-vm-to-runtime-vm',
    mappings: mappings.map((m, i) => ({ index: i, ...m, runtimeAddress: m.address + slid })),
    mappingWithSlide: slideMappings.map((m, i) => ({ ...m, runtimeAddress: m.address + slide, slideInfo: slideMetadata[i] ?? null })),
  };
  return image;
}

function validateSlideMappings(slideMappings, mappings) {
  for (let i = 0; i < slideMappings.length; i++) {
    const item = slideMappings[i];
    const canonical = mappings.find((m) => m.address === item.address && m.size === item.size && m.fileOffset === item.fileOffset);
    if (!canonical) throw new Error(`dyld shared cache slide mapping ${i} does not match a canonical mapping`);
    if (canonical.maxProt !== item.maxProt || canonical.initProt !== item.initProt) {
      throw new Error(`dyld shared cache slide mapping ${i} protection identity disagrees with its canonical mapping`);
    }
  }
}

function maxRecordsOption(opts) {
  if (opts.maxRebases == null) return MAX_REBASE_RECORDS;
  if (!Number.isSafeInteger(opts.maxRebases) || opts.maxRebases < 1 || opts.maxRebases > MAX_REBASE_RECORDS) throw new RangeError(`maxRebases must be in 1..${MAX_REBASE_RECORDS}`);
  return opts.maxRebases;
}

function parseSlideInfoSync(allBytes, item, slide, mappings, opts) {
  if (item.slideInfoFileSize === 0n) return { version: null, complete: true, rebaseCount: 0, rebases: [] };
  const offset = Number(item.slideInfoFileOffset), size = Number(item.slideInfoFileSize);
  const infoBytes = allBytes.subarray(offset, offset + size);
  const version = new ByteView(infoBytes, { littleEndian: true }).u32(0);
  if (version !== 2) throw new Error(`unsupported dyld shared cache slide info version ${version}`);
  const info = parseSlideInfo2Structure(infoBytes, item, BigInt(allBytes.byteLength));
  const mappingBytes = allBytes.subarray(Number(item.fileOffset), Number(item.fileOffset + item.size));
  const rebases = walkSlideInfo2Sync(mappingBytes, item, info, slide, mappings, maxRecordsOption(opts));
  return { version, pageSize: info.pageSize, complete: true, rebaseCount: rebases.length, rebases };
}

async function parseSlideInfoSource(source, item, slide, mappings, opts) {
  if (item.slideInfoFileSize === 0n) return { version: null, complete: true, rebaseCount: 0, rebases: [] };
  const infoBytes = await readBoundedRange(source, item.slideInfoFileOffset, Number(item.slideInfoFileSize), opts.signal);
  const version = new ByteView(infoBytes, { littleEndian: true }).u32(0);
  if (version !== 2) throw new Error(`unsupported dyld shared cache slide info version ${version}`);
  const info = parseSlideInfo2Structure(infoBytes, item, source.size);
  const rebases = await walkSlideInfo2Source(source, item, info, slide, mappings, maxRecordsOption(opts), opts.signal);
  return { version, pageSize: info.pageSize, complete: true, rebaseCount: rebases.length, rebases };
}

export function parseDyldSharedCache(input, opts = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input.buffer || input, input.byteOffset || 0, input.byteLength);
  const headerBytes = bytes.subarray(0, Math.min(bytes.byteLength, Math.max(MODERN_HEADER_SIZE, MIN_HEADER_SIZE)));
  const header = parseHeader(headerBytes, BigInt(bytes.byteLength));
  const mappingStart = header.mappingOffset;
  const mappings = parseMappings(bytes.subarray(mappingStart, mappingStart + header.mappingCount * MAPPING_INFO_SIZE), header.mappingCount, BigInt(bytes.byteLength));
  const slideMappings = header.mappingWithSlideCount === 0 ? [] : parseMappingsWithSlide(
    bytes.subarray(header.mappingWithSlideOffset, header.mappingWithSlideOffset + header.mappingWithSlideCount * MAPPING_WITH_SLIDE_SIZE),
    header.mappingWithSlideCount,
    BigInt(bytes.byteLength),
  );
  validateSlideMappings(slideMappings, mappings);
  const slide = normalizeSlide(header, opts);
  if (slide !== 0n && slideMappings.length === 0) throw new Error('cannot apply a nonzero dyld shared cache slide without slide info');
  const slideMetadata = slideMappings.map((item) => parseSlideInfoSync(bytes, item, slide, mappings, opts));
  return makeImage(bytes, null, header, mappings, slideMappings, slide, slideMetadata);
}

export async function parseDyldSharedCacheSource(input, opts = {}) {
  const source = asByteSource(input, opts.source || {});
  const headerLength = Number(source.size < BigInt(MODERN_HEADER_SIZE) ? source.size : BigInt(MODERN_HEADER_SIZE));
  const headerBytes = await readBoundedRange(source, 0n, headerLength, opts.signal);
  const header = parseHeader(headerBytes, source.size);
  const mappingBytes = await readBoundedRange(source, BigInt(header.mappingOffset), header.mappingCount * MAPPING_INFO_SIZE, opts.signal);
  const mappings = parseMappings(mappingBytes, header.mappingCount, source.size);
  let slideMappings = [];
  if (header.mappingWithSlideCount > 0) {
    const bytes = await readBoundedRange(source, BigInt(header.mappingWithSlideOffset), header.mappingWithSlideCount * MAPPING_WITH_SLIDE_SIZE, opts.signal);
    slideMappings = parseMappingsWithSlide(bytes, header.mappingWithSlideCount, source.size);
  }
  validateSlideMappings(slideMappings, mappings);
  const slide = normalizeSlide(header, opts);
  if (slide !== 0n && slideMappings.length === 0) throw new Error('cannot apply a nonzero dyld shared cache slide without slide info');
  const slideMetadata = [];
  for (const item of slideMappings) slideMetadata.push(await parseSlideInfoSource(source, item, slide, mappings, opts));
  return makeImage(null, source, header, mappings, slideMappings, slide, slideMetadata);
}

async function readBoundedRange(source, offset, length, signal) {
  if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('dyld shared cache read length must be a non-negative safe integer');
  const limit = Number(source.maxReadLength);
  if (!Number.isSafeInteger(limit) || limit <= 0 || length <= limit) return source.readExactly(offset, length, { signal });
  const out = new Uint8Array(length);
  let done = 0;
  while (done < length) {
    const take = Math.min(limit, length - done);
    out.set(await source.readExactly(exactNonNegativeBigInt(offset, 'read offset') + BigInt(done), take, { signal }), done);
    done += take;
  }
  return out;
}
