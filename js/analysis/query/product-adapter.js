import { createAppAnalysisQueryAdapter as createBaseAdapter } from './app-adapter.js';

const SAFE_ROUTE = Symbol('analysis-query-safe-ui-route');
const SAFE_FUNCTION_DISCOVERY = Symbol('analysis-query-function-discovery-single-flight');

function abortIfNeeded(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('AbortError');
  error.name = 'AbortError';
  throw error;
}

function waitForProducer(promise, signal) {
  abortIfNeeded(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => {
      try {
        abortIfNeeded(signal);
      } catch (error) {
        finish(reject, error);
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function storeValue(app, key) {
  try {
    if (typeof app?.store?.get === 'function') return app.store.get(key);
  } catch { /* compatibility-shaped state below */ }
  return app?.store?.[key] ?? null;
}

function nonNegativeSafeInteger(value, fallback, code) {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(code);
  return value;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function artifactVersionsFor(app) {
  const direct = app?.analysisArtifactVersions ?? app?.artifactVersions ?? null;
  if (direct && isPlainObject(direct)) return { ...direct };
  const backend = app?.backend;
  let route = backend?.analysisRoute ?? 'unknown';
  try { route = backend?.analysisRouteInfo?.()?.route ?? route; } catch { /* stable conservative identity */ }
  const capability = storeValue(app, 'capability') || {};
  return {
    queryContract: 'analysis-query-public-product/v2',
    analysisRoute: String(route ?? 'unknown'),
    architecture: String(storeValue(app, 'architecture') ?? capability.architecture ?? 'unknown'),
    capabilityContract: String(capability.semanticVersion ?? capability.analysisVersion ?? capability.version ?? 'unspecified'),
    instructionAlignment: String(storeValue(app, 'instructionAlignment') ?? capability.instructionAlignment ?? 'unknown'),
    symbolsGeneration: String(app?.symbols?.gen ?? 0),
    sliceIndex: String(storeValue(app, 'sliceIndex') ?? -1),
  };
}

async function canonicalIdentity(app, options = {}) {
  abortIfNeeded(options.signal);
  const backend = app?.backend ?? null;
  const fileInfo = storeValue(app, 'fileInfo');
  const project = storeValue(app, 'project') ?? app?.workspace?.project ?? app?.activeProject ?? app?.project ?? null;
  let binaryId = backend?.binaryId ?? null;

  // A live Backend can derive a content-addressed identity, so parser/project
  // metadata must never short-circuit it. Metadata is only a compatibility
  // fallback for adapter-shaped consumers without Backend identity support.
  if (!binaryId && typeof backend?.ensureBinaryId === 'function') {
    binaryId = await backend.ensureBinaryId({
      signal: options.signal ?? null,
      onProgress: options.onIdentityProgress ?? options.onProgress,
    });
  }
  if (!binaryId) {
    binaryId = fileInfo?.binaryId
      ?? fileInfo?.sha256
      ?? fileInfo?.hash
      ?? project?.binaryHash
      ?? project?.binary?.hash
      ?? null;
  }
  if (!binaryId && typeof app?.ensureAnalysisIdentity === 'function') {
    binaryId = await app.ensureAnalysisIdentity(options);
  }
  abortIfNeeded(options.signal);
  if (!binaryId) {
    const error = new Error('analysis-query-binary-unbound');
    error.code = 'ANALYSIS_QUERY_BINARY_UNBOUND';
    throw error;
  }
  if (typeof binaryId !== 'string' || !binaryId.trim()) {
    const error = new TypeError('analysis-query-binary-id-invalid');
    error.code = 'ANALYSIS_QUERY_BINARY_ID_INVALID';
    throw error;
  }

  return {
    binaryId,
    projectRevision: nonNegativeSafeInteger(
      project?.revision ?? app?.projectRevision ?? app?.workspace?.bindingRevision,
      0,
      'analysis-query-project-revision-invalid',
    ),
    artifactVersions: artifactVersionsFor(app),
    analysisEpoch: nonNegativeSafeInteger(
      backend?.gen ?? app?.analysisEpoch,
      0,
      'analysis-query-epoch-invalid',
    ),
  };
}

function discoveryOptions(value) {
  if (typeof value === 'function') return { onProgress: value, signal: null };
  if (value && typeof value === 'object') return value;
  return {};
}

function discoveryKey(app, region) {
  const epoch = Number(app?.backend?.gen ?? app?.analysisEpoch ?? 0);
  let regions = [];
  try { regions = typeof app?.programRegions === 'function' ? app.programRegions() || [] : []; } catch { regions = []; }
  const ids = regions.filter((item) => item?.exec !== false).map((item) => String(item?.id ?? ''));
  if (region?.exec !== false && region?.id != null && !ids.includes(String(region.id))) ids.push(String(region.id));
  return `${epoch}:${ids.join('|')}`;
}

function settleFunctionDiscoveryRoute(app) {
  const routed = app?.ensureFunctions;
  if (typeof routed !== 'function' || routed[SAFE_FUNCTION_DISCOVERY]) return;
  const producers = new Map();
  const safe = function singleFlightEnsureFunctions(region, rawOptions = {}) {
    const options = discoveryOptions(rawOptions);
    abortIfNeeded(options.signal);
    const key = discoveryKey(app, region);
    let producer = producers.get(key);
    if (!producer) {
      producer = Promise.resolve().then(() => routed.call(app, region, options.onProgress));
      producers.set(key, producer);
      producer.finally(() => {
        if (producers.get(key) === producer) producers.delete(key);
      }).catch(() => {});
    }
    // Consumer cancellation only detaches this waiter. The shared discovery
    // producer remains alive for compatible searches/program-index consumers.
    return waitForProducer(producer, options.signal);
  };
  Object.defineProperty(safe, SAFE_FUNCTION_DISCOVERY, { value: true });
  app.ensureFunctions = safe;
}

async function ensureFunctionDiscovery(app, options = {}) {
  abortIfNeeded(options.signal);
  if (typeof app?.ensureFunctions !== 'function') return;
  const symbols = app?.symbols ?? null;
  if (symbols?.functionStartsComplete === true || symbols?.functionDiscovery?.complete === true) return;
  let region = null;
  try { region = typeof app?.codeRegion === 'function' ? app.codeRegion() : null; } catch { /* use current region */ }
  region ??= storeValue(app, 'currentRegion');
  await app.ensureFunctions(region ?? null, { signal: options.signal, onProgress: options.onProgress });
  abortIfNeeded(options.signal);
}

function settleUiRoute(app) {
  const routed = app?.analyzeFunctionAt;
  if (typeof routed !== 'function' || routed[SAFE_ROUTE]) return;
  const safe = async function routedAnalyzeFunctionAt(id, options = {}) {
    try {
      return await routed.call(app, id, options);
    } catch {
      // The historical App entry point is intentionally fire-and-forget from
      // navigation. Preserve its null-on-analysis-failure contract so a hash,
      // stale-snapshot, ABI, or producer failure cannot become an unhandled UI
      // rejection. Direct AnalysisQueryAPI calls remain fail-closed.
      return null;
    }
  };
  Object.defineProperty(safe, SAFE_ROUTE, { value: true });
  app.analyzeFunctionAt = safe;
}

export function createAppAnalysisQueryAdapter(app) {
  settleFunctionDiscoveryRoute(app);
  const base = createBaseAdapter(app);
  settleUiRoute(app);
  return {
    ...base,
    currentIdentity: (options = {}) => canonicalIdentity(app, options),
    async functions(snapshot, query = {}, page = {}, options = {}) {
      await ensureFunctionDiscovery(app, options);
      return base.functions(snapshot, query, page, options);
    },
  };
}
