import { STRING_SCAN_BUDGET, StringCollectionBudget } from '../string-budget.js';
import { ProgramIndex, mergeProgramScans, PROGRAM_MERGE_LIMITS } from '../program.js';
import { investigationServiceFor } from './investigation-service.js';

const INSTALL_VERSION = 'shared-app-artifacts/v3';
const STRING_ENTRIES = new WeakMap();
const PROGRAM_ENTRIES = new WeakMap();
const REF_YIELD_EVERY = 16_384;

function abortError(signal, fallback = 'Analysis consumer aborted') {
  const error = signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason || fallback));
  if (!error.name || error.name === 'Error') error.name = 'AbortError';
  if (!error.code) error.code = 'ABORT_ERR';
  return error;
}
function throwIfAborted(signal) { if (signal?.aborted) throw abortError(signal); }
function normalizeOptions(value) {
  if (typeof value === 'function') return { onProgress:value, signal:null, priority:'user-visible', budget:null };
  const options = value && typeof value === 'object' ? value : {};
  return {
    signal:options.signal ?? null,
    onProgress:typeof options.onProgress === 'function' ? options.onProgress : null,
    priority:options.priority ?? 'user-visible',
    budget:options.budget ?? null,
  };
}
function producerOptions(options = {}) {
  return Object.freeze({
    priority:options.priority ?? 'user-visible',
    // Budget remains consumer metadata. It is forwarded to dependency producers
    // that understand the contract, but never used here to shrink canonical
    // string/function/reference denominators.
    budget:options.budget ?? null,
  });
}
function mapFor(root, app) {
  let map = root.get(app);
  if (!map) { map = new Map(); root.set(app, map); }
  return map;
}
function publishProgress(entry, value) {
  for (const subscriber of entry.subscribers) {
    try { subscriber.onProgress?.(value); } catch { /* observer only */ }
  }
}
function attach(entry, options) {
  throwIfAborted(options.signal);
  const subscriber = { onProgress:options.onProgress, priority:options.priority, budget:options.budget };
  entry.subscribers.add(subscriber);
  entry.waiters++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value, cancelled = false) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener?.('abort', onAbort);
      entry.subscribers.delete(subscriber);
      entry.waiters = Math.max(0, entry.waiters - 1);
      if (cancelled && entry.waiters === 0 && !entry.settled && !entry.controller.signal.aborted) {
        entry.controller.abort(options.signal?.reason ?? 'no-active-consumers');
      }
      fn(value);
    };
    const onAbort = () => finish(reject, abortError(options.signal), true);
    if (options.signal?.aborted) { onAbort(); return; }
    options.signal?.addEventListener?.('abort', onAbort, { once:true });
    entry.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}
function requestWithSignal(request, signal) {
  throwIfAborted(signal);
  if (!request || typeof request.then !== 'function') return Promise.resolve(request);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      try { request.cancel?.(); } catch { /* best effort */ }
      finish(reject, abortError(signal));
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener?.('abort', onAbort, { once:true });
    Promise.resolve(request).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}
