import { parseMachOSource as parseMachOSourceRaw } from './source-loaders.js';

/*
 * Selected FAT Mach-O slices are immutable loader artifacts.  Keep the cache at
 * the public source-loader boundary so analysis and pointer-resolution share the
 * same parse instead of each reparsing identical bytes.
 *
 * The producer owns its AbortController.  Consumer cancellation only detaches
 * that waiter; the producer is aborted when the last waiter leaves.  This avoids
 * one UI/query cancellation destroying work another consumer still needs.
 */
const CACHE = new WeakMap();

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Mach-O slice parse cancelled');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function normalizeScalar(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value ?? null;
  return String(value);
}

function cacheKey(options = {}) {
  const ranges = options.ranges || {};
  const strings = options.strings && typeof options.strings === 'object' ? options.strings : options.strings === true ? true : false;
  return JSON.stringify({
    sliceIndex: normalizeScalar(options.sliceIndex),
    strings,
    ranges: {
      pageSize: normalizeScalar(ranges.pageSize),
      maxPageSize: normalizeScalar(ranges.maxPageSize),
      maxCachedBytes: normalizeScalar(ranges.maxCachedBytes),
      maxReads: normalizeScalar(ranges.maxReads),
      maxTotalBytes: normalizeScalar(ranges.maxTotalBytes),
    },
  });
}

function sourceCache(source) {
  let cache = CACHE.get(source);
  if (!cache) {
    cache = new Map();
    CACHE.set(source, cache);
  }
  return cache;
}

function waitForEntry(entry, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  entry.waiters++;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      entry.waiters = Math.max(0, entry.waiters - 1);
      fn(value);
    };
    const onAbort = () => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      entry.waiters = Math.max(0, entry.waiters - 1);
      if (!entry.settled && entry.waiters === 0) entry.controller.abort('macho-slice-no-consumers');
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once:true });
    entry.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

export function parseMachOSource(input, options = {}, prefix = null, rangeOptions = options.ranges || {}) {
  /* Cache only source-backed selected-slice requests.  Whole-container parsing
     is intentionally left to openBinarySource(), and non-object inputs cannot
     provide stable source identity. */
  const source = input && (typeof input === 'object' || typeof input === 'function') ? input : null;
  const selected = options.sliceIndex != null;
  if (!source || !selected || prefix != null) return parseMachOSourceRaw(input, options, prefix, rangeOptions);

  const cache = sourceCache(source);
  const key = cacheKey({ ...options, ranges:rangeOptions || options.ranges || {} });
  let entry = cache.get(key);
  if (!entry) {
    const controller = new AbortController();
    const producerOptions = { ...options, signal:controller.signal };
    entry = { controller, waiters:0, settled:false, promise:null };
    entry.promise = parseMachOSourceRaw(input, producerOptions, null, rangeOptions)
      .then((image) => {
        entry.settled = true;
        return image;
      })
      .catch((error) => {
        cache.delete(key);
        throw error;
      });
    cache.set(key, entry);
  }
  return waitForEntry(entry, options.signal ?? null);
}

export function clearMachOSourceCache(source) {
  if (source && (typeof source === 'object' || typeof source === 'function')) CACHE.delete(source);
}

export const __machoSourceCacheForTests = Object.freeze({ cacheKey });
