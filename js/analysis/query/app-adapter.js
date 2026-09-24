import { scopedAnalysisHost, scopedImmutableSourceIdentity } from './scoped-host.js';
import { analyzeFunctionCached, supportsArm64SemanticAnalysis } from '../../analyze.js';
import { buildOverlay } from '../../narrate.js';
import { decompile } from '../../decompile.js';
import { irFor } from '../../ir.js';
import { createCxxEvidenceProvider } from '../cxx/project.js';
import { buildCTranslationUnit } from './translation-unit.js';
import { inferTypes } from '../../types.js';
import { resolveABIPlugin } from '../../targets/abi/index.js';
import { riscvAbiFromElfFlags } from '../../targets/abi/riscv-lp64.js';
import { X86_SEMANTIC_FUNCTION_MAX_DECODE_BYTES } from '../../targets/architecture/x86_64/semantic-function-contract.js';
import { ANALYSIS_COMPLETENESS, weakestCompleteness } from '../status.js';

const QUERY_ROUTED_FETCH = Symbol('analysis-query-routed-fetch');
const QUERY_ROUTED_ANALYZE = Symbol('analysis-query-routed-analyze');
const MAX_PAGE = 5_000;
const MAX_FUNCTION_SCAN = 400_000;

const DECOMPILER_QUERY_OPTION_KEYS = Object.freeze([
  'profile',
  'decompilerTimeBudgetMs',
  'phase8TimeBudgetMs',
  'phase8WorkBudget',
  'renderProvenanceBudget',
  'renderProvenanceBindingBudget',
]);

const SLICE_CXX_PROVIDERS = new WeakMap();

function getSliceIdentityKey(app) {
  const sliceIndex = storeValue(app, 'sliceIndex') ?? 0;
  const file = app?.backend?.file ?? storeValue(app, 'file');
  if (file && typeof file === 'object') return file;
  if (app?.symbols && typeof app.symbols === 'object') return app.symbols;
  if (app?.backend && typeof app.backend === 'object') return app.backend;
  if (app && typeof app === 'object') return app;
  return null;
}

function ensureCxxEvidenceProviderForApp(app) {
  const key = getSliceIdentityKey(app);
  if (!key) return null;
  let entry = SLICE_CXX_PROVIDERS.get(key);
  if (!entry) {
    const symbols = app?.symbols ?? null;
    const backend = app?.backend ?? null;
    if (!symbols || !backend) return null;
    const architecture = architectureOf(app) ?? 'arm64';
    const pointerBytes = architecture === 'arm64_32' ? 4 : 8;
    const read = async (addr, len) => {
      try {
        const result = await backend.readAt(addr, len);
        return result?.found ? result.bytes : null;
      } catch {
        return null;
      }
    };
    const provider = createCxxEvidenceProvider({
      symbols,
      read,
      pointerBytes,
      architecture,
      snapshotId: `slice:${String(storeValue(app, 'sliceIndex') ?? 0)}`,
      maxClasses: 2500,
      maxSlots: 128,
      maxReads: 8192,
    });
    // Build index at most once
    const buildPromise = provider.build().catch(() => null);
    entry = { provider, buildPromise };
    SLICE_CXX_PROVIDERS.set(key, entry);
  }
  return entry;
}

export function decompilerOptionsFromQuery(options = {}) {
  if (!options || typeof options !== 'object') return {};
  const forwarded = {};
  for (const key of DECOMPILER_QUERY_OPTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(options, key)) forwarded[key] = options[key];
  }
  return forwarded;
}

function storeValue(app, key) {
  try { return typeof app?.store?.get === 'function' ? app.store.get(key) : (app?.store?.[key] ?? null); }
  catch { return null; }
}

function addressOf(value) {
  // The canonical address query boundary enforces one address-domain
  // invariant regardless of input representation: an address is a
  // non-negative integer. Only the number branch checked the sign before
  // (#5196), so -1n / '-1' / 'function:-1' laundered a negative address
  // into backend calls that the same logical value as a number could not
  // reach.
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string') {
    const text = value.trim().replace(/^(?:fn|function):/i, '');
    if (!text) return null;
    try { const parsed = BigInt(text); return parsed >= 0n ? parsed : null; } catch { return null; }
  }
  if (value && typeof value === 'object') return addressOf(value.address ?? value.startAddress ?? value.startAddr ?? value.start ?? value.functionId ?? value.id);
  return null;
}

const functionId = (value) => value == null ? null : `0x${BigInt(value).toString(16)}`;

function nonNegativeSafeInteger(value, fallback = 0) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

// Snapshot identity generations are authority-bearing: an explicitly present
// invalid value must never collapse into another valid generation (e.g. 0).
// Only a missing value falls back to the default.
function identityGeneration(value, code) {
  if (value == null) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(code);
  return value;
}

function positiveSafeIntegerScalar(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value === 'bigint') return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  return null;
}

function abortError(signal, fallback = 'Analysis query aborted') {
  const reason = signal?.reason;
  let message = fallback;
  if (reason instanceof Error) {
    try { message = reason.message || String(reason) || fallback; } catch { /* use fallback */ }
  } else if (reason != null) {
    try { message = String(reason) || fallback; } catch { /* use fallback */ }
  }
  // Never mutate signal.reason: it can be frozen, shared, or otherwise
  // caller-owned. A fresh normalized error also prevents one consumer's
  // cancellation metadata from leaking into another consumer.
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

async function requestWithSignal(request, signal) {
  if (!request || typeof request.then !== 'function') {
    throwIfAborted(signal);
    return Promise.resolve(request);
  }
  const task = Promise.resolve(request);
  // A producer can abort synchronously while creating its request. Once a
  // cancelable request exists, observe it and cancel it before normalizing the
  // consumer abort; the pre-abort search check still prevents new work.
  if (signal?.aborted) {
    try { request.cancel?.(); } catch { /* best effort */ }
    void task.catch(() => {});
    throw abortError(signal);
  }
  if (!signal?.addEventListener) return task;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      if (settled) return;
      try { request.cancel?.(); } catch { /* best effort */ }
      finish(reject, abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once:true });
    if (signal.aborted) onAbort();
    task.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function pageOf(page = {}) {
  const rawOffset = page.offset ?? page.start ?? 0;
  const rawLimit = page.limit ?? page.size ?? 200;
  return {
    offset:nonNegativeSafeInteger(rawOffset, 0),
    limit:typeof rawLimit === 'number' && Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(MAX_PAGE, rawLimit) : 200,
  };
}

function cumulativePageLimit(offset, limit) {
  return offset > Number.MAX_SAFE_INTEGER - limit ? null : offset + limit;
}

function nextPageOffset(offset, advance) {
  const next = offset + Math.max(1, advance);
  return Number.isSafeInteger(next) && next > offset ? next : null;
}

function unsupportedPage(id, page, reason) {
  const { offset, limit } = pageOf(page);
  return {
    value:[],
    functionId:id,
    page:{ offset, limit, returned:0, total:0, next:null },
    status:{ completeness:'unsupported', reason, paged:true },
  };
}
function unsupported(id, reason) {
  return { value:null, functionId:id, status:{ completeness:'unsupported', reason } };
}

const COMPLETENESS = new Set(ANALYSIS_COMPLETENESS);

function completenessOf(value, fallback = 'complete') {
  const evidence = [];
  const statusCompleteness = value?.status?.completeness;
  const topLevelCompleteness = value?.completeness;
  if (typeof statusCompleteness === 'string') evidence.push(statusCompleteness);
  if (typeof topLevelCompleteness === 'string') evidence.push(topLevelCompleteness);
  if (value?.unsupported === true) evidence.push('unsupported');
  if (value?.truncated === true) evidence.push('truncated');
  if (topLevelCompleteness?.complete === false || value?.complete === false || value?.partial === true) evidence.push('partial');

  const recognized = evidence.filter((item) => COMPLETENESS.has(item));
  const hasInvalidString = evidence.some((item) => typeof item === 'string' && !COMPLETENESS.has(item));
  if (hasInvalidString) recognized.push('partial');
  if (recognized.length === 0) return fallback;
  return weakestCompleteness(recognized);
}

function wrap(value, completeness = null, status = {}) {
  if (value == null) return null;
  return { value, status:{ ...status, completeness:completeness ?? completenessOf(value) } };
}

function paged(values, page, completeness = 'complete', status = {}) {
  const source = Array.from(values || []);
  const { offset, limit } = pageOf(page);
  const items = source.slice(offset, offset + limit);
  return {
    value:items,
    page:{
      offset,
      limit,
      returned:items.length,
      total:completeness === 'complete' ? source.length : null,
      next:offset + items.length < source.length ? offset + items.length : null,
    },
    status:{ ...status, completeness, paged:true },
  };
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function artifactVersions(app) {
  const value = app?.analysisArtifactVersions ?? app?.artifactVersions;
  const versions = isPlainObject(value) ? { ...value } : {};
  // Function topology is an internal semantic identity, not caller data. A
  // downstream topology refinement (B1a) bumps it, so a pre-refinement query or
  // summary snapshot becomes stale without the byte/analysis epoch moving. The
  // reserved value always wins over a caller-provided one.
  const revision = app?.symbols?.functionTopologyRevision;
  if (Number.isSafeInteger(revision) && revision >= 0) {
    versions.functionTopology = { revision };
  }
  return versions;
}

function currentInfo(app) { return storeValue(app, 'fileInfo'); }
function validSliceIndex(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  return -1;
}
function currentSlice(app) {
  const index = validSliceIndex(storeValue(app, 'sliceIndex'));
  return index !== null && index >= 0 ? currentInfo(app)?.slices?.[index] ?? null : null;
}
function architectureOf(app) {
  const value = storeValue(app, 'architecture') ?? storeValue(app, 'capability')?.architecture ?? currentSlice(app)?.capability?.architecture ?? '';
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
function formatOf(app) {
  const value = app?.backend?.formatId ?? currentInfo(app)?.formatId ?? '';
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
function executableRegion(app, address) {
  if (typeof app?.executableRegionFor === 'function') {
    try { return app.executableRegionFor(BigInt(address)); } catch { return null; }
  }
  const a = BigInt(address);
  return (storeValue(app, 'regions') || []).find((region) => {
    try { return region?.exec === true && a >= BigInt(region.vmAddr) && a < BigInt(region.vmAddr) + BigInt(region.size); }
    catch { return false; }
  }) ?? null;
}

function rangeFor(app, id) {
  const address = addressOf(id);
  if (address == null) return { ok:false, reason:'function-address-invalid' };
  if (typeof app?.validatedFunctionRange === 'function') {
    try {
      const live = app.validatedFunctionRange(address);
      if (live?.ok) {
        const fn = live.function ?? app?.symbols?.functionAt?.(address) ?? null;
        return fn?.end == null && live.complete !== false
          ? { ...live, complete:false, reason:live.reason || 'function-end-unproven' }
          : live;
      }
      if (live) return live;
    } catch { /* derive below */ }
  }
  const fn = app?.symbols?.functionAt?.(address);
  if (!fn) return { ok:false, reason:'function-symbol-missing' };
  const region = executableRegion(app, fn.start);
  if (!region) return { ok:false, reason:'function-start-not-executable', function:fn };
  if (fn.end == null) {
    const loaderWindow = app?.symbols?.functionAnalysisWindow?.(fn.start) ?? null;
    const windowEnd = loaderWindow?.end ?? null;
    const regionEnd = BigInt(region.vmAddr) + BigInt(region.size);
    if (windowEnd == null || windowEnd <= fn.start || windowEnd > regionEnd) {
      return { ok:false, reason:'function-end-unproven', function:fn, region };
    }
    return {
      ok:true, start:BigInt(fn.start), end:BigInt(windowEnd), region, function:fn,
      complete:false, reason:'function-end-unproven',
      provenance:'elf-loader-contract+section-analysis-window',
      analysisWindow:loaderWindow,
    };
  }
  const regionEnd = BigInt(region.vmAddr) + BigInt(region.size);
  let end = BigInt(fn.end);
  if (end <= fn.start) return { ok:false, reason:'invalid-function-range', function:fn, region };
  const crossed = end > regionEnd;
  if (crossed) end = regionEnd;
  return {
    ok:true, start:BigInt(fn.start), end, region, function:fn,
    complete:!crossed,
    reason:crossed ? 'symbol-range-crosses-executable-region' : null,
    provenance:'executable-region+proven-function-extent',
  };
}

function semanticIR(value) { return value?.pipeline?.semanticIr ?? value?.semanticAnalysis?.pipeline?.semanticIr ?? value?.semanticIR ?? null; }
function semanticCFG(value) { return value?.pipeline?.cfg ?? value?.semanticAnalysis?.pipeline?.cfg ?? value?.cfg ?? null; }

function normalizePlatform(value) {
  if (typeof value !== 'string') return null;
  const p = value.trim().toLowerCase();
  if (!p) return null;
  if (p.includes('windows') || p === 'win32') return 'windows';
  if (p.includes('linux')) return 'linux';
  if (p.includes('freebsd')) return 'freebsd';
  if (p.includes('netbsd')) return 'netbsd';
  if (p.includes('openbsd')) return 'openbsd';
  if (p.includes('solaris')) return 'solaris';
  if (p.includes('system v') || p === 'sysv' || p.includes('unix')) return 'unix';
  return p;
}

const EMPTY_DESCRIPTOR_METADATA = Object.freeze({});
function descriptorMetadata(app) {
  const slice = currentSlice(app);
  const descriptor = slice?.info?.descriptor ?? slice?.descriptor ?? currentInfo(app)?.productDescriptor ?? app?.backend?.platformInfo?.productDescriptor;
  return descriptor?.formatMetadata ?? EMPTY_DESCRIPTOR_METADATA;
}

// The legacy ARM64 model keeps this callback for presentation consumers, but
// callbacks are not query values: AnalysisQueryAPI must be able to detach and
// freeze every published result. The lookup is reconstructed only on the
// app-owned presentation sidecar below, never published through the query API.
function cloneableLegacyModel(model) {
  if (!model || typeof model !== 'object' || typeof model.blockOfRow !== 'function') return model;
  const { blockOfRow: _blockOfRow, ...data } = model;
  return data;
}

// ── Public decompile DTO ────────────────────────────────────────────────────
// The decompile query publishes an explicit *presentation* schema. The
// decompiler's internal analysis state is deliberately not part of that
// contract:
//   * it is producer-owned state — compatibility models and analysis contexts
//     can carry live row/address/symbol callbacks — so publishing it hands
//     consumers a handle on live analysis state, and
//   * it is deeply recursive and unbounded, so publishing it made the query
//     envelope's structuredClone()/deepFreezeTree() overflow the stack on large
//     functions even when the decompilation itself succeeded.
// Rendered navigation only needs `lines` + `renderProvenance`, which are
// published here, and the control-flow graph is served by `cfg()`. The
// dedicated `semanticIR()` query serves the canonical Semantic IR v2
// (`pipeline.semanticIr`), which carries no runtime observer and therefore
// crosses the clone boundary. The ARM64 legacy compatibility IR is also
// clone-safe after the IR-ownership repair, but that route still does not
// publish it through `semanticIR()`; decompile keeps every internal IR private.
export const DECOMPILE_DTO_SCHEMA = 'analysis-query-decompile-presentation-v1';

// The published schema and the never-published producer state are exported as
// frozen *arrays*: frozen documentation a consumer can read, never a mutable
// runtime authority. `Object.freeze(new Set(...))` would still allow `.add()` /
// `.delete()`, so a consumer could silently reclassify an internal field as
// publishable. Lookup below uses module-private Sets derived from these arrays
// at module evaluation time, so no consumer can change what `publish()` does.
export const DECOMPILE_PUBLIC_FIELDS = Object.freeze([
  'semantic', 'signature', 'summary', 'pseudocode', 'text', 'code',
  'lines', 'evidence', 'warnings', 'labels', 'coverage',
  'renderProvenance', 'unknownInstructions',
]);

// Producer-owned analysis state that is never published. A field is listed here
// because the field itself is internal by contract; its contents are not
// inspected, which is why producer-owned observers such as `ctx.rowOfAddress`
// do not fail the query. A field in neither list is unknown to the schema: it is never
// published, it fails closed when it carries an unclonable value, and it is
// reported as an explicit projection loss otherwise (never a silent drop).
export const DECOMPILE_INTERNAL_FIELDS = Object.freeze([
  'ir', 'ctx', 'types', 'highVariables', 'cAst', 'semanticAst', 'semanticFacts',
  'sourceMap', 'prototype', 'aggregateLayouts', 'rewriteProof', 'rewriteStats',
  'passMetrics', 'phase8', 'phase8Projection', 'metrics', 'importantInputs',
  'importantOutputs', 'sideEffects', 'conditions', 'expressionHistoryBinding',
  'semanticSuppressionHistory', 'semanticControlRenderHistory',
  'semanticStatementRenderHistory',
  'semanticStoreRenderHistory', 'switchRenderHistory', 'legacyFallback',
]);

const DECOMPILE_PUBLIC_FIELD_SET = new Set(DECOMPILE_PUBLIC_FIELDS);
const DECOMPILE_INTERNAL_FIELD_SET = new Set(DECOMPILE_INTERNAL_FIELDS);

// structuredClone() overflows the stack at a nesting depth far below what the
// internal analysis graph reaches. Published presentation data is shallow by
// construction (measured <= 8 for rendered lines and the origin ledger), so a
// field deeper than this is withheld with an explicit availability marker
// instead of overflowing the query envelope.
const DECOMPILE_MAX_PUBLISHED_DEPTH = 64;

// Iterative on purpose: the value being inspected can itself be deep, and a
// recursive walk would reintroduce the stack overflow this boundary exists to
// prevent. SharedArrayBuffer is unclonable and therefore reported as such.
function containsUnclonableValue(root) {
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (typeof node === 'function' || typeof node === 'symbol') return true;
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (typeof SharedArrayBuffer !== 'undefined' && node instanceof SharedArrayBuffer) return true;
    if (node instanceof ArrayBuffer || ArrayBuffer.isView(node) || node instanceof Date) continue;
    if (node instanceof Map) { for (const [key, value] of node) stack.push(key, value); continue; }
    if (node instanceof Set) { for (const value of node) stack.push(value); continue; }
    for (const key of Object.keys(node)) stack.push(node[key]);
  }
  return false;
}

function exceedsPublishedDepthBudget(root) {
  const stack = [[root, 1]];
  const seen = new Set();
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (depth > DECOMPILE_MAX_PUBLISHED_DEPTH) return true;
    if (node instanceof ArrayBuffer || ArrayBuffer.isView(node) || node instanceof Date) continue;
    if (node instanceof Map) { for (const [key, value] of node) stack.push([key, depth + 1], [value, depth + 1]); continue; }
    if (node instanceof Set) { for (const value of node) stack.push([value, depth + 1]); continue; }
    for (const key of Object.keys(node)) stack.push([node[key], depth + 1]);
  }
  return false;
}

// Projects a producer decompiler result onto the explicit public schema.
// Returns the published value plus the fields the projection had to give up:
//   * `withheld`   — public fields too deep to cross the clone boundary,
//   * `unexpected` — fields the schema does not know at all (producer drift).
// Neither list is ever a silent drop: both are reported on `status.projection`
// with a non-`complete` completeness, and neither is published.
function publicDecompilerProjection(value) {
  if (value == null || typeof value !== 'object') return { value, withheld:[], unexpected:[] };

  // Unknown fields are outside the schema. Dropping an unclonable value there
  // would silently turn a producer error into an apparently complete result, so
  // those keep failing closed; the declared internal fields are the only place
  // a live observer is allowed to live. A cloneable unknown field is not
  // published either — it is reported as schema drift, so a producer that adds
  // a new field cannot look like a complete result under the old schema.
  let keys;
  try {
    keys = Object.keys(value);
  } catch { throw new TypeError('analysis-query-value-unclonable'); }
  const unexpected = [];
  for (const key of keys) {
    if (DECOMPILE_PUBLIC_FIELD_SET.has(key) || DECOMPILE_INTERNAL_FIELD_SET.has(key)) continue;
    let unclonable;
    try { unclonable = containsUnclonableValue(value[key]); }
    catch { unclonable = true; }
    if (unclonable) throw new TypeError('analysis-query-value-unclonable');
    unexpected.push(key);
  }
  unexpected.sort();

  const projection = {};
  const withheld = [];
  for (const key of DECOMPILE_PUBLIC_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const field = value[key];
    if (field === undefined) continue;
    let bounded = false;
    try { bounded = exceedsPublishedDepthBudget(field); }
    catch { bounded = true; }
    if (bounded) withheld.push(key);
    else projection[key] = field;
  }
  // The only ctx-derived public scalar: the count of instructions the semantic
  // pipeline could not model. It is a number, so it crosses the boundary safely.
  if (projection.unknownInstructions === undefined) {
    const unknownInstructions = value.ctx?.unknownInstructions;
    if (typeof unknownInstructions === 'number' && Number.isSafeInteger(unknownInstructions) && unknownInstructions >= 0) {
      projection.unknownInstructions = unknownInstructions;
    }
  }
  return { value:projection, withheld, unexpected };
}

function legacyPresentationModel(model) {
  if (!model || typeof model !== 'object' || typeof model.blockOfRow === 'function') return model;
  if (!Array.isArray(model.semantic)) return model;
  const presentation = {
    ...model,
    blockOfRow: (row) => model.semantic.find((block) => row >= block.startRow && row <= block.endRow) || null,
  };
  return Object.freeze(presentation);
}

function presentationMatchesSelection(app, start) {
  if (typeof app?.symbols?.functionAt !== 'function') return true;
  const row = storeValue(app, 'selectedRow');
  if (typeof row !== 'number' || !Number.isSafeInteger(row) || row < 0) return true;
  if (typeof app?.viewer?.rowAddress !== 'function') return true;
  let selected;
  try { selected = BigInt(app.viewer.rowAddress(row)); } catch { return true; }
  let selectedFunction;
  let targetFunction;
  try {
    selectedFunction = app.symbols.functionAt(selected);
    targetFunction = app.symbols.functionAt(BigInt(start));
  } catch { return true; }
  if (selectedFunction?.start == null || targetFunction?.start == null) return true;
  try { return BigInt(selectedFunction.start) === BigInt(targetFunction.start); } catch { return true; }
}

function applyLegacyPresentation(app, value) {
  if (!value?.model) return;
  const start = value.startAddr ?? value.startAddress ?? value.model?.startAddress;
  if (start == null) return;
  const region = executableRegion(app, start);
  if (!region) return;
  if (!presentationMatchesSelection(app, start)) return;
  const model = legacyPresentationModel(value.model);
  app.semantic = { regionId:region.id, model, result:value };
  if (storeValue(app, 'currentRegion') === region) {
    try { app.viewer?.setBlockOverlay?.(region.id, buildOverlay(model)); } catch { /* presentation only */ }
  }
}

function installRoutes(app, directFetch) {
  if (!app) return;
  if (typeof directFetch === 'function' && !app._fetchFunctionModel?.[QUERY_ROUTED_FETCH]) {
    const routedFunctionModel = async function routedFunctionModel(id, options = {}) {
      if (!app.analysisQueries) return directFetch(addressOf(id) ?? id, options);
      const snapshot = await app.analysisQueries.snapshot(options);
      const result = await app.analysisQueries.function(snapshot, id, options);
      if (result.completeness === 'unsupported' || result.value == null) {
        const error = new Error('analysis-query-function-unavailable');
        error.code = 'ANALYSIS_QUERY_FUNCTION_UNAVAILABLE';
        throw error;
      }
      return result.value;
    };
    Object.defineProperty(routedFunctionModel, QUERY_ROUTED_FETCH, { value:directFetch });
    app._fetchFunctionModel = routedFunctionModel;
  }
  const original = app.analyzeFunctionAt;
  if (typeof original === 'function' && !original?.[QUERY_ROUTED_ANALYZE]) {
    const routedAnalyzeFunctionAt = async function routedAnalyzeFunctionAt(id, options = {}) {
      if (!app.analysisQueries) return original.call(app, id, options);
      const snapshot = await app.analysisQueries.snapshot(options);
      const result = await app.analysisQueries.function(snapshot, id, options);
      if (result.completeness === 'unsupported' || result.value == null) return null;
      applyLegacyPresentation(app, result.value);
      return result.value;
    };
    Object.defineProperty(routedAnalyzeFunctionAt, QUERY_ROUTED_ANALYZE, { value:original.bind(app) });
    app.analyzeFunctionAt = routedAnalyzeFunctionAt;
  }
}

export function createAppAnalysisQueryAdapter(app) {
  const existingFetch = typeof app?._fetchFunctionModel === 'function' ? app._fetchFunctionModel : null;
  const directFetch = existingFetch?.[QUERY_ROUTED_FETCH] ?? (existingFetch ? existingFetch.bind(app) : null);
  let metadataEpoch = null;
  let metadataTask = null;

  const metadataSummary = () => {
    const epoch = identityGeneration(
      app?.backend?.gen ?? app?.analysisEpoch ?? 0,
      'analysis-query-epoch-invalid',
    );
    if (metadataEpoch === epoch && metadataTask) return metadataTask;
    metadataEpoch = epoch;
    metadataTask = typeof app?.backend?.binaryMetadata === 'function'
      ? Promise.resolve(app.backend.binaryMetadata('summary')).catch(() => null)
      : Promise.resolve(null);
    return metadataTask;
  };

  const abiFor = async (architecture) => {
    const descriptor = descriptorMetadata(app);
    const metadata = await metadataSummary();
    const rawExplicit = descriptor.abi ?? metadata?.summary?.abi ?? metadata?.metadata?.abi ?? null;
    const explicit = typeof rawExplicit === 'string' && rawExplicit.trim() ? rawExplicit.trim() : null;
    const rawBits = descriptor.bits ?? metadata?.summary?.bits;
    const bits = rawBits == null ? 64 : (typeof rawBits === 'number' && Number.isSafeInteger(rawBits) && rawBits > 0 ? rawBits : null);
    let platform = normalizePlatform(descriptor.platform ?? metadata?.summary?.platform);
    if (architecture === 'riscv64') {
      if (rawExplicit != null && !explicit) return { supported:false, reason:'riscv-explicit-abi-invalid' };
      if (explicit) {
        const plugin = resolveABIPlugin({ architecture, platform:platform ?? 'unix', abiId:explicit });
        return plugin?.supported ? { supported:true, abiId:plugin.id, platform:platform ?? 'unix', evidence:'explicit' } : { supported:false, reason:'riscv-explicit-abi-unsupported' };
      }
      if (bits == null) return { supported:false, reason:'riscv-bits-invalid' };
      const flags = metadata?.metadata?.flags;
      if (flags == null) return { supported:false, reason:'riscv-elf-flags-unavailable' };
      const selected = riscvAbiFromElfFlags(flags, { bits });
      return selected?.supported && selected.abiId
        ? { supported:true, abiId:selected.abiId, platform:platform ?? 'unix', evidence:'elf-e-flags' }
        : { supported:false, reason:selected?.reason || 'riscv-abi-unproven' };
    }
    if (architecture === 'x86_64') {
      if (rawExplicit != null && !explicit) return { supported:false, reason:'x86-64-explicit-abi-invalid' };
      platform ??= formatOf(app) === 'pe' ? 'windows' : formatOf(app) === 'elf' ? 'unix' : null;
      const plugin = resolveABIPlugin({ architecture, platform, ...(explicit ? { abiId:explicit } : {}) });
      return plugin?.supported ? { supported:true, abiId:plugin.id, platform:platform ?? 'unknown', evidence:explicit ? 'explicit' : 'format-platform' } : { supported:false, reason:'x86-64-abi-unproven' };
    }
    return { supported:false, reason:`semantic-function-unsupported-architecture:${architecture || 'unknown'}` };
  };

  const produceFunction = async (id, options = {}) => {
    const range = rangeFor(app, id);
    if (!range.ok) return unsupported(id, range.reason || 'function-range-unavailable');
    const architecture = architectureOf(app);
    const symbols = app?.symbols;
    const name = symbols?.nameAt?.(range.start) ?? symbols?.label?.(range.start) ?? null;

    if (supportsArm64SemanticAnalysis(architecture)) {
      if (!app?.backend || !range.region || !storeValue(app, 'canDisassemble') || !symbols?.functionCount) return unsupported(id, 'arm64-function-producer-unavailable');
      const alignment = Number(storeValue(app, 'instructionAlignment') ?? storeValue(app, 'capability')?.instructionAlignment ?? 4);
      if (alignment !== 4) return unsupported(id, 'arm64-legacy-producer-requires-4-byte-instructions');
      // BigInt division floors, so an unaligned function start would silently
      // analyze the preceding instruction row and publish it as the canonical
      // result for the unaligned address. Match `App.analyzeFunctionAt()` and
      // fail closed instead (#4969).
      const delta = range.start - BigInt(range.region.vmAddr);
      if (delta < 0n || delta % 4n !== 0n) return unsupported(id, 'arm64-function-start-unaligned');
      // Legacy row indices are JavaScript numbers end to end. A row index
      // beyond MAX_SAFE_INTEGER silently rounds to a neighboring instruction
      // row, so the producer would analyze and publish a different function
      // than the one requested (#5062); such ranges must fail closed.
      const rowOffset = delta / 4n;
      const endRowExact = (range.end - BigInt(range.region.vmAddr) + 3n) / 4n - 1n;
      const maxRowExact = BigInt(range.region.size) / 4n - 1n;
      const MAX_ROW = BigInt(Number.MAX_SAFE_INTEGER);
      if (rowOffset > MAX_ROW || endRowExact > MAX_ROW || maxRowExact > MAX_ROW) {
        return unsupported(id, 'function-row-index-unrepresentable');
      }
      const startRow = Number(rowOffset);
      const maxRow = Math.max(0, Number(maxRowExact));
      const endRow = Math.min(Number(endRowExact), maxRow);
      if (startRow < 0 || endRow < startRow) return unsupported(id, 'function-range-empty');
      const value = await analyzeFunctionCached(app.backend, range.region, startRow, endRow, symbols, options.onProgress, { ...options, architecture });
      const completeness = value?.truncated ? 'truncated' : range.complete === false ? 'partial' : 'complete';
      const queryValue = value?.model ? { ...value, model:cloneableLegacyModel(value.model) } : value;
      const enriched = {
        ...queryValue, functionId:functionId(range.start), architectureId:architecture,
        startAddress:range.start, endAddress:range.end, name,
        completeness:{ complete:completeness === 'complete', reason:value?.truncated ? 'analysis-budget' : range.reason || null, provenance:range.provenance, regionId:range.region.id },
      };
      return wrap(enriched, completeness, { reason:enriched.completeness.reason, architecture, producer:'legacy-arm64-compatibility' });
    }

    if (!['x86_64', 'riscv64'].includes(architecture) || typeof app?.backend?.analyzeSemanticFunction !== 'function') {
      return unsupported(id, `function-analysis-unsupported-architecture:${architecture || 'unknown'}`);
    }
    const span = range.end - range.start;
    if (span <= 0n) return unsupported(id, 'function-range-empty');
    const budgeted = span > BigInt(X86_SEMANTIC_FUNCTION_MAX_DECODE_BYTES);
    const length = Number(budgeted ? BigInt(X86_SEMANTIC_FUNCTION_MAX_DECODE_BYTES) : span);
    const abi = await abiFor(architecture);
    if (!abi.supported) return unsupported(id, abi.reason);
    const rawSliceIndex = storeValue(app, 'sliceIndex');
    const validatedSlice = validSliceIndex(rawSliceIndex);
    if (rawSliceIndex != null && (validatedSlice === null || validatedSlice < 0)) {
      return unsupported(id, 'invalid-slice-index');
    }
    const sliceIndex = validatedSlice !== null && validatedSlice >= 0 ? validatedSlice : 0;
    const requestedCompleteness = budgeted || range.complete === false ? 'partial' : 'complete';
    const canonical = await app.backend.analyzeSemanticFunction({
      address:range.start, length, architecture, abiId:abi.abiId, platform:abi.platform, sliceIndex,
      name:name ?? undefined, completeness:requestedCompleteness, signal:options.signal ?? null,
      onIdentityProgress:options.onIdentityProgress ?? options.onProgress,
    });
    const completeness = budgeted ? 'truncated' : range.complete === false ? 'partial' : completenessOf(canonical);
    return wrap({
      ...canonical, functionId:functionId(range.start), startAddress:range.start,
      endAddress:range.start + BigInt(length), requestedEndAddress:range.end, name,
      truncated:budgeted, complete:completeness === 'complete',
    }, completeness, {
      reason:budgeted ? 'semantic-function-decode-budget' : range.reason || null,
      architecture, abiId:abi.abiId, abiEvidence:abi.evidence, producer:'canonical-semantic-function',
    });
  };

  const loadFunction = async (id, options = {}) => {
    if (typeof app?.analyzeFunction === 'function') {
      const value = await app.analyzeFunction(id, options);
      if (value != null) return wrap(value);
    }
    if (directFetch) {
      const value = await directFetch(addressOf(id) ?? id, options);
      if (value != null) return wrap(value);
    }
    return produceFunction(id, options);
  };

  const adapter = {
    async currentIdentity(options = {}) {
      if (options.signal?.aborted) {
        const error = options.signal.reason instanceof Error ? options.signal.reason : new Error('AbortError');
        error.name = 'AbortError';
        throw error;
      }
      const fileInfo = currentInfo(app);
      const project = storeValue(app, 'project') ?? app?.workspace?.project ?? app?.project ?? null;
      let binaryId = app?.backend?.binaryId ?? fileInfo?.binaryId ?? fileInfo?.sha256 ?? fileInfo?.hash ?? project?.binaryHash ?? project?.binary?.hash ?? null;
      if (options.scopedSourceIdentity === true) {
        // Scoped queries never force a full-file hash and do not treat a
        // display/project hash as proof of the current source's contents.
        const local = scopedImmutableSourceIdentity(app, app?.backend?.file ?? storeValue(app, 'file'));
        if (!local) {
          const error = new Error('scoped-analysis-disabled-or-source-unavailable');
          error.code = 'ANALYSIS_QUERY_SCOPED_SOURCE_UNAVAILABLE';
          throw error;
        }
        const verified = app?.backend?.binaryId;
        binaryId = typeof verified === 'string' && /^bin_sha256_[0-9a-f]{64}$/.test(verified) ? verified : local;
      }
      if (!binaryId && typeof app?.backend?.ensureBinaryId === 'function') {
        try { binaryId = await app.backend.ensureBinaryId({ signal:options.signal ?? null, onProgress:options.onIdentityProgress ?? options.onProgress }); }
        catch (error) { if (options.signal?.aborted || error?.name === 'AbortError' || error?.stale) throw error; }
      }
      if (!binaryId && typeof app?.ensureAnalysisIdentity === 'function') {
        try { binaryId = await app.ensureAnalysisIdentity(); } catch { /* fail below */ }
      }
      if (typeof binaryId !== 'string' || binaryId.trim() === '') {
        const error = new Error('analysis-query-binary-unbound');
        error.code = 'ANALYSIS_QUERY_BINARY_UNBOUND';
        throw error;
      }
      const projectRevision = project?.revision ?? app?.projectRevision ?? app?.workspace?.bindingRevision ?? 0;
      const analysisEpoch = app?.backend?.gen ?? app?.analysisEpoch ?? 0;
      return { binaryId:binaryId.trim(), projectRevision:identityGeneration(projectRevision, 'analysis-query-project-revision-invalid'), artifactVersions:artifactVersions(app), analysisEpoch:identityGeneration(analysisEpoch, 'analysis-query-epoch-invalid') };
    },

    async binaryInfo(snapshot) {
      const info = currentInfo(app);
      const slice = currentSlice(app);
      const value = {
        binaryId:snapshot.binaryId, name:info?.name ?? storeValue(app, 'file')?.name ?? null,
        size:info?.size ?? storeValue(app, 'file')?.size ?? null,
        formatId:formatOf(app) || (info?.format ?? null), architecture:architectureOf(app) || null,
        sliceIndex:(() => {
          const validatedSlice = validSliceIndex(storeValue(app, 'sliceIndex'));
          return validatedSlice !== null && validatedSlice >= 0 ? validatedSlice : -1;
        })(),
        capability:storeValue(app, 'capability') ?? slice?.capability ?? info?.capability ?? null,
        regions:(storeValue(app, 'regions') || []).map((r) => ({ id:r.id, name:r.name ?? null, section:r.section ?? null, vmAddr:r.vmAddr, size:r.size, exec:r.exec === true, read:r.read === true, write:r.write === true })),
      };
      return wrap(value, info ? 'complete' : 'partial', { reason:info ? null : 'file-info-unavailable' });
    },

    async functions(_snapshot, query = {}, page = {}, options = {}) {
      const symbols = app?.symbols;
      if (!symbols?.funcs) return unsupported(null, 'function-index-unavailable');
      const rawNeedle = query.text ?? query.name ?? '';
      if (typeof rawNeedle !== 'string') return unsupported(null, 'function-query-text-invalid');
      const needle = rawNeedle.trim().toLowerCase();
      const hasAddress = Object.prototype.hasOwnProperty.call(query, 'address') && query.address != null;
      const exactAddress = addressOf(query.address);
      if (hasAddress && (exactAddress == null || exactAddress < 0n)) {
        return unsupported(null, 'function-query-address-invalid');
      }
      const { offset, limit } = pageOf(page);
      const count = Math.min(symbols.funcs.length, MAX_FUNCTION_SCAN);
      const indexComplete = symbols.functionStartsComplete === true && count === symbols.funcs.length;
      const abortIfNeeded = () => {
        if (options.signal?.aborted) throw options.signal.reason ?? Object.assign(new Error('AbortError'), { name:'AbortError' });
      };
      const rowAt = (address, name = symbols.nameAt?.(address) ?? null) => {
        const fn = symbols.functionAt?.(address);
        return { id:functionId(address), address, name, end:fn?.end ?? null, size:fn?.end != null ? fn.end - address : null, evidence:symbols.functionEvidence?.(address) ?? null };
      };

      if (exactAddress == null && !needle) {
        const start = Math.min(offset, count);
        const end = Math.min(count, start + limit);
        const rows = [];
        for (let i = start; i < end; i++) {
          abortIfNeeded();
          const address = BigInt(symbols.funcs[i]);
          rows.push(rowAt(address));
        }
        return {
          value:rows,
          page:{ offset, limit, returned:rows.length, total:indexComplete ? count : null, next:end < count ? end : null },
          status:{ completeness:indexComplete ? 'complete' : 'partial', paged:true, reason:indexComplete ? null : count < symbols.funcs.length ? 'function-scan-budget' : 'function-discovery-incomplete' },
        };
      }

      const rows = [];
      let matched = 0;
      let hasMore = false;
      let exhausted = true;
      for (let i = 0; i < count; i++) {
        abortIfNeeded();
        const address = BigInt(symbols.funcs[i]);
        const name = symbols.nameAt?.(address) ?? null;
        if (exactAddress != null && address !== exactAddress) continue;
        if (needle && !String(name ?? '').toLowerCase().includes(needle) && !address.toString(16).includes(needle.replace(/^0x/, ''))) continue;
        if (matched++ < offset) continue;
        if (rows.length >= limit) {
          hasMore = true;
          exhausted = false;
          break;
        }
        rows.push(rowAt(address, name));
        if (exactAddress != null) break;
      }
      const scanComplete = exhausted && count === symbols.funcs.length;
      const complete = indexComplete && scanComplete;
      return {
        value:rows,
        page:{ offset, limit, returned:rows.length, total:complete ? matched : null, next:hasMore ? offset + rows.length : null },
        status:{ completeness:complete ? 'complete' : 'partial', paged:true, reason:complete ? null : count < symbols.funcs.length ? 'function-scan-budget' : !scanComplete ? 'function-filter-page-bounded' : 'function-discovery-incomplete' },
      };
    },

    async functionById(_snapshot, id, options = {}) { return loadFunction(id, options); },

    async instructions(_snapshot, range, page = {}, options = {}) {
      const request = range && typeof range === 'object' ? range : { functionId:range };
      let start = addressOf(request.start ?? request.address);
      let end = addressOf(request.end);
      // A functionId projection must inherit the function-range completeness:
      // `ok:true` means a safe bounded window exists, not that the whole
      // function body was proven (#5996). An explicit caller-supplied
      // {start,end} range keeps the read-completeness contract of that range.
      let rangeComplete = true;
      let rangeReason = null;
      if (start == null && request.functionId != null) {
        const fnRange = rangeFor(app, request.functionId);
        if (!fnRange.ok) return unsupported(request.functionId, fnRange.reason);
        start = fnRange.start;
        end = fnRange.end;
        rangeComplete = fnRange.complete !== false;
        rangeReason = fnRange.reason ?? null;
      }
      if (start == null) return unsupported(null, 'instruction-range-start-required');
      const rawLength = request.length ?? (end == null ? 4096 : end - start);
      let length = positiveSafeIntegerScalar(rawLength);
      if (length == null) return unsupported(null, 'instruction-range-invalid');
      const truncated = length > 1024 * 1024;
      length = Math.min(length, 1024 * 1024);
      if (typeof app?.backend?.disassembleAt === 'function') {
        const decoded = await app.backend.disassembleAt(start, { architecture:architectureOf(app), length, signal:options.signal ?? null });
        if (decoded?.supported && decoded?.found) {
          const rows = (decoded.instructions || []).map((insn, i) => ({ id:insn.instructionId ?? `${functionId(insn.address ?? start)}:${i}`, address:insn.address == null ? null : BigInt(insn.address), size:Number(insn.length ?? insn.size ?? 0), mnemonic:String(insn.mnemonic ?? insn.instructionFamily ?? ''), operands:String(insn.opStr ?? insn.operands ?? ''), raw:insn }));
          const shortRead = decoded.readComplete === false;
          const completeness = truncated ? 'truncated' : shortRead ? 'truncated' : !rangeComplete ? 'partial' : 'complete';
          return paged(
            rows,
            page,
            completeness,
            { reason:truncated ? 'instruction-read-budget' : shortRead ? 'instruction-read-short' : rangeReason },
          );
        }
      }
      const result = await loadFunction(request.functionId ?? start, options);
      const rows = result?.value?.model?.instructions;
      return rows ? paged(rows, page, result.status?.completeness ?? completenessOf(result.value)) : unsupported(request.functionId ?? start, 'instruction-producer-unavailable');
    },

    async semanticIR(_snapshot, id, options = {}) {
      if (typeof app?.getSemanticIR === 'function') {
        const value = await app.getSemanticIR(id, options);
        if (value != null) return wrap(value);
      }
      const result = await loadFunction(id, options);
      const value = semanticIR(result?.value);
      return value == null ? unsupported(id, result?.value ? 'semantic-ir-v2-unavailable' : 'function-producer-unavailable') : wrap(value, result.status?.completeness);
    },

    async cfg(_snapshot, id, options = {}) {
      if (typeof app?.getCFG === 'function') {
        const value = await app.getCFG(id, options);
        if (value != null) return wrap(value);
      }
      const result = await loadFunction(id, options);
      const value = semanticCFG(result?.value);
      return value == null ? unsupported(id, result?.value ? 'cfg-unavailable' : 'function-producer-unavailable') : wrap(value, result.status?.completeness);
    },

    async callers(_snapshot, id, page = {}, options = {}) {
      const address = addressOf(id);
      if (address == null || typeof app?.ensureProgram !== 'function') return unsupported(id, 'program-index-unavailable');
      const program = await app.ensureProgram({ signal:options.signal ?? null, onProgress:options.onProgress, priority:options.priority, budget:options.budget });
      if (!program?.callersOf) return unsupported(id, 'program-index-unavailable');
      if (program.graphCompleteness && (!program.graphCompleteness.supported || program.graphCompleteness.unsupported)) {
        return unsupported(id, program.graphCompleteness.reasons?.[0] || program.queryIncompleteReason || 'unsupported-program-analysis');
      }
      if (program.unsupported) {
        return unsupported(id, program.queryIncompleteReason || 'unsupported-program-analysis');
      }
      const { offset, limit } = pageOf(page);
      // MAX_PAGE bounds a single page (via pageOf), never the cumulative
      // offset: the producer only serves a leading prefix, so reaching an
      // offset beyond MAX_PAGE requires fetching the full prefix.
      const cumulativeLimit = cumulativePageLimit(offset, limit);
      if (cumulativeLimit == null) return unsupportedPage(id, page, 'page-range-overflow');
      const source = program.callersOf(address, cumulativeLimit);
      const sourceRows = Array.from(source || []);
      const queryLimited = source?.queryLimited === true;
      const result = paged(
        sourceRows,
        page,
        source?.complete === false || queryLimited ? 'partial' : 'complete',
        { reason:source?.incompleteReason ?? (queryLimited ? 'query-limit' : null) },
      );
      if (source?.queryLimited === true && result.page.next == null) {
        // A capped producer may expose one empty boundary page at exactly its
        // current prefix length. Advance once so offset=5000 does not repeat
        // itself, but stop when the producer's entire prefix is already below
        // the requested offset: there is no evidence for another page and an
        // unconditional cursor would create an infinite empty continuation.
        const canProbeBeyondPrefix = sourceRows.length >= result.page.offset;
        if (canProbeBeyondPrefix) {
          const next = nextPageOffset(
            result.page.offset,
            result.page.returned > 0 ? result.page.returned : result.page.limit,
          );
          if (next != null) result.page.next = next;
        }
      }
      return result;
    },

    async callees(_snapshot, id, page = {}, options = {}) {
      const range = rangeFor(app, id);
      if (!range.ok || typeof app?.ensureProgram !== 'function') return unsupported(id, range.reason || 'program-index-unavailable');
      const program = await app.ensureProgram({ signal:options.signal ?? null, onProgress:options.onProgress, priority:options.priority, budget:options.budget });
      if (!program?.calleesOf) return unsupported(id, 'program-index-unavailable');
      if (program.graphCompleteness && (!program.graphCompleteness.supported || program.graphCompleteness.unsupported)) {
        return unsupported(id, program.graphCompleteness.reasons?.[0] || program.queryIncompleteReason || 'unsupported-program-analysis');
      }
      if (program.unsupported) {
        return unsupported(id, program.queryIncompleteReason || 'unsupported-program-analysis');
      }
      const { offset, limit } = pageOf(page);
      const cumulativeLimit = cumulativePageLimit(offset, limit);
      if (cumulativeLimit == null) return unsupportedPage(id, page, 'page-range-overflow');
      const source = program.calleesOf(range.start, range.end, cumulativeLimit);
      const sourceRows = Array.from(source || []);
      // The scan only covers the validated range; an unproven function extent
      // (analysis window or region clip) keeps the query partial (#5991).
      const rangeIncomplete = range.complete === false;
      const queryLimited = source?.queryLimited === true;
      const reason = source?.incompleteReason ?? (queryLimited ? 'query-limit' : (rangeIncomplete ? (range.reason ?? 'function-extent-unproven') : null));
      const result = paged(sourceRows, page, source?.complete === false || queryLimited || rangeIncomplete ? 'partial' : 'complete', { reason });
      if (queryLimited && result.page.next == null) {
        const canProbeBeyondPrefix = sourceRows.length >= result.page.offset;
        if (canProbeBeyondPrefix) {
          const next = nextPageOffset(
            result.page.offset,
            result.page.returned > 0 ? result.page.returned : result.page.limit,
          );
          if (next != null) result.page.next = next;
        }
      }
      return result;
    },

    async xrefs(_snapshot, id, page = {}, options = {}) {
      const address = addressOf(id);
      if (address == null || typeof app?.ensureProgram !== 'function') return unsupported(id, 'program-index-unavailable');
      const program = await app.ensureProgram({ signal:options.signal ?? null, onProgress:options.onProgress, priority:options.priority, budget:options.budget });
      if (!program) return unsupported(id, 'program-index-unavailable');
      if (program.graphCompleteness && (!program.graphCompleteness.supported || program.graphCompleteness.unsupported)) {
        return unsupported(id, program.graphCompleteness.reasons?.[0] || program.queryIncompleteReason || 'unsupported-program-analysis');
      }
      if (program.unsupported) {
        return unsupported(id, program.queryIncompleteReason || 'unsupported-program-analysis');
      }
      const { offset, limit } = pageOf(page);
      const cap = Math.min(MAX_PAGE, offset + limit);
      const refs = program.refSitesTo?.(address, 1n, cap) || [];
      const calls = program.callSitesTo?.(address, cap) || [];
      const rows = [
        ...Array.from(refs).map((x) => ({ kind:'reference', site:x.site, target:x.target, refKind:x.kind ?? null })),
        ...Array.from(calls).map((x) => ({ kind:'call', site:x.site, target:address, caller:x.caller ?? null })),
      ].sort((a, b) => BigInt(a.site) < BigInt(b.site) ? -1 : BigInt(a.site) > BigInt(b.site) ? 1 : 0);
      const queryLimited = refs.queryLimited === true || calls.queryLimited === true;
      const complete = refs.complete !== false && calls.complete !== false && !queryLimited;
      return paged(rows, page, complete ? 'complete' : 'partial', {
        reason:refs.incompleteReason ?? calls.incompleteReason ?? (queryLimited ? 'query-limit' : null),
        ...(queryLimited ? { truncationReason:'query-limit' } : {}),
      });
    },

    async types(_snapshot, scope, _page = {}, options = {}) {
      if (typeof app?.getTypes === 'function') {
        const value = await app.getTypes(scope, options);
        if (value != null) return wrap(value);
      }
      const id = scope?.functionId ?? scope?.address ?? scope;
      const result = await loadFunction(id, options);
      const model = result?.value?.model;
      return model ? wrap(inferTypes(model), result.status?.completeness, { inference:true }) : unsupported(id, 'typed-function-projection-unavailable');
    },

    async evidence(_snapshot, query = {}, page = {}, options = {}) {
      const rawTarget = query?.functionId ?? query?.address ?? null;
      const targetAddress = addressOf(rawTarget);
      // Only a canonical address or an explicitly allowed string identity may
      // select evidence. A structured value must never coerce through String()
      // into another function's id, and an explicitly invalid target fails
      // closed instead of scanning unfiltered or loading garbage.
      const targetId = targetAddress != null ? functionId(targetAddress)
        : (typeof rawTarget === 'string' && rawTarget.trim() ? rawTarget.trim() : null);
      if (rawTarget != null && targetAddress == null && targetId == null) {
        return unsupported(rawTarget, 'evidence-target-invalid');
      }
      if (typeof app?.getEvidence === 'function') {
        const providerQuery = { ...query };
        delete providerQuery.functionId;
        delete providerQuery.address;
        if (targetId != null) providerQuery.functionId = targetId;
        const value = await app.getEvidence(providerQuery, options);
        return value == null ? unsupported(targetId, 'evidence-store-unavailable') : paged(Array.isArray(value) ? value : [value], page);
      }

      const rows = [];
      const deep = app?.autoReport?.report?.deep || [];
      if (targetAddress == null && targetId == null) {
        rows.push(...deep);
      } else {
        for (const item of deep) {
          const itemAddr = addressOf(item?.functionId ?? item?.address ?? item?.addr ?? item?.startAddress);
          const itemFnId = typeof item?.functionId === 'string' && item.functionId.trim() ? item.functionId.trim()
            : (itemAddr != null ? functionId(itemAddr) : null);
          if ((targetAddress != null && itemAddr != null && itemAddr === targetAddress) ||
              (targetId != null && itemFnId === targetId)) {
            rows.push(item);
          }
        }
      }

      let decompilerCompleteness = 'complete';
      if (targetAddress != null || targetId != null) {
        const result = await loadFunction(rawTarget, options);
        const functionCompleteness = completenessOf(result, 'complete');
        if (functionCompleteness !== 'unsupported') decompilerCompleteness = functionCompleteness;
        for (const evidence of result?.value?.decompiler?.evidence || []) {
          rows.push({ kind:'decompiler', functionId:targetId ?? rawTarget, evidence });
        }
        if (!rows.length && result?.status?.completeness === 'unsupported') {
          return unsupported(rawTarget, result.status.reason || 'function-range-unavailable');
        }
      }

      if (!rows.length && targetAddress != null) {
        const range = rangeFor(app, targetAddress);
        if (!range.ok) return unsupported(rawTarget, range.reason || 'function-range-unavailable');
      }

      const autoTruncated = app?.autoReport?.report?.truncated === true;
      const completeness = decompilerCompleteness !== 'complete' ? decompilerCompleteness : (autoTruncated ? 'partial' : 'complete');
      return rows.length ? paged(rows, page, completeness) : unsupported(rawTarget, 'evidence-store-unavailable');
    },

    async decompile(_snapshot, id, options = {}) {
      // Every producer result crosses the same explicit DTO boundary, so the
      // canonical semantic path, an app-owned getDecompile() and the legacy
      // ARM64 decompiler cannot drift apart.
      const publish = (value, completeness = null, status = {}) => {
        const { value:published, withheld, unexpected } = publicDecompilerProjection(value);
        if (!withheld.length && !unexpected.length) return wrap(published, completeness, status);
        // Every field the projection gave up is an explicit availability loss
        // reported with the schema and the field names, never a silent drop.
        // A withheld deep field is `truncated`; an unknown field is schema
        // drift, so the published value is a `partial` projection of it.
        const truncated = withheld.length > 0;
        const projectionCompleteness = truncated ? 'truncated' : 'partial';
        const producerCompleteness = completeness ?? completenessOf(value, 'complete');
        const combinedCompleteness = weakestCompleteness([producerCompleteness, projectionCompleteness]);
        return wrap(published, combinedCompleteness, {
          ...status,
          reason:status.reason ?? (truncated ? 'decompile-projection-withheld' : 'decompile-projection-schema-drift'),
          projection:{ schema:DECOMPILE_DTO_SCHEMA, withheld, unexpected },
        });
      };
      if (typeof app?.getDecompile === 'function') {
        const value = await app.getDecompile(id, options);
        if (value != null) return publish(value);
      }
      const result = await loadFunction(id, options);
      const functionCompleteness = result?.value?.completeness;
      const functionStatus = {
        reason:result?.status?.reason ?? functionCompleteness?.reason ?? null,
        ...(functionCompleteness?.provenance != null ? { provenance:functionCompleteness.provenance } : {}),
      };
      if (result?.value?.decompiler) {
        return publish(result.value.decompiler, result.status?.completeness, functionStatus);
      }
      if (!result?.value?.model) return unsupported(id, 'decompiler-projection-unavailable');
      const address = addressOf(id) ?? result.value.startAddr ?? result.value.startAddress;
      let cxxEvidence = options.cxxEvidence ?? null;
      if (!cxxEvidence && supportsArm64SemanticAnalysis(architectureOf(app))) {
        const entry = ensureCxxEvidenceProviderForApp(app);
        if (entry) {
          await entry.buildPromise;
          try {
            const ir = irFor(result.value.model);
            cxxEvidence = entry.provider.projectForFunction({
              functionAddress: address != null ? BigInt(address) : null,
              functionName: address == null ? null : app?.symbols?.nameAt?.(address),
              ir,
            });
          } catch {
            cxxEvidence = null;
          }
        }
      }
      const projection = decompile(result.value.model, {
        ...decompilerOptionsFromQuery(options),
        name:address == null ? null : app?.symbols?.nameAt?.(address),
        addr:address,
        ...(cxxEvidence ? { cxxEvidence } : {}),
      });
      return publish(projection, result.status?.completeness, functionStatus);
    },

    async translationUnit(_snapshot, ids, options = {}) {
      if (!Array.isArray(ids) || ids.length === 0) return unsupported(null, 'translation-unit-function-list-required');
      // Keep this query bounded. A whole-program export should use a future
      // streaming/export owner rather than making one query clone unbounded.
      if (ids.length > 256) return unsupported(null, 'translation-unit-function-limit');

      const functions = [];
      for (const id of ids) {
        throwIfAborted(options.signal);
        const result = await loadFunction(id, options);
        if (result?.status?.completeness === 'unsupported' || result?.value == null) {
          return unsupported(id, result?.status?.reason || 'translation-unit-function-unavailable');
        }
        const address = addressOf(id) ?? result.value.startAddr ?? result.value.startAddress ?? null;
        const name = address == null ? null : app?.symbols?.nameAt?.(address) ?? app?.symbols?.label?.(address) ?? null;
        let producer = result.value.decompiler ?? null;
        if (!producer && result.value.model) {
          let cxxEvidence = options.cxxEvidence ?? null;
          if (!cxxEvidence && supportsArm64SemanticAnalysis(architectureOf(app))) {
            const entry = ensureCxxEvidenceProviderForApp(app);
            if (entry) {
              await entry.buildPromise;
              try {
                const ir = irFor(result.value.model);
                cxxEvidence = entry.provider.projectForFunction({
                  functionAddress: address != null ? BigInt(address) : null,
                  functionName: name,
                  ir,
                });
              } catch {
                cxxEvidence = null;
              }
            }
          }
          producer = decompile(result.value.model, {
            name,
            addr:address,
            ...(cxxEvidence ? { cxxEvidence } : {}),
          });
        }
        producer ??= result.value;
        const pseudocode = producer?.pseudocode ?? producer?.text ?? producer?.code ?? null;
        if (typeof pseudocode !== 'string' || !pseudocode.trim()) {
          return unsupported(id, 'translation-unit-pseudocode-unavailable');
        }
        functions.push({
          functionId:result.value.functionId ?? id,
          address:result.value.startAddress ?? result.value.startAddr ?? address,
          name:result.value.name ?? name,
          signature:producer.signature ?? null,
          pseudocode,
          // These remain internal to the producer; the packager consumes them
          // and publishes only declarations/provenance, never the analysis graph.
          ir:producer.ir ?? result.value.ir ?? null,
          semanticIR:producer.semanticIR ?? result.value.semanticIR ?? null,
          types:producer.types ?? result.value.types ?? null,
          locationTypes:producer.locationTypes ?? result.value.locationTypes ?? null,
          globalEvidence:producer.globalEvidence ?? result.value.globalEvidence ?? null,
        });
      }

      const unit = buildCTranslationUnit(functions, {
        symbolFor:(address) => app?.symbols?.nameAt?.(BigInt(address)) ?? app?.symbols?.label?.(BigInt(address)) ?? null,
      });
      return wrap(unit, unit.completeness, { reason:unit.reason, schema:unit.schema });
    },

    async search(_snapshot, query, page = {}, options = {}) {
      if (typeof app?.querySearch === 'function') {
        const value = await app.querySearch(query, options);
        if (value?.unsupported === true || value?.status?.completeness === 'unsupported'
          || value?.completeness === 'unsupported') {
          return unsupportedPage(null, page,
            value?.reason ?? value?.unsupportedReason ?? value?.status?.reason ?? 'search-kind-unsupported');
        }
        return paged(Array.isArray(value) ? value : value?.results || [], page, completenessOf(value));
      }
      if (!query || typeof query !== 'object' || typeof app?.backend?.search !== 'function') return unsupported(null, 'typed-search-producer-unavailable');
      throwIfAborted(options.signal);
      const request = app.backend.search(query, options.onProgress);
      const value = await requestWithSignal(request, options.signal);
      // An explicit backend `unsupported` must survive the query boundary:
      // "the backend cannot run this search" is not a complete empty result
      // (#5840, #5833).
      if (value?.unsupported === true) return unsupportedPage(null, page, value?.unsupportedReason ?? 'search-kind-unsupported');
      return paged(value?.results || [], page, value?.cancelled ? 'partial' : value?.capped ? 'truncated' : 'complete', { reason:value?.cancelled ? 'cancelled' : value?.capped ? 'search-result-cap' : null });
    },

    async causalPath(_snapshot, source, sink, options = {}) {
      return typeof app?.queryCausalPath === 'function' ? wrap(await app.queryCausalPath(source, sink, options)) : unsupported(source?.functionId ?? source ?? null, 'causal-path-producer-unavailable');
    },
  };

  // This opt-in branch is deliberately lazy. Existing query methods and the
  // default decoder/decompiler path retain their prior owners and behavior.
  const scopedMethods = ['taskIdiomView', 'inspectConditionalModel', 'checkLoopInvariant', 'asyncEventOrder', 'portableIntegerChecks', 'demandQuery', 'investigateDemand', 'demandInvestigationFrontier', 'resumeDemandQuery', 'explainDemandResult', 'replayDemandResult', 'blockCaptures', 'investigationFrontier', 'typeEvidence', 'interproceduralQuery', 'abiInputBindings', 'abiPlacementEvidence', 'explainTransformChain', 'runtimeObservations', 'scopedCapabilities', 'semanticQuery', 'resumeSemanticQuery', 'dispatchTargets',
    'applePointerView', 'appleMetadataView', 'knowledgeMatches', 'objectMemory', 'rangeValueCatalog', 'callGraphSlice', 'resumeCallGraphSlice', 'referenceSlice', 'replayReferenceSlice', 'refineValueFacts', 'summarySlice', 'resumeSummarySlice', 'proofSlice', 'replayProof', 'cancelScopedQuery'];
  for (const method of scopedMethods) adapter[method] = async (snapshot, request = {}, options = {}) => {
    if (!scopedAnalysisHost(app)?.configuration.enabled) return unsupported(null, 'scoped-analysis-disabled');
    const { dispatchScopedAppQuery } = await import('./scoped-app.js');
    return dispatchScopedAppQuery(app, snapshot, method, request, options, {
      file: () => storeValue(app, 'file'), architecture: () => architectureOf(app), format: () => formatOf(app),
      sliceIndex: () => validSliceIndex(storeValue(app, 'sliceIndex')),
      artifactVersions: () => artifactVersions(app), metadata: () => descriptorMetadata(app),
      regions: () => storeValue(app, 'regions'),
      capability: () => storeValue(app, 'capability') ?? currentSlice(app)?.capability ?? currentInfo(app)?.capability,
      projectRevision: () => identityGeneration((storeValue(app, 'project') ?? app?.workspace?.project ?? app?.project)?.revision
        ?? app?.projectRevision ?? app?.workspace?.bindingRevision ?? 0, 'analysis-query-project-revision-invalid'),
      rangeFor: (id) => rangeFor(app, id),
    });
  };

  installRoutes(app, directFetch);
  return adapter;
}
