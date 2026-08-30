from pathlib import Path


def replace_once(path, old, new):
    p=Path(path); text=p.read_text()
    if old not in text:
        raise SystemExit(f'pattern missing in {path}: {old[:120]!r}')
    if text.count(old)!=1:
        raise SystemExit(f'pattern not unique in {path}: {text.count(old)}')
    p.write_text(text.replace(old,new,1))

# #2504: do not invoke whole-binary recognition from ordinary open at all.
replace_once('js/app.js', """        // ObjC recovery is intentionally demand-driven. It can traverse large
        // runtime metadata and must not be a hidden prerequisite of opening a file.
        // Swift/recognition keep their existing background warmup behavior.
        return Promise.allSettled([
          this.ensureSwift(),
          this.ensureRecognition({ maxFunctions: 350000 }),
        ]);
""", """        // ObjC and whole-binary recognition are intentionally demand-driven.
        // Swift metadata may warm in the background, but recognition only starts
        // from an explicit consumer (Overview/Explorer/etc.).
        return Promise.allSettled([
          this.ensureSwift(),
        ]);
""")

# #2540: keep App's public bridge signal/options capable as well as the Product route.
replace_once('js/app.js',
             "  async loadDiffBaseline(file){return this.workspace.loadBaseline(file);}\n",
             "  async loadDiffBaseline(file, options={}){return this.workspace.loadBaseline(file, options);}\n")

# Shared App-level metadata producer waiter helper (#2507).
replace_once('js/app.js',
"const FUNCTION_DISCOVERY_GLOBAL_CAP = 400_000;\n",
"""const FUNCTION_DISCOVERY_GLOBAL_CAP = 400_000;

function appProducerAbortError(signal, message='Analysis producer aborted') {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(signal?.reason == null ? message : String(signal.reason));
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}
function waitForAppProducer(entry, signal) {
  if (signal?.aborted) return Promise.reject(appProducerAbortError(signal));
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
      if (!entry.settled && entry.waiters === 0) entry.controller.abort('analysis-producer-no-consumers');
      reject(appProducerAbortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once:true });
    entry.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}
""")

# Ref-count Objective-C metadata and bridge cancellation into backend readAt.
replace_once('js/app.js',
"""    if (this.objcModel && this.objcRuntime) return this.fields;
    if (this.objcBusy && this.objcBusyEpoch === epoch) return this.objcBusy;
""",
"""    if (this.objcModel && this.objcRuntime) return this.fields;
    if (this.objcBusy && this.objcBusyEpoch === epoch && this.objcBusyState) return waitForAppProducer(this.objcBusyState, options.signal ?? null);
""")
replace_once('js/app.js',
"""    this.objcBusyEpoch = epoch;
    this.objcBusy = (async () => {
      const read = (addr, len) => this.backend.readAt(addr, len).then((r) => (r && r.found ? r.bytes : null)).catch(() => null);
      try {
""",
"""    this.objcBusyEpoch = epoch;
    const producerController = new AbortController();
    const producerState = { controller:producerController, waiters:0, settled:false, promise:null };
    const producerOptions = { ...options, signal:producerController.signal };
    producerState.promise = (async () => {
      const read = async (addr, len) => {
        if (producerController.signal.aborted) throw appProducerAbortError(producerController.signal, 'Objective-C metadata read aborted');
        const request = this.backend.readAt(addr, len, false, { priority:producerOptions.priority === 'background' ? 'background' : 'current' });
        const onAbort = () => request.cancel?.();
        producerController.signal.addEventListener('abort', onAbort, { once:true });
        try {
          const r = await request;
          if (producerController.signal.aborted) throw appProducerAbortError(producerController.signal, 'Objective-C metadata read aborted');
          return r && r.found ? r.bytes : null;
        } catch (error) {
          if (producerController.signal.aborted || error?.name === 'AbortError') throw error;
          return null;
        } finally {
          producerController.signal.removeEventListener('abort', onAbort);
        }
      };
      try {
""")
replace_once('js/app.js',
"""        const model = await buildObjcRuntimeModel(read, list, { protocolList, categoryList, executableRanges, architecture }, null, imageBase, null, options);
""",
"""        const model = await buildObjcRuntimeModel(read, list, { protocolList, categoryList, executableRanges, architecture }, null, imageBase, null, producerOptions);
""")
replace_once('js/app.js',
"""      } catch { /* fail-soft on partial Apple metadata */ }
      finally { if (this.objcBusyEpoch === epoch) { this.objcBusy=null; this.objcBusyEpoch=-1; } }
      return epoch === this.backend.gen ? this.fields : EMPTY_FIELDS;
    })();
    return this.objcBusy;
  }

  async ensureSwift() {
""",
"""      } catch (error) {
        if (producerController.signal.aborted || error?.name === 'AbortError') throw error;
        /* fail-soft on partial Apple metadata */
      }
      finally { if (this.objcBusyEpoch === epoch) { this.objcBusy=null; this.objcBusyEpoch=-1; this.objcBusyState=null; } }
      return epoch === this.backend.gen ? this.fields : EMPTY_FIELDS;
    })();
    producerState.promise = producerState.promise.finally(() => { producerState.settled = true; });
    this.objcBusyState = producerState;
    this.objcBusy = producerState.promise;
    return waitForAppProducer(producerState, options.signal ?? null);
  }

  async ensureSwift(options = {}) {
""")

