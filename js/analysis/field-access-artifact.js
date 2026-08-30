const CACHE = new WeakMap();

function abortError(signal, fallback = 'Field-access search aborted') {
  const error = signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason || fallback));
  if (!error.name || error.name === 'Error') error.name = 'AbortError';
  return error;
}

function resultState(result) {
  const complete = result?.complete !== false && result?.truncated !== true;
  return {
    complete,
    reason:complete ? null : (result?.reason || result?.incompleteReason || result?.truncationReason || 'field-access-incomplete'),
  };
}

function cacheFor(backend) {
  let map = CACHE.get(backend);
  if (!map) { map = new Map(); CACHE.set(backend, map); }
  return map;
}

function artifactKey(region, offset, size) {
  return `${region.id}:${BigInt(offset)}:${Number(size || 0)}`;
}

function entryFor(backend, region, offset, size) {
  const map = cacheFor(backend);
  const key = artifactKey(region, offset, size);
  let entry = map.get(key);
  if (entry) return entry;

  const request = backend.fieldAccess({ regionId:region.id, offset, size:size || 0 });
  entry = { request, waiters:0, result:null, promise:null };
  entry.promise = Promise.resolve(request)
    .then((result) => {
      const state = resultState(result);
      entry.result = Object.freeze({
        regionId:region.id,
        results:Object.freeze((result?.results || []).map((row) => Object.freeze({ ...row, regionId:region.id }))),
        ...state,
      });
      return entry.result;
    })
    .catch((error) => {
      if (!entry.result) map.delete(key);
      throw error;
    });
  map.set(key, entry);
  return entry;
}

export function fieldAccessRegion(backend, region, offset, size, { signal } = {}) {
  if (!backend || !region?.id) return Promise.resolve({ regionId:region?.id || null, results:[], complete:false, reason:'field-access-unavailable' });
  const entry = entryFor(backend, region, offset, size);
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
      if (entry.waiters === 0 && !entry.result && typeof entry.request?.cancel === 'function') entry.request.cancel();
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener?.('abort', onAbort, { once:true });
    if (signal?.aborted) { onAbort(); return; }
    entry.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function executableRegions(app) {
  return (app?.store?.get?.('regions') || []).filter((region) => {
    if (!region?.exec || !region?.id) return false;
    try { return BigInt(region.size ?? region.declaredSize ?? 0) > 0n; } catch { return false; }
  });
}

function aggregate(parts, regions, completedIds) {
  const results = [];
  const reasons = [];
  let sourcesComplete = true;
  for (const part of parts.values()) {
    results.push(...part.results);
    if (!part.complete) { sourcesComplete = false; if (part.reason) reasons.push(part.reason); }
  }
  const unscannedRegionIds = regions.map((region) => region.id).filter((id) => !completedIds.has(id));
  const complete = unscannedRegionIds.length === 0 && sourcesComplete;
  return Object.freeze({
    results:Object.freeze(results),
    complete,
    scannedRegionIds:Object.freeze(Array.from(completedIds)),
    unscannedRegionIds:Object.freeze(unscannedRegionIds),
    reason:complete ? null : (reasons[0] || (unscannedRegionIds.length ? 'regions-pending' : 'field-access-incomplete')),
  });
}

export async function fieldAccessAcrossExecutableRegions(app, offset, size, {
  signal = null,
  concurrency = 2,
  onPartial = null,
} = {}) {
  const regions = executableRegions(app);
  if (!regions.length) return aggregate(new Map(), [], new Set());
  const currentId = app?.codeRegion?.()?.id;
  regions.sort((a, b) => Number(b.id === currentId) - Number(a.id === currentId));

  const parts = new Map();
  const completedIds = new Set();
  const publish = () => onPartial?.(aggregate(parts, regions, completedIds));
  const runOne = async (region) => {
    if (signal?.aborted) throw abortError(signal);
    const part = await fieldAccessRegion(app.backend, region, offset, size, { signal });
    parts.set(region.id, part);
    completedIds.add(region.id);
    publish();
  };

  // The active region is the fast path. Publish it before starting the bounded
  // background expansion so first useful evidence does not wait for the whole binary.
  await runOne(regions[0]);
  const rest = regions.slice(1);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(Math.floor(Number(concurrency) || 1), 3, rest.length || 1));
  const workers = Array.from({ length:workerCount }, async () => {
    while (cursor < rest.length) {
      const index = cursor++;
      await runOne(rest[index]);
    }
  });
  await Promise.all(workers);
  return aggregate(parts, regions, completedIds);
}

export function clearFieldAccessArtifacts(backend) {
  if (backend) CACHE.delete(backend);
}
