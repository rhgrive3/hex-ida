import { AnalysisQueryAPI } from './query/api.js';
import { createAppAnalysisQueryAdapter as createBaseQueryAdapter } from './query/app-adapter.js';
import { createBinaryIdFromDigest } from '../core/identity/index.js';
import { ProgramIndex, mergeProgramScans, PROGRAM_MERGE_LIMITS } from '../program.js';
import { foldShapes } from '../shapes.js';

const RUNTIME_VERSION = 'demand-driven-analysis/v1';
const MAX_PAGE = 5000;
const MAX_LOCAL_SCAN_CACHE = 32;
const OBJECT_IDS = new WeakMap();
let nextObjectId = 1;

function objectId(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return String(value ?? 'null');
  let id = OBJECT_IDS.get(value);
  if (!id) { id = nextObjectId++; OBJECT_IDS.set(value, id); }
  return String(id);
}
function storeValue(app, key) {
  try { return typeof app?.store?.get === 'function' ? app.store.get(key) : app?.store?.[key]; }
  catch { return null; }
}
function abortError(signal, message = 'Analysis query aborted') {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(message); error.name = 'AbortError'; return error;
}
function abortIfNeeded(signal) { if (signal?.aborted) throw abortError(signal); }
function addressOf(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string') {
    const text = value.trim().replace(/^(?:fn|function):/i, '');
    if (!text) return null;
    try { return BigInt(text); } catch { return null; }
  }
  if (value && typeof value === 'object') return addressOf(value.address ?? value.startAddress ?? value.startAddr ?? value.start ?? value.functionId ?? value.id);
  return null;
}
function pageOf(page = {}) {
  const rawOffset = Number(page.offset ?? page.start ?? 0);
  const rawLimit = Number(page.limit ?? page.size ?? 200);
  return {
    offset: Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0,
    limit: Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(MAX_PAGE, rawLimit) : 200,
  };
}
function paged(values, page, completeness = 'complete', status = {}) {
  const source = Array.from(values || []);
  const { offset, limit } = pageOf(page);
  const items = source.slice(offset, offset + limit);
  return {
    value: items,
    page: { offset, limit, returned: items.length, total: completeness === 'complete' ? source.length : null, next: offset + items.length < source.length ? offset + items.length : null },
    status: { ...status, completeness, paged: true },
  };
}
function unsupported(reason) { return { value: null, status: { completeness: 'unsupported', reason } }; }
function executableRegions(app) {
  try {
    const regions = typeof app?.programRegions === 'function' ? app.programRegions() : (storeValue(app, 'regions') || []).filter((r) => r?.exec === true && BigInt(r.size ?? 0) > 0n);
    return Array.from(regions || []).filter((r) => r?.exec === true && BigInt(r.size ?? 0) > 0n);
  } catch { return []; }
}
function regionForAddress(app, address) {
  if (address == null) return null;
  if (typeof app?.executableRegionFor === 'function') {
    try { return app.executableRegionFor(address); } catch { /* derive below */ }
  }
  const value = BigInt(address);
  return executableRegions(app).find((r) => value >= BigInt(r.vmAddr) && value < BigInt(r.vmAddr) + BigInt(r.size)) ?? null;
}
function dedupeRegions(regions) {
  const seen = new Set();
  return regions.filter((r) => { if (!r?.id || seen.has(r.id)) return false; seen.add(r.id); return true; });
}
function regionScanLimits(count) {
  const divisor = Math.max(1, Number(count) || 1);
  const share = (value) => Math.max(1, Math.floor(Number(value || 0) / divisor));
  return { callLimit: share(PROGRAM_MERGE_LIMITS.calls), refLimit: share(PROGRAM_MERGE_LIMITS.refs), kindLimit: share(PROGRAM_MERGE_LIMITS.kindWords) };
}
function localRegionPlan(app, address, kind) {
  const allRegions = executableRegions(app);
  const target = regionForAddress(app, address);
  const current = storeValue(app, 'currentRegion');
  const currentExec = current?.exec === true && BigInt(current?.size ?? 0) > 0n ? current : null;
  const local = kind === 'callees' ? dedupeRegions([target].filter(Boolean)) : dedupeRegions([target, currentExec].filter(Boolean));
  const unscanned = allRegions.filter((region) => !local.some((item) => item.id === region.id));
  return { allRegions, target, local, unscanned };
}
function pruneCache(cache) { while (cache.size > MAX_LOCAL_SCAN_CACHE) cache.delete(cache.keys().next().value); }
function waitForShared(entry, signal) {
  abortIfNeeded(signal); entry.waiters++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return; settled = true; signal?.removeEventListener('abort', onAbort); entry.waiters = Math.max(0, entry.waiters - 1); fn(value);
    };
    const onAbort = () => {
      if (settled) return; settled = true; signal?.removeEventListener('abort', onAbort); entry.waiters = Math.max(0, entry.waiters - 1);
      if (!entry.settled && entry.waiters === 0) entry.request?.cancel?.();
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    entry.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}
function mergeMapCounts(target, source) { for (const [key, value] of source || []) target.set(key, (target.get(key) || 0) + Number(value || 0)); }
function cloneShapeEntry(entry) {
  return { ...entry, amountFrom: new Map(entry.amountFrom || []), usedAgainst: new Map(entry.usedAgainst || []), sites: Array.from(entry.sites || []).slice(0, 8) };
}
function mergeShapeMaps(maps, reasons = []) {
  const out = new Map(); let capped = false; let allUnsupported = maps.length > 0; let complete = maps.length > 0;
  for (const folded of maps) {
    capped ||= folded?.capped === true; allUnsupported &&= folded?.unsupported === true; complete &&= folded?.complete === true;
    if (folded?.complete === false && folded?.incompleteReason) reasons.push(String(folded.incompleteReason));
    for (const [key, entry] of folded || []) {
      let target = out.get(key);
      if (!target) { out.set(key, cloneShapeEntry(entry)); continue; }
      for (const field of ['decreases','increases','clamped','crossObject','scaled','amountFromCall','amountFromImm','usedAsAmount','usedScaled','usedCross','events','inBigObject']) target[field] = Number(target[field] || 0) + Number(entry[field] || 0);
      target.size ||= entry.size; target.objectSpan = Math.max(Number(target.objectSpan || 0), Number(entry.objectSpan || 0));
      mergeMapCounts(target.amountFrom, entry.amountFrom); mergeMapCounts(target.usedAgainst, entry.usedAgainst);
      for (const site of entry.sites || []) if (target.sites.length < 8) target.sites.push(site);
    }
  }
  const uniqueReasons = [...new Set(reasons.filter(Boolean))];
  Object.defineProperties(out, {
    complete: { value: complete && uniqueReasons.length === 0, enumerable:false, configurable:true },
    capped: { value:capped, enumerable:false, configurable:true },
    unsupported: { value:allUnsupported, enumerable:false, configurable:true },
    incompleteReason: { value: uniqueReasons.length ? uniqueReasons.join(';') : (allUnsupported ? 'unsupported-architecture' : capped ? 'capped' : null), enumerable:false, configurable:true },
  });
  return out;
}
function recognitionInputKey(app) {
  return [Number(app?.backend?.gen ?? app?.analysisEpoch ?? 0), Number(app?.symbols?.gen ?? 0), objectId(app?.fields), objectId(app?.objcModel), objectId(app?.objcRuntime), objectId(app?.swiftModel), objectId(app?.swiftRuntime)].join(':');
}