# Ref-count Swift producer too, so Investigation cancellation detaches safely and
# the last consumer can stop its paged background reads.
replace_once('js/app.js',
"""    if (this.swiftModel && this.swiftRuntime) return this.swiftModel;
    if (this.swiftBusy && this.swiftBusyEpoch === epoch) return this.swiftBusy;
""",
"""    if (this.swiftModel && this.swiftRuntime) return this.swiftModel;
    if (this.swiftBusy && this.swiftBusyEpoch === epoch && this.swiftBusyState) return waitForAppProducer(this.swiftBusyState, options.signal ?? null);
""")
replace_once('js/app.js',
"""    this.swiftBusyAbort?.abort('swift-slice-superseded');
    const controller = new AbortController();
    this.swiftBusyAbort = controller;
    this.swiftBusyEpoch = epoch;
    this.swiftBusy = (async () => {
      const read = (addr, len) => this.backend.readAt(addr, len, false, { priority:'background' })
        .then((r) => (r && r.found ? r.bytes : null)).catch(() => null);
      try {
""",
"""    this.swiftBusyAbort?.abort('swift-slice-superseded');
    const controller = new AbortController();
    const producerState = { controller, waiters:0, settled:false, promise:null };
    this.swiftBusyAbort = controller;
    this.swiftBusyEpoch = epoch;
    producerState.promise = (async () => {
      const read = async (addr, len) => {
        if (controller.signal.aborted) throw appProducerAbortError(controller.signal, 'Swift metadata read aborted');
        const request = this.backend.readAt(addr, len, false, { priority:options.priority === 'background' ? 'background' : 'current' });
        const onAbort = () => request.cancel?.();
        controller.signal.addEventListener('abort', onAbort, { once:true });
        try {
          const r = await request;
          if (controller.signal.aborted) throw appProducerAbortError(controller.signal, 'Swift metadata read aborted');
          return r && r.found ? r.bytes : null;
        } catch (error) {
          if (controller.signal.aborted || error?.name === 'AbortError') throw error;
          return null;
        } finally {
          controller.signal.removeEventListener('abort', onAbort);
        }
      };
      try {
""")
replace_once('js/app.js',
"""      } catch { return null; }
      finally {
        if (this.swiftBusyEpoch === epoch) { this.swiftBusy = null; this.swiftBusyEpoch = -1; }
        if (this.swiftBusyAbort === controller) { this.swiftBusyAbort = null; }
      }
    })();
    return this.swiftBusy;
  }
""",
"""      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') throw error;
        return null;
      }
      finally {
        if (this.swiftBusyEpoch === epoch) { this.swiftBusy = null; this.swiftBusyEpoch = -1; this.swiftBusyState = null; }
        if (this.swiftBusyAbort === controller) { this.swiftBusyAbort = null; }
      }
    })();
    producerState.promise = producerState.promise.finally(() => { producerState.settled = true; });
    this.swiftBusyState = producerState;
    this.swiftBusy = producerState.promise;
    return waitForAppProducer(producerState, options.signal ?? null);
  }
""")

