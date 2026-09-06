const CACHE = new WeakMap();

function abortError(signal, fallback = 'Field-access search aborted') {
  const error = signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason || fallback));
  if (!error.name || error.name === 'Error') error.name = 'AbortError';
  return error;
}

function resultState(result) {
  const unsupported = result?.unsupported === true;
  const complete = result?.complete === true && result?.truncated !== true && !unsupported;
  return {
    complete,
    ...(unsupported ? { unsupported:true } : {}),
    reason:complete ? null : (result?.reason || result?.incompleteReason || result?.truncationReason || (unsupported ? 'field-access-unsupported' : 'field-access-incomplete')),
  };
}

function backendGeneration(backend) {
  try {
    const generation = backend?.analysisEpoch;
    return Number.isSafeInteger(generation) && generation >= 0 ? generation : null;
  } catch {
    return null;
  }
}

function cacheFor(backend) {
  const generation = backendGeneration(backend);
  if (generation == null) {
    CACHE.delete(backend);
    return new Map();
  }
  let state = CACHE.get(backend);
  if (!state || state.generation !== generation) {
    state = { generation, entries:new Map() };
    CACHE.set(backend, state);
  }
  return state.entries;
}

function canonicalRegionId(region) {
  const regionId = region?.id;
  if (typeof regionId !== 'string' || regionId.length === 0) throw new TypeError('field-access-region-id-invalid');
  return regionId;
}

function canonicalOffset(offset) {
  if (typeof offset === 'bigint') return offset;
  if (typeof offset === 'number' && Number.isSafeInteger(offset)) return BigInt(offset);
  throw new TypeError('field-access-offset-invalid');
}

function canonicalSize(size) {
  if (size == null) return 0;
  if (typeof size === 'bigint') {
    if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('field-access-size-invalid');
    return Number(size);
  }
  if (typeof size === 'number' && Number.isSafeInteger(size) && size >= 0) return size === 0 ? 0 : size;
  throw new TypeError('field-access-size-invalid');
}

function canonicalRequest(region, offset, size) {
  return Object.freeze({
    regionId:canonicalRegionId(region),
    offset:canonicalOffset(offset),
    size:canonicalSize(size),
  });
}

function artifactKey(request) {
  return `${request.regionId}:${request.offset}:${request.size}`;
}

function validBackendResult(result) {
  if (result == null || typeof result !== 'object' || Array.isArray(result)) return false;
  if (!Array.isArray(result.results)) return false;
  if (result.complete != null && typeof result.complete !== 'boolean') return false;
  if (result.truncated != null && typeof result.truncated !== 'boolean') return false;
  if (result.unsupported != null && typeof result.unsupported !== 'boolean') return false;
  return true;
}

function entryFor(backend, requestParams) {
  const map = cacheFor(backend);
  const key = artifactKey(requestParams);
  let entry = map.get(key);
  if (entry) return entry;

  const request = backend.fieldAccess(requestParams);
  entry = { request, waiters:0, result:null, promise:null };
  entry.promise = Promise.resolve(request)
    .then((result) => {
      if (!validBackendResult(result)) throw new TypeError('field-access-invalid-result');
      const state = resultState(result);
      entry.result = Object.freeze({
        regionId:requestParams.regionId,
        results:Object.freeze(result.results.map((row) => Object.freeze({ ...row, regionId:requestParams.regionId }))),
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
  if (!backend || region?.id == null || region.id === '') return Promise.resolve({ regionId:region?.id || null, results:[], complete:false, reason:'field-access-unavailable' });
  if (signal?.aborted) return Promise.reject(abortError(signal));
  const requestParams = canonicalRequest(region, offset, size);
  const entry = entryFor(backend, requestParams);
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
  const publish = () => {
    if (typeof onPartial === 'function') onPartial(aggregate(parts, regions, completedIds));
  };
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