function scheduleBackgroundIdentity(signal) {
  abortIfNeeded(signal);
  if (globalThis.scheduler?.postTask) {
    return globalThis.scheduler.postTask(() => undefined, { priority:'background', signal:signal ?? undefined });
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, abortError(signal, 'Binary identity scheduling aborted'));
    signal?.addEventListener('abort', onAbort, { once:true });
    if (signal?.aborted) { onAbort(); return; }
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => finish(resolve), { timeout:250 });
    } else {
      setTimeout(() => finish(resolve), 0);
    }
  });
}

function installWorkerBackedIdentity(app) {
  const backend = app?.backend;
  if (!backend || typeof backend.ensureContentHash !== 'function') return;
  backend.ensureBinaryId = function ensureBinaryIdFromPlatformWorker(options = {}) {
    if (this.binaryId) return Promise.resolve(this.binaryId);
    if (!this.file) return Promise.reject(new Error('binary-id-file-unavailable'));
    if (!this._binaryIdPromise) {
      const file = this.file; const epoch = this.gen;
      this._binaryIdPromise = scheduleBackgroundIdentity(options.signal).then(() => this.ensureContentHash(options.onProgress, options.signal ?? null)).then((hash) => {
        abortIfNeeded(options.signal);
        if (this.file !== file || this.gen !== epoch) { const error = new Error('stale binary identity'); error.stale = true; throw error; }
        const binaryId = createBinaryIdFromDigest(hash); this.binaryId = binaryId; return binaryId;
      }).catch((error) => { this._binaryIdPromise = null; throw error; });
    }
    return this._binaryIdPromise;
  };
}
function installDemandRecognition(app) {
  if (typeof app?.ensureRecognition !== 'function') return () => recognitionInputKey(app);
  const originalRecognition = app.ensureRecognition.bind(app);
  const originalApplySlice = typeof app.applySlice === 'function' ? app.applySlice.bind(app) : null;
  const originalObjc = typeof app.ensureObjc === 'function' ? app.ensureObjc.bind(app) : null;
  const originalSwift = typeof app.ensureSwift === 'function' ? app.ensureSwift.bind(app) : null;
  const bootstrapEpochs = new Set(); let acceptedKey = null;
  const invalidate = (before) => { const after = recognitionInputKey(app); if (before !== after && app.recognition) app.recognition = null; if (before !== after) acceptedKey = null; };
  if (originalObjc) app.ensureObjc = async function (...args) { const before = recognitionInputKey(app); try { return await originalObjc(...args); } finally { invalidate(before); } };
  if (originalSwift) app.ensureSwift = async function (...args) { const before = recognitionInputKey(app); try { return await originalSwift(...args); } finally { invalidate(before); } };
  app.ensureRecognition = async function demandRecognition(options = {}) {
  const epoch = Number(app?.backend?.gen ?? app?.analysisEpoch ?? 0);
  if (bootstrapEpochs.has(epoch) && options.force !== true) return app.recognition ?? null;
  for (let attempt = 0; attempt < 2; attempt++) {
    abortIfNeeded(options.signal);
    const metadata = [];
    const sliceIndex = Number(storeValue(app, 'sliceIndex') ?? -1);
    if (originalObjc && sliceIndex >= 0) metadata.push(app.ensureObjc(sliceIndex));
    if (originalSwift) metadata.push(app.ensureSwift());
    if (metadata.length) await Promise.allSettled(metadata);
    abortIfNeeded(options.signal);
    const key = recognitionInputKey(app);
    if (app.recognition && acceptedKey === key) return app.recognition;
    if (app.recognition) app.recognition = null;
    acceptedKey = null;
    const value = await originalRecognition(options);
    abortIfNeeded(options.signal);
    const after = recognitionInputKey(app);
    if (value && after === key) {
      acceptedKey = key;
      return value;
    }
    app.recognition = null;
  }
  const error = new Error('recognition inputs changed while producing the result');
  error.code = 'RECOGNITION_INPUTS_CHANGED';
  throw error;
};
if (originalApplySlice) app.applySlice = function demandApplySlice(...args) {
    const epoch = Number(app?.backend?.gen ?? app?.analysisEpoch ?? 0); bootstrapEpochs.add(epoch);
    const result = originalApplySlice(...args); Promise.resolve(app.symbolsReady).finally(() => bootstrapEpochs.delete(epoch)); return result;
  };
  return () => `${RUNTIME_VERSION}:${acceptedKey ?? recognitionInputKey(app)}`;
}
function installMultiRegionShapes(app) {
  if (!app?.backend || typeof app.backend.valueShapes !== 'function') return;
  const regionCache = new Map(); let combinedKey = null;
  app.ensureShapes = async function demandShapes(progressOrOptions = {}) {
    const onProgress = typeof progressOrOptions === 'function' ? progressOrOptions : progressOrOptions?.onProgress;
    const signal = typeof progressOrOptions === 'object' ? progressOrOptions?.signal ?? null : null;
    abortIfNeeded(signal);
    const epoch = Number(app.backend.gen ?? app.analysisEpoch ?? 0); const regions = executableRegions(app);
    if (!regions.length) return null;
    const key = `${epoch}:${regions.map((r) => r.id).join('|')}`;
    if (app.shapes && combinedKey === key) return app.shapes;
    if (app.shapesBusy && app.shapesBusyEpoch === epoch) return app.shapesBusy;
    app.shapesBusyEpoch = epoch;
    app.shapesBusy = (async () => {
      const folded = []; const reasons = [];
      for (let index = 0; index < regions.length; index++) {
        abortIfNeeded(signal); const region = regions[index]; const cacheKey = `${epoch}:${region.id}`; let value = regionCache.get(cacheKey);
        if (!value) {
          const request = app.backend.valueShapes(region.id, (progress) => onProgress?.({ phase:'shapes', region:region.id, done:index + (progress?.all ? Math.min(1, progress.done / progress.all) : 0), all:regions.length }));
          try {
            value = await new Promise((resolve, reject) => {
              const onAbort = () => { signal?.removeEventListener('abort', onAbort); request.cancel?.(); reject(abortError(signal)); };
              signal?.addEventListener('abort', onAbort, { once:true });
              if (signal?.aborted) { onAbort(); return; }
              Promise.resolve(request).then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort));
            });
            if (value && !value.cancelled) regionCache.set(cacheKey, value);
          } catch (error) { if (signal?.aborted || error?.name === 'AbortError') throw error; reasons.push(`${region.id}:shape-scan-failed`); continue; }
        }
        if (!value || value.cancelled) { reasons.push(`${region.id}:shape-scan-cancelled`); continue; }
        folded.push(foldShapes(value));
      }
      if (epoch !== app.backend.gen) return null;
      const merged = mergeShapeMaps(folded, reasons); app.shapes = merged; combinedKey = key; pruneCache(regionCache); return merged;
    })().finally(() => { if (app.shapesBusyEpoch === epoch) { app.shapesBusy = null; app.shapesBusyEpoch = -1; } });
    return app.shapesBusy;
  };
}