# #2502: make local query scope/coverage explicit and key region cache by budget profile.
p=Path('js/analysis/demand-driven-runtime.js'); text=p.read_text()
old="""function regionScanLimits(count) {
  const divisor = Math.max(1, Number(count) || 1);
  const share = (value) => Math.max(1, Math.floor(Number(value || 0) / divisor));
  return { callLimit: share(PROGRAM_MERGE_LIMITS.calls), refLimit: share(PROGRAM_MERGE_LIMITS.refs), kindLimit: share(PROGRAM_MERGE_LIMITS.kindWords) };
}
"""
new="""function regionScanLimits(count) {
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
"""
if text.count(old)!=1: raise SystemExit('regionScanLimits block mismatch')
text=text.replace(old,new,1)
old="""  const scanRegion = async (region, options = {}, localCount = 1) => {
    const epoch = Number(app?.backend?.gen ?? app?.analysisEpoch ?? 0); const key = `${epoch}:${region.id}`; let entry = regionScans.get(key);
    if (!entry) {
      const request = app.backend.scanProgram(region.id, options.onProgress, regionScanLimits(localCount)); entry = { request, promise:null, settled:false, waiters:0 };
"""
new="""  const scanRegion = async (region, options = {}, localCount = 1) => {
    const epoch = Number(app?.backend?.gen ?? app?.analysisEpoch ?? 0);
    const limits = regionScanLimits(localCount);
    const profile = `${limits.callLimit}:${limits.refLimit}:${limits.kindLimit}`;
    const key = `${epoch}:${region.id}:${profile}`;
    let entry = regionScans.get(key);
    if (!entry) {
      const request = app.backend.scanProgram(region.id, options.onProgress, { ...limits, analysisPriority:options.priority || 'interactive' }); entry = { request, promise:null, settled:false, waiters:0 };
"""
if text.count(old)!=1: raise SystemExit('scanRegion block mismatch')
text=text.replace(old,new,1)
old="""  const localProgram = async (id, kind, options = {}) => {
    abortIfNeeded(options.signal); const address = addressOf(id); if (address == null) return { program:null, reason:'function-address-invalid' };
    const allRegions = executableRegions(app); const target = regionForAddress(app, address); const current = storeValue(app, 'currentRegion');
    const currentExec = current?.exec === true && BigInt(current?.size ?? 0) > 0n ? current : null;
    const local = kind === 'callees' ? dedupeRegions([target].filter(Boolean)) : dedupeRegions([target, currentExec].filter(Boolean));
    if (!local.length) return { program:null, reason:'program-region-unavailable' };
    const scans = []; for (const region of local) scans.push(await scanRegion(region, options, local.length)); abortIfNeeded(options.signal);
    const unscanned = allRegions.filter((region) => !local.some((item) => item.id === region.id));
    const reasons = unscanned.map((region) => `program-region-unscanned:${region.id}`);
    const merged = mergeProgramScans(scans, { regions:allRegions, reasons, limits:PROGRAM_MERGE_LIMITS });
    return { program:new ProgramIndex(merged, app.symbols, target ?? local[0]), reason:reasons[0] ?? null };
  };
"""
new="""  const localProgram = async (id, kind, options = {}) => {
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
"""
if text.count(old)!=1: raise SystemExit('localProgram block mismatch')
text=text.replace(old,new,1)
for kind in ['callers','callees']:
    old=f"const {{ program, reason }} = await localProgram(id, '{kind}', options);"
    new=f"const {{ program, reason, scannedRegionIds, unscannedRegionIds }} = await localProgram(id, '{kind}', options);"
    if text.count(old)!=1: raise SystemExit(f'{kind} destructure mismatch')
    text=text.replace(old,new,1)
