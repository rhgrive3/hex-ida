/*
 * First-party App -> AI context.
 *
 * Product analysis facts cross AnalysisQueryAPI. The historical direct-index
 * implementation is isolated in hex-context-legacy.js and is used only by
 * headless/compatibility hosts that do not expose the public query layer.
 */
import {
  analyzeModelAt as analyzeLegacyModelAt,
  createHexAIContext as createLegacyHexAIContext,
} from './hex-context-legacy.js';
import { createAnalysisSnapshot } from '../../analysis/query/index.js';

const QUERY_AUTHORITY = 'AnalysisQueryAPI';
const MAX_QUERY_PAGE = 5_000;

function normalizeOptions(options) {
  return options && typeof options === 'object' ? options : {};
}

function toBigInt(value) {
  if (value == null) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || !/^(?:0x[0-9a-f]+|-?[0-9]+)$/i.test(trimmed)) return null;
  try { return BigInt(trimmed); }
  catch { return null; }
}

function safeCount(value, fallback, max = MAX_QUERY_PAGE) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? Math.min(max, value) : fallback;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^[0-9]+$/.test(trimmed)) return fallback;
    const n = Number(trimmed);
    return Number.isSafeInteger(n) && n >= 0 ? Math.min(max, n) : fallback;
  }
  return fallback;
}

function queryCompleteness(result) {
  return result?.completeness ?? result?.status?.completeness ?? 'partial';
}

function queryReason(result) {
  return result?.status?.reason ?? result?.reason ?? null;
}

function isStale(error) {
  return error?.name === 'AnalysisSnapshotStaleError'
    || error?.code === 'ANALYSIS_SNAPSHOT_STALE';
}

function abortIfNeeded(signal) {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('AbortError');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  throw error;
}

async function withFreshSnapshot(app, operation, options = {}) {
  const opts = normalizeOptions(options);
  const api = app?.analysisQueries;
  if (!api) throw new Error('analysis-query-api-unavailable');
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    abortIfNeeded(opts.signal);
    const snapshot = await api.snapshot({
      signal:opts.signal ?? null,
      onProgress:opts.onProgress,
      onIdentityProgress:opts.onIdentityProgress,
    });
    try {
      const value = await operation(api, snapshot);
      abortIfNeeded(opts.signal);
      return value;
    } catch (error) {
      last = error;
      if (!isStale(error) || attempt > 0) throw error;
    }
  }
  throw last ?? new Error('analysis-query-retry-exhausted');
}

function presentationModel(result) {
  const value = result?.value;
  if (!value) return null;
  if (value.model) return value.model;
  const legacy = value.pipeline?.legacyV1 ?? value.semanticAnalysis?.pipeline?.legacyV1 ?? null;
  if (!legacy) return null;
  const model = { ...legacy };
  model.truncated = model.truncated === true || value.truncated === true || queryCompleteness(result) !== 'complete';
  Object.defineProperties(model, {
    __analysisAuthority:{ value:QUERY_AUTHORITY, enumerable:false },
    __canonicalAnalysisResult:{ value:value, enumerable:false },
  });
  return model;
}

async function queryFunction(app, address, options = {}) {
  const opts = normalizeOptions(options);
  const addr = toBigInt(address);
  if (addr == null) return { result:null, model:null };
  const queryOptions = { ...opts };
  if (typeof opts.maxInstructions === 'number' && Number.isFinite(opts.maxInstructions)) {
    if (Math.floor(opts.maxInstructions) <= 0) return { result:null, model:null };
    queryOptions.maxRows = Math.max(1, Math.floor(opts.maxInstructions));
  }
  const result = await withFreshSnapshot(app,
    (api, snapshot) => api.function(snapshot, addr, queryOptions), queryOptions);
  if (queryCompleteness(result) === 'unsupported' || result?.value == null) return { result, model:null };
  return { result, model:presentationModel(result) };
}

/**
 * Semantic compatibility projection for deterministic AI tools.
 * Raw assembly remains a separate QueryAPI.instructions() capability and is
 * never synthesized from Semantic-v2 instruction objects.
 */
export async function analyzeModelAt(app, address, end = null, options = {}) {
  const opts = normalizeOptions(options);
  if (!app?.analysisQueries) return analyzeLegacyModelAt(app, address, end, opts);
  const parsedEnd = end != null ? toBigInt(end) : null;
  const queryOpts = parsedEnd != null && opts.end == null ? { ...opts, end:parsedEnd } : opts;
  const { model } = await queryFunction(app, address, queryOpts);
  return model;
}

