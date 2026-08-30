const CACHE = new WeakMap();
const YIELD_EVERY = 16384;

function abortError(signal) {
  const error = signal?.reason instanceof Error ? signal.reason : new Error('Operation aborted');
  if (!error.name || error.name === 'Error') error.name = 'AbortError';
  return error;
}

function dataRanges(regions) {
  return (regions || [])
    .filter((region) => {
      if (region?.exec) return false;
      let size = 0n;
      try { size = BigInt(region?.declaredSize ?? region?.size ?? 0); } catch { return false; }
      return size > 0n && /__data|__bss|__common|__const|__cfstring|__objc_(ivar|const|data)/.test(region?.section || '');
    })
    .map((region) => ({
      region,
      lo:BigInt(region.vmAddr),
      hi:BigInt(region.vmAddr) + BigInt(region.declaredSize ?? region.size ?? 0),
    }))
    .filter((range) => range.hi > range.lo)
    .sort((a, b) => a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0);
}

function rangeKey(ranges) {
  return ranges.map(({ region, lo, hi }) => `${region.id || region.name}:${lo}:${hi}`).join('|');
}

function regionFor(ranges, address) {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = ranges[mid];
    if (address < range.lo) hi = mid - 1;
    else if (address >= range.hi) lo = mid + 1;
    else return range.region;
  }
  return null;
}

function completeness(program) {
  const graph = program?.graphCompleteness;
  const incomplete = program?.unsupported === true
    || graph?.complete === false
    || program?.refsCapped === true
    || Boolean(program?.queryIncompleteReason);
  return {
    complete: !incomplete,
    reason: program?.queryIncompleteReason
      || graph?.reasons?.[0]
      || (program?.refsCapped ? 'refs-source-capped' : null)
      || (program?.unsupported ? 'unsupported-program-analysis' : null),
  };
}

async function produce(program, ranges, signal) {
  const counts = new Map();
  const total = Math.max(0, Number(program?.refCount || 0));
  for (let i = 0; i < total; i++) {
    if (signal.aborted) throw abortError(signal);
    const target = program.refTo?.[i];
    if (target != null) {
      const address = BigInt(target);
      const region = regionFor(ranges, address);
      if (region) {
        const key = address.toString();
        const existing = counts.get(key);
        if (existing) existing.refs++;
        else counts.set(key, { addr:address, refs:1, region:region.name || region.section || region.id || '' });
      }
    }
    if (i && i % YIELD_EVERY === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { counts, scannedRefs:total, ...completeness(program) };
}

function entryFor(program, ranges) {
  let map = CACHE.get(program);
  if (!map) { map = new Map(); CACHE.set(program, map); }
  const key = rangeKey(ranges);
  let entry = map.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, waiters:0, result:null, promise:null };
    entry.promise = produce(program, ranges, controller.signal)
      .then((value) => { entry.result = value; return value; })
      .catch((error) => { if (!entry.result) map.delete(key); throw error; });
    map.set(key, entry);
  }
  return entry;
}

export function globalReferenceStats(program, regions, { signal } = {}) {
  if (!program) return Promise.resolve({ counts:new Map(), scannedRefs:0, complete:false, reason:'program-index-unavailable' });
  const ranges = dataRanges(regions);
  const entry = entryFor(program, ranges);
  if (entry.result) return Promise.resolve(entry.result);
  entry.waiters++;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      entry.waiters = Math.max(0, entry.waiters - 1);
      fn(value);
    };
    const onAbort = () => {
      finish(reject, abortError(signal));
      if (entry.waiters === 0 && !entry.result) entry.controller.abort(signal?.reason ?? 'no-consumers');
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener?.('abort', onAbort, { once:true });
    entry.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

export function clearGlobalReferenceStats(program) {
  if (program) CACHE.delete(program);
}