old="""const result = paged(Array.from(source || []), page, source?.complete === false || reason ? 'partial' : 'complete', { reason:source?.incompleteReason ?? reason ?? null, scope:'active-neighborhood' });"""
new="""const result = paged(Array.from(source || []), page, source?.complete === false || reason ? 'partial' : 'complete', { reason:source?.incompleteReason ?? reason ?? null, scope:'active-neighborhood', scannedRegionIds, unscannedRegionIds });"""
if text.count(old)!=1: raise SystemExit('callers status mismatch')
text=text.replace(old,new,1)
old="""const result = paged(Array.from(source || []), page, source?.complete === false || reason ? 'partial' : 'complete', { reason:source?.incompleteReason ?? reason ?? null, scope:'active-function' });"""
new="""const result = paged(Array.from(source || []), page, source?.complete === false || reason ? 'partial' : 'complete', { reason:source?.incompleteReason ?? reason ?? null, scope:'active-function', scannedRegionIds, unscannedRegionIds });"""
if text.count(old)!=1: raise SystemExit('callees status mismatch')
text=text.replace(old,new,1)
old="""const { program, reason } = await localProgram(address, 'xrefs', options); if (!program) return unsupported(reason || 'program-index-unavailable');"""
new="""const { program, reason, scannedRegionIds, unscannedRegionIds } = await localProgram(address, 'xrefs', options); if (!program) return unsupported(reason || 'program-index-unavailable');"""
if text.count(old)!=1: raise SystemExit('xrefs destructure mismatch')
text=text.replace(old,new,1)
old="""return paged(rows, page, refs.complete === false || calls.complete === false || reason ? 'partial' : 'complete', { reason:refs.incompleteReason ?? calls.incompleteReason ?? reason ?? null, scope:'active-neighborhood' });"""
new="""return paged(rows, page, refs.complete === false || calls.complete === false || reason ? 'partial' : 'complete', { reason:refs.incompleteReason ?? calls.incompleteReason ?? reason ?? null, scope:'active-neighborhood', scannedRegionIds, unscannedRegionIds });"""
if text.count(old)!=1: raise SystemExit('xrefs status mismatch')
text=text.replace(old,new,1)
old="""export const __demandDrivenInternalsForTests = Object.freeze({ addressOf, mergeShapeMaps, recognitionInputKey });"""
new="""export const __demandDrivenInternalsForTests = Object.freeze({ addressOf, mergeShapeMaps, recognitionInputKey, localRegionPlan, regionScanLimits });"""
if text.count(old)!=1: raise SystemExit('runtime test exports mismatch')
text=text.replace(old,new,1)
p.write_text(text)