function exactPageTotal(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function copyWithMetadata(result, key = 'results') {
  const rows = Array.isArray(result?.value) ? result.value : [];
  const completeness = queryCompleteness(result);
  const page = result?.page || {};
  const total = exactPageTotal(page.total);
  const offset = safeCount(page.offset, 0, 1_000_000);
  const returned = safeCount(page.returned, rows.length, MAX_QUERY_PAGE);
  return {
    [key]:rows,
    offset,
    returned,
    total,
    complete:completeness === 'complete' && page.next == null,
    truncated:completeness !== 'complete' || page.next != null,
    reason:queryReason(result),
    completeness:{
      complete:completeness === 'complete' && page.next == null,
      returned,
      total,
      reason:queryReason(result),
    },
  };
}

function cloneContextDescriptors(source) {
  return Object.defineProperties({}, Object.getOwnPropertyDescriptors(source));
}

function define(context, name, descriptor) {
  Object.defineProperty(context, name, {
    configurable:true,
    enumerable:true,
    ...descriptor,
  });
}

function currentAddressOf(context) {
  try { return toBigInt(context.currentAddress); } catch { return null; }
}

function storeValue(app, key) {
  try { return typeof app?.store?.get === 'function' ? app.store.get(key) : (app?.store?.[key] ?? null); }
  catch { return null; }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function canonicalAnalysisRevision(app) {
  const rawEpoch = app?.backend?.gen ?? app?.analysisEpoch ?? null;
  if (rawEpoch == null) return null;
  const project = storeValue(app, 'project') ?? app?.workspace?.project ?? app?.project ?? null;
  const rawVersions = app?.analysisArtifactVersions ?? app?.artifactVersions;
  const artifactVersions = isPlainObject(rawVersions) ? { ...rawVersions } : {};
  return createAnalysisSnapshot({
    binaryId:'ai-cache-analysis-binding',
    projectRevision:project?.revision ?? app?.projectRevision ?? app?.workspace?.bindingRevision ?? 0,
    artifactVersions,
    analysisEpoch:rawEpoch,
  }).snapshotId;
}

/**
 * Build the live first-party AI capability object. Product App instances always
 * expose AnalysisQueryAPI; hosts without it are explicit compatibility oracles.
 */
export function createHexAIContext(app) {
  if (!app?.analysisQueries) return createLegacyHexAIContext(app);

  const legacy = createLegacyHexAIContext(app);
  const context = cloneContextDescriptors(legacy);
  const MAX_NAME_CACHE = 2048;
  const names = new Map();
  let cachedNameScope = null;
  const currentBinaryId = () => {
    try { return app?.backend?.binaryId ?? legacy.binaryId ?? null; }
    catch { return app?.backend?.binaryId ?? null; }
  };
  const currentNameScope = () => JSON.stringify([currentBinaryId(), app?.backend?.gen ?? app?.analysisEpoch ?? null]);
  const ensureNameScope = () => {
    const activeScope = currentNameScope();
    if (activeScope !== cachedNameScope) {
      names.clear();
      cachedNameScope = activeScope;
    }
    return activeScope;
  };
  const nameCacheKey = (address) => JSON.stringify([ensureNameScope(), address.toString()]);
  const remember = (row) => {
    const address = toBigInt(row?.address ?? row?.addr ?? row?.startAddress);
    if (address != null) {
      if (row?.name) {
        const key = nameCacheKey(address);
        if (names.has(key)) names.delete(key);
        names.set(key, String(row.name));
        while (names.size > MAX_NAME_CACHE) names.delete(names.keys().next().value);
      } else if (row && Object.hasOwn(row, 'name')) {
        names.delete(nameCacheKey(address));
      }
    }
    return address;
  };
  const nameOf = (address) => {
    const addr = toBigInt(address);
    return addr == null ? null : (names.get(nameCacheKey(addr)) || null);
  };

  define(context, 'analysisAuthority', { value:QUERY_AUTHORITY, writable:false });
  define(context, 'binaryId', {
    get() { return app?.backend?.binaryId ?? legacy.binaryId ?? null; },
  });

  // #8931: use the canonical AnalysisQueryAPI snapshot identity machinery for
  // the outer deterministic cache too. This keeps epoch/project validation and
  // artifactVersions normalization identical to QueryAPI, so malformed nested
  // values cannot alias a prior valid cache key. Binary identity remains an
  // independent ObservationStore binding dimension, hence the fixed local
  // binary id used solely to digest the analysis tuple. A host with no live
  // epoch stays explicit-unknown and retains #5887's per-context nonce.
  define(context, 'analysisRevision', {
    get() { return canonicalAnalysisRevision(app); },
  });

  // Direct analysis indexes are intentionally not part of the production AI
  // context. Query callbacks below are the only first-party analysis authority.
  define(context, 'symbols', { get:() => null });
  define(context, 'program', { get:() => null });
  define(context, 'functions', { get:() => [] });
  define(context, 'strings', { get:() => [] });
  define(context, 'candidateFunctions', {
    get() {
      const address = currentAddressOf(context);
      return address == null ? [] : [address];
    },
  });
  define(context, 'activeFunction', {
    get() {
      const address = currentAddressOf(context);
      return address == null ? null : { address, name:nameOf(address) };
    },
  });
  define(context, 'functionName', { value:(address) => nameOf(address) });

  define(context, 'analyze', {
    value:async (address, _end = null, options = {}) => {
      const { result, model } = await queryFunction(app, address, options);
      remember(result?.value);
      return model;
    },
  });

  define(context, 'searchFunctions', {
    value:async (query, options = {}) => {
      const opts = normalizeOptions(options);
      const offset = safeCount(opts.offset, 0, 1_000_000);
      const limit = Math.max(1, safeCount(opts.limit, 40, 200));
      const result = await withFreshSnapshot(app,
        (api, snapshot) => api.functions(snapshot, { text:String(query ?? '') }, { offset, limit }, { signal:opts.signal ?? null }),
        opts);
      const page = copyWithMetadata(result);
      page.results = page.results.map((row) => {
        const address = remember(row);
        return { ...row, addr:address ?? row?.address ?? null };
      });
      page.matchCount = page.total;
      return page;
    },
  });

  define(context, 'searchStrings', {
    value:async (query, options = {}) => {
      const opts = normalizeOptions(options);
      const offset = safeCount(opts.offset, 0, 1_000_000);
      const limit = Math.max(1, safeCount(opts.limit, 50, 200));
      const targetCount = limit + 1;
      return withFreshSnapshot(app, async (api, snapshot) => {
        const info = await api.binaryInfo(snapshot, { signal:opts.signal ?? null });
        if (queryCompleteness(info) === 'unsupported' || !info?.value) {
          return { results:[], offset, returned:0, total:null, complete:false, truncated:true, reason:queryReason(info) || 'binary-info-unavailable' };
        }
        const results = [];
        let neededOffset = offset;
        let anySupported = false;
        let complete = queryCompleteness(info) === 'complete';
        let exactTotal = 0;
        let exactTotalKnown = complete;
        let reason = complete ? null : (queryReason(info) || 'binary-info-incomplete');
        for (const region of info.value.regions || []) {
          abortIfNeeded(opts.signal);
          if (results.length >= targetCount) break;
          const regionOffset = neededOffset;
          const remaining = targetCount - results.length;
          const result = await api.search(snapshot, {
            regionId:region.id,
            kind:'text',
            query:String(query ?? ''),
            from:0,
          }, { offset:regionOffset, limit:remaining }, { signal:opts.signal ?? null });
          const regionCompleteness = queryCompleteness(result);
          if (regionCompleteness === 'unsupported') {
            if (neededOffset > 0) {
              return { results:[], offset, returned:0, total:null, complete:false, truncated:true, reason:queryReason(result) || 'search-region-total-unproven' };
            }
            exactTotalKnown = false;
            complete = false;
            reason ||= queryReason(result) || 'typed-search-producer-unavailable';
            continue;
          }
          anySupported = true;
          const regionTotal = exactPageTotal(result?.page?.total);
          if (regionCompleteness === 'complete' && regionTotal != null) {
            const nextExactTotal = exactTotal + regionTotal;
            if (Number.isSafeInteger(nextExactTotal)) exactTotal = nextExactTotal;
            else exactTotalKnown = false;
          } else {
            exactTotalKnown = false;
          }
          if (regionCompleteness !== 'complete') {
            complete = false;
            reason ||= queryReason(result) || 'search-incomplete';
          }
          const matches = Array.isArray(result?.value) ? result.value : [];
          if (neededOffset > 0) {
            if (regionCompleteness === 'complete' && regionTotal != null && regionTotal <= neededOffset) {
              neededOffset -= regionTotal;
              continue;
            }
            if (matches.length === 0) {
              // A partial/truncated region's page.total is only the count of
              // materialized rows, so it cannot prove the requested offset lies
              // beyond this region. Skipping into later regions on that basis
              // fabricates the global window position (#5458): stop instead.
              return { results:[], offset, returned:0, total:null, complete:false, truncated:true, reason: queryReason(result) || 'search-region-total-unproven' };
            }
            neededOffset = 0;
          }
          for (const row of matches) {
            const address = toBigInt(row?.addr ?? row?.address);
            results.push({
              ...row,
              addr:undefined,
              address:undefined,
              stringAddress:address,
              regionId:region.id,
            });
            if (results.length >= targetCount) break;
          }
        }
        if (!anySupported) complete = false;
        const rows = results.slice(0, limit);
        const hasNext = results.length > limit;
        const exhausted = !hasNext;
        const pageComplete = anySupported && complete && exhausted;
        return {
          results:rows,
          offset,
          returned:rows.length,
          total:pageComplete && exactTotalKnown ? exactTotal : null,
          complete:pageComplete,
          truncated:!pageComplete,
          reason:pageComplete ? null : (reason || (hasNext ? 'result-limit' : 'typed-search-producer-unavailable')),
        };
      }, opts);
    },
  });

  define(context, 'getInstructions', {
    value:async (address, options = {}) => {
      const opts = normalizeOptions(options);
      const offset = safeCount(opts.offset, 0, 1_000_000);
      const limit = Math.max(1, safeCount(opts.limit, 160, 500));
      const result = await withFreshSnapshot(app,
        (api, snapshot) => api.instructions(snapshot, { functionId:address }, { offset, limit }, { signal:opts.signal ?? null }),
        opts);
      return copyWithMetadata(result);
    },
  });

  define(context, 'decompile', {
    value:async (address, options = {}) => {
      const opts = normalizeOptions(options);
      const result = await withFreshSnapshot(app,
        (api, snapshot) => api.decompile(snapshot, address, { signal:opts.signal ?? null }), opts);
      if (queryCompleteness(result) === 'unsupported' || result?.value == null) return null;
      return typeof result.value === 'string'
        ? result.value
        : (result.value.pseudocode ?? result.value.text ?? result.value.code ?? null);
    },
  });

  define(context, 'pseudocodeFor', { value:() => null });

  define(context, 'getCFG', {
    value:async (address, options = {}) => {
      const opts = normalizeOptions(options);
      const result = await withFreshSnapshot(app,
        (api, snapshot) => api.cfg(snapshot, address, { signal:opts.signal ?? null }), opts);
      if (queryCompleteness(result) === 'unsupported' || !result?.value || typeof result.value !== 'object' || Array.isArray(result.value)) {
        return { blocks:[], complete:false, truncated:true, reason:queryReason(result) || 'cfg-unavailable' };
      }
      return {
        ...result.value,
        complete:queryCompleteness(result) === 'complete',
        truncated:queryCompleteness(result) !== 'complete',
        reason:queryReason(result),
      };
    },
  });

  const graphPage = (method, address, options = {}) => {
    const opts = normalizeOptions(options);
    const offset = safeCount(opts.offset, 0, 1_000_000);
    const limit = Math.max(1, safeCount(opts.limit, 100, 1_000));
    return withFreshSnapshot(app, async (api, snapshot) => {
      const result = await api[method](snapshot, address, { offset, limit }, { signal:opts.signal ?? null });
      const page = copyWithMetadata(result);
      if (queryCompleteness(result) !== 'complete') {
        page.total = null;
        page.completeness = { ...page.completeness, total:null };
      }
      const nextOffset = exactPageTotal(result?.page?.next);
      if (nextOffset != null && nextOffset > offset && nextOffset <= 1_000_000) {
        Object.defineProperty(page, 'nextOffset', { value:nextOffset, enumerable:false });
      }
      return page;
    }, opts);
  };
  define(context, 'getXrefs', { value:(address, options = {}) => graphPage('xrefs', address, options) });
  define(context, 'getCallers', { value:(address, options = {}) => graphPage('callers', address, options) });
  define(context, 'getCallees', { value:(address, options = {}) => graphPage('callees', address, options) });

  define(context, 'findPaths', {
    value:async (from, to, options = {}) => {
      const opts = normalizeOptions(options);
      return withFreshSnapshot(app, async (api, snapshot) => {
        const result = await api.causalPath(snapshot, { functionId:from }, { functionId:to }, { ...opts, signal:opts.signal ?? null });
        if (queryCompleteness(result) === 'unsupported' || !result?.value || typeof result.value !== 'object' || Array.isArray(result.value)) {
          return { paths:[], returned:0, total:null, complete:false, truncated:true, unsupported:true, reason:queryReason(result) || 'causal-path-unavailable' };
        }
        return result.value;
      }, opts);
    },
  });

  return context;
}

export default createHexAIContext;
