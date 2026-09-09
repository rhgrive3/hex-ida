import { parseMachOSource as parseMachOSourceRaw } from './source-loaders.js';

/*
 * Selected FAT Mach-O slices are shared producer artifacts. Keep the cache at
 * the public source-loader boundary so analysis and pointer-resolution share the
 * same parse instead of each reparsing identical bytes. The producer image
 * is never returned directly: each waiter receives a detached mutable view so
 * consumer annotations cannot mutate the cache or another consumer's result.
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

function cacheableStringsOptions(value) {
  if (value === true) return true;
  if (!value || typeof value !== 'object') return false;
  const semantic = { ...value };
  delete semantic.signal;
  return semantic;
}

function producerStringsOptions(value, onProgress, signal) {
  if (!value || typeof value !== 'object') return value;
  // Per-request observers must not be captured by the shared producer
  // (#5742): the producer receives a dispatcher that fans out to every
  // active waiter's callback, and a throwing observer is an observer bug,
  // not a parse failure.
  const { onProgress: _consumerProgress, ...rest } = value;
  return { ...rest, onProgress, signal };
}

function producerRangeOptions(value) {
  if (!value || typeof value !== 'object') return value;
  // A first consumer's ranges.signal must not reach the shared producer
  // (#5740): withSignal() keeps an existing signal, so a waiter's private
  // abort would cancel the parse other consumers still need.
  const { signal: _consumerSignal, ...rest } = value;
  return rest;
}

function cloneCachedArtifact(value) {
  const shared = new Set();
  if (value?.source && typeof value.source === 'object') shared.add(value.source);
  return cloneValue(value, new Map(), shared);
}

function cloneValue(value, seen, shared) {
  if (value == null || typeof value !== 'object' || shared.has(value)) return value;
  if (seen.has(value)) return seen.get(value);

  if (value instanceof ArrayBuffer) {
    const copy = value.slice(0);
    seen.set(value, copy);
    return copy;
  }
  if (ArrayBuffer.isView(value)) {
    const copy = value instanceof DataView
      ? new DataView(cloneValue(value.buffer, seen, shared), value.byteOffset, value.byteLength)
      : value.slice();
    seen.set(value, copy);
    return copy;
  }
  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    seen.set(value, copy);
    return copy;
  }
  if (value instanceof RegExp) {
    const copy = new RegExp(value.source, value.flags);
    copy.lastIndex = value.lastIndex;
    seen.set(value, copy);
    return copy;
  }
  if (value instanceof Map) {
    const copy = new Map();
    seen.set(value, copy);
    for (const [key, item] of value) {
      copy.set(cloneValue(key, seen, shared), cloneValue(item, seen, shared));
    }
    return copy;
  }
  if (value instanceof Set) {
    const copy = new Set();
    seen.set(value, copy);
    for (const item of value) copy.add(cloneValue(item, seen, shared));
    return copy;
  }

  const copy = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if ('value' in descriptor) descriptor.value = cloneValue(descriptor.value, seen, shared);
    try { Object.defineProperty(copy, key, descriptor); } catch { /* preserve best-effort data copies */ }
  }
  return copy;
}

function cacheKey(options = {}) {
  const ranges = options.ranges || {};
  const source = options.source || {};
  const strings = cacheableStringsOptions(options.strings);
  return JSON.stringify({
    sliceIndex: normalizeScalar(options.sliceIndex),
    strings,
    source: {
      maxReadLength: normalizeScalar(source.maxReadLength),
    },
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

function waitForEntry(entry, signal, onProgress = null) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  // Track each waiter separately. A shared callback function may be used by
  // multiple consumers; removing one waiter must not detach the other.
  const observer = typeof onProgress === 'function' ? { callback:onProgress } : null;
  if (observer) entry.progressObservers.add(observer);
  entry.waiters++;
  return new Promise((resolve, reject) => {
    let done = false;
    const detach = () => {
      signal?.removeEventListener('abort', onAbort);
      entry.waiters = Math.max(0, entry.waiters - 1);
      if (observer) entry.progressObservers.delete(observer);
    };
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      detach();
      fn(value);
    };
    const onAbort = () => {
      if (done) return;
      done = true;
      detach();
      if (!entry.settled && entry.waiters === 0) {
        entry.retire();
        entry.controller.abort('macho-slice-no-consumers');
      }
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once:true });
    entry.promise.then((value) => {
      try { finish(resolve, cloneCachedArtifact(value)); }
      catch (error) { finish(reject, error); }
    }, (error) => finish(reject, error));
  });
}

export function parseMachOSource(input, options = {}, prefix = null, rangeOptions = options.ranges || {}) {
  /* Cache only source-backed selected-slice requests.  Whole-container parsing
     is intentionally left to openBinarySource(), and non-object inputs cannot
     provide stable source identity. */
  const effectiveRangeOptions = rangeOptions ?? options.ranges ?? {};
  const source = input && (typeof input === 'object' || typeof input === 'function') ? input : null;
  // Only immutable ByteSources have stable identity worth caching: a mutable
  // Uint8Array/ArrayBuffer input (MemoryByteSource keeps the caller's buffer
  // by reference) can change between calls while the cached image still
  // reflects the old bytes — the cache would launder that mismatch into a
  // "confirmed" parse (#5536).
  const cacheable = !!source && !(input instanceof Uint8Array || input instanceof ArrayBuffer || ArrayBuffer.isView(input) || (typeof Blob !== 'undefined' && input instanceof Blob));
  const selected = options.sliceIndex != null;
  if (!source || !cacheable || !selected || prefix != null) return parseMachOSourceRaw(input, options, prefix, effectiveRangeOptions);

  const signal = options.signal ?? null;
  // An already-aborted caller must not mint a cache entry: the producer would
  // run the whole parse with zero live waiters (#5735).
  if (signal?.aborted) return Promise.reject(abortError(signal));

  const cache = sourceCache(source);
  const key = cacheKey({ ...options, ranges:effectiveRangeOptions });
  let entry = cache.get(key);
  if (entry && (entry.retired || entry.controller.signal.aborted)) {
    if (cache.get(key) === entry) cache.delete(key);
    entry = null;
  }
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, waiters:0, settled:false, retired:false, promise:null, retire:null, progressObservers:new Set() };
    entry.retire = () => {
      if (entry.retired) return;
      entry.retired = true;
      if (cache.get(key) === entry) cache.delete(key);
    };
    const dispatchProgress = (event) => {
      for (const observer of entry.progressObservers) {
        try { observer.callback(event); } catch { /* one broken observer must not fail the shared parse */ }
      }
    };
    const producerRanges = producerRangeOptions(effectiveRangeOptions);
    const producerOptions = {
      ...options,
      signal:controller.signal,
      ranges:producerRanges,
      strings:producerStringsOptions(options.strings, dispatchProgress, controller.signal),
    };
    entry.promise = parseMachOSourceRaw(input, producerOptions, null, producerRanges)
      .then((image) => {
        entry.settled = true;
        if (controller.signal.aborted || image?.metadata?.sourceStrings?.cancelled === true) entry.retire();
        return image;
      })
      .catch((error) => {
        entry.retire();
        throw error;
      });
    cache.set(key, entry);
  }
  return waitForEntry(entry, signal, options.strings?.onProgress ?? null);
}

export function clearMachOSourceCache(source) {
  if (source && (typeof source === 'object' || typeof source === 'function')) CACHE.delete(source);
}

export const __machoSourceCacheForTests = Object.freeze({ cacheKey });
