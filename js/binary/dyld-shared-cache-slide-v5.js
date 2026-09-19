import { ByteView } from './reader.js';

const PAGE_ATTR_NO_REBASE = 0xffff;
const RUNTIME_OFFSET_MASK = 0x3ffffffffn;
const NEXT_MASK = 0x7ffn;

function exactNonNegativeBigInt(value, label) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new TypeError(`${label} must be a non-negative exact integer`);
}

function checkedRange(offset, size, total, label) {
  const o = exactNonNegativeBigInt(offset, `${label} offset`);
  const n = exactNonNegativeBigInt(size, `${label} size`);
  if (o > total || n > total - o) throw new Error(`${label} is outside dyld shared cache bounds`);
}

function inAnyMapping(address, mappings) {
  return mappings.some((m) => address >= m.address && address < m.address + m.size);
}

function inTargetRange(address, range) {
  return range != null && range.size > 0n && address >= range.start && address < range.start + range.size;
}

function isPowerOfTwo(value) {
  return Number.isSafeInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

export function parseSlideInfo5Structure(bytes, mapping, totalSize) {
  const r = new ByteView(bytes, { littleEndian: true });
  if (r.length < 24) throw new Error('dyld shared cache slide info v5 is truncated');
  const version = r.u32(0);
  if (version !== 5) throw new Error(`unsupported dyld shared cache slide info version ${version}`);
  const pageSize = r.u32(4);
  const startsCount = r.u32(8);
  const valueAdd = r.u64(16);
  if (!isPowerOfTwo(pageSize) || pageSize < 4096 || pageSize > 65536) {
    throw new Error('invalid dyld shared cache slide info v5 page size');
  }
  const expectedPages = Number((mapping.size + BigInt(pageSize) - 1n) / BigInt(pageSize));
  if (startsCount !== expectedPages) throw new Error('dyld shared cache slide v5 page count does not cover its mapping exactly');
  if (startsCount > Math.floor((r.length - 24) / 2)) throw new Error('dyld shared cache slide v5 page starts are out of bounds');
  checkedRange(mapping.fileOffset, mapping.size, totalSize, 'dyld shared cache v5 rebased mapping');
  const starts = Array.from({ length: startsCount }, (_, i) => r.u16(24 + i * 2));
  return { version, pageSize, starts, valueAdd };
}

function decodeRecord(mapping, pageOffset, raw, info, slide, mappings, targetRange) {
  const authenticated = ((raw >> 63n) & 1n) !== 0n;
  const runtimeOffset = raw & RUNTIME_OFFSET_MASK;
  const targetAddress = info.valueAdd + runtimeOffset;
  const targetInCurrentFileMappings = inAnyMapping(targetAddress, mappings);
  const targetInSharedRegion = inTargetRange(targetAddress, targetRange);
  if (!targetInCurrentFileMappings && !targetInSharedRegion) {
    throw new Error('dyld shared cache v5 rebase target is outside declared shared region');
  }
  const next = Number((raw >> 52n) & NEXT_MASK);
  const high8 = Number((raw >> 34n) & 0xffn);
  const record = {
    storageAddress: mapping.address + BigInt(pageOffset),
    runtimeStorageAddress: mapping.address + BigInt(pageOffset) + slide,
    rawValue: raw,
    targetAddress,
    runtimeTargetAddress: targetAddress + slide,
    authenticated,
    runtimeOffset,
    nextPointerUnits: next,
    targetInCurrentFileMappings,
    targetInSharedRegion,
  };
  if (authenticated) {
    record.diversity = Number((raw >> 34n) & 0xffffn);
    record.addressDiversity = ((raw >> 50n) & 1n) !== 0n;
    record.keyIsData = ((raw >> 51n) & 1n) !== 0n;
  } else {
    record.high8 = high8;
    record.materializedRuntimeValue = (targetAddress + slide) | (BigInt(high8) << 56n);
  }
  return { next, record };
}

function initialOffset(info, page) {
  const start = info.starts[page];
  if (start === PAGE_ATTR_NO_REBASE) return null;
  // dyld_cache_slide_info5 page_starts entries are pointer5 element offsets,
  // just like offsetToNextPointer. Each unit advances one 64-bit pointer.
  return start * 8;
}

export function walkSlideInfo5Sync(bytes, mapping, info, slide, mappings, maxRecords, targetRange = null) {
  const r = new ByteView(bytes, { littleEndian: true, base: mapping.fileOffset });
  const rebases = [];
  for (let page = 0; page < info.starts.length; page++) {
    let withinPage = initialOffset(info, page);
    if (withinPage == null) continue;
    let guard = 0;
    while (true) {
      const pageStart = page * info.pageSize;
      const pageEnd = Math.min((page + 1) * info.pageSize, bytes.length);
      const offset = pageStart + withinPage;
      if ((withinPage & 7) !== 0 || offset < pageStart || offset + 8 > pageEnd) throw new Error('dyld shared cache v5 rebase chain leaves its page');
      if (rebases.length >= maxRecords) throw new Error('dyld shared cache rebase record budget exceeded');
      const { next, record } = decodeRecord(mapping, offset, r.u64(offset), info, slide, mappings, targetRange);
      rebases.push(record);
      if (next === 0) break;
      withinPage += next * 8;
      if (++guard > info.pageSize / 8) throw new Error('dyld shared cache v5 rebase chain is cyclic');
    }
  }
  return rebases;
}

export async function walkSlideInfo5Source(read64, mapping, info, slide, mappings, maxRecords, targetRange = null) {
  const rebases = [];
  for (let page = 0; page < info.starts.length; page++) {
    let withinPage = initialOffset(info, page);
    if (withinPage == null) continue;
    let guard = 0;
    while (true) {
      const pageStart = page * info.pageSize;
      const pageEnd = Math.min((page + 1) * info.pageSize, Number(mapping.size));
      const offset = pageStart + withinPage;
      if ((withinPage & 7) !== 0 || offset < pageStart || offset + 8 > pageEnd) throw new Error('dyld shared cache v5 rebase chain leaves its page');
      if (rebases.length >= maxRecords) throw new Error('dyld shared cache rebase record budget exceeded');
      const raw = await read64(mapping.fileOffset + BigInt(offset));
      const { next, record } = decodeRecord(mapping, offset, raw, info, slide, mappings, targetRange);
      rebases.push(record);
      if (next === 0) break;
      withinPage += next * 8;
      if (++guard > info.pageSize / 8) throw new Error('dyld shared cache v5 rebase chain is cyclic');
    }
  }
  return rebases;
}
