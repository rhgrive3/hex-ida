import { scopedAnalysisHost } from '../../analysis/query/scoped-host.js';
/* Final QueryAPI correctness layer for the first-party AI context.
 * The reviewed implementation lives in hex-context-query-base.js. This facade
 * preserves its surface while fixing completeness/cancellation propagation that
 * cannot be represented by its historical helpers.
 */
import {
  analyzeModelAt as analyzeBaseModelAt,
  createHexAIContext as createBaseHexAIContext,
} from './hex-context-query-base.js';

const QUERY_AUTHORITY = 'AnalysisQueryAPI';

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
function completenessOf(result) { return result?.completeness ?? result?.status?.completeness ?? 'partial'; }
function reasonOf(result) { return result?.status?.reason ?? result?.reason ?? null; }
function isStale(error) { return error?.name === 'AnalysisSnapshotStaleError' || error?.code === 'ANALYSIS_SNAPSHOT_STALE'; }
function abortIfNeeded(signal) {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('AbortError');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  throw error;
}
function hasExplicitFalsyAbortReason(signal) {
  return signal?.aborted === true && signal.reason !== undefined && !signal.reason;
}
function rethrowWithExactAbortReason(signal, error) {
  if (hasExplicitFalsyAbortReason(signal)) throw signal.reason;
  throw error;
}
function bounded(value, fallback, max) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? Math.min(max, value) : fallback;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^[0-9]+$/.test(trimmed)) return fallback;
    const number = Number(trimmed);
    return Number.isSafeInteger(number) && number >= 0 ? Math.min(max, number) : fallback;
  }
  return fallback;
}
async function withFreshSnapshot(app, operation, options = {}) {
  const opts = normalizeOptions(options);
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    abortIfNeeded(opts.signal);
    let snapshot;
    try {
      snapshot = await app.analysisQueries.snapshot({
        signal:opts.signal ?? null,
        onProgress:opts.onProgress,
        onIdentityProgress:opts.onIdentityProgress,
      });
    } catch (error) {
      rethrowWithExactAbortReason(opts.signal, error);
    }
    try {
      const value = await operation(app.analysisQueries, snapshot);
      abortIfNeeded(opts.signal);
      return value;
    } catch (error) {
      last = error;
      if (!isStale(error) || attempt > 0) rethrowWithExactAbortReason(opts.signal, error);
    }
  }
  throw last ?? new Error('analysis-query-retry-exhausted');
}
function define(context, name, value) {
  Object.defineProperty(context, name, { value, enumerable:true, configurable:true, writable:false });
}

export async function analyzeModelAt(app, address, end = null, options = {}) {
  const opts = normalizeOptions(options);
  try {
    return await analyzeBaseModelAt(app, address, end, opts);
  } catch (error) {
    rethrowWithExactAbortReason(opts.signal, error);
  }
}