function installCancellableFunctionDiscovery(app) {
  if (!app?.backend || typeof app.backend.guessFunctions !== 'function') return;
  const producers = new Map();
  app.ensureFunctions = function demandFunctionDiscovery(region, rawOptions = {}) {
    const options = typeof rawOptions === 'function' ? { onProgress:rawOptions, signal:null } : (rawOptions || {});
    abortIfNeeded(options.signal);
    const run = async () => {
      if (app.symbolsReady) {
        try { await app.symbolsReady; } catch { /* symbol seeds are optional */ }
      }
      abortIfNeeded(options.signal);
      const symbols = app.symbols;
      if (!symbols || symbols.functionStartsComplete === true || symbols.functionDiscovery?.complete === true) return symbols;
      const targets = executableRegions(app);
      if (region?.exec === true && !targets.some((item) => item.id === region.id)) targets.push(region);
      const unique = dedupeRegions(targets);
      if (!unique.length) return symbols;
      const epoch = Number(app?.backend?.gen ?? app?.analysisEpoch ?? 0);
      const key = `${epoch}:${unique.map((item) => item.id).join('|')}`;
      if (symbols.functionDiscovery?.attempted === true && symbols.functionDiscovery?.regionSetKey === unique.map((item) => item.id).join('|')) return symbols;
      let entry = producers.get(key);
      if (!entry) {
        const producerController = new AbortController();
        entry = {
          request:{ cancel:() => producerController.abort('function-discovery-no-consumers') },
          promise:null, settled:false, waiters:0,
        };
        entry.promise = (async () => {
          let remaining = Math.max(0, 400_000 - Math.min(400_000, symbols.functionCount || 0));
          let remainingBytes = unique.reduce((sum, item) => sum + BigInt(item.size), 0n);
          const results = [], reasons = [];
          for (let index = 0; index < unique.length; index++) {
            abortIfNeeded(producerController.signal);
            if (epoch !== Number(app?.backend?.gen ?? app?.analysisEpoch ?? 0)) throw Object.assign(new Error('stale function discovery'), { stale:true });
            const item = unique[index], size = BigInt(item.size);
            const share = remaining > 0 && remainingBytes > 0n
              ? Math.max(1, Math.min(remaining, Number((BigInt(remaining) * size + remainingBytes - 1n) / remainingBytes)))
              : 0;
            if (share <= 0) {
              results.push({ regionId:item.id, complete:false, skipped:true });
              reasons.push(`function-global-budget:${item.id}`);
              remainingBytes -= size;
              continue;
            }
            const request = app.backend.guessFunctions(item.id, share, (progress) => options.onProgress?.({
              phase:'functions', region:item.id,
              done:index + (progress?.all ? Math.min(1, progress.done / progress.all) : 0), all:unique.length,
            }));
            const onAbort = () => request.cancel?.();
            producerController.signal.addEventListener('abort', onAbort, { once:true });
            try {
              const result = await request;
              if (result?.starts?.length) {
                symbols.addFunctions(result.starts, { source:'heuristic', confidence:0.55, confirmed:false });
                symbols.guessed = true;
                remaining = Math.max(0, remaining - result.starts.length);
              }
              const complete = result?.discoveryComplete === true || result?.completeness?.complete === true || result?.complete === true;
              results.push({ regionId:item.id, complete, capped:!!result?.capped, discovered:result?.starts?.length || 0 });
              if (!complete) reasons.push(`${item.id}:${result?.completeness?.reason || result?.truncationReason || 'function-discovery-incomplete'}`);
            } finally {
              producerController.signal.removeEventListener('abort', onAbort);
            }
            remainingBytes -= size;
          }
          abortIfNeeded(producerController.signal);
          if (epoch !== Number(app?.backend?.gen ?? app?.analysisEpoch ?? 0)) throw Object.assign(new Error('stale function discovery'), { stale:true });
          const complete = results.length === unique.length && results.every((item) => item.complete === true);
          const regionSetKey = unique.map((item) => item.id).join('|');
          symbols.functionDiscovery = {
            complete, attempted:true, regionSetKey, regions:results,
            reasons:[...new Set(reasons)], capped:results.some((item) => item.capped),
          };
          symbols.functionStartsComplete = complete;
          symbols.functionStartsCapped = symbols.functionDiscovery.capped || reasons.some((reason) => reason.includes('budget'));
          app.viewer?.setSymbols?.(symbols);
          return symbols;
        })().then((value) => { entry.settled = true; return value; }).catch((error) => {
          producers.delete(key);
          throw error;
        });
        producers.set(key, entry);
      }
      return waitForShared(entry, options.signal ?? null);
    };
    return run();
  };
}

