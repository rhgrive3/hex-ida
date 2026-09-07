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
  // Each waiter needs its own registration token. A Set keyed by the callback
  // itself would merge identical callbacks and let one waiter detach another.
  const progressObserver = onProgress ? (event) => onProgress(event) : null;
  if (progressObserver) entry.progressObservers.add(progressObserver);
  entry.waiters++;
  return new Promise((resolve, reject) => {
    let done = false;
    const detach = () => {
      signal?.removeEventListener('abort', onAbort);
      entry.waiters = Math.max(0, entry.waiters - 1);
      if (progressObserver) entry.progressObservers.delete(progressObserver);
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

  const signal = options.signal ?? null;
  // An already-aborted caller must not mint a cache entry: the producer would
  // run the whole parse with zero live waiters (#5735).
  if (signal?.aborted) return Promise.reject(abortError(signal));

  const cache = sourceCache(source);
  const key = cacheKey({ ...options, ranges:rangeOptions || options.ranges || {} });
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
        try { observer(event); } catch { /* one broken observer must not fail the shared parse */ }
      }
    };
    const producerRanges = producerRangeOptions(rangeOptions);
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