function yieldMainRealm(signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, abortError(signal));
    signal?.addEventListener?.('abort', onAbort, { once:true });
    setTimeout(() => finish(resolve), 0);
  });
}
function epochOf(app) { return Number(app?.backend?.gen ?? app?.analysisEpoch ?? -1); }
function storeValue(app, key) { try { return app?.store?.get?.(key) ?? null; } catch { return null; } }
function stringPriority(region) {
  const section = region?.section || '';
  if (region?.cstrings || /^__(cstring|objc_methname|objc_classname|swift5_reflstr|oslogstring)$/.test(section)) return 0;
  if (/string|objc_method|objc_class|ustring/i.test(section)) return 1;
  return 2;
}
function stringTargets(app) {
  return (storeValue(app, 'regions') || []).filter((region) => {
    try {
      return BigInt(region?.size ?? 0) > 0n &&
        (region.cstrings || /string|cstring|objc_methname|objc_method|objc_classname|objc_class|oslogstring|const|ustring|swift5_reflstr/i.test(region.section || ''));
    } catch { return false; }
  }).sort((a, b) => stringPriority(a) - stringPriority(b));
}
function executableRegions(app) {
  const source = typeof app?.programRegions === 'function'
    ? app.programRegions()
    : (storeValue(app, 'regions') || []).filter((region) => region?.exec === true);
  return Array.from(source || []).filter((region) => {
    try { return region?.exec === true && BigInt(region.size ?? 0) > 0n; } catch { return false; }
  });
}
function splitLimit(remaining, size, remainingBytes) {
  if (!(remaining > 0) || remainingBytes <= 0n) return 0;
  return Math.max(1, Math.min(remaining, Number((BigInt(remaining) * size + remainingBytes - 1n) / remainingBytes)));
}
function dataRanges(app) {
  return (storeValue(app, 'regions') || []).filter((region) => {
    if (region?.exec) return false;
    try {
      const size = BigInt(region?.declaredSize ?? region?.size ?? 0);
      return size > 0n && /__data|__bss|__common|__const|__cfstring|__objc_(ivar|const|data)/.test(region?.section || '');
    } catch { return false; }
  }).map((region) => ({
    region,
    lo:BigInt(region.vmAddr),
    hi:BigInt(region.vmAddr) + BigInt(region.declaredSize ?? region.size ?? 0),
  })).filter((range) => range.hi > range.lo).sort((a, b) => a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0);
}
function dataRegionFor(ranges, address) {
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
function boundedRefCount(scan) {
  const requested = Number.isSafeInteger(scan?.refCount) ? scan.refCount : (scan?.refTo?.length || 0);
  return Math.max(0, Math.min(requested, scan?.refFrom?.length || 0, scan?.refTo?.length || 0, scan?.refKind?.length || 0));
}
async function accumulateGlobalRefs(counts, scan, ranges, { signal = null, yieldEvery = REF_YIELD_EVERY } = {}) {
  const count = boundedRefCount(scan);
  const cadence = Math.max(1, Number(yieldEvery) || REF_YIELD_EVERY);
  for (let index = 0; index < count; index++) {
    throwIfAborted(signal);
    const address = BigInt(scan.refTo[index]);
    const region = dataRegionFor(ranges, address);
    if (region) {
      const key = address.toString();
      const previous = counts.get(key);
      if (previous) previous.refs++;
      else counts.set(key, { addr:address, refs:1, region:region.name || region.section || region.id || '' });
    }
    if (index > 0 && index % cadence === 0) await yieldMainRealm(signal);
  }
  return count;
}
function statsFor(program, counts, scannedRefs) {
  const graph = program?.graphCompleteness;
  const complete = !!program && program.unsupported !== true && program.refsCapped !== true && program.completeness?.complete !== false && graph?.refsComplete !== false;
  return Object.freeze({
    counts,
    scannedRefs,
    complete,
    reason:complete ? null : (program?.queryIncompleteReason || graph?.reasons?.[0] || (program?.refsCapped ? 'refs-source-capped' : 'program-analysis-incomplete')),
    producer:'program-region-ref-aggregate/v1',
  });
}

function createStringEntry(app, key, initialOptions = {}) {
  const controller = new AbortController();
  const entry = {
    controller, waiters:0, settled:false, subscribers:new Set(), result:null, promise:null,
    producerOptions:producerOptions(initialOptions),
  };
  const epoch = epochOf(app);
  entry.promise = (async () => {
    const budget = new StringCollectionBudget(STRING_SCAN_BUDGET);
    const targets = stringTargets(app);
    const current = storeValue(app, 'currentRegion');
    const use = [], skipped = [];
    for (const region of targets) {
      const bytes = budget.requestBytes(Number(region.size));
      if (bytes <= 0) { skipped.push(region); continue; }
      use.push({ region, bytes });
      if (bytes < Number(region.size)) skipped.push(region);
    }
    if (!use.length && current) {
      const bytes = budget.requestBytes(Number(current.size));
      if (bytes > 0) use.push({ region:current, bytes });
    }
    const rows = [];
    let scannedBytes = 0, backendIncomplete = false;
    for (let index = 0; index < use.length; index++) {
      throwIfAborted(controller.signal);
      if (epoch !== epochOf(app)) throw Object.assign(new Error('stale shared strings'), { stale:true });
      if (budget.exhausted) { skipped.push(...use.slice(index).map((item) => item.region)); break; }
      const { region, bytes } = use[index];
      const limit = budget.requestLimit();
      if (limit <= 0) break;
      const request = app.backend.strings({
        regionId:region.id, min:4, maxBytes:bytes, limit,
        analysisPriority:String(entry.producerOptions.priority || 'user-visible'),
      }, (progress) => publishProgress(entry, {
        phase:'strings', region:region.id,
        done:index + (progress?.all ? Math.min(1, progress.done / progress.all) : 0), all:use.length,
      }));
      const result = await requestWithSignal(request, controller.signal);
      scannedBytes += Number(result?.scannedBytes || 0);
      if (result?.complete !== true) { backendIncomplete = true; if (!skipped.includes(region)) skipped.push(region); }
      for (const item of result?.results || []) {
        if (!budget.accept(item.text)) break;
        rows.push({ addr:item.addr, text:item.text, region });
      }
      if (result?.capped && !budget.truncationReason) budget.truncationReason = result.truncationReason || 'result-budget';
    }
    throwIfAborted(controller.signal);
    if (epoch !== epochOf(app)) throw Object.assign(new Error('stale shared strings'), { stale:true });
    const truncated = !!budget.truncationReason || skipped.length > 0 || backendIncomplete;
    Object.assign(rows, {
      complete:!truncated,
      truncated,
      truncationReason:budget.truncationReason || (skipped.length ? 'input-budget' : backendIncomplete ? 'backend-partial' : null),
      scannedBytes,
      skippedRegions:[...new Set(skipped.map((region) => region.id))],
      unscannedRegions:[...new Set(skipped.map((region) => region.id))],
      producer:'shared-string-artifact/v1',
      producerPriority:entry.producerOptions.priority,
      producerBudgetSupplied:entry.producerOptions.budget != null,
    });
    app.stringIndex = rows;
    entry.result = rows;
    return rows;
  })().then((value) => { entry.settled = true; return value; }).catch((error) => {
    mapFor(STRING_ENTRIES, app).delete(key);
    throw error;
  }).finally(() => {
    if (app.stringsBusyEpoch === epoch) { app.stringsBusy = null; app.stringsBusyEpoch = -1; }
  });
  app.stringsBusyEpoch = epoch;
  app.stringsBusy = entry.promise;
  mapFor(STRING_ENTRIES, app).set(key, entry);
  return entry;
}

function createProgramEntry(app, key, regions, initialOptions = {}) {
  const controller = new AbortController();
  const entry = {
    controller, waiters:0, settled:false, subscribers:new Set(), result:null, promise:null,
    producerOptions:producerOptions(initialOptions),
  };
  const epoch = epochOf(app);
  entry.promise = (async () => {
    const primary = regions.find((region) => region.section === '__text') || regions[0];
    await app.ensureFunctions?.(primary, {
      signal:controller.signal,
      onProgress:(progress) => publishProgress(entry, progress),
      priority:entry.producerOptions.priority,
      budget:entry.producerOptions.budget,
    });
    throwIfAborted(controller.signal);
    if (epoch !== epochOf(app)) throw Object.assign(new Error('stale shared program'), { stale:true });
    const scans = [], failures = [];
    const ranges = dataRanges(app);
    const counts = new Map();
    let scannedRefs = 0;
    let calls = PROGRAM_MERGE_LIMITS.calls, refs = PROGRAM_MERGE_LIMITS.refs, kinds = PROGRAM_MERGE_LIMITS.kindWords;
    let remainingBytes = regions.reduce((sum, region) => sum + BigInt(region.size), 0n);
    for (let index = 0; index < regions.length; index++) {
      throwIfAborted(controller.signal);
      const region = regions[index], size = BigInt(region.size);
      const request = app.backend.scanProgram(region.id, (progress) => publishProgress(entry, {
        phase:'program', region:region.id,
        done:index + (progress?.all ? Math.min(1, progress.done / progress.all) : 0), all:regions.length,
      }), {
        architecture:storeValue(app, 'architecture') || app.currentSlice?.()?.capability?.architecture || 'unknown',
        callLimit:splitLimit(calls, size, remainingBytes),
        refLimit:splitLimit(refs, size, remainingBytes),
        kindLimit:splitLimit(kinds, size, remainingBytes),
        analysisPriority:String(entry.producerOptions.priority || 'user-visible'),
      });
      try {
        const scan = await requestWithSignal(request, controller.signal);
        if (scan && !scan.cancelled) {
          scans.push(scan);
          scannedRefs += await accumulateGlobalRefs(counts, scan, ranges, { signal:controller.signal });
          calls = Math.max(0, calls - Number(scan.callCount ?? scan.callFrom?.length ?? 0));
          refs = Math.max(0, refs - Number(scan.refCount ?? scan.refFrom?.length ?? 0));
          kinds = Math.max(0, kinds - Number(scan.kindsCovered ?? scan.kinds?.length ?? 0));
        } else failures.push(`${region.id}:program-scan-cancelled`);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        failures.push(`${region.id}:program-scan-failed`);
      }
      remainingBytes -= size;
    }
    if (app.symbols?.functionStartsComplete !== true) failures.push('function-discovery-incomplete');
    throwIfAborted(controller.signal);
    if (epoch !== epochOf(app)) throw Object.assign(new Error('stale shared program'), { stale:true });
    const merged = mergeProgramScans(scans, { regions, reasons:failures, limits:PROGRAM_MERGE_LIMITS });
    const program = new ProgramIndex(merged, app.symbols, primary);
    const stats = statsFor(program, counts, scannedRefs);
    Object.defineProperty(stats, 'producerPriority', { value:entry.producerOptions.priority, enumerable:true });
    Object.defineProperty(stats, 'producerBudgetSupplied', { value:entry.producerOptions.budget != null, enumerable:true });
    Object.defineProperty(program, 'globalReferenceStats', { value:stats, enumerable:false, configurable:true });
    Object.defineProperty(merged, 'globalReferenceStats', { value:stats, enumerable:false, configurable:true });
    app.programScan = merged;
    app.programKey = key;
    app.program = program;
    entry.result = program;
    return program;
  })().then((value) => { entry.settled = true; return value; }).catch((error) => {
    mapFor(PROGRAM_ENTRIES, app).delete(`${epoch}:${key}`);
    throw error;
  }).finally(() => {
    if (app.programBusyEpoch === epoch) { app.programBusy = null; app.programBusyEpoch = -1; }
  });
  app.programBusyEpoch = epoch;
  app.programBusy = entry.promise;
  mapFor(PROGRAM_ENTRIES, app).set(`${epoch}:${key}`, entry);
  return entry;
}

export function installSharedAppArtifacts(app) {
  if (!app || app.__sharedAppArtifactsVersion === INSTALL_VERSION) return app;

  app.ensureStrings = function sharedStrings(rawOptions = {}) {
    const options = normalizeOptions(rawOptions);
    throwIfAborted(options.signal);
    if (app.stringIndex) return Promise.resolve(app.stringIndex);
    const epoch = epochOf(app);
    const key = String(epoch);
    const map = mapFor(STRING_ENTRIES, app);
    let entry = map.get(key);
    if (!entry) entry = createStringEntry(app, key, options);
    return attach(entry, options);
  };

  app.ensureProgram = function sharedProgram(rawOptions = {}) {
    const options = normalizeOptions(rawOptions);
    throwIfAborted(options.signal);
    const regions = executableRegions(app);
    if (!regions.length) return Promise.resolve(null);
    const key = regions.map((region) => region.id).join('|');
    if (app.program && app.programKey === key && app.program.gen === app.symbols?.gen && app.program.globalReferenceStats) return Promise.resolve(app.program);
    const epoch = epochOf(app);
    const mapKey = `${epoch}:${key}`;
    const map = mapFor(PROGRAM_ENTRIES, app);
    let entry = map.get(mapKey);
    if (!entry) entry = createProgramEntry(app, key, regions, options);
    return attach(entry, options);
  };

  // Investigation, schema recovery, Globals, and legacy callers now converge on
  // one producer per artifact instead of maintaining parallel whole-binary scans.
  const service = investigationServiceFor(app);
  service.collectStrings = (options = {}) => app.ensureStrings(options);
  service.buildProgram = (options = {}) => app.ensureProgram(options);

  Object.defineProperty(app, '__sharedAppArtifactsVersion', { value:INSTALL_VERSION, configurable:true });
  return app;
}

export const __sharedAppArtifactInternalsForTests = Object.freeze({
  normalizeOptions,
  accumulateGlobalRefs,
  statsFor,
});