export function createHexAIContext(app) {
  const context = createBaseHexAIContext(app);
  if (context?.analysisAuthority !== QUERY_AUTHORITY || !app?.analysisQueries) return context;

  const scopedMethods = new Set(['taskIdiomView', 'inspectConditionalModel', 'checkLoopInvariant', 'asyncEventOrder', 'portableIntegerChecks', 'blockCaptures', 'investigationFrontier', 'typeEvidence', 'interproceduralQuery', 'abiInputBindings', 'abiPlacementEvidence', 'explainTransformChain', 'runtimeObservations', 'scopedCapabilities', 'semanticQuery', 'resumeSemanticQuery', 'dispatchTargets',
    'applePointerView', 'knowledgeMatches', 'objectMemory', 'rangeValueCatalog', 'callGraphSlice', 'resumeCallGraphSlice', 'referenceSlice', 'replayReferenceSlice', 'refineValueFacts', 'summarySlice', 'resumeSummarySlice', 'proofSlice', 'replayProof', 'cancelScopedQuery', 'demandInvestigationFrontier', 'investigateDemand', 'demandQuery', 'resumeDemandQuery', 'explainDemandResult', 'replayDemandResult']);
  define(context, 'runScopedAnalysis', async (method, request, options = {}) => {
    const opts = normalizeOptions(options);
    if (!scopedMethods.has(method)) throw new TypeError('scoped-ai-method-not-allowed');
    const isCancel = method === 'cancelScopedQuery';
    if (!isCancel) abortIfNeeded(opts.signal);
    if (!scopedAnalysisHost(app)?.configuration?.enabled) return {
      value: { status:'unsupported', reason:'scoped-analysis-disabled', exact:false },
      completeness:'unsupported', analysisAuthority:QUERY_AUTHORITY,
    };
    const api = app.analysisQueries;
    if (typeof api?.scopedSnapshot !== 'function' || typeof api[method] !== 'function') throw new TypeError('scoped-ai-query-api-unavailable');
    let result;
    try {
      const snapshot = await api.scopedSnapshot({ signal:opts.signal ?? null });
      // Do not auto-retry consumed cursors. Staleness is an explicit restart
      // obligation; retrying could duplicate results or reset a query budget.
      const limits = opts.limits && typeof opts.limits === 'object' && !Array.isArray(opts.limits) ? opts.limits : {};
      result = await api[method](snapshot, request, { signal:opts.signal ?? null, limits });
    } catch (error) {
      rethrowWithExactAbortReason(opts.signal, error);
    }
    if (!isCancel) abortIfNeeded(opts.signal);
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return { value:null, completeness:'unsupported', analysisAuthority:QUERY_AUTHORITY };
    }
    return { ...result, analysisAuthority:QUERY_AUTHORITY };
  });

  // The reviewed base predates the repository-wide exact AbortSignal.reason
  // invariant. Restore explicit falsy reasons at every inherited async Query
  // capability without changing the base compatibility implementation.
  const wrapAbortReason = (name, optionsIndex) => {
    const base = context[name];
    if (typeof base !== 'function') return;
    define(context, name, async (...args) => {
      const options = normalizeOptions(args[optionsIndex]);
      try {
        return await base(...args);
      } catch (error) {
        rethrowWithExactAbortReason(options.signal, error);
      }
    });
  };
  wrapAbortReason('analyze', 2);
  wrapAbortReason('searchFunctions', 1);
  wrapAbortReason('getInstructions', 1);
  wrapAbortReason('getCFG', 1);
  wrapAbortReason('getXrefs', 1);
  wrapAbortReason('getCallers', 1);
  wrapAbortReason('getCallees', 1);

  define(context, 'searchStrings', async (query, options = {}) => {
    const opts = normalizeOptions(options);
    const offset = bounded(opts.offset, 0, 1_000_000);
    const limit = Math.max(1, bounded(opts.limit, 50, 200));
    const targetCount = limit + 1;
    return withFreshSnapshot(app, async (api, snapshot) => {
      const info = await api.binaryInfo(snapshot, { signal:opts.signal ?? null });
      if (completenessOf(info) === 'unsupported' || !info?.value) {
        return { results:[], offset, returned:0, total:null, complete:false, truncated:true, reason:reasonOf(info) || 'binary-info-unavailable' };
      }
      const results = [];
      let neededOffset = offset;
      let anySupported = false;
      let complete = completenessOf(info) === 'complete';
      let exactTotal = 0;
      let exactTotalKnown = complete;
      let reason = complete ? null : (reasonOf(info) || 'binary-info-incomplete');
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
        const regionCompleteness = completenessOf(result);
        if (regionCompleteness === 'unsupported') {
          if (neededOffset > 0) {
            return { results:[], offset, returned:0, total:null, complete:false, truncated:true, reason:reasonOf(result) || 'search-region-total-unproven' };
          }
          exactTotalKnown = false;
          complete = false;
          reason ||= reasonOf(result) || 'typed-search-producer-unavailable';
          continue;
        }
        anySupported = true;
        const rawRegionTotal = result?.page?.total;
        const exactRegionTotal = typeof rawRegionTotal === 'number'
          && Number.isSafeInteger(rawRegionTotal)
          && rawRegionTotal >= 0
          ? rawRegionTotal
          : null;
        const regionTotal = exactRegionTotal;
        if (regionCompleteness === 'complete' && exactRegionTotal != null) {
          const nextExactTotal = exactTotal + exactRegionTotal;
          if (Number.isSafeInteger(nextExactTotal)) exactTotal = nextExactTotal;
          else exactTotalKnown = false;
        } else {
          exactTotalKnown = false;
        }
        if (regionCompleteness !== 'complete') {
          complete = false;
          reason ||= reasonOf(result) || 'search-incomplete';
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
            return { results:[], offset, returned:0, total:null, complete:false, truncated:true, reason: reasonOf(result) || 'search-region-total-unproven' };
          }
          neededOffset = 0;
        }
        for (const row of matches) {
          const address = toBigInt(row?.addr ?? row?.address);
          results.push({ ...row, addr:undefined, address:undefined, stringAddress:address, regionId:region.id });
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
  });

  const getDecompile = async (address, options = {}) => {
    const opts = normalizeOptions(options);
    return withFreshSnapshot(app, async (api, snapshot) => {
      const result = await api.decompile(snapshot, address, { signal:opts.signal ?? null });
      const completeness = completenessOf(result);
      if (completeness === 'unsupported' || result?.value == null) {
        return { text:null, complete:false, truncated:true, unsupported:true, reason:reasonOf(result) || 'decompiler-projection-unavailable' };
      }
      const text = typeof result.value === 'string'
        ? result.value
        : (result.value.pseudocode ?? result.value.text ?? result.value.code ?? null);
      return {
        value:result.value,
        text:typeof text === 'string' ? text : null,
        complete:completeness === 'complete',
        truncated:completeness !== 'complete',
        reason:reasonOf(result),
        analysisAuthority:QUERY_AUTHORITY,
      };
    }, opts);
  };
  define(context, 'getDecompile', getDecompile);
  define(context, 'decompile', async (address, options = {}) => (await getDecompile(address, options)).text);

  define(context, 'findPaths', async (from, to, options = {}) => {
    const opts = normalizeOptions(options);
    return withFreshSnapshot(app, async (api, snapshot) => {
      const result = await api.causalPath(snapshot, { functionId:from }, { functionId:to }, { ...opts, signal:opts.signal ?? null });
      const completeness = completenessOf(result);
      if (completeness === 'unsupported' || !result?.value || typeof result.value !== 'object' || Array.isArray(result.value)) {
        return { paths:[], returned:0, total:null, complete:false, truncated:true, unsupported:true, reason:reasonOf(result) || 'causal-path-unavailable', analysisAuthority:QUERY_AUTHORITY };
      }
      return {
        ...result.value,
        complete:completeness === 'complete',
        truncated:completeness !== 'complete',
        reason:reasonOf(result) ?? result.value?.reason ?? null,
        analysisAuthority:QUERY_AUTHORITY,
      };
    }, opts);
  });

  return context;
}

export default createHexAIContext;