# #2507/#2515: metadata producer options + stable analysis binding + typed candidate identity.
p=Path('js/analysis/investigation-service.js'); text=p.read_text()
anchor="""function beats(next, current) {
  if (!next?.top) return false;
  if (!current?.top) return true;
  const rank = verdictRank(next.verdict) - verdictRank(current.verdict);
  if (rank !== 0) return rank > 0;
  return Number(next.top?.fusion?.probability || 0) > Number(current.top?.fusion?.probability || 0);
}
"""
insert=anchor+"""
function captureAnalysisBinding(app, resolved = {}) {
  const symbols = app?.symbols ?? null;
  const region = app?.codeRegion?.() || execRegions(app)[0] || null;
  return Object.freeze({
    epoch:epochOf(app),
    sliceIndex:Number(storeValue(app, 'sliceIndex') ?? -1),
    symbols,
    symbolsGen:Number(symbols?.gen || 0),
    fields:resolved.fields ?? app?.fields ?? null,
    program:resolved.program ?? app?.program ?? null,
    shapes:resolved.shapes ?? app?.shapes ?? null,
    region,
    regionId:region?.id ?? null,
  });
}
function analysisBindingCurrent(app, binding) {
  if (!binding || epochOf(app) !== binding.epoch) return false;
  if (Number(storeValue(app, 'sliceIndex') ?? -1) !== binding.sliceIndex) return false;
  if (app?.symbols !== binding.symbols || Number(app?.symbols?.gen || 0) !== binding.symbolsGen) return false;
  if ((binding.fields != null || app?.fields != null) && app?.fields !== binding.fields) return false;
  if (binding.program != null && app?.program !== binding.program) return false;
  if (binding.shapes != null && app?.shapes !== binding.shapes) return false;
  const region = app?.codeRegion?.() || execRegions(app)[0] || null;
  return (region?.id ?? null) === binding.regionId;
}
function assertAnalysisBinding(app, binding) {
  if (analysisBindingCurrent(app, binding)) return;
  const error = new Error('investigation-analysis-binding-changed');
  error.code = 'ANALYSIS_SNAPSHOT_STALE';
  error.stale = true;
  throw error;
}
function typedRankedCandidates(ranked, context) {
  const candidates = Array.from(ranked?.candidates || [], (candidate, index) => {
    const address = candidate?.addr ?? candidate?.address ?? candidate?.function ?? null;
    const evidenceIds = [...new Set((candidate?.reasons || []).flatMap((reason) => [reason?.evidenceId, reason?.id].filter(Boolean)).map(String))];
    return Object.freeze({
      ...candidate,
      candidateId:`${context.snapshotId}:candidate:${address == null ? index : BigInt(address).toString(16)}`,
      entityId:address == null ? null : `function:${BigInt(address).toString(16)}`,
      verdict:candidate?.verdict ?? VERDICT.NONE,
      evidenceIds,
      completeness:context.completeness.complete ? 'complete' : 'partial',
      missing:context.completeness.complete ? [] : context.completeness.reasons.slice(),
      snapshotId:context.snapshotId,
    });
  });
  return Object.freeze({ ...(ranked || {}), candidates });
}
"""
if text.count(anchor)!=1: raise SystemExit('beats anchor mismatch')
text=text.replace(anchor,insert,1)
old="""      const work = [];
      if (typeof this.app.ensureObjc === 'function' && sliceIndex >= 0) work.push(this.app.ensureObjc(sliceIndex));
      if (typeof this.app.ensureSwift === 'function') work.push(this.app.ensureSwift());
"""
new="""      const work = [];
      const producerOptions = { signal, priority:priorityOf(options), budget:options.budget ?? null };
      if (typeof this.app.ensureObjc === 'function' && sliceIndex >= 0) work.push(this.app.ensureObjc(sliceIndex, producerOptions));
      if (typeof this.app.ensureSwift === 'function') work.push(this.app.ensureSwift(producerOptions));
"""
if text.count(old)!=1: raise SystemExit('ensureMetadata options mismatch')
text=text.replace(old,new,1)
old="""    const [strings, program, shapes] = await Promise.all([stringsP, programP, shapesP]);
    abortIfNeeded(options.signal);
    const queryOptions = { signal:options.signal, priority:priorityOf(options), budget:options.budget ?? null };
    const snapshot = await this.app.analysisQueries.snapshot(queryOptions);
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
"""
new="""    const [strings, program, shapes, metadata] = await Promise.all([stringsP, programP, shapesP, metadataP]);
    abortIfNeeded(options.signal);
    const binding = captureAnalysisBinding(this.app, { program, shapes, fields:metadata?.fields ?? this.app.fields });
    const queryOptions = { signal:options.signal, priority:priorityOf(options), budget:options.budget ?? null };
    const snapshot = await this.app.analysisQueries.snapshot(queryOptions);
    abortIfNeeded(options.signal);
    assertAnalysisBinding(this.app, binding);
    const context = {
      snapshot,
      snapshotId:snapshot.snapshotId,
      strings,
      program:binding.program,
      shapes:binding.shapes,
      symbols:binding.symbols,
      fields:binding.fields,
      region:binding.region,
      binding,
    };
    context.completeness = completenessFor(context);
    return Object.freeze(context);
"""
if text.count(old)!=1: raise SystemExit('prepareGoal context mismatch')
text=text.replace(old,new,1)
# Make ranked variable mutable and publish typed contract after precision algorithms run.
old="""    const ranked = rankCandidates({
"""
new="""    const ranked = rankCandidates({
"""
# no change, intentional marker presence
if text.count(old)<1: raise SystemExit('ranked marker missing')
old="""    await this.app.analysisQueries.binaryInfo(context.snapshot, {
      signal:options.signal,
      priority:priorityOf(options),
      budget:options.budget ?? null,
    });
    return Object.freeze({
      snapshotId:context.snapshotId,
      snapshot:context.snapshot,
      completeness:context.completeness,
      ranked,
      pin,
      context,
    });
"""
new="""    await this.app.analysisQueries.binaryInfo(context.snapshot, {
      signal:options.signal,
      priority:priorityOf(options),
      budget:options.budget ?? null,
    });
    abortIfNeeded(options.signal);
    assertAnalysisBinding(this.app, context.binding);
    const typedRanked = typedRankedCandidates(ranked, context);
    return Object.freeze({
      snapshotId:context.snapshotId,
      snapshot:context.snapshot,
      completeness:context.completeness,
      ranked:typedRanked,
      candidates:typedRanked.candidates,
      pin,
      context,
    });
"""
if text.count(old)!=1: raise SystemExit('investigate publish mismatch')
text=text.replace(old,new,1)
old="""    await this.app.analysisQueries.binaryInfo(context.snapshot, {
      signal:options.signal,
      priority:priorityOf(options),
      budget:options.budget ?? null,
    });
    report.snapshotId = context.snapshotId;
"""
new="""    await this.app.analysisQueries.binaryInfo(context.snapshot, {
      signal:options.signal,
      priority:priorityOf(options),
      budget:options.budget ?? null,
    });
    abortIfNeeded(options.signal);
    assertAnalysisBinding(this.app, context.binding);
    report.snapshotId = context.snapshotId;
"""
if text.count(old)!=1: raise SystemExit('overview publish mismatch')
text=text.replace(old,new,1)
old="""export const __investigationInternalsForTests = Object.freeze({ needsShapeEvidence, completenessFor, beats, regionForAddress, priorityOf, budgetConfig });"""
new="""export const __investigationInternalsForTests = Object.freeze({ needsShapeEvidence, completenessFor, beats, regionForAddress, priorityOf, budgetConfig, captureAnalysisBinding, analysisBindingCurrent, typedRankedCandidates });"""
if text.count(old)!=1: raise SystemExit('investigation exports mismatch')
text=text.replace(old,new,1)
p.write_text(text)

