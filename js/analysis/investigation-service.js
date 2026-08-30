import { StringCollectionBudget, STRING_SCAN_BUDGET } from '../string-budget.js';
import { ProgramIndex, mergeProgramScans, PROGRAM_MERGE_LIMITS } from '../program.js';
import { rankCandidates } from '../rank.js';
import { vendorsOf } from '../vendors.js';
import { pinpointField, pinpointFunction, pinpointLocation } from '../pinpoint.js';
import { VERDICT, verdictRank } from '../evidence.js';
import { stringLookup } from '../role.js';
import { makePinpointAnalyzer } from '../ui/pinpoint-runtime.js';
import { autoAnalyze } from '../auto.js';

const SERVICES = new WeakMap();

function abortError(signal, message = 'Investigation cancelled') {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}
function abortIfNeeded(signal) { if (signal?.aborted) throw abortError(signal); }
function epochOf(app) { return Number(app?.backend?.gen ?? app?.analysisEpoch ?? -1); }
function storeValue(app, key) {
  try { return app?.store?.get?.(key) ?? null; } catch { return null; }
}
function execRegions(app) {
  const source = typeof app?.programRegions === 'function'
    ? app.programRegions()
    : (storeValue(app, 'regions') || []).filter((r) => r?.exec === true && BigInt(r.size ?? 0) > 0n);
  return Array.from(source || []).filter((r) => r?.exec === true && BigInt(r.size ?? 0) > 0n);
}
function regionForAddress(app, address) {
  if (address == null) return null;
  try {
    const direct = app?.executableRegionFor?.(BigInt(address));
    if (direct) return direct;
  } catch { /* derive below */ }
  const value = BigInt(address);
  return execRegions(app).find((r) => value >= BigInt(r.vmAddr) && value < BigInt(r.vmAddr) + BigInt(r.size)) ?? null;
}
function progress(options, value) { try { options?.onProgress?.(value); } catch { /* observer only */ } }

function waitShared(entry, signal) {
  abortIfNeeded(signal);
  entry.waiters++;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      entry.waiters = Math.max(0, entry.waiters - 1);
      fn(value);
    };
    const onAbort = () => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      entry.waiters = Math.max(0, entry.waiters - 1);
      if (!entry.settled && entry.waiters === 0) entry.controller.abort('investigation-no-consumers');
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once:true });
    entry.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function requestWithSignal(request, signal) {
  if (!request || typeof request.then !== 'function') return Promise.resolve(request);
  if (signal?.aborted) { request.cancel?.(); return Promise.reject(abortError(signal)); }
  return new Promise((resolve, reject) => {
    const onAbort = () => { try { request.cancel?.(); } catch { /* best effort */ } reject(abortError(signal)); };
    signal?.addEventListener('abort', onAbort, { once:true });
    Promise.resolve(request).then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort));
  });
}

function stringTargets(app) {
  const regions = storeValue(app, 'regions') || [];
  const priority = (r) => {
    const section = r.section || '';
    if (r.cstrings || /^__(cstring|objc_methname|objc_classname|swift5_reflstr|oslogstring)$/.test(section)) return 0;
    if (/string|objc_method|objc_class|ustring/i.test(section)) return 1;
    return 2;
  };
  return regions.filter((r) => BigInt(r?.size ?? 0) > 0n &&
    (r.cstrings || /string|cstring|objc_methname|objc_method|objc_classname|objc_class|oslogstring|const|ustring|swift5_reflstr/i.test(r.section || '')))
    .sort((a, b) => priority(a) - priority(b));
}

function splitLimit(remaining, size, remainingBytes) {
  if (!(remaining > 0) || remainingBytes <= 0n) return 0;
  return Math.max(1, Math.min(remaining, Number((BigInt(remaining) * size + remainingBytes - 1n) / remainingBytes)));
}

function programComplete(program) {
  if (!program) return false;
  const graph = program.graphCompleteness;
  if (graph && graph.complete === false) return false;
  if (program.callsCapped || program.refsCapped || program.statsComplete === false) return false;
  return true;
}
function completenessFor({ strings, program, shapes }) {
  const reasons = [];
  if (strings?.complete !== true) reasons.push(strings?.truncationReason || 'strings-partial');
  if (!programComplete(program)) reasons.push(program?.queryIncompleteReason || 'program-partial');
  if (shapes && shapes.complete !== true) reasons.push(shapes.incompleteReason || 'shapes-partial');
  return { complete:reasons.length === 0, reasons:[...new Set(reasons.filter(Boolean))] };
}
function needsShapeEvidence(goal) {
  const expects = goal?.expects || {};
  return !!(expects.numeric || expects.store || ['hp','attack','defense','damage','money','score','level','stamina','item'].includes(goal?.id));
}
function beats(next, current) {
  if (!next?.top) return false;
  if (!current?.top) return true;
  const rank = verdictRank(next.verdict) - verdictRank(current.verdict);
  if (rank !== 0) return rank > 0;
  return Number(next.top?.fusion?.probability || 0) > Number(current.top?.fusion?.probability || 0);
}

