import { ByteView } from './reader.js';
import { asByteSource } from './source.js';
import { decodeDyldSharedCacheMagic } from './detect.js';
import {
  parseDyldSharedCache as parseDyldSharedCacheCore,
  parseDyldSharedCacheSource as parseDyldSharedCacheSourceCore,
} from './dyld-shared-cache-core.js';

const LEGACY_SLIDE_INFO_END = 0x48;
const MODERN_HEADER_SIZE = 0x140;
const LEGACY_SLIDE_INFO_OFFSET = 0x38;
const LEGACY_SLIDE_INFO_SIZE = 0x40;

function rejectUnsupportedLegacySlideInfo(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < LEGACY_SLIDE_INFO_END) return;
  if (!decodeDyldSharedCacheMagic(bytes.subarray(0, 16))) return;
  const r = new ByteView(bytes, { littleEndian: true });
  const mappingOffset = r.u32(0x10);
  if (mappingOffset < LEGACY_SLIDE_INFO_END || mappingOffset >= MODERN_HEADER_SIZE) return;
  if (r.u64(LEGACY_SLIDE_INFO_OFFSET) !== 0n || r.u64(LEGACY_SLIDE_INFO_SIZE) !== 0n) {
    throw new Error('legacy dyld shared cache slide info is unsupported');
  }
}

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('Expected bytes for dyld shared cache parsing');
}

async function readGuardPrefix(source, signal) {
  const length = Number(source.size < BigInt(MODERN_HEADER_SIZE) ? source.size : BigInt(MODERN_HEADER_SIZE));
  const out = new Uint8Array(length);
  let done = 0;
  while (done < length) {
    const take = Math.min(source.maxReadLength, length - done);
    out.set(await source.readExactly(BigInt(done), take, { signal }), done);
    done += take;
  }
  return out;
}

export function parseDyldSharedCache(input, opts = {}) {
  const bytes = asBytes(input);
  rejectUnsupportedLegacySlideInfo(bytes.subarray(0, Math.min(bytes.byteLength, MODERN_HEADER_SIZE)));
  return parseDyldSharedCacheCore(bytes, opts);
}

export async function parseDyldSharedCacheSource(input, opts = {}) {
  const source = asByteSource(input, opts.source || {});
  rejectUnsupportedLegacySlideInfo(await readGuardPrefix(source, opts.signal));
  return parseDyldSharedCacheSourceCore(source, opts);
}