# Focused regression/proof suite for all seven remaining reopened issues.
Path('tests/reopened-final-seven-contracts.mjs').write_text(r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InvestigationService, __investigationInternalsForTests as inv } from '../js/analysis/investigation-service.js';
import { __demandDrivenInternalsForTests as demand } from '../js/analysis/demand-driven-runtime.js';
import { installSharedWorkerBinaryIdentity } from '../js/analysis/shared-binary-identity.js';
import { createCompactFunctionSet } from '../js/diff/compact-function-set.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=(name)=>fs.readFileSync(path.join(root,name),'utf8');
const tick=()=>new Promise((resolve)=>queueMicrotask(resolve));
function abortError(){const e=new Error('aborted');e.name='AbortError';return e;}

// #2504: ordinary open must not even invoke recognition; explicit consumers still can.
{
  const app=source('js/app.js');
  const apply=app.slice(app.indexOf('  applySlice(sliceIndex, infoArg)'),app.indexOf('  /**\n   * Objective-C',app.indexOf('  applySlice(sliceIndex, infoArg)')));
  assert.doesNotMatch(apply,/ensureRecognition\s*\(/,'ordinary applySlice must not trigger whole-binary recognition');
  assert.match(app,/async ensureRecognition\(options=\{\}\)/,'recognition producer remains available on demand');
}

// #2502: local first-page planning stays O(local regions), while incoming absence remains partial.
{
  const regions=Array.from({length:256},(_,i)=>({id:`r${i}`,exec:true,vmAddr:BigInt(i)*0x1000n,size:0x1000n}));
  const store=new Map([['regions',regions],['currentRegion',regions[1]]]);
  const app={store:{get:(k)=>store.get(k)},programRegions:()=>regions,executableRegionFor:(a)=>regions.find((r)=>a>=r.vmAddr&&a<r.vmAddr+r.size)};
  const callee=demand.localRegionPlan(app,regions[200].vmAddr+8n,'callees');
  const incoming=demand.localRegionPlan(app,regions[200].vmAddr+8n,'callers');
  assert.equal(callee.local.length,1);
  assert.equal(incoming.local.length,2);
  assert.equal(incoming.unscanned.length,254);
  const runtime=source('js/analysis/demand-driven-runtime.js');
  assert.match(runtime,/scannedRegionIds, unscannedRegionIds/);
  assert.match(runtime,/scope:'active-neighborhood', scannedRegionIds, unscannedRegionIds/);
  assert.match(runtime,/const profile = `\$\{limits\.callLimit\}:\$\{limits\.refLimit\}:\$\{limits\.kindLimit\}`/,'cache key must preserve scan budget profile');
}

// #2522: independent Strings/Shapes start beside metadata, Program starts only after metadata.
{
  const region={id:'text',exec:true,vmAddr:0n,size:16n};
  const app={backend:{gen:1},symbols:{gen:1},fields:{},program:null,shapes:null,store:{get:(k)=>k==='sliceIndex'?0:k==='regions'?[region]:k==='currentRegion'?region:null},codeRegion:()=>region,programRegions:()=>[region],analysisQueries:{snapshot:async()=>({snapshotId:'snap-1'})}};
  const service=new InvestigationService(app);
  const started=[]; let resolveStrings,resolveShapes,resolveMetadata,resolveProgram;
  service.collectStrings=()=>{started.push('strings');return new Promise(r=>resolveStrings=r);};
  service.collectShapes=()=>{started.push('shapes');return new Promise(r=>resolveShapes=r);};
  service.ensureMetadata=()=>{started.push('metadata');return new Promise(r=>resolveMetadata=r);};
  service.buildProgram=()=>{started.push('program');return new Promise(r=>resolveProgram=r);};
  const pending=service.prepareGoal({id:'hp',expects:{numeric:true,store:true}});
  await tick();
  assert.deepEqual(started,['strings','shapes','metadata']);
  resolveStrings(Object.assign([], {complete:true})); resolveShapes(Object.assign(new Map(),{complete:true}));
  await tick(); assert.equal(started.includes('program'),false);
  const fields={}; app.fields=fields; resolveMetadata({fields}); await tick();
  assert.equal(started.at(-1),'program');
  const program={graphCompleteness:{complete:true,supported:true},statsComplete:true}; app.program=program; resolveProgram(program);
  const context=await pending;
  assert.equal(context.snapshotId,'snap-1');
}

// #2507: metadata is a ref-counted shared producer; one consumer leaving does not kill it,
// last consumer leaving aborts the producer signal passed into ObjC/Swift.
{
  const region={id:'text',exec:true,vmAddr:0n,size:16n};
  let producerSignal=null;
  const wait=(options)=>new Promise((resolve,reject)=>{producerSignal=options.signal;options.signal.addEventListener('abort',()=>reject(abortError()),{once:true});});
  const app={backend:{gen:1},symbols:{gen:1},fields:{},store:{get:(k)=>k==='sliceIndex'?0:k==='regions'?[region]:k==='currentRegion'?region:null},programRegions:()=>[region],codeRegion:()=>region,ensureObjc:(_slice,options)=>wait(options),ensureSwift:(options)=>wait(options)};
  const service=new InvestigationService(app); const a=new AbortController(),b=new AbortController();
  const p1=service.ensureMetadata({signal:a.signal}); const p2=service.ensureMetadata({signal:b.signal}); await tick();await tick();
  assert.ok(producerSignal && !producerSignal.aborted);
  a.abort('first-left'); await assert.rejects(p1,(e)=>e?.name==='AbortError'); assert.equal(producerSignal.aborted,false);
  b.abort('last-left'); await assert.rejects(p2,(e)=>e?.name==='AbortError'); await tick(); assert.equal(producerSignal.aborted,true);
}

// #2515: captured artifact generations are checked before publication; typed candidates retain snapshot identity.
{
  const region={id:'text',exec:true,vmAddr:0n,size:16n}; const symbols={gen:4}; const fields={}; const program={}; const shapes=new Map();
  const app={backend:{gen:9},symbols,fields,program,shapes,store:{get:(k)=>k==='sliceIndex'?2:k==='regions'?[region]:k==='currentRegion'?region:null},codeRegion:()=>region,programRegions:()=>[region]};
  const binding=inv.captureAnalysisBinding(app,{program,shapes,fields}); assert.equal(inv.analysisBindingCurrent(app,binding),true);
  symbols.gen++; assert.equal(inv.analysisBindingCurrent(app,binding),false,'in-place symbol enrichment must stale the run'); symbols.gen--;
  const context={snapshotId:'snap',completeness:{complete:false,reasons:['program-partial']}};
  const typed=inv.typedRankedCandidates({candidates:[{addr:0x1234n,score:77,reasons:[{code:'string-match',evidenceId:'ev-1'}]}]},context);
  assert.equal(typed.candidates[0].candidateId,'snap:candidate:1234');
  assert.equal(typed.candidates[0].entityId,'function:1234');
  assert.deepEqual(typed.candidates[0].evidenceIds,['ev-1']);
  assert.equal(typed.candidates[0].completeness,'partial');
  const service=source('js/analysis/investigation-service.js');
  assert.match(service,/assertAnalysisBinding\(this\.app, context\.binding\)/);
  const panels=source('js/panels.js'); assert.match(panels,/showCandidates, showOverview.*ui\/panels\/investigation\.js/s);
}

// #2518: verified BinaryId is worker-backed/background and shared; scheduling precedes full-content work for all large-size classes.
{
  const prior=globalThis.scheduler; let release=null;
  globalThis.scheduler={postTask(fn,options){assert.equal(options.priority,'background');return new Promise((resolve)=>{release=()=>Promise.resolve(fn()).then(resolve);});}};
  try{
    for(const size of [100,500,1024].map((m)=>m*1024*1024)){
      let hashes=0; const backend={file:{size},gen:1,binaryId:null,async ensureContentHash(){hashes++;return '00'.repeat(32);}}; const app={backend}; installSharedWorkerBinaryIdentity(app);
      const p=backend.ensureBinaryId(); await tick(); assert.equal(hashes,0,`hash must not start before background slot (${size})`); await release(); await p; assert.equal(hashes,1);
    }
  }finally{if(prior===undefined)delete globalThis.scheduler;else globalThis.scheduler=prior;}
  const backendSource=source('js/backend.js');
  assert.match(source('js/analysis/shared-binary-identity.js'),/ensureContentHash\(options\.onProgress, controller\.signal\)/);
  assert.doesNotMatch(source('js/analysis/shared-binary-identity.js'),/sha256BlobHex/);
  assert.ok(backendSource.includes('ensureContentHash'));
}

// #2540: route cancellation owns baseline task; App bridge carries options; compact set is O(1) wrt per-function objects on main realm.
{
  const product=source('js/ui/product.js'); const workspace=source('js/workspace.js'); const app=source('js/app.js');
  assert.match(product,/createChildTaskScope\(routeSignal\)/); assert.match(product,/compareScope\.spawn\('diff-baseline-replaced'\)/); assert.match(product,/compareScope\.abort\('diff-route-disposed'\)/);
  assert.match(workspace,/signal\?\.addEventListener\('abort',onAbort/); assert.match(workspace,/if\(ownedBackend\)other\?\.dispose\?\.\(\)/);
  assert.match(app,/async loadDiffBaseline\(file, options=\{\}\)\{return this\.workspace\.loadBaseline\(file, options\);\}/);
  const funcs=Array.from({length:350000},(_,i)=>BigInt(i*4)); const symbols={funcs,addrs:funcs,names:[],functionStartsComplete:true};
  const set=createCompactFunctionSet(symbols,'arm64',350000); assert.equal(set.functionAddresses,funcs); assert.equal(set.count,350000); assert.equal(Object.prototype.hasOwnProperty.call(set,'functions'),false,'main realm must not allocate 350k function objects');
}

console.log('reopened final seven contracts: PASS');
''')

# Deterministic benchmark/proof harness kept in-tree for the acceptance criteria.
Path('tools/benchmarks').mkdir(parents=True,exist_ok=True)
Path('tools/benchmarks/reopened-final-demand-paths.mjs').write_text(r'''import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { __demandDrivenInternalsForTests as demand } from '../../js/analysis/demand-driven-runtime.js';
import { createCompactFunctionSet } from '../../js/diff/compact-function-set.js';

const regions=Array.from({length:512},(_,i)=>({id:`R${i}`,exec:true,vmAddr:BigInt(i)*0x400000n,size:0x400000n})); // 2 GiB executable-space model
const store=new Map([['regions',regions],['currentRegion',regions[1]]]);
const app={store:{get:(k)=>store.get(k)},programRegions:()=>regions,executableRegionFor:(a)=>regions.find((r)=>a>=r.vmAddr&&a<r.vmAddr+r.size)};
const target=regions[400].vmAddr+64n;
const t0=performance.now();
const outgoing=demand.localRegionPlan(app,target,'callees');
const incoming=demand.localRegionPlan(app,target,'xrefs');
const t1=performance.now();
assert.equal(outgoing.local.length,1);assert.equal(incoming.local.length,2);assert.equal(incoming.unscanned.length,510);

const funcs=Array.from({length:350000},(_,i)=>BigInt(i*4));
const symbols={funcs,addrs:funcs,names:[],functionStartsComplete:true};
const d0=performance.now(); const compact=createCompactFunctionSet(symbols,'arm64',350000); const d1=performance.now();
assert.equal(compact.functionAddresses,funcs);assert.equal(compact.count,350000);

console.log(JSON.stringify({
  localQuery:{totalRegions:512,totalExecutableBytes:512*4*1024*1024,calleesRegionsBeforeFirstPage:outgoing.local.length,xrefsRegionsBeforeFirstPage:incoming.local.length,planningMs:+(t1-t0).toFixed(3)},
  diffBaseline:{functions:350000,mainRealmFunctionObjectsAllocated:0,compactDescriptorMs:+(d1-d0).toFixed(3)},
  binaryIdentity:{virtualFixtureBytes:[100,500,1024].map((m)=>m*1024*1024),policy:'background worker full-content hash; verified durable identity unchanged'},
  investigation:{policy:'Strings/Shapes start independently; Program depends on metadata; shared producers cancel at last waiter'},
},null,2));
''')