function installDemandQueryAPI(app, recognitionVersion) {
  const base = createBaseQueryAdapter(app); const regionScans = new Map();
  const scanRegion = async (region, options = {}, localCount = 1) => {
    const epoch = Number(app?.backend?.gen ?? app?.analysisEpoch ?? 0);
    const limits = regionScanLimits(localCount);
    const profile = `${limits.callLimit}:${limits.refLimit}:${limits.kindLimit}`;
    const key = `${epoch}:${region.id}:${profile}`;
    let entry = regionScans.get(key);
    if (!entry) {
      const request = app.backend.scanProgram(region.id, options.onProgress, { ...limits, analysisPriority:options.priority || 'interactive' }); entry = { request, promise:null, settled:false, waiters:0 };
      entry.promise = Promise.resolve(request).then((scan) => { if (!scan || scan.cancelled) throw Object.assign(new Error('program scan cancelled'), { name:'AbortError' }); entry.settled = true; return scan; }).catch((error) => { regionScans.delete(key); throw error; });
      regionScans.set(key, entry); pruneCache(regionScans);
    }
    return waitForShared(entry, options.signal ?? null);
  };
  const localProgram = async (id, kind, options = {}) => {
    abortIfNeeded(options.signal); const address = addressOf(id); if (address == null) return { program:null, reason:'function-address-invalid', scannedRegionIds:[], unscannedRegionIds:[] };
    const { allRegions, target, local, unscanned } = localRegionPlan(app, address, kind);
    if (!local.length) return { program:null, reason:'program-region-unavailable', scannedRegionIds:[], unscannedRegionIds:allRegions.map((r) => r.id) };
    const scans = []; for (const region of local) scans.push(await scanRegion(region, options, local.length)); abortIfNeeded(options.signal);
    // Outgoing callees are function-local once the function extent is proven; incoming
    // callers/xrefs still require the remaining executable regions for global absence.
    const reasons = kind === 'callees' ? [] : unscanned.map((region) => `program-region-unscanned:${region.id}`);
    const coverageRegions = kind === 'callees' ? local : allRegions;
    const merged = mergeProgramScans(scans, { regions:coverageRegions, reasons, limits:PROGRAM_MERGE_LIMITS });
    return {
      program:new ProgramIndex(merged, app.symbols, target ?? local[0]),
      reason:reasons[0] ?? null,
      scannedRegionIds:local.map((r) => r.id),
      unscannedRegionIds:unscanned.map((r) => r.id),
    };
  };
  const graphUnsupported = (program) => program?.unsupported === true || (program?.graphCompleteness && (!program.graphCompleteness.supported || program.graphCompleteness.unsupported));
  const adapter = {
    ...base,
    async currentIdentity(options = {}) {
      const identity = await base.currentIdentity(options);
      return { ...identity, artifactVersions:{ ...(identity.artifactVersions || {}), demandQueryRuntime:RUNTIME_VERSION, recognitionInputs:recognitionVersion() } };
    },
    async functions(snapshot, query = {}, page = {}, options = {}) {
      const region = typeof app.codeRegion === 'function' ? app.codeRegion() : storeValue(app, 'currentRegion');
      if (typeof app.ensureFunctions === 'function') await app.ensureFunctions(region ?? null, { signal:options.signal ?? null, onProgress:options.onProgress });
      abortIfNeeded(options.signal);
      return base.functions(snapshot, query, page, options);
    },
    async callers(_snapshot, id, page = {}, options = {}) {
      const { program, reason, scannedRegionIds, unscannedRegionIds } = await localProgram(id, 'callers', options);
      if (!program?.callersOf) return unsupported(reason || 'program-index-unavailable');
      if (graphUnsupported(program)) return unsupported(program.queryIncompleteReason || reason || 'unsupported-program-analysis');
      const { offset, limit } = pageOf(page); const source = program.callersOf(addressOf(id), Math.min(MAX_PAGE, offset + limit));
      const relationReason=source?.incompleteReason ?? reason ?? null;
      const result = paged(Array.from(source || []), page, source?.complete === false || reason ? 'partial' : 'complete', { reason:relationReason, truncationReason:relationReason, scope:'active-neighborhood', scannedRegionIds, unscannedRegionIds });
      if (source?.queryLimited === true && result.page.next == null && result.page.returned > 0) result.page.next = result.page.offset + result.page.returned; return result;
    },
    async callees(_snapshot, id, page = {}, options = {}) {
      const address = addressOf(id); const range = address == null ? null : app.validatedFunctionRange?.(address);
      if (!range?.ok) return unsupported(range?.reason || 'function-range-unavailable');
      const { program, reason, scannedRegionIds, unscannedRegionIds } = await localProgram(address, 'callees', options);
      if (!program?.calleesOf) return unsupported(reason || 'program-index-unavailable');
      if (graphUnsupported(program)) return unsupported(program.queryIncompleteReason || reason || 'unsupported-program-analysis');
      const { offset, limit } = pageOf(page); const source = program.calleesOf(range.start, range.end, Math.min(MAX_PAGE, offset + limit));
      const relationReason=source?.incompleteReason ?? reason ?? null;
      const result = paged(Array.from(source || []), page, source?.complete === false || reason ? 'partial' : 'complete', { reason:relationReason, truncationReason:relationReason, scope:'active-function', scannedRegionIds, unscannedRegionIds });
      if (source?.queryLimited === true && result.page.next == null && result.page.returned > 0) result.page.next = result.page.offset + result.page.returned; return result;
    },
    async xrefs(_snapshot, id, page = {}, options = {}) {
      const address = addressOf(id); if (address == null) return unsupported('function-address-invalid');
      const { program, reason, scannedRegionIds, unscannedRegionIds } = await localProgram(address, 'xrefs', options); if (!program) return unsupported(reason || 'program-index-unavailable');
      if (graphUnsupported(program)) return unsupported(program.queryIncompleteReason || reason || 'unsupported-program-analysis');
      const { offset, limit } = pageOf(page); const cap = Math.min(MAX_PAGE, offset + limit); const refs = program.refSitesTo?.(address, 1n, cap) || []; const calls = program.callSitesTo?.(address, cap) || [];
      const rows = [...Array.from(refs).map((x) => ({ kind:'reference', site:x.site, target:x.target, refKind:x.kind ?? null })), ...Array.from(calls).map((x) => ({ kind:'call', site:x.site, target:address, caller:x.caller ?? null }))].sort((a,b) => BigInt(a.site) < BigInt(b.site) ? -1 : BigInt(a.site) > BigInt(b.site) ? 1 : 0);
      const relationReason=refs.incompleteReason ?? calls.incompleteReason ?? reason ?? null;
      return paged(rows, page, refs.complete === false || calls.complete === false || reason ? 'partial' : 'complete', { reason:relationReason, truncationReason:relationReason, scope:'active-neighborhood', scannedRegionIds, unscannedRegionIds });
    },
    async search(_snapshot, query, page = {}, options = {}) {
      if (!query || typeof query !== 'object' || typeof app?.backend?.search !== 'function') return unsupported('typed-search-producer-unavailable');
      abortIfNeeded(options.signal); const request = app.backend.search(query, options.onProgress);
      const value = await new Promise((resolve, reject) => {
        const onAbort = () => { request.cancel?.(); reject(abortError(options.signal, 'Search aborted')); };
        options.signal?.addEventListener('abort', onAbort, { once:true });
        Promise.resolve(request).then(resolve, reject).finally(() => options.signal?.removeEventListener('abort', onAbort));
      });
      abortIfNeeded(options.signal); const completeness = value?.capped || value?.cancelled ? 'partial' : 'complete';
      return paged(value?.results || [], page, completeness, { reason:value?.cancelled ? 'cancelled' : value?.capped ? 'search-result-cap' : null });
    },
  };
  app.analysisQueries = new AnalysisQueryAPI(adapter);
}

export function installDemandDrivenAnalysis(app) {
  if (!app || app.__demandDrivenAnalysisVersion === RUNTIME_VERSION) return app?.analysisQueries ?? null;
  installWorkerBackedIdentity(app);
  const recognitionVersion = installDemandRecognition(app);
  installMultiRegionShapes(app);
  installCancellableFunctionDiscovery(app);
  installDemandQueryAPI(app, recognitionVersion);
  Object.defineProperty(app, '__demandDrivenAnalysisVersion', { value:RUNTIME_VERSION, configurable:true });
  return app.analysisQueries;
}
export const __demandDrivenInternalsForTests = Object.freeze({ addressOf, mergeShapeMaps, recognitionInputKey, localRegionPlan, regionScanLimits });