export class InvestigationService {
  constructor(app) {
    this.app = app;
    this.shared = new Map();
    this.pinCache = new Map();
  }

  #shared(key, producer, options = {}) {
    let entry = this.shared.get(key);
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, waiters:0, settled:false, promise:null };
      entry.promise = Promise.resolve().then(() => producer(controller.signal))
        .then((value) => { entry.settled = true; return value; })
        .catch((error) => { this.shared.delete(key); throw error; });
      this.shared.set(key, entry);
    }
    return waitShared(entry, options.signal ?? null);
  }

  collectStrings(options = {}) {
    if (this.app.stringIndex) return Promise.resolve(this.app.stringIndex);
    const epoch = epochOf(this.app);
    return this.#shared(`strings:${epoch}`, async (signal) => {
      const budget = new StringCollectionBudget(STRING_SCAN_BUDGET);
      const targets = stringTargets(this.app);
      const current = storeValue(this.app, 'currentRegion');
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
      let scannedBytes = 0, backendPartial = false;
      for (let index = 0; index < use.length; index++) {
        abortIfNeeded(signal);
        if (epoch !== epochOf(this.app)) throw Object.assign(new Error('stale investigation strings'), { stale:true });
        if (budget.exhausted) { skipped.push(...use.slice(index).map((x) => x.region)); break; }
        const { region, bytes } = use[index];
        const limit = budget.requestLimit();
        if (limit <= 0) break;
        const request = this.app.backend.strings({ regionId:region.id, min:4, maxBytes:bytes, limit }, (p) => progress(options, { phase:'strings', region:region.id, done:index + (p?.all ? Math.min(1, p.done / p.all) : 0), all:use.length }));
        const result = await requestWithSignal(request, signal);
        scannedBytes += Number(result?.scannedBytes || 0);
        if (result?.complete !== true) { backendPartial = true; if (!skipped.includes(region)) skipped.push(region); }
        for (const item of result?.results || []) {
          if (!budget.accept(item.text)) break;
          rows.push({ addr:item.addr, text:item.text, region });
        }
        if (result?.capped && !budget.truncationReason) budget.truncationReason = result.truncationReason || 'result-budget';
      }
      const truncated = !!budget.truncationReason || skipped.length > 0 || backendPartial;
      Object.assign(rows, {
        complete:!truncated,
        truncated,
        truncationReason:budget.truncationReason || (skipped.length ? 'input-budget' : backendPartial ? 'backend-partial' : null),
        scannedBytes,
        unscannedRegions:[...new Set(skipped.map((r) => r.id))],
      });
      if (epoch === epochOf(this.app)) this.app.stringIndex = rows;
      return rows;
    }, options);
  }

  async discoverFunctions(options = {}) {
    const symbols = this.app.symbols;
    if (!symbols || symbols.functionStartsComplete === true || symbols.functionDiscovery?.complete === true) return symbols;
    if (typeof this.app.ensureFunctions !== 'function') return symbols;
    const region = this.app.codeRegion?.() || execRegions(this.app)[0] || null;
    return this.app.ensureFunctions(region, { signal:options.signal ?? null, onProgress:options.onProgress });
  }

  buildProgram(options = {}) {
    const app = this.app;
    const regions = execRegions(app);
    if (!regions.length) return Promise.resolve(null);
    const epoch = epochOf(app);
    const key = regions.map((r) => r.id).join('|');
    if (app.program && app.programKey === key && app.program.gen === app.symbols?.gen) return Promise.resolve(app.program);
    return this.#shared(`program:${epoch}:${Number(app.symbols?.gen || 0)}:${key}`, async (signal) => {
      await this.discoverFunctions({ ...options, signal });
      abortIfNeeded(signal);
      const scans = [], failures = [];
      let calls = PROGRAM_MERGE_LIMITS.calls, refs = PROGRAM_MERGE_LIMITS.refs, kinds = PROGRAM_MERGE_LIMITS.kindWords;
      let remainingBytes = regions.reduce((sum, region) => sum + BigInt(region.size), 0n);
      for (let index = 0; index < regions.length; index++) {
        abortIfNeeded(signal);
        const region = regions[index], size = BigInt(region.size);
        const request = app.backend.scanProgram(region.id, (p) => progress(options, { phase:'program', region:region.id, done:index + (p?.all ? Math.min(1, p.done / p.all) : 0), all:regions.length }), {
          callLimit:splitLimit(calls, size, remainingBytes),
          refLimit:splitLimit(refs, size, remainingBytes),
          kindLimit:splitLimit(kinds, size, remainingBytes),
        });
        try {
          const scan = await requestWithSignal(request, signal);
          if (scan && !scan.cancelled) {
            scans.push(scan);
            calls = Math.max(0, calls - Number(scan.callCount ?? scan.callFrom?.length ?? 0));
            refs = Math.max(0, refs - Number(scan.refCount ?? scan.refFrom?.length ?? 0));
            kinds = Math.max(0, kinds - Number(scan.kindsCovered ?? scan.kinds?.length ?? 0));
          } else failures.push(`${region.id}:program-scan-cancelled`);
        } catch (error) {
          if (signal.aborted) throw error;
          failures.push(`${region.id}:program-scan-failed`);
        }
        remainingBytes -= size;
      }
      if (app.symbols?.functionStartsComplete !== true) failures.push('function-discovery-incomplete');
      abortIfNeeded(signal);
      if (epoch !== epochOf(app)) throw Object.assign(new Error('stale investigation program'), { stale:true });
      const merged = mergeProgramScans(scans, { regions, reasons:failures, limits:PROGRAM_MERGE_LIMITS });
      const primary = regions.find((r) => r.section === '__text') || regions[0];
      const program = new ProgramIndex(merged, app.symbols, primary);
      app.programScan = merged;
      app.programKey = key;
      app.program = program;
      return program;
    }, options);
  }

  collectShapes(options = {}) {
    const epoch = epochOf(this.app);
    if (this.app.shapes) return Promise.resolve(this.app.shapes);
    return this.#shared(`shapes:${epoch}`, (signal) => this.app.ensureShapes({ signal, onProgress:(p) => progress(options, p) }), options);
  }

  ensureMetadata(options = {}) {
    const epoch = epochOf(this.app);
    return this.#shared(`metadata:${epoch}`, async (signal) => {
      abortIfNeeded(signal);
      const sliceIndex = Number(storeValue(this.app, 'sliceIndex') ?? -1);
      const work = [];
      if (typeof this.app.ensureObjc === 'function' && sliceIndex >= 0) work.push(this.app.ensureObjc(sliceIndex));
      if (typeof this.app.ensureSwift === 'function') work.push(this.app.ensureSwift());
      await Promise.allSettled(work);
      abortIfNeeded(signal);
      if (epoch !== epochOf(this.app)) throw Object.assign(new Error('stale investigation metadata'), { stale:true });
      return { fields:this.app.fields, objc:this.app.objcModel, swift:this.app.swiftModel };
    }, options);
  }

  #addressAwareAnalyzer(signal) {
    const cache = new Map();
    return async (address, end, options = {}) => {
      const region = regionForAddress(this.app, address) || this.app.codeRegion?.();
      if (!region) return null;
      let analyzer = cache.get(region.id);
      if (!analyzer) { analyzer = makePinpointAnalyzer(this.app, region, signal); cache.set(region.id, analyzer); }
      return analyzer ? analyzer(address, end, options) : null;
    };
  }

  #globalAccessScanner(signal) {
    return async (list, options = {}) => {
      const offsets = (list || []).map((item) => ({ offset:item.offset, size:item.size || 0 }));
      const merged = new Map();
      if (!offsets.length) return merged;
      for (const region of execRegions(this.app)) {
        abortIfNeeded(signal);
        const request = this.app.backend.fieldAccessMany(region.id, offsets);
        const result = await requestWithSignal(request, signal);
        for (const [key, rows] of result || []) {
          const current = merged.get(key) || [];
          current.push(...(rows || []).map((row) => ({ ...row, regionId:region.id })));
          merged.set(key, current);
        }
      }
      return merged;
    };
  }

  async prepareGoal(goal, options = {}) {
    abortIfNeeded(options.signal);
    const shapeNeeded = needsShapeEvidence(goal);
    const stringsP = this.collectStrings(options);
    const shapesP = shapeNeeded ? this.collectShapes(options) : Promise.resolve(null);
    const metadataP = shapeNeeded ? this.ensureMetadata(options) : Promise.resolve({ fields:this.app.fields });
    const programP = metadataP.then(() => this.buildProgram(options));
    const [strings, program, shapes] = await Promise.all([stringsP, programP, shapesP]);
    abortIfNeeded(options.signal);
    const snapshot = await this.app.analysisQueries.snapshot({ signal:options.signal });
    const context = {
      snapshot,
      snapshotId:snapshot.snapshotId,
      strings,
      program,
      shapes,
      symbols:this.app.symbols,
      fields:this.app.fields,
      region:this.app.codeRegion?.() || execRegions(this.app)[0] || null,
    };
    context.completeness = completenessFor(context);
    return context;
  }

  async investigate(goal, options = {}) {
    const context = await this.prepareGoal(goal, options);
    const ranked = rankCandidates({
      goal,
      strings:context.strings,
      program:context.program,
      symbols:context.symbols,
      region:context.region,
      limit:options.limit ?? 40,
      vendors:vendorsOf(context.fields),
    });
    abortIfNeeded(options.signal);
    const cacheKey = `${context.snapshotId}:${goal?.id || ''}:${goal?.text || ''}`;
    let pin = this.pinCache.get(cacheKey) || null;
    if (!pin) {
      const common = {
        goal,
        fields:context.fields,
        shapes:context.shapes,
        program:context.program,
        symbols:context.symbols,
        strings:context.strings,
        region:context.region,
        map:null,
        textAt:stringLookup(context.strings || []),
        signal:options.signal || null,
        analyze:this.#addressAwareAnalyzer(options.signal || null),
        scanAccess:this.#globalAccessScanner(options.signal || null),
        budget:{ left:48 },
        limit:12,
        onProgress:(value) => progress(options, { phase:'pinpoint', ...value }),
      };
      let candidate = null;
      const attempt = async (fn) => {
        try { return await fn(); }
        catch (error) { if (options.signal?.aborted) throw error; return null; }
      };
      if (context.fields?.classCount) candidate = await attempt(() => pinpointField(common));
      const undecided = (value) => !value?.top || verdictRank(value.verdict) <= verdictRank(VERDICT.AMBIGUOUS);
      if (undecided(candidate) && (ranked.candidates.length || context.shapes?.size)) {
        const location = await attempt(() => pinpointLocation({ ...common, ranked:ranked.candidates }));
        if (beats(location, candidate)) candidate = location;
      }
      if (undecided(candidate) && ranked.candidates.length) {
        const fn = await attempt(() => pinpointFunction({ ...common, ranked:ranked.candidates }));
        if (beats(fn, candidate)) candidate = fn;
      }
      pin = candidate;
      if (!options.signal?.aborted) this.pinCache.set(cacheKey, pin);
    }
    await this.app.analysisQueries.binaryInfo(context.snapshot, { signal:options.signal });
    return Object.freeze({
      snapshotId:context.snapshotId,
      snapshot:context.snapshot,
      completeness:context.completeness,
      ranked,
      pin,
      context,
    });
  }

  async overview(options = {}) {
    const goal = { id:'overview', expects:{ numeric:true, store:true, call:true, compare:true } };
    const context = await this.prepareGoal(goal, options);
    let recognition = null;
    try { recognition = await this.app.ensureRecognition({ signal:options.signal, maxFunctions:350000, knowledgeLimit:512 }); }
    catch (error) { if (options.signal?.aborted) throw error; }
    const report = await autoAnalyze({
      strings:context.strings,
      program:context.program,
      symbols:context.symbols,
      region:context.region,
      fields:context.fields,
      shapes:context.shapes,
      recognition,
      analyze:this.#addressAwareAnalyzer(options.signal || null),
      scanAccess:this.#globalAccessScanner(options.signal || null),
      isCancelled:() => !!options.signal?.aborted,
      onProgress:(value) => progress(options, value),
    });
    await this.app.analysisQueries.binaryInfo(context.snapshot, { signal:options.signal });
    report.snapshotId = context.snapshotId;
    report.completeness = context.completeness;
    return Object.freeze({ snapshotId:context.snapshotId, snapshot:context.snapshot, completeness:context.completeness, report, context });
  }
}

export function investigationServiceFor(app) {
  if (!app) throw new TypeError('investigation-app-required');
  let service = SERVICES.get(app);
  if (!service) { service = new InvestigationService(app); SERVICES.set(app, service); }
  return service;
}

export const __investigationInternalsForTests = Object.freeze({ needsShapeEvidence, completenessFor, beats, regionForAddress });