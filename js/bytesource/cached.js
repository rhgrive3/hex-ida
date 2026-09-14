import { ByteSource, asByteSource, nonNegativeBigInt } from '../binary/source.js';

export class ByteSourceCancelledError extends Error {
  constructor(message = 'ByteSource read was cancelled') {
    super(message);
    this.name = 'ByteSourceCancelledError';
    this.code = 'BYTE_SOURCE_CANCELLED';
  }
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new ByteSourceCancelledError();
}

export class CachedByteSource extends ByteSource {
  constructor(input, options = {}) {
    const source = asByteSource(input, options.source || {});
    super(source.size, { maxReadLength: options.maxReadLength ?? source.maxReadLength });
    this.source = source;
    this.pageSize = options.pageSize ?? 256 * 1024;
    this.maxCachedBytes = options.maxCachedBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(this.pageSize) || this.pageSize <= 0) throw new TypeError('pageSize must be a positive safe integer');
    if (this.pageSize > source.maxReadLength) throw new RangeError('pageSize must not exceed source maxReadLength');
    if (!Number.isSafeInteger(this.maxCachedBytes) || this.maxCachedBytes < this.pageSize) throw new TypeError('maxCachedBytes must be at least one page');
    this.cache = new Map();
    this.inflight = new Map();
    this.cachedBytes = 0;
    this.generation = 0;
    this.stats = { requests: 0, hits: 0, misses: 0, backendBytesRead: 0, largestRead: 0 };
  }

  async read(offset, length, options = {}) {
    const range = this.validateRange(offset, length);
    throwIfCancelled(options.signal);
    this.stats.requests++;
    this.stats.largestRead = Math.max(this.stats.largestRead, range.length);
    if (range.length === 0) return new Uint8Array(0);

    const generation = this.generation;
    const out = new Uint8Array(range.length);
    let done = 0;
    const start = range.offset;
    while (done < range.length) {
      throwIfCancelled(options.signal);
      const absolute = start + BigInt(done);
      const pageIndex = absolute / BigInt(this.pageSize);
      const pageOffset = Number(absolute % BigInt(this.pageSize));
      const page = await this.#page(pageIndex, options.signal);
      throwIfCancelled(options.signal);
      // clear() also revokes cache-hit continuations and multi-page reads.
      if (generation !== this.generation) throw new ByteSourceCancelledError();
      if (pageOffset >= page.length) break;
      const take = Math.min(page.length - pageOffset, range.length - done);
      out.set(page.subarray(pageOffset, pageOffset + take), done);
      done += take;
    }
    return done === range.length ? out : out.subarray(0, done);
  }

  async readExactly(offset, length, options = {}) {
    const range = this.validateRange(offset, length);
    const generation = this.generation;
    const bytes = await this.read(range.offset, range.length, options);
    // The inner read can finish one microtask before this public operation.
    throwIfCancelled(options.signal);
    if (generation !== this.generation) throw new ByteSourceCancelledError();
    if (bytes.byteLength !== range.length) throw new Error(`truncated cached read: expected ${range.length}, received ${bytes.byteLength}`);
    return bytes;
  }

  async #page(pageIndex, signal) {
    const key = pageIndex.toString();
    const cached = this.cache.get(key);
    if (cached) {
      this.stats.hits++;
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    this.stats.misses++;
    let entry = this.inflight.get(key);
    let startProducer = null;
    if (!entry) {
      const offset = pageIndex * BigInt(this.pageSize);
      const remaining = this.size - offset;
      const length = Number(remaining < BigInt(this.pageSize) ? remaining : BigInt(this.pageSize));
      const generation = this.generation;
      entry = {
        controller: new AbortController(),
        waiters: 0,
        settled: false,
        discard: false,
        promise: null,
        cancel: null,
      };
      const cancelled = new Promise((_, reject) => {
        entry.cancel = () => reject(new ByteSourceCancelledError());
      });
      // Reserve the entry and its consumers before backend code can reenter.
      // Start within this call (not a later microtask): consumers such as the
      // Mach-O cache rely on replacement I/O starting before read() returns.
      const producer = new Promise((resolve, reject) => {
        startProducer = () => {
          (async () => {
            throwIfCancelled(entry.controller.signal);
            const result = await this.source.readExactly(offset, length, { signal: entry.controller.signal });
            this.stats.backendBytesRead += result.byteLength;
            throwIfCancelled(entry.controller.signal);
            // Backend views may alias reusable storage or retain an entire file.
            // Cache-owned buffers make page accounting and snapshots exact.
            const bytes = new Uint8Array(result);
            if (!entry.discard && generation === this.generation) this.#remember(key, bytes);
            return bytes;
          })().then(resolve, reject);
        };
      });
      // A backend may ignore cancellation indefinitely. Revocation must still settle
      // consumers, and the race keeps late producer failures observed.
      entry.promise = Promise.race([producer, cancelled]).finally(() => {
        entry.settled = true;
        if (this.inflight.get(key) === entry) this.inflight.delete(key);
      });
      // A consumer can reject during signal setup before it starts waiting.
      // Observe that abandoned entry without changing errors seen by other consumers.
      entry.promise.catch(() => {});
      this.inflight.set(key, entry);
    }

    const waiting = this.#waitForPage(key, entry, signal);
    startProducer?.();
    return waiting;
  }

  #waitForPage(key, entry, signal) {
    throwIfCancelled(signal);
    entry.waiters++;
    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      entry.waiters = Math.max(0, entry.waiters - 1);
      if (entry.waiters !== 0 || entry.settled || entry.discard) return;
      entry.discard = true;
      if (this.inflight.get(key) === entry) this.inflight.delete(key);
      entry.cancel();
      entry.controller.abort();
    };

    if (!signal) {
      return entry.promise.finally(detach);
    }

    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (fn, value) => {
        if (finished) return;
        finished = true;
        // Listener cleanup is advisory; it cannot strand a settled consumer.
        try { signal.removeEventListener?.('abort', onAbort); } catch { /* preserve the result */ }
        detach();
        fn(value);
      };
      const onAbort = () => finish(reject, new ByteSourceCancelledError());
      entry.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
      try {
        signal.addEventListener?.('abort', onAbort, { once: true });
      } catch (error) {
        finish(reject, error);
        return;
      }
      if (signal.aborted) {
        onAbort();
        return;
      }
    });
  }

  #remember(key, bytes) {
    if (this.cache.has(key)) this.#drop(key);
    this.cache.set(key, bytes);
    this.cachedBytes += bytes.byteLength;
    while (this.cachedBytes > this.maxCachedBytes && this.cache.size) {
      this.#drop(this.cache.keys().next().value);
    }
  }

  #drop(key) {
    const value = this.cache.get(key);
    if (!value) return;
    this.cachedBytes -= value.byteLength;
    this.cache.delete(key);
  }

  clear() {
    this.generation++;
    const entries = [...this.inflight.values()];
    this.cache.clear();
    this.inflight.clear();
    this.cachedBytes = 0;
    // Revoke the entire old generation before any abort listener can start a
    // replacement read. Never iterate a map that those callbacks can repopulate.
    for (const entry of entries) entry.discard = true;
    for (const entry of entries) {
      entry.cancel();
      entry.controller.abort();
    }
  }

  memoryStats() {
    return {
      bytesCached: this.cachedBytes,
      chunksCached: this.cache.size,
      pendingReads: this.inflight.size,
      ...this.stats,
    };
  }
}

export class InstrumentedByteSource extends ByteSource {
  constructor(input) {
    const source = asByteSource(input);
    super(source.size, { maxReadLength: source.maxReadLength });
    this.source = source;
    this.reads = [];
  }

  async read(offset, length, options = {}) {
    const range = this.validateRange(offset, length);
    this.reads.push({ offset: nonNegativeBigInt(range.offset), length: range.length });
    return this.source.readExactly(range.offset, range.length, options);
  }

  metrics() {
    let totalRequested = 0;
    let largestSingleRead = 0;
    let peakRequestedRange = 0n;
    for (const read of this.reads) {
      totalRequested += read.length;
      largestSingleRead = Math.max(largestSingleRead, read.length);
      const end = read.offset + BigInt(read.length);
      if (end > peakRequestedRange) peakRequestedRange = end;
    }
    return { reads: this.reads.length, totalRequested, largestSingleRead, peakRequestedRange: peakRequestedRange.toString() };
  }
}
