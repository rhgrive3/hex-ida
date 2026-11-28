/* Format-neutral backend facade. Legacy ARM64/Mach-O worker remains a compatibility engine. */
import { LRU } from './lru.js';
import { augmentAnalysisResultWithChainedImports } from './chained.js';
import { markMachOSymbolTruthIncomplete, mergeMachOAnalysisResults } from './macho-analysis-merge.js';
import { AnalysisCache } from './cache/analysis-cache.js';
import { sha256BlobHex } from './cache/content-identity.js';
import { createBinaryIdFromDigest } from './core/identity/index.js';
import {
  ANALYSIS_ORCHESTRATION_ROUTE,
  ArtifactAnalysisOrchestrator,
  awaitCancellableProducer,
  createWorkerAnalysisArtifactDescriptor,
  normalizeAnalysisRoute,
} from './cache/artifact-orchestration.js';
import { X86_DECODER_SEMANTIC_VERSION } from './targets/architecture/x86_64/decoded-instruction.js';
import { X86_64_MACHINE_EFFECTS_SEMANTIC_VERSION } from './targets/architecture/x86_64/effects/common.js';
import {
  X86_SEMANTIC_FUNCTION_ANALYSIS_VERSION,
  X86_SEMANTIC_FUNCTION_MAX_DECODE_BYTES,
  X86_SEMANTIC_FUNCTION_SCHEMA_VERSION,
} from './targets/architecture/x86_64/semantic-function-contract.js';
import { RISCV64_DECODER_SEMANTIC_VERSION } from './targets/architecture/riscv64/decoded-instruction.js';
import { RISCV64_MACHINE_EFFECTS_SEMANTIC_VERSION } from './targets/architecture/riscv64/effects/common.js';
import { resolveRiscvIsaProfile } from './binary/riscv-isa.js';
import { ScanWorkerPool } from './scan-pool.js';
import {
  isMobileDevice,
  computeMaxScanWorkers,
  planProgramChunks,
  planShapeChunks,
  routeCrossChunkForwardTargets,
  mergeChunkProgramScans,
  mergeChunkShapeScans,
  computeWaveConcurrency,
} from './scan-planner.js';

/*
 * Per-architecture inputs to the shared semantic-function route.
 *
 * The route itself is architecture-neutral (js/analysis/semantic-function.js);
 * what differs is which decoder contract, which effects semantic version, and
 * which calling conventions are legal. `artifactKind` is pinned per
 * architecture rather than derived, so extending this table cannot silently
 * change an existing architecture's artifact identity and invalidate its
 * warm-reuse evidence.
 */
const SEMANTIC_FUNCTION_TARGETS = Object.freeze({
  x86_64: Object.freeze({
    artifactKind: 'phase5-x86-semantic-function',
    decoderContract: 'x86-64-decoded-instruction/v1',
    decoderSemanticVersion: X86_DECODER_SEMANTIC_VERSION,
    architectureSemanticVersion: X86_64_MACHINE_EFFECTS_SEMANTIC_VERSION,
    analysisVersion: X86_SEMANTIC_FUNCTION_ANALYSIS_VERSION,
    schemaVersion: X86_SEMANTIC_FUNCTION_SCHEMA_VERSION,
    abiIds: Object.freeze(['sysv-amd64', 'microsoft-x64']),
    defaultPlatform: (formatId) => (formatId === 'pe' ? 'windows' : 'linux'),
  }),
  riscv64: Object.freeze({
    artifactKind: 'phase6-riscv64-semantic-function',
    decoderContract: 'riscv64-decoded-instruction/v1',
    decoderSemanticVersion: RISCV64_DECODER_SEMANTIC_VERSION,
    architectureSemanticVersion: RISCV64_MACHINE_EFFECTS_SEMANTIC_VERSION,
    analysisVersion: RISCV64_MACHINE_EFFECTS_SEMANTIC_VERSION,
    schemaVersion: X86_SEMANTIC_FUNCTION_SCHEMA_VERSION,
    abiIds: Object.freeze(['lp64', 'lp64f', 'lp64d']),
    defaultPlatform: () => 'linux',
  }),
});

function semanticFunctionTarget(architecture) {
  const target = SEMANTIC_FUNCTION_TARGETS[String(architecture || 'x86_64')];
  if (!target) throw new TypeError(`semantic-function-unsupported-architecture:${architecture}`);
  return target;
}

const LEGACY_MACHO_ARCHITECTURES = Object.freeze(['arm64', 'arm64e', 'arm64_32']);
function isLegacyMachArchitecture(architecture) {
  return LEGACY_MACHO_ARCHITECTURES.includes(String(architecture || '').toLowerCase());
}

const AARCH64_ARCHITECTURES = Object.freeze(['arm64', 'arm64e', 'arm64_32', 'arm64ec', 'aarch64', 'aarch64_be']);
function isAarch64Architecture(architecture) {
  return AARCH64_ARCHITECTURES.includes(String(architecture || '').toLowerCase());
}

const DEFAULT_PARALLEL_SCAN_THRESHOLD_BYTES = 16 * 1024 * 1024;
const PROGRAM_INDEX_BUDGET_BYTES = 96 * 1024 * 1024;
const MAX_PROGRAM_EDGES = 8_000_000;
const MAX_PROGRAM_REFS = 8_000_000;
const MAX_PROGRAM_KIND_WORDS = 16 * 1024 * 1024;
const MAX_SHAPE_EVENTS = 200_000;
const SCAN_PROGRESS_THROTTLE_MS = 50;

function capOf(value, hard) {
  return value == null ? hard : Math.max(0, Math.min(hard, Math.floor(Number(value) || 0)));
}

function disposedBackendError() {
  const error = new Error('Backend has been disposed.');
  error.code = 'BACKEND_DISPOSED';
  return error;
}

function rejectedDisposedRequest() {
  const promise = Promise.reject(disposedBackendError());
  promise.requestId = null;
  promise.cancel = () => {};
  return promise;
}

function isFatalScanError(error) {
  if (!error) return false;
  return error.code === 'WORKER_FAILED'
    || error.code === 'BACKEND_DISPOSED'
    || error.stale === true
    || error.name === 'StaleRequestError'
    || error.name === 'AbortError'
    || error.code === 'ABORT_ERR';
}

function isPoolNonFallbackError(error) {
  if (!error) return false;
  return error.code === 'BACKEND_DISPOSED'
    || error.stale === true
    || error.name === 'StaleRequestError'
    || error.name === 'AbortError'
    || error.code === 'ABORT_ERR';
}

function cancelJobList(jobs) {
  for (const job of jobs) {
    try { job?.cancel?.(); } catch { /* best effort */ }
  }
}

function requirePrimitiveSafeInteger(value, code) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError(code);
  return value;
}

function requirePrimitiveString(value, code) {
  if (typeof value !== 'string') throw new TypeError(code);
  return value;
}

function semanticFunctionAddress(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('semantic-function-address-required');
    return BigInt(value);
  }
  if (typeof value === 'string') {
    if (!value.trim()) throw new TypeError('semantic-function-address-required');
    try { return BigInt(value); }
    catch { throw new TypeError('semantic-function-address-required'); }
  }
  throw new TypeError('semantic-function-address-required');
}

export const CHUNK_ROWS = 1024;
export const CHUNK_BYTES = CHUNK_ROWS * 4;
const CHUNK_CACHE = 64;
const MAX_INFLIGHT = 6;
const MACHO_SPECULATIVE_MAGICS = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe,
  0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
]);

// Phase 4 production cutover: ArtifactStore/scheduler is the default analysis
// route. CURRENT remains available only through explicit route selection as the
// differential/compatibility oracle; there is no automatic fallback.
export const BACKEND_DEFAULT_ANALYSIS_ROUTE = ANALYSIS_ORCHESTRATION_ROUTE.ARTIFACT;
const DEFAULT_ARTIFACT_COMPLETENESS = 'complete';

function configuredAnalysisRoute() {
  // Test/CI-only rehearsal override. Browser production has no `process` and
  // therefore follows BACKEND_DEFAULT_ANALYSIS_ROUTE exactly.
  const rehearsal = typeof process !== 'undefined' ? process?.env?.HEX_ANALYSIS_ROUTE : null;
  return normalizeAnalysisRoute(rehearsal || BACKEND_DEFAULT_ANALYSIS_ROUTE);
}

const BACKEND_ANALYSIS_ARTIFACT_VERSIONS = Object.freeze({
  producer:'hex-current-backend-analysis-v1',
  loader:'hex-current-loader-orchestration-v1',
  architectureSemantic:'hex-current-semantic-oracle-v1',
  abiSemantic:'hex-current-abi-oracle-v1',
  semanticSchema:'hex-current-analysis-result-v1',
});

export class StaleRequestError extends Error {
  constructor() {
    super('The analysis request belongs to a file or slice that is no longer active.');
    this.name = 'StaleRequestError';
    this.stale = true;
  }
}

function cancelledRequestError(message = 'Analysis request cancelled.') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function workerFailureError(workerName, event, fallback = 'The analysis worker failed.') {
  const message = event?.message || event?.error?.message || fallback;
  const error = event?.error instanceof Error ? event.error : new Error(message);
  if (!error.code) error.code = 'WORKER_FAILED';
  error.workerName = workerName;
  return error;
}

function carryCancellation(mapped, source) {
  mapped.requestId = source?.requestId ?? null;
  mapped.cancel = () => source?.cancel?.();
  return mapped;
}

function freezeArchitectureProbeResult(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeArchitectureProbeResult(child, seen);
  return Object.freeze(value);
}

export class Backend {
  constructor(options = {}) {
    this._legacyWorker = null;
    this._platformWorker = null;
    this.seq = 1;
    this.analysisEpoch = 0;
    this.transportEpoch = 0;
    this._scanEpoch = 0;
    this.pending = new Map();
    this.cache = new LRU(CHUNK_CACHE);
    this.inflight = new Map();
    this.queue = [];
    this.file = null;
    this.formatId = 'unknown';
    this.platformInfo = null;
    this.legacyInfo = null;
    this._activeMachArchitecture = null;
    this.arm64Bridge = false;
    this.onSearchProgress = null;
    this.onScanProgress = null;
    this.onAnalysisProgress = null;
    this.onChunk = null;
    this.onFatal = null;
    this._archProbe = null;
    this._archProbeWorker = null;
    this._archProbeFinish = null;
    this._archProbeResult = null;
    this._disasmWorker = null;
    this._disasmSeq = 1;
    this._disasmPending = new Map();
    this.contentHash = null;
    this.binaryId = null;
    this._binaryIdPromise = null;
    this._binaryIdFlight = null;
    this.disposed = false;
    this.analysisRoute = normalizeAnalysisRoute(options.analysisRoute ?? configuredAnalysisRoute());
    this._artifactOrchestrator = options.artifactOrchestrator ?? null;
    this._artifactStoreOptions = options.artifactStoreOptions ?? {};
    this._artifactSchedulerOptions = options.artifactSchedulerOptions ?? {};
    this.analysisCache = options.analysisCache || new AnalysisCache(options.analysisCacheOptions);
    this._scanWorkerFactory = options.scanWorkerFactory ?? null;
    this._parallelScanThresholdBytes = options.parallelScanThresholdBytes ?? DEFAULT_PARALLEL_SCAN_THRESHOLD_BYTES;
    this._scanPool = null;

    if (typeof document !== 'undefined') {
      this._memoryPressureHandler = () => {
        if (!document.hidden) return;
        this.dropQueued();
        this.cleanupMemory().catch(() => {});
      };
      document.addEventListener('visibilitychange', this._memoryPressureHandler, { passive: true });
    }
  }

  get legacyWorker() {
    return this._legacyWorker;
  }

  set legacyWorker(worker) {
    this._legacyWorker = worker;
    if (worker) {
      worker.onmessage = (event) => this._onMessage(event.data, 'legacy');
      const failed = (event) => {
        if (this._legacyWorker !== worker) return;
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        try { worker.terminate(); } catch {}
        this._legacyWorker = null;
        const error = workerFailureError('legacy', event, 'The analysis worker failed.');
        this._rejectWorkerPending('legacy', error);
        if (this.onFatal) this.onFatal(error.message);
      };
      worker.onerror = failed;
      worker.onmessageerror = failed;
    }
  }

  get platformWorker() {
    return this._platformWorker;
  }

  set platformWorker(worker) {
    this._platformWorker = worker;
    if (worker) {
      worker.onmessage = (event) => this._onMessage(event.data, 'platform');
      const failed = (event) => {
        if (this._platformWorker !== worker) return;
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        try { worker.terminate(); } catch {}
        this._platformWorker = null;
        const error = workerFailureError('platform', event, 'The analysis worker failed.');
        this._rejectWorkerPending('platform', error);
        if (this.onFatal) this.onFatal(error.message);
      };
      worker.onerror = failed;
      worker.onmessageerror = failed;
    }
  }

  get worker() {
    return this._legacyWorker || this._platformWorker || this._worker('legacy');
  }

  set worker(w) {
    this.legacyWorker = w;
  }

  get gen() { return this.analysisEpoch; }

  setAnalysisRoute(route) {
    this.analysisRoute = normalizeAnalysisRoute(route);
    return this.analysisRoute;
  }

  analysisRouteInfo() {
    return Object.freeze({
      route:this.analysisRoute,
      defaultCutover:BACKEND_DEFAULT_ANALYSIS_ROUTE === ANALYSIS_ORCHESTRATION_ROUTE.ARTIFACT,
      canonicalIdentityRequired:true,
      completenessRequired:true,
      artifactRuntimeCreated:!!this._artifactOrchestrator,
      artifactRuntime:this._artifactOrchestrator?.stats?.() ?? null,
    });
  }

  _artifactRuntime() {
    if (!this._artifactOrchestrator) {
      this._artifactOrchestrator = new ArtifactAnalysisOrchestrator({
        storeOptions:this._artifactStoreOptions,
        schedulerOptions:this._artifactSchedulerOptions,
      });
    }
    return this._artifactOrchestrator;
  }

  _rejectWorkerPending(workerName, error) {
    const matched = [];
    for (const [id, pending] of this.pending) {
      if (pending.workerName !== workerName) continue;
      matched.push([id, pending]);
    }
    for (const [id] of matched) this.pending.delete(id);
    for (const [, pending] of matched) {
      try { pending.onCancel?.(); } catch { /* best effort */ }
      pending.reject(error);
    }
  }

  _onMessage(message, workerName) {
    if (!message) return;
    if (message.t === 'searchProgress' || message.t === 'scanProgress' || message.t === 'analysisProgress') {
      const pending = this.pending.get(message.requestId);
      if (!pending || pending.uiEpoch !== this.gen || pending.transportEpoch !== this.transportEpoch || message.epoch !== pending.transportEpoch) return;
      if (pending.onProgress) pending.onProgress(message);
      else if (message.t === 'searchProgress' && this.onSearchProgress) this.onSearchProgress(message);
      else if (message.t === 'scanProgress' && this.onScanProgress) this.onScanProgress(message);
      else if (message.t === 'analysisProgress' && this.onAnalysisProgress) this.onAnalysisProgress(message);
      return;
    }
    if (message.t === 'fatal') {
      const error = workerFailureError(workerName, { message: message.error }, 'The analysis worker failed.');
      this._rejectWorkerPending(workerName, error);
      if (this.onFatal) this.onFatal(error.message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending || pending.workerName !== workerName) return;
    this.pending.delete(message.id);
    if (pending.uiEpoch !== this.gen || pending.transportEpoch !== this.transportEpoch || message.epoch !== pending.transportEpoch) {
      pending.reject(new StaleRequestError());
      return;
    }
    if (message.t === 'ok') pending.resolve(message.result);
    else pending.reject(new Error(message.error || 'Analysis failed.'));
  }

  _worker(name) {
    if (this.disposed) {
      const error = new Error('Backend has been disposed.');
      error.code = 'BACKEND_DISPOSED';
      throw error;
    }
    if (name === 'platform') {
      if (!this._platformWorker) {
        const worker = new Worker(new URL('./platform/worker.js', import.meta.url), { type: 'module' });
        this.platformWorker = worker;
      }
      return this._platformWorker;
    }
    if (name === 'legacy') {
      if (!this._legacyWorker) {
        const worker = new Worker(new URL('./worker.js', import.meta.url));
        this.legacyWorker = worker;
      }
      return this._legacyWorker;
    }
    throw new Error(`Unknown worker: ${name}`);
  }

  _callTo(workerName, t, payload = {}, transfer, onProgress, options = {}) {
    if (this.disposed) {
      return rejectedDisposedRequest();
    }
    const id = this.seq++;
    if (options?.trackLastRequest !== false) this.lastRequestId = id;
    const uiEpoch = this.gen;
    const transportEpoch = this.transportEpoch;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, uiEpoch, transportEpoch, workerName, onProgress });
      try {
        this._worker(workerName).postMessage({ t, id, requestId: id, epoch: transportEpoch, ...payload }, transfer || []);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
    promise.requestId = id;
    promise.cancel = () => this.cancel(id);
    return promise;
  }

  _engineWorker(t) {
    if (this.formatId === 'unknown' || this.formatId === 'macho') return 'legacy';
    if (this.arm64Bridge && !['analyze', 'metadata', 'memoryStats', 'cleanupMemory'].includes(t)) return 'legacy';
    return 'platform';
  }

  call(t, payload, transfer, onProgress) { return this._callTo(this._engineWorker(t), t, payload, transfer, onProgress); }

  _releaseDisassembly(error) {
    if (this._disasmWorker) { this._disasmWorker.terminate(); this._disasmWorker = null; }
    const failure = error || new Error('disassembly worker released');
    for (const pending of this._disasmPending.values()) {
      pending.cleanup?.();
      pending.reject(failure);
    }
    this._disasmPending.clear();
  }

  advanceEpoch() {
    if (this.disposed) return this.analysisEpoch;
    this.analysisEpoch++;
    this.resetCache();
    this._releaseDisassembly(new StaleRequestError());
    for (const worker of [this._legacyWorker, this._platformWorker]) {
      if (worker) worker.postMessage({ t: 'cancel', epoch: this.transportEpoch });
    }
    const previousScanEpoch = this._scanEpoch;
    this._scanEpoch++;
    this._scanPool?.cancelEpoch(previousScanEpoch);
    const stale = [];
    for (const [id, pending] of this.pending) {
      if (pending.uiEpoch === this.gen) continue;
      stale.push([id, pending]);
    }
    for (const [id] of stale) this.pending.delete(id);
    for (const [, pending] of stale) {
      try { pending.onCancel?.(); } catch { /* best effort */ }
      pending.reject(new StaleRequestError());
    }
    return this.analysisEpoch;
  }

  async open(file) {
    if (this.disposed) {
      const error = new Error('Backend has been disposed.'); error.code = 'BACKEND_DISPOSED';
      throw error;
    }
    const previousTransportEpoch = this.transportEpoch;
    const openTransportEpoch = ++this.transportEpoch;
    const previousScanEpoch = this._scanEpoch;
    this._scanEpoch++;
    for (const worker of [this._legacyWorker, this._platformWorker]) {
      if (worker) worker.postMessage({ t: 'cancel', epoch: previousTransportEpoch });
    }
    this._scanPool?.cancelEpoch(previousScanEpoch);
    const assertCurrent = () => {
      if (this.transportEpoch !== openTransportEpoch) throw new StaleRequestError();
    };
    const step = async (promise) => {
      try {
        const value = await promise;
        assertCurrent();
        return value;
      } catch (error) {
        assertCurrent();
        throw error;
      }
    };

    // Sniff Mach-O magic when a sliceable File/Blob is provided so platform and
    // legacy workers can parse Mach-O binaries in parallel without touching the
    // legacy worker for non-Mach-O formats.
    let speculativeLegacyReq = null;
    let speculativeLegacyOutcome = null;
    if (typeof file?.slice === 'function' && Number(file?.size ?? 0) >= 4) {
      try {
        const header = await file.slice(0, 4).arrayBuffer();
        assertCurrent();
        if (header.byteLength >= 4) {
          const magic = new DataView(header).getUint32(0, false);
          if (MACHO_SPECULATIVE_MAGICS.has(magic)) {
            speculativeLegacyReq = this._callTo('legacy', 'open', { file });
            speculativeLegacyOutcome = speculativeLegacyReq.then(
              (value) => ({ ok: true, value }),
              (error) => ({ ok: false, error }),
            );
          }
        }
      } catch (error) {
        if (error?.stale) throw error;
      }
    }
    const awaitLegacyOpen = async () => {
      if (speculativeLegacyOutcome) {
        const pending = speculativeLegacyOutcome;
        speculativeLegacyOutcome = null;
        speculativeLegacyReq = null;
        const outcome = await pending;
        assertCurrent();
        if (outcome.ok) return outcome.value;
        throw outcome.error;
      }
      return step(this._callTo('legacy', 'open', { file }));
    };
    const cancelSpeculativeLegacy = () => {
      if (speculativeLegacyReq) {
        try { speculativeLegacyReq.cancel?.(); } catch { /* best effort */ }
        speculativeLegacyReq = null;
        speculativeLegacyOutcome = null;
      }
    };

    try {
    let detection = null;
    let platformError = null;
    let initialPlatformInfo = null;
    // A platform open already performs source-backed format detection. Reuse that
    // parsed result instead of sending the same File through detect() and open().
    try {
      initialPlatformInfo = await step(this._callTo('platform', 'open', { file }, null, (p) => this.onAnalysisProgress?.(p)));
      detection = initialPlatformInfo?.detection ?? initialPlatformInfo?.detected ?? {
        formatId: initialPlatformInfo?.formatId || initialPlatformInfo?.capability?.format || 'unknown',
      };
    } catch (error) {
      if (error?.stale) { cancelSpeculativeLegacy(); throw error; }
      platformError = error;
    }
    assertCurrent();

    let nextFormat = 'unknown';
    let nextPlatform = null;
    let nextLegacy = null;
    let nextBridge = false;
    let result = null;
    if (detection?.formatId === 'macho') {
      nextFormat = 'macho';
      const legacy = await awaitLegacyOpen();
      const normalized = initialPlatformInfo;
      assertCurrent();
      legacy.formatId = 'macho';
      for (const slice of legacy.slices || []) slice.capability = legacySliceCapability(slice);
      legacy.capability = legacy.slices?.[0]?.capability || legacySliceCapability(null);
      legacy.platform = {
        compatibility:'hybrid-macho', sourceBackedDetection:true, detected:detection,
        normalizedDyldTruth:!!normalized, duplicateUniversalParseAvoided:false,
        platformSelectedSliceReparseAvoided:normalized?.platform?.selectedSliceParseReused === true,
        legacyCompatibilityParseRequired:true,
        ...(platformError ? { normalizedDyldError: platformError.message } : {}),
      };
      nextLegacy = legacy;
      nextPlatform = normalized
        ? { ...normalized, normalizedDyldTruth:true, compatibility:'hybrid-macho' }
        : { formatId:'macho', capability:legacy.capability, detection, normalizedDyldTruth:false, compatibility:'legacy-macho' };
      result = legacy;
    } else {
      const platformInfo = initialPlatformInfo;
      assertCurrent();
      if (platformInfo) {
        nextPlatform = platformInfo;
        nextFormat = platformInfo.formatId || platformInfo.capability?.format || detection?.formatId || 'unknown';
        const capability = platformInfo.capability || platformInfo.slices?.[0]?.capability;
        nextBridge = capability?.architecture === 'arm64';
        if (nextBridge) {
          try {
            await awaitLegacyOpen();
            const allRegions=[...(platformInfo.slices||[]).flatMap((slice)=>slice.regions||[]),platformInfo.raw].filter(Boolean);
            await step(this._callTo('legacy','setRegions',{regions:allRegions}));
          } catch (error) {
            if (error?.stale) throw error;
            nextBridge=false;
          }
        } else {
          cancelSpeculativeLegacy();
        }
        result=platformInfo;
      } else {
        const legacy=await awaitLegacyOpen();
        const fallbackFormatId = legacyFallbackFormatId(legacy);
        assertCurrent();
        if (fallbackFormatId === null) {
          const error = new Error('Legacy fallback could not determine a supported binary format; open failed.');
          error.code = 'BACKEND_LEGACY_FORMAT_UNSUPPORTED';
          throw error;
        }
        nextLegacy=legacy;
        if (fallbackFormatId === 'macho') {
          nextFormat='macho';
          legacy.formatId = 'macho';
          for (const slice of legacy.slices || []) slice.capability = legacySliceCapability(slice);
          legacy.capability = legacy.slices?.[0]?.capability || legacySliceCapability(null);
          legacy.platform = {
            compatibility:'legacy-macho', sourceBackedDetection:false, detected:detection,
            normalizedDyldTruth:false, duplicateUniversalParseAvoided:false,
            platformSelectedSliceReparseAvoided:false, legacyCompatibilityParseRequired:true,
            ...(platformError ? { normalizedDyldError: platformError.message } : {}),
          };
          nextPlatform = { formatId:'macho', capability:legacy.capability, detection:detection||{formatId:'macho'}, normalizedDyldTruth:false, compatibility:'legacy-macho', fallbackFromPlatformFailure:true };
        } else {
          if (platformError && legacy.format === 'Raw binary') legacy.warnings=[...(legacy.warnings||[]),platformError.message];
        }
        result=legacy;
      }
    }
    assertCurrent();
    this.advanceEpoch();
    this.file=file;
    this.formatId=nextFormat;
    this._activeMachArchitecture=null;
    this.platformInfo=nextPlatform;
    this.legacyInfo=nextLegacy;
    this.arm64Bridge=nextBridge;
    this.contentHash=null;
    this.binaryId=null;
    this._binaryIdFlight?.controller.abort(cancelledRequestError('Binary identity superseded by a new file.'));
    this._binaryIdFlight=null;
    this._binaryIdPromise=null;
    return result;
    } finally {
      cancelSpeculativeLegacy();
    }
  }

  probe() {
    if (this.formatId === 'macho' || this.arm64Bridge) return this._callTo('legacy', 'probe', {});
    return this._callTo('platform', 'probe', {});
  }

  probeArchitectures() {
    if (this.disposed) return Promise.resolve({ ok:false, error:'Backend has been disposed.', support:{ arm64:false, x86_64:false } });
    if (this._archProbe) return this._archProbe;
    // Capstone capability is a property of the engine runtime, not of the
    // binary this Backend has open, so a settled probe result stays valid for
    // the Backend lifetime. Regenerating a probe Worker (plus its WASM module
    // init) per sequential decode makes every disassembly pay a fixed
    // re-probe tax; only failure results are retried (#5957).
    if (this._archProbeResult) return Promise.resolve(this._archProbeResult);
    this._archProbe = new Promise((resolve) => {
      const worker = new Worker(new URL('./platform/capstone-probe-worker.js', import.meta.url));
      this._archProbeWorker = worker;
      let finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        if (this._archProbeWorker === worker) this._archProbeWorker = null;
        try { worker.terminate(); } catch { /* best effort */ }
        resolve(value);
      };
      this._archProbeFinish = finish;
      worker.onmessage = (event) => finish(event.data);
      const fail = (event) => finish({ ok: false, error: event?.message || 'architecture probe worker failed', support: { arm64: false, x86_64: false } });
      worker.onerror = fail;
      worker.onmessageerror = fail;
      try { worker.postMessage({ t: 'probe' }); }
      catch (error) { finish({ ok:false, error:error.message, support:{ arm64:false, x86_64:false } }); }
    }).then((value) => {
      if (value?.ok === true) this._archProbeResult = freezeArchitectureProbeResult(value);
      return value;
    }).finally(() => { this._archProbe = null; this._archProbeFinish = null; });
    return this._archProbe;
  }

  registerRegions(regions) {
    const jobs = [this._callTo('platform', 'setRegions', { regions })];
    if (this.formatId === 'macho' || this.arm64Bridge) jobs.push(this._callTo('legacy', 'setRegions', { regions }));
    return Promise.all(jobs).then(() => ({ ok: true }));
  }

  search(params, onProgress) {
    const architecture = String(params?.architecture || this._activeMachArchitecture || this.platformInfo?.capability?.architecture || '').toLowerCase();
    if (this.formatId === 'macho' && architecture && !isLegacyMachArchitecture(architecture) && params?.kind !== 'hex' && params?.kind !== 'text') {
      return this._callTo('platform', 'search', params, null, onProgress);
    }
    return this.call('search', params, null, onProgress);
  }

  cancel(request) {
    const requestId = typeof request === 'number' ? request : request?.requestId ?? this.lastRequestId;
    if (requestId == null) return false;
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    if (typeof pending.onCancel === 'function') {
      try { pending.onCancel(); } catch { /* local settlement is authoritative */ }
    } else {
      try { this._worker(pending.workerName).postMessage({ t: 'cancel', requestId, epoch: pending.transportEpoch }); } catch { /* local settlement is authoritative */ }
    }
    pending.reject(cancelledRequestError());
    return true;
  }

  cancelSearch(request) {
    if (request == null) return false;
    return this.cancel(request);
  }

  analyze(sliceIndex, options = {}) {
    if (this.formatId === 'macho') {
      const capability = this.legacyInfo?.slices?.[sliceIndex]?.capability
        || this.platformInfo?.slices?.[sliceIndex]?.capability
        || this.platformInfo?.capability;
      const architecture = String(capability?.architecture || '').toLowerCase();
      if (architecture) this._activeMachArchitecture = architecture;
    }
    const explicitRoute = Object.hasOwn(options, 'route');
    const route = normalizeAnalysisRoute(options.route ?? this.analysisRoute);
    if (route === ANALYSIS_ORCHESTRATION_ROUTE.CURRENT) return this._analyzeCurrent(sliceIndex, options);
    if (explicitRoute) return this._analyzeArtifact(sliceIndex, options);
    return this._analyzeArtifactPublic(sliceIndex, options);
  }

  _analyzeCurrent(sliceIndex, options = {}) {
    if (this.formatId !== 'macho') {
      return awaitCancellableProducer(this._callTo('platform', 'analyze', { sliceIndex }), options.signal);
    }
    return this._analyzeCurrentMachO(sliceIndex, options);
  }

  async _analyzeCurrentMachO(sliceIndex, options = {}) {
    const uiEpoch = this.gen, transportEpoch = this.transportEpoch, file = this.file;
    const assertCurrent = () => {
      if (uiEpoch !== this.gen || transportEpoch !== this.transportEpoch || file !== this.file) throw new StaleRequestError();
    };
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
    const wantNormalized = !!this.platformInfo?.normalizedDyldTruth;
    const legacyReq = this._callTo('legacy', 'analyze', { sliceIndex });
    const legacyPromise = awaitCancellableProducer(legacyReq, options.signal);
    let platformReq = null;
    let normalizedOutcome = null;
    if (wantNormalized) {
      platformReq = this._callTo('platform', 'analyze', { sliceIndex });
      normalizedOutcome = awaitCancellableProducer(platformReq, options.signal).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
    }
    let enriched;
    try {
      const legacy = await legacyPromise;
      assertCurrent();
      enriched = await augmentAnalysisResultWithChainedImports(file, sliceIndex, legacy);
      assertCurrent();
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
    } catch (error) {
      try { platformReq?.cancel?.(); } catch { /* best effort */ }
      throw error;
    }
    if (!normalizedOutcome) {
      return markMachOSymbolTruthIncomplete(enriched, this.legacyInfo?.platform?.normalizedDyldError || 'normalized-macho-analysis-unavailable');
    }
    const outcome = await normalizedOutcome;
    if (outcome.ok) {
      assertCurrent();
      return mergeMachOAnalysisResults(enriched, outcome.value);
    }
    const error = outcome.error;
    if (error?.name === 'AbortError' || options.signal?.aborted) throw options.signal?.reason ?? error;
    if (error?.stale) throw error;
    assertCurrent();
    return markMachOSymbolTruthIncomplete(enriched, error?.message || 'normalized-macho-analysis-failed');
  }

  _analysisArtifactDescriptor(sliceIndex, options = {}) {
    const capability = this.formatId === 'macho'
      ? (this.legacyInfo?.slices?.[sliceIndex]?.capability || this.platformInfo?.slices?.[sliceIndex]?.capability || this.platformInfo?.capability)
      : (this.platformInfo?.slices?.[sliceIndex]?.capability || this.platformInfo?.capability);
    const architecture = capability?.architecture || 'unknown';
    return createWorkerAnalysisArtifactDescriptor({
      binaryId:options.binaryId,
      sliceIndex:Number(sliceIndex),
      architecture,
      artifactKind:'backend-analysis-result',
      producerVersion:options.producerVersion ?? BACKEND_ANALYSIS_ARTIFACT_VERSIONS.producer,
      loaderVersion:options.loaderVersion ?? BACKEND_ANALYSIS_ARTIFACT_VERSIONS.loader,
      architectureSemanticVersion:options.architectureSemanticVersion ?? BACKEND_ANALYSIS_ARTIFACT_VERSIONS.architectureSemantic,
      abiSemanticVersion:options.abiSemanticVersion ?? BACKEND_ANALYSIS_ARTIFACT_VERSIONS.abiSemantic,
      semanticSchemaVersion:options.semanticSchemaVersion ?? BACKEND_ANALYSIS_ARTIFACT_VERSIONS.semanticSchema,
      config:{ sliceIndex:Number(sliceIndex), formatId:this.formatId, architecture, ...(options.config || {}) },
      originRefs:[`binary:${String(options.binaryId || '')}`],
    });
  }

  _semanticFunctionArtifactDescriptor(options = {}) {
    const abiId = String(options.abiId || '');
    if (!abiId) throw new TypeError('semantic-function-abi-id-required');
    const architecture = String(options.architecture || 'x86_64');
    const target = semanticFunctionTarget(architecture);
    return createWorkerAnalysisArtifactDescriptor({
      binaryId:options.binaryId,
      sliceIndex:Number(options.sliceIndex ?? 0),
      architecture,
      artifactKind:target.artifactKind,
      producerVersion:target.analysisVersion,
      loaderVersion:BACKEND_ANALYSIS_ARTIFACT_VERSIONS.loader,
      architectureSemanticVersion:target.architectureSemanticVersion,
      abiSemanticVersion:`${abiId}@${String(options.abiSemanticVersion || '1')}`,
      semanticSchemaVersion:target.schemaVersion,
      config:{
        address:BigInt(options.address).toString(),
        length:Number(options.length),
        architecture,
        abiId,
        platform:String(options.platform || 'unknown'),
        decoderSemanticVersion:target.decoderSemanticVersion,
        analysisVersion:target.analysisVersion,
        functionPrototype:options.functionPrototype ?? null,
        dataEndianness:String(options.dataEndianness || 'unknown'),
        instructionEndianness:String(options.instructionEndianness || 'unknown'),
        ...(options.riscvIsa == null ? {} : { riscvIsa:options.riscvIsa }),
      },
      keyExtras:{
        decoderContract:target.decoderContract,
        decoderSemanticVersion:target.decoderSemanticVersion,
        semanticRoute:'machine-effects>semantic-ir-v2>cfg>ssa>memoryssa>compat>shared-decompiler',
      },
      upstreamArtifactIds:options.upstreamArtifactIds ?? [],
      originRefs:[`binary:${String(options.binaryId)}`, `virtual-address:${BigInt(options.address).toString()}`],
    });
  }

  /**
   * Production Backend/API orchestration for the shared semantic-function
   * route. It adds no legacy fallback and promotes no capability by itself: the
   * architecture must already be registered with an exact lifter and a
   * supported calling convention.
   */
  async analyzeSemanticFunction(options = {}) {
    const address = semanticFunctionAddress(options.address);
    const length = requirePrimitiveSafeInteger(options.length, 'semantic-function-bounded-length-required');
    if (length < 1 || length > X86_SEMANTIC_FUNCTION_MAX_DECODE_BYTES) {
      throw new TypeError('semantic-function-bounded-length-required');
    }
    const architecture = options.architecture == null || options.architecture === ''
      ? 'x86_64'
      : requirePrimitiveString(options.architecture, 'semantic-function-architecture-required');
    const target = semanticFunctionTarget(architecture);
    const abiId = options.abiId == null || options.abiId === ''
      ? ''
      : requirePrimitiveString(options.abiId, 'semantic-function-abi-id-required');
    if (!target.abiIds.includes(abiId)) throw new TypeError(`semantic-function-${architecture}-abi-required`);
    const sliceIndex = options.sliceIndex == null
      ? 0
      : requirePrimitiveSafeInteger(options.sliceIndex, 'semantic-function-slice-index-required');
    if (sliceIndex < 0) throw new TypeError('semantic-function-slice-index-required');
    const formatMetadata = this.platformInfo?.productDescriptor?.formatMetadata
      || this.platformInfo?.slices?.[sliceIndex]?.info?.descriptor?.formatMetadata
      || {};
    const dataEndianness = String(options.dataEndianness || formatMetadata.endian || this.platformInfo?.capability?.endianness || 'unknown');
    const instructionEndianness = String(options.instructionEndianness || (architecture === 'arm64' ? 'little' : dataEndianness));
    const riscvIsa = architecture === 'riscv64'
      ? (options.riscvIsa || resolveRiscvIsaProfile(formatMetadata.riscvIsa, address, { allowAssumed:true }))
      : null;
    const binaryId = options.binaryId ?? await this.ensureBinaryId({ signal:options.signal, onProgress:options.onIdentityProgress });
    const descriptor = this._semanticFunctionArtifactDescriptor({
      ...options, architecture, binaryId, address, length, abiId, dataEndianness, instructionEndianness, riscvIsa,
    });
    const uiEpoch = this.gen, transportEpoch = this.transportEpoch, file = this.file;
    const result = await this._artifactRuntime().request({
      descriptor,
      signal:options.signal ?? null,
      budget:options.budget ?? null,
      priority:options.priority ?? 'current',
      // Artifact completeness describes whether this bounded analysis request
      // finished, not whether every decoded instruction has exact semantics.
      completeness:options.completeness ?? 'complete',
      validate:(payload) => payload?.route === 'phase5-shadow-v2'
        && payload?.pipeline?.instrumentation?.v2Executed === true
        && payload?.abiId === abiId,
      creation:{ backend:'Backend', route:'phase5-shadow-v2', abiId, address:address.toString(), length },
      produce:async ({ signal }) => {
        const decoded = await this.disassembleAt(address, { architecture, length, signal, riscvIsa });
        if (!decoded?.supported || !decoded?.found || !decoded.instructions?.length) throw new Error(`semantic-function-${architecture}-decode-unavailable`);
        const decodedWithOrigins = decoded.instructions.map((instruction) => {
          const instructionAddress = BigInt(instruction.address);
          const instructionLength = Number(instruction.length ?? instruction.size);
          const relative = instructionAddress - address;
          const byteStart = decoded.fileOffset == null ? null : BigInt(decoded.fileOffset) + relative;
          return {
            ...instruction,
            origin:{
              byteRanges:byteStart == null ? [] : [{ binaryId, start:byteStart, length:instructionLength }],
              virtualRanges:[{ sliceId:descriptor.sliceId, start:instructionAddress, length:instructionLength }],
            },
          };
        });
        return await awaitCancellableProducer(this._callTo('platform', 'semanticFunction', {
          input:{
            binaryId,
            sliceId:descriptor.sliceId,
            architecture,
            platform:options.platform || target.defaultPlatform(this.formatId),
            abiId,
            decoderSemanticVersion:target.decoderSemanticVersion,
            analysisVersion:target.analysisVersion,
            instructions:decodedWithOrigins,
            name:options.name,
            functionPrototype:options.functionPrototype ?? null,
            dataEndianness,
            instructionEndianness,
            ...(riscvIsa == null ? {} : { architectureProfile:riscvIsa }),
            machineEffectsContext:{
              dataEndianness,
              instructionEndianness,
              ...(riscvIsa?.instructionAlignment == null ? {} : { instructionAlignment:Number(riscvIsa.instructionAlignment) }),
            },
          },
        }), signal);
      },
    });
    if (uiEpoch !== this.gen || transportEpoch !== this.transportEpoch || file !== this.file) {
      await this._artifactRuntime().store.delete(descriptor.artifactId).catch(() => {});
      throw new StaleRequestError();
    }
    return Object.freeze({ ...result.payload, artifactId:descriptor.artifactId, reused:result.reused === true });
  }

  async ensureBinaryId(options = {}) {
    if (this.binaryId) return this.binaryId;
    if (!this.file) throw new Error('binary-id-file-unavailable');
    if (options.signal?.aborted) throw cancelledRequestError(String(options.signal.reason || 'Binary identity request cancelled.'));
    const file = this.file;
    let flight = this._binaryIdFlight;
    if (flight?.controller.signal.aborted && flight.waiters.size === 0) {
      if (this._binaryIdFlight === flight) this._binaryIdFlight = null;
      if (this._binaryIdPromise === flight.promise) this._binaryIdPromise = null;
      flight = null;
    }
    if (!flight) {
      const controller = new AbortController();
      flight = { file, controller, waiters:new Set(), settled:false, promise:null };
      flight.promise = sha256BlobHex(file, {
        chunkBytes:options.chunkBytes,
        signal:controller.signal,
        onProgress:(progress) => {
          for (const waiter of flight.waiters) {
            try { waiter.onProgress?.(progress); } catch { /* progress observers cannot own the producer */ }
          }
        },
      }).then((result) => {
        if (this.file !== file) throw new StaleRequestError();
        const binaryId = createBinaryIdFromDigest(result.hex);
        this.binaryId = binaryId;
        return binaryId;
      }).finally(() => {
        flight.settled = true;
        if (this._binaryIdFlight === flight) this._binaryIdFlight = null;
        if (this._binaryIdPromise === flight.promise) this._binaryIdPromise = null;
      });
      flight.promise.catch(() => {});
      this._binaryIdFlight = flight;
      this._binaryIdPromise = flight.promise;
    }
    const signal = options.signal ?? null;
    const waiter = { onProgress:typeof options.onProgress === 'function' ? options.onProgress : null };
    flight.waiters.add(waiter);
    return new Promise((resolve, reject) => {
      let done = false;
      const detach = (consumerCancelled = false) => {
        if (done) return;
        done = true;
        signal?.removeEventListener?.('abort', onAbort);
        flight.waiters.delete(waiter);
        if (consumerCancelled && !flight.settled && flight.waiters.size === 0) {
          flight.controller.abort(cancelledRequestError('Binary identity has no active consumers.'));
        }
      };
      const onAbort = () => {
        detach(true);
        reject(cancelledRequestError(String(signal?.reason || 'Binary identity request cancelled.')));
      };
      signal?.addEventListener?.('abort', onAbort, { once:true });
      if (signal?.aborted) return onAbort();
      flight.promise.then(
        (value) => { detach(false); resolve(value); },
        (error) => { detach(false); reject(error); },
      );
    });
  }

  async _analyzeArtifactPublic(sliceIndex, options = {}) {
    const binaryId = options.binaryId ?? await this.ensureBinaryId({ signal:options.signal, onProgress:options.onIdentityProgress });
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
    return this._analyzeArtifact(sliceIndex, {
      ...options,
      binaryId,
      completeness:Object.hasOwn(options, 'completeness') ? options.completeness : DEFAULT_ARTIFACT_COMPLETENESS,
    });
  }

  async _analyzeArtifact(sliceIndex, options = {}) {
    if (!Object.hasOwn(options, 'completeness')) throw new TypeError('analysis-artifact-completeness-required');
    const uiEpoch = this.gen, transportEpoch = this.transportEpoch, file = this.file;
    const descriptor = this._analysisArtifactDescriptor(sliceIndex, options);
    if (uiEpoch !== this.gen || transportEpoch !== this.transportEpoch || file !== this.file) throw new StaleRequestError();
    const result = await this._artifactRuntime().request({
      descriptor,
      signal:options.signal ?? null,
      budget:options.budget ?? null,
      priority:options.priority ?? 'current',
      completeness:options.completeness,
      validate:options.validate ?? null,
      creation:{ backend:'Backend', formatId:this.formatId, sliceIndex:Number(sliceIndex) },
      produce:({ signal }) => this._analyzeCurrent(sliceIndex, { ...options, route:ANALYSIS_ORCHESTRATION_ROUTE.CURRENT, signal }),
    });
    if (uiEpoch !== this.gen || transportEpoch !== this.transportEpoch || file !== this.file) {
      await this._artifactRuntime().store.delete(descriptor.artifactId).catch(() => {});
      throw new StaleRequestError();
    }
    return result.payload;
  }

  guessFunctions(regionId, limit, onProgress, options = {}) {
    const architecture = String(options.architecture || this._activeMachArchitecture || this.platformInfo?.capability?.architecture || '').toLowerCase();
    if (this.formatId === 'macho' && architecture && !isLegacyMachArchitecture(architecture)) {
      return this._callTo('platform', 'guessFunctions', { regionId, limit, architecture }, null, onProgress);
    }
    return this.call('guessFunctions', { regionId, limit }, null, onProgress);
  }
  _ensureScanPool() {
    if (!this._scanPool) {
      this._scanPool = new ScanWorkerPool({
        maxWorkers: computeMaxScanWorkers({ document: { hidden: false } }),
        workerFactory: this._scanWorkerFactory || undefined,
      });
    }
    return this._scanPool;
  }

  _resolveScanEffectiveArch(limits = null) {
    const machArch = this.formatId === 'macho'
      ? (this._activeMachArchitecture || this.legacyInfo?.slices?.[0]?.capability?.architecture || '')
      : '';
    return String(limits?.architecture || machArch || this.platformInfo?.capability?.architecture || '').toLowerCase();
  }

  _canUseParallelScan(effectiveArch) {
    return (!effectiveArch || isLegacyMachArchitecture(effectiveArch))
      && !!(this.file && typeof this.file.slice === 'function')
      && (typeof Worker !== 'undefined' || typeof this._scanWorkerFactory === 'function')
      && !(typeof document !== 'undefined' && document.hidden);
  }

  _orchestrateParallelScan(onProgress, executor) {
    const outerId = this.seq++;
    this.lastRequestId = outerId;
    const uiEpoch = this.gen;
    const transportEpoch = this.transportEpoch;
    const scanEpoch = this._scanEpoch;
    const sourceFile = this.file;

    let settled = false;
    let aborted = false;
    let activeChild = null;
    let outerResolve = null;
    let outerReject = null;

    const isCurrent = () => !aborted
      && !this.disposed
      && uiEpoch === this.gen
      && transportEpoch === this.transportEpoch
      && scanEpoch === this._scanEpoch
      && sourceFile === this.file;

    const currentAbortError = () => {
      if (this.disposed) return disposedBackendError();
      if (uiEpoch !== this.gen || transportEpoch !== this.transportEpoch || scanEpoch !== this._scanEpoch || sourceFile !== this.file) {
        return new StaleRequestError();
      }
      return cancelledRequestError();
    };

    const setActiveChild = (child) => {
      activeChild = child;
      if (aborted && child) {
        activeChild = null;
        try {
          if (typeof child.cancel === 'function') child.cancel();
          else if (typeof child === 'function') child();
        } catch { /* best effort */ }
      }
    };

    const clearActiveChild = (child) => {
      if (child == null || activeChild === child) activeChild = null;
    };

    const cancelActiveChild = () => {
      const child = activeChild;
      activeChild = null;
      if (!child) return;
      try {
        if (typeof child.cancel === 'function') child.cancel();
        else if (typeof child === 'function') child();
      } catch { /* best effort */ }
    };

    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      this.pending.delete(outerId);
      outerResolve(value);
    };

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      this.pending.delete(outerId);
      outerReject(error);
    };

    const promise = new Promise((resolve, reject) => {
      outerResolve = resolve;
      outerReject = reject;
      this.pending.set(outerId, {
        resolve: finishResolve,
        reject: finishReject,
        uiEpoch,
        transportEpoch,
        workerName: 'scan-pool',
        onProgress: typeof onProgress === 'function' ? onProgress : null,
        onCancel: () => {
          aborted = true;
          cancelActiveChild();
        },
      });
    });
    promise.requestId = outerId;
    promise.cancel = () => this.cancel(outerId);

    (async () => {
      try {
        return await executor({
          outerId,
          uiEpoch,
          transportEpoch,
          scanEpoch,
          sourceFile,
          isCurrent,
          currentAbortError,
          setActiveChild,
          clearActiveChild,
        });
      } finally {
        activeChild = null;
        this.pending.delete(outerId);
      }
    })().then(finishResolve, finishReject);

    return promise;
  }

  classifyExecutableCoverage({ gaps, regionIds, architecture, endian } = {}) {
    if (this._engineWorker('readAt') !== 'legacy' || !isAarch64Architecture(architecture)) {
      const promise = Promise.resolve(null);
      promise.requestId = null;
      promise.cancel = () => {};
      return promise;
    }
    return this._callTo('legacy', 'classifyExecutableCoverage', { gaps, regionIds, endian });
  }

  scanProgram(regionId, onProgress, limits = {}) {
    if (this.disposed) return rejectedDisposedRequest();
    const effectiveArch = this._resolveScanEffectiveArch(limits);
    const payload = { regionId, ...limits };
    if (this.formatId === 'macho' && effectiveArch) {
      if (!isLegacyMachArchitecture(effectiveArch)) {
        return this._callTo('platform', 'scanProgram', payload, null, onProgress);
      }
    } else if (this._engineWorker('scanProgram') !== 'legacy') {
      return this._callTo('platform', 'scanProgram', payload, null, onProgress);
    }

    if (!this._canUseParallelScan(effectiveArch)) {
      return this._callTo('legacy', 'scanProgram', payload, null, onProgress);
    }

    return this._orchestrateParallelScan(onProgress, async ({
      outerId,
      uiEpoch,
      transportEpoch,
      scanEpoch,
      sourceFile,
      isCurrent,
      currentAbortError,
      setActiveChild,
      clearActiveChild,
    }) => {
      const runLegacyFallback = async () => {
        if (!isCurrent()) throw currentAbortError();
        const fallbackReq = this._callTo('legacy', 'scanProgram', payload, null, onProgress, { trackLastRequest: false });
        setActiveChild(fallbackReq);
        try {
          return await fallbackReq;
        } finally {
          clearActiveChild(fallbackReq);
        }
      };

      let meta = null;
      const metaReq = this._callTo('legacy', 'getScanMeta', { regionId }, null, null, { trackLastRequest: false });
      setActiveChild(metaReq);
      try {
        meta = await metaReq;
      } catch (error) {
        clearActiveChild(metaReq);
        if (!isCurrent()) throw currentAbortError();
        if (isFatalScanError(error)) throw error;
        return await runLegacyFallback();
      }
      clearActiveChild(metaReq);
      if (!isCurrent()) throw currentAbortError();

      const region = meta?.region;
      const regionSize = region ? Number(region.size) : 0;
      const thresholdBytes = Math.max(0, Number(this._parallelScanThresholdBytes ?? DEFAULT_PARALLEL_SCAN_THRESHOLD_BYTES));
      if (!region || meta.hasDataInCode || !Number.isFinite(regionSize) || regionSize < thresholdBytes) {
        return await runLegacyFallback();
      }

      const isMobile = isMobileDevice();
      const maxWorkers = computeMaxScanWorkers();
      if (maxWorkers < 2) {
        return await runLegacyFallback();
      }

      const chunks = planProgramChunks({
        region,
        functionStarts: meta.functionStarts,
        maxWorkers,
        isMobile,
        parallelThresholdBytes: thresholdBytes,
      });
      if (!Array.isArray(chunks) || chunks.length < 2) {
        return await runLegacyFallback();
      }

      const pool = this._ensureScanPool();
      const totalBytes = regionSize;
      const stage1DoneByChunk = new Float64Array(chunks.length);
      const stage2DoneByChunk = new Float64Array(chunks.length);
      const stage2HitsByChunk = new Float64Array(chunks.length);
      let lastProgressAt = 0;

      const emitProgress = (force = false) => {
        if (!isCurrent()) return;
        const handler = typeof onProgress === 'function' ? onProgress : this.onScanProgress;
        if (typeof handler !== 'function') return;
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (!force && now - lastProgressAt < SCAN_PROGRESS_THROTTLE_MS) return;
        lastProgressAt = now;
        let stage1Done = 0;
        let stage2Done = 0;
        let hits = 0;
        for (let i = 0; i < chunks.length; i++) {
          stage1Done += stage1DoneByChunk[i];
          stage2Done += stage2DoneByChunk[i];
          hits += stage2HitsByChunk[i];
        }
        const done = Math.min(totalBytes, Math.floor(stage1Done * 0.2 + stage2Done * 0.8));
        try {
          handler({ t: 'scanProgress', requestId: outerId, epoch: transportEpoch, done, all: totalBytes, hits });
        } catch { /* progress observers cannot own the producer */ }
      };

      // Stage 1: parallel local backward loop kills + cross-chunk forward targets
      const stage1Jobs = [];
      const cancelStage1 = () => cancelJobList(stage1Jobs);
      setActiveChild(cancelStage1);
      for (const chunk of chunks) {
        const job = pool.runTask({
          t: 'scanStage1',
          payload: {
            file: sourceFile,
            region,
            chunkIndex: chunk.chunkIndex,
            chunkStart: chunk.chunkStart,
            chunkEnd: chunk.chunkEnd,
            functionStarts: chunk.functionStarts,
          },
          epoch: scanEpoch,
          requestId: outerId,
          onProgress: (msg) => {
            if (!isCurrent()) return;
            stage1DoneByChunk[chunk.chunkIndex] = Math.min(chunk.chunkEnd - chunk.chunkStart, Number(msg?.done || 0));
            emitProgress(false);
          },
        });
        job.catch(() => {});
        stage1Jobs.push(job);
      }

      let stage1Results;
      try {
        stage1Results = await Promise.all(stage1Jobs);
      } catch (error) {
        cancelStage1();
        clearActiveChild(cancelStage1);
        stage1Jobs.length = 0;
        if (!isCurrent()) throw currentAbortError();
        if (isPoolNonFallbackError(error)) throw error;
        return await runLegacyFallback();
      }
      clearActiveChild(cancelStage1);
      if (!isCurrent()) throw currentAbortError();
      for (let i = 0; i < chunks.length; i++) {
        stage1DoneByChunk[i] = chunks[i].chunkEnd - chunks[i].chunkStart;
      }
      emitProgress(false);

      const incomingByChunk = routeCrossChunkForwardTargets(chunks, stage1Results);

      // Stage 2: strictly ascending chunkIndex waves with adaptive concurrency & fail-fast
      const words = Math.floor(regionSize / 4);
      const globalCallCap = capOf(limits?.callLimit, MAX_PROGRAM_EDGES);
      const globalRefCap = capOf(limits?.refLimit, MAX_PROGRAM_REFS);
      const globalKindCap = capOf(limits?.kindLimit, MAX_PROGRAM_KIND_WORDS);

      let kinds = new Uint8Array(Math.min(words, globalKindCap));
      const liveByteCeiling = isMobile ? PROGRAM_INDEX_BUDGET_BYTES : Math.floor(PROGRAM_INDEX_BUDGET_BYTES * 1.5);
      const stage2Results = new Array(chunks.length).fill(null);
      let callsSoFar = 0;
      let refsSoFar = 0;
      let accumulatedChunkBytes = 0;
      let needLegacyFallback = false;

      const releaseParallelBuffers = () => {
        kinds = null;
        for (let i = 0; i < stage2Results.length; i++) {
          const res = stage2Results[i];
          if (res) {
            res.callFrom = null;
            res.callTo = null;
            res.refFrom = null;
            res.refTo = null;
            res.refKind = null;
            res.kinds = null;
            stage2Results[i] = null;
          }
        }
        for (let i = 0; i < stage1Results.length; i++) {
          const s1 = stage1Results[i];
          if (s1) {
            s1.crossChunkForwardTargets = null;
            s1.loopKillAddrs = null;
            s1.loopKillMasks = null;
            stage1Results[i] = null;
          }
        }
        if (Array.isArray(incomingByChunk)) incomingByChunk.fill(null);
      };

      let nextChunkIdx = 0;
      while (nextChunkIdx < chunks.length) {
        if (!isCurrent()) {
          releaseParallelBuffers();
          throw currentAbortError();
        }
        const remainingBudget = Math.max(0, liveByteCeiling - (kinds ? kinds.byteLength : 0) - accumulatedChunkBytes);
        const hiddenCap = (typeof document !== 'undefined' && document.hidden) ? 1 : maxWorkers;
        const waveMax = Math.min(hiddenCap, chunks.length - nextChunkIdx);
        const waveInfo = computeWaveConcurrency({
          remainingBudget,
          maxWaveWorkers: waveMax,
          isMobile,
          hidden: typeof document !== 'undefined' && !!document.hidden,
        });
        const activeWaveWorkers = Math.max(1, Math.min(waveMax, waveInfo));
        const chunkBudgetBytes = Math.floor(remainingBudget / activeWaveWorkers);

        const waveCallLimit = Math.max(0, globalCallCap - callsSoFar);
        const waveRefLimit = Math.max(0, globalRefCap - refsSoFar);
        const waveChunks = chunks.slice(nextChunkIdx, nextChunkIdx + activeWaveWorkers);
        nextChunkIdx += waveChunks.length;

        const waveJobs = [];
        const cancelWave = () => cancelJobList(waveJobs);
        setActiveChild(cancelWave);
        let waveFailed = false;
        let waveError = null;

        const wavePromises = waveChunks.map((chunk) => {
          const s1 = stage1Results[chunk.chunkIndex];
          const job = pool.runTask({
            t: 'scanProgramChunk',
            payload: {
              file: sourceFile,
              region,
              chunkIndex: chunk.chunkIndex,
              chunkStart: chunk.chunkStart,
              chunkEnd: chunk.chunkEnd,
              functionStarts: chunk.functionStarts,
              stringRanges: meta.stringRanges,
              incomingForwardTargets: incomingByChunk[chunk.chunkIndex],
              loopKillAddrs: s1?.loopKillAddrs,
              loopKillMasks: s1?.loopKillMasks,
              callLimit: waveCallLimit,
              refLimit: waveRefLimit,
              globalKindCap,
              chunkBudgetBytes,
            },
            epoch: scanEpoch,
            requestId: outerId,
            onProgress: (msg) => {
              if (!isCurrent()) return;
              stage2DoneByChunk[chunk.chunkIndex] = Math.min(chunk.chunkEnd - chunk.chunkStart, Number(msg?.done || 0));
              stage2HitsByChunk[chunk.chunkIndex] = Number(msg?.hits || 0);
              emitProgress(false);
            },
          });
          job.catch(() => {});
          waveJobs.push(job);
          if (s1) {
            s1.crossChunkForwardTargets = null;
            s1.loopKillAddrs = null;
            s1.loopKillMasks = null;
            stage1Results[chunk.chunkIndex] = null;
          }
          return job.then((res) => {
            if (waveFailed || needLegacyFallback || !isCurrent()) return;
            if (res?.kinds && kinds) {
              const wordBase = chunk.wordBase ?? Math.floor(chunk.chunkStart / 4);
              const copyLen = Math.min(res.kinds.length, Math.max(0, kinds.length - wordBase));
              if (copyLen > 0) {
                kinds.set(copyLen === res.kinds.length ? res.kinds : res.kinds.subarray(0, copyLen), wordBase);
              }
              res.kinds = null;
            }
            stage2Results[chunk.chunkIndex] = res;
            const cCount = Number(res?.callCount ?? res?.callFrom?.length ?? 0);
            const rCount = Number(res?.refCount ?? res?.refFrom?.length ?? 0);
            callsSoFar += cCount;
            refsSoFar += rCount;
            accumulatedChunkBytes += (res?.callFrom?.byteLength || 0)
              + (res?.callTo?.byteLength || 0)
              + (res?.refFrom?.byteLength || 0)
              + (res?.refTo?.byteLength || 0)
              + (res?.refKind?.byteLength || 0);
            stage2DoneByChunk[chunk.chunkIndex] = chunk.chunkEnd - chunk.chunkStart;
            stage2HitsByChunk[chunk.chunkIndex] = cCount + rCount;
            emitProgress(false);

            const clampedBytes = Math.min(callsSoFar, globalCallCap) * 16
              + Math.min(refsSoFar, globalRefCap) * 17
              + (kinds ? kinds.byteLength : 0);
            if (res?.budgetCapped === true || clampedBytes > PROGRAM_INDEX_BUDGET_BYTES) {
              needLegacyFallback = true;
              cancelWave();
            }
          }, (error) => {
            if (needLegacyFallback) return;
            if (!waveFailed) {
              waveFailed = true;
              waveError = error;
              cancelWave();
            }
          });
        });

        await Promise.all(wavePromises);
        clearActiveChild(cancelWave);

        if (!isCurrent()) {
          releaseParallelBuffers();
          throw currentAbortError();
        }
        if (needLegacyFallback) {
          releaseParallelBuffers();
          return await runLegacyFallback();
        }
        if (waveFailed) {
          releaseParallelBuffers();
          if (isPoolNonFallbackError(waveError)) throw waveError;
          return await runLegacyFallback();
        }
      }

      if (!isCurrent()) {
        releaseParallelBuffers();
        throw currentAbortError();
      }
      emitProgress(true);
      return mergeChunkProgramScans({
        region,
        chunks,
        chunkResults: stage2Results,
        kinds,
        callLimit: globalCallCap,
        refLimit: globalRefCap,
        kindLimit: globalKindCap,
        memoryBudgetBytes: PROGRAM_INDEX_BUDGET_BYTES,
      });
    });
  }

  fieldAccess(params, onProgress) { return this.call('fieldAccess', params, null, onProgress); }

  valueShapes(regionId, onProgress) {
    if (this.disposed) return rejectedDisposedRequest();
    const effectiveArch = this._resolveScanEffectiveArch(null);
    if (this.formatId === 'macho' && effectiveArch && !isLegacyMachArchitecture(effectiveArch)) {
      return this._callTo('platform', 'valueShapes', { regionId }, null, onProgress);
    }
    if (this._engineWorker('valueShapes') !== 'legacy') {
      return this._callTo('platform', 'valueShapes', { regionId }, null, onProgress);
    }

    if (!this._canUseParallelScan(effectiveArch)) {
      return this._callTo('legacy', 'valueShapes', { regionId }, null, onProgress);
    }

    return this._orchestrateParallelScan(onProgress, async ({
      outerId,
      uiEpoch,
      transportEpoch,
      scanEpoch,
      sourceFile,
      isCurrent,
      currentAbortError,
      setActiveChild,
      clearActiveChild,
    }) => {
      const runLegacyFallback = async () => {
        if (!isCurrent()) throw currentAbortError();
        const fallbackReq = this._callTo('legacy', 'valueShapes', { regionId }, null, onProgress, { trackLastRequest: false });
        setActiveChild(fallbackReq);
        try {
          return await fallbackReq;
        } finally {
          clearActiveChild(fallbackReq);
        }
      };

      let meta = null;
      const metaReq = this._callTo('legacy', 'getScanMeta', { regionId }, null, null, { trackLastRequest: false });
      setActiveChild(metaReq);
      try {
        meta = await metaReq;
      } catch (error) {
        clearActiveChild(metaReq);
        if (!isCurrent()) throw currentAbortError();
        if (isFatalScanError(error)) throw error;
        return await runLegacyFallback();
      }
      clearActiveChild(metaReq);
      if (!isCurrent()) throw currentAbortError();

      const region = meta?.region;
      const regionSize = region ? Number(region.size) : 0;
      const thresholdBytes = Math.max(0, Number(this._parallelScanThresholdBytes ?? DEFAULT_PARALLEL_SCAN_THRESHOLD_BYTES));
      if (!region || !Number.isFinite(regionSize) || regionSize < thresholdBytes) {
        return await runLegacyFallback();
      }

      const isMobile = isMobileDevice();
      const maxWorkers = computeMaxScanWorkers();
      if (maxWorkers < 2) {
        return await runLegacyFallback();
      }

      const chunks = await planShapeChunks({
        file: sourceFile,
        region,
        maxWorkers,
        isMobile,
        parallelThresholdBytes: thresholdBytes,
      });
      if (!isCurrent()) throw currentAbortError();
      if (!Array.isArray(chunks) || chunks.length < 2) {
        return await runLegacyFallback();
      }

      const pool = this._ensureScanPool();
      const totalBytes = regionSize;
      const doneByChunk = new Float64Array(chunks.length);
      const hitsByChunk = new Float64Array(chunks.length);
      let lastProgressAt = 0;

      const emitProgress = (force = false) => {
        if (!isCurrent()) return;
        const handler = typeof onProgress === 'function' ? onProgress : this.onScanProgress;
        if (typeof handler !== 'function') return;
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (!force && now - lastProgressAt < SCAN_PROGRESS_THROTTLE_MS) return;
        lastProgressAt = now;
        let done = 0;
        let hits = 0;
        for (let i = 0; i < chunks.length; i++) {
          done += doneByChunk[i];
          hits += hitsByChunk[i];
        }
        try {
          handler({ t: 'scanProgress', requestId: outerId, epoch: transportEpoch, done: Math.min(totalBytes, Math.floor(done)), all: totalBytes, hits });
        } catch { /* progress observers cannot own the producer */ }
      };

      const shapeResults = new Array(chunks.length).fill(null);
      let eventsSoFar = 0;
      const releaseShapeBuffers = () => {
        for (let i = 0; i < shapeResults.length; i++) shapeResults[i] = null;
      };

      let nextChunkIdx = 0;
      while (nextChunkIdx < chunks.length && eventsSoFar < MAX_SHAPE_EVENTS) {
        if (!isCurrent()) {
          releaseShapeBuffers();
          throw currentAbortError();
        }
        const hiddenCap = (typeof document !== 'undefined' && document.hidden) ? 1 : maxWorkers;
        const waveSize = Math.max(1, Math.min(hiddenCap, chunks.length - nextChunkIdx));
        const waveChunks = chunks.slice(nextChunkIdx, nextChunkIdx + waveSize);
        nextChunkIdx += waveChunks.length;

        const shapeLimit = Math.max(0, MAX_SHAPE_EVENTS - eventsSoFar);
        const waveJobs = [];
        const cancelWave = () => cancelJobList(waveJobs);
        setActiveChild(cancelWave);
        let waveFailed = false;
        let waveError = null;

        const wavePromises = waveChunks.map((chunk) => {
          const job = pool.runTask({
            t: 'scanShapesChunk',
            payload: {
              file: sourceFile,
              region,
              chunkIndex: chunk.chunkIndex,
              chunkStart: chunk.chunkStart,
              chunkEnd: chunk.chunkEnd,
              shapeLimit,
            },
            epoch: scanEpoch,
            requestId: outerId,
            onProgress: (msg) => {
              if (!isCurrent()) return;
              doneByChunk[chunk.chunkIndex] = Math.min(chunk.chunkEnd - chunk.chunkStart, Number(msg?.done || 0));
              hitsByChunk[chunk.chunkIndex] = Number(msg?.hits || 0);
              emitProgress(false);
            },
          });
          job.catch(() => {});
          waveJobs.push(job);
          return job.then((res) => {
            if (waveFailed || !isCurrent()) return;
            shapeResults[chunk.chunkIndex] = res;
            const count = Number(res?.count ?? res?.addr?.length ?? 0);
            eventsSoFar += count;
            doneByChunk[chunk.chunkIndex] = chunk.chunkEnd - chunk.chunkStart;
            hitsByChunk[chunk.chunkIndex] = count;
            emitProgress(false);
          }, (error) => {
            if (!waveFailed) {
              waveFailed = true;
              waveError = error;
              cancelWave();
            }
          });
        });

        await Promise.all(wavePromises);
        clearActiveChild(cancelWave);

        if (!isCurrent()) {
          releaseShapeBuffers();
          throw currentAbortError();
        }
        if (waveFailed) {
          releaseShapeBuffers();
          if (isPoolNonFallbackError(waveError)) throw waveError;
          return await runLegacyFallback();
        }
      }

      if (!isCurrent()) {
        releaseShapeBuffers();
        throw currentAbortError();
      }
      emitProgress(true);
      return mergeChunkShapeScans({
        region,
        chunkResults: shapeResults.filter(Boolean),
        maxEvents: MAX_SHAPE_EVENTS,
      });
    });
  }
  fieldAccessMany(regionId, offsets) {
    const request = this.call('fieldAccess', { regionId, offsets });
    const mapped = request.then((res) => {
      const out = new Map();
      for (const key of Object.keys(res?.groups || {})) out.set(key, res.groups[key]);
      return out;
    });
    return carryCancellation(mapped, request);
  }
  strings(params, onProgress) { return this.call('strings', params, null, onProgress); }
  xrefs(params, onProgress) { return this.call('xrefs', params, null, onProgress); }
  readAt(addr, len, text, options = {}) {
    const priority = options?.priority === 'background' ? 'background' : 'current';
    return this.call('readAt', { addr, len, text, priority });
  }
  resolvePointer(raw, context = {}) {
    return this._callTo('platform', 'resolvePointer', { raw, address: context?.address ?? null, sliceIndex: context?.sliceIndex ?? null });
  }
  binaryMetadata(kind = 'summary', start = 0, limit = 500) {
    if (this.formatId !== 'macho') return this._callTo('platform', 'metadata', { kind, start, limit });
    const slice = this.legacyInfo?.slices?.[0] || null;
    const capability = slice?.capability || this.platformInfo?.capability || null;
    if (kind === 'summary') {
      return Promise.resolve({
        summary: { format: 'macho', arch: capability?.architecture || 'unknown', bits: capability?.bits || 0, endian: capability?.endianness || 'unknown', sections: slice?.regions?.length || 0 },
        metadata: { compatibility: 'legacy-macho', duplicateUniversalParseAvoided: true }, capability,
      });
    }
    return Promise.resolve({ kind, start, total: 0, items: [], next: null, compatibility: 'legacy-macho', unsupported: true });
  }

  async ensureContentHash(onProgress, signal = null) {
    if (this.contentHash) return this.contentHash;
    const result = await awaitCancellableProducer(this._callTo('platform', 'hash', {}, null, onProgress), signal);
    this.contentHash = result.hash;
    return this.contentHash;
  }

  async disassembleAt(addr, options = {}) {
    const uiEpoch = this.gen;
    const architecture = options.architecture || this.platformInfo?.capability?.architecture || 'arm64';
    const support = await this.probeArchitectures();
    if (uiEpoch !== this.gen) throw new StaleRequestError();
    if (!support?.support?.[architecture]) return { supported: false, architecture, instructions: [] };
    if (this.formatId === 'macho') return { supported: false, architecture, instructions: [], compatibility: 'legacy-viewer' };
    const requestedLength = Number(Math.min(1024 * 1024, options.length || 4096));
    const read = await awaitCancellableProducer(this._callTo('platform', 'readAt', { addr, len: requestedLength, text: false }), options.signal ?? null);
    if (uiEpoch !== this.gen) throw new StaleRequestError();
    if (!read?.found) return { supported: true, architecture, instructions: [], found: false };
    const readLength = Number(read.bytes?.length ?? 0);
    const readComplete = readLength >= requestedLength;
    const formatMetadata = this.platformInfo?.productDescriptor?.formatMetadata || {};
    const riscvIsa = architecture === 'riscv64'
      ? (options.riscvIsa || resolveRiscvIsaProfile(formatMetadata.riscvIsa, addr, { allowAssumed:true }))
      : null;
    if (riscvIsa?.code === false) return { supported:true, architecture, found:true, instructions:[], region:read.region ?? null, fileOffset:read.fileOffset ?? null, riscvIsa, requestedLength, readLength, readComplete };
    const result = await awaitCancellableProducer(this._disassembleBytes(read.bytes, addr, architecture, uiEpoch, {
      riscvIsa, priority: options.priority, signal: options.signal,
      transferredOwnedBytes: read.transferredOwnedBytes === true,
    }), options.signal ?? null);
    if (uiEpoch !== this.gen) throw new StaleRequestError();
    return { supported: true, architecture, found: true, region:read.region ?? null, fileOffset:read.fileOffset ?? null, ...(riscvIsa == null ? {} : { riscvIsa }), ...result, requestedLength, readLength, readComplete };
  }

  _disassembleBytes(bytes, address, architecture, uiEpoch = this.gen, decodeContext = {}) {
    if (this.disposed) return Promise.reject(new Error('backend disposed'));
    if (decodeContext.signal?.aborted) return Promise.reject(cancelledRequestError('disassembly cancelled'));
    if (!this._disasmWorker) {
      this._disasmWorker = new Worker(new URL('./platform/capstone-disasm-worker.js', import.meta.url));
      const worker = this._disasmWorker;
      worker.onmessage = (event) => {
        const pending = this._disasmPending.get(event.data?.id);
        if (!pending) return;
        this._disasmPending.delete(event.data.id);
        pending.cleanup?.();
        if (pending.uiEpoch !== this.gen) { pending.reject(new StaleRequestError()); return; }
        if (event.data.ok) pending.resolve(event.data); else pending.reject(new Error(event.data.error || 'disassembly failed'));
      };
      const fail = (event) => {
        if (this._disasmWorker !== worker) return;
        this._releaseDisassembly(workerFailureError('disassembly', event, 'disassembly worker failed'));
      };
      worker.onerror = fail;
      worker.onmessageerror = fail;
    }
    const id = this._disasmSeq++;
    // readAtAddress copied these bytes into a dedicated buffer, then transferred
    // ownership to this realm. Pass that buffer onward without copying it on
    // the UI thread. Other callers and partial/shared views retain the copy.
    const copy = decodeContext.transferredOwnedBytes === true
      && bytes instanceof Uint8Array
      && bytes.buffer instanceof ArrayBuffer
      && bytes.byteOffset === 0
      && bytes.byteLength === bytes.buffer.byteLength
        ? bytes
        : bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
    const priority = decodeContext.priority || 'current';
    let cleanupSignal = null;
    const promise = new Promise((resolve, reject) => {
      this._disasmPending.set(id, {
        resolve, reject, uiEpoch, priority,
        cleanup: () => cleanupSignal?.(),
      });
      try {
        this._disasmWorker.postMessage({ id, architecture, address, bytes: copy, riscvIsa:decodeContext.riscvIsa ?? null, priority }, [copy.buffer]);
      } catch (error) {
        this._disasmPending.delete(id);
        cleanupSignal?.();
        reject(error);
      }
    });
    promise.cancel = () => {
      const pending = this._disasmPending.get(id);
      if (!pending) return;
      this._disasmPending.delete(id);
      pending.cleanup?.();
      try {
        this._disasmWorker?.postMessage({ t: 'cancel', id });
      } catch {}
      pending.reject(cancelledRequestError('disassembly cancelled'));
    };
    const signal = decodeContext.signal;
    if (signal) {
      const onAbort = () => promise.cancel();
      cleanupSignal = () => {
        try { signal.removeEventListener?.('abort', onAbort); } catch {}
      };
      try {
        signal.addEventListener?.('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      } catch {}
    }
    return promise;
  }

  async loadAnalysisCache(options = {}) {
    const hash = await this.ensureContentHash(options.onProgress, options.signal);
    return this.analysisCache.get(hash, { artifactId:options.artifactId });
  }
  async saveAnalysisCache(data, options = {}) {
    const hash = await this.ensureContentHash(options.onProgress, options.signal);
    return this.analysisCache.put(hash, data, { artifactId:options.artifactId });
  }
  memoryStats() { return this._callTo('platform', 'memoryStats', {}); }
  cleanupMemory() {
    if (this.disposed) return rejectedDisposedRequest();
    this.resetCache();
    this._releaseDisassembly(new Error('disassembly worker released for memory pressure'));
    this._scanPool?.onMemoryPressure();
    if (!this._platformWorker) {
      const promise = Promise.resolve(null);
      promise.requestId = null;
      promise.cancel = () => false;
      return promise;
    }
    return this._callTo('platform', 'cleanupMemory', {}, null, null, { trackLastRequest: false });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const failure = new Error('Backend has been disposed.'); failure.code = 'BACKEND_DISPOSED';
    this.analysisEpoch++; this.transportEpoch++; this._scanEpoch++;
    this._binaryIdFlight?.controller.abort(cancelledRequestError('Backend disposed.'));
    this.binaryId = null; this._binaryIdPromise = null; this._binaryIdFlight = null;
    this.resetCache();
    this._releaseDisassembly(failure);
    this._archProbeFinish?.({ ok:false, error:failure.message, support:{ arm64:false, x86_64:false } });
    this._archProbeFinish = null; this._archProbeWorker = null; this._archProbeResult = null;
    const allPending = Array.from(this.pending.values());
    this.pending.clear();
    for (const pending of allPending) {
      try { pending.onCancel?.(); } catch { /* best effort */ }
      pending.reject(failure);
    }
    if (this._scanPool) {
      try { this._scanPool.dispose(); } catch { /* best effort */ }
      this._scanPool = null;
    }
    for (const worker of [this._legacyWorker, this._platformWorker]) {
      if (worker) { try { worker.terminate(); } catch { /* best effort */ } }
    }
    this._legacyWorker = null;
    this._platformWorker = null;
    this._artifactOrchestrator?.close?.().catch?.(() => {});
    if (typeof document !== 'undefined' && this._memoryPressureHandler) {
      document.removeEventListener('visibilitychange', this._memoryPressureHandler);
      this._memoryPressureHandler = null;
    }
  }

  resetCache() {
    this.cache.clear();
    this.inflight.clear();
    this.queue.length = 0;
  }

  key(regionId, chunk) { return this.gen + ':' + regionId + '#' + chunk; }

  peek(regionId, chunk, wantAsm) {
    const entry = this.cache.get(this.key(regionId, chunk));
    if (!entry) return undefined;
    if (wantAsm && !entry.mn) return undefined;
    return entry;
  }

  fetchChunk(regionId, chunk, wantAsm) {
    const key = this.key(regionId, chunk);
    const cached = this.cache.get(key);
    if (cached && !cached.error && (!wantAsm || cached.mn)) return Promise.resolve(cached);
    const gen = this.gen;
    const request = this.call('chunk', { regionId, chunk, wantAsm });
    const mapped = request.then((res) => {
      const entry = normalizeChunk(res);
      if (gen === this.gen) this.cache.set(key, entry);
      return entry;
    });
    return carryCancellation(mapped, request);
  }

  request(regionId, chunk, wantAsm, options = {}) {
    const priority = options?.priority ?? 'visible';
    const key = this.key(regionId, chunk);
    const inflight = this.inflight.get(key);
    if (inflight) {
      if (wantAsm && !inflight.wantAsm) inflight.wantAsm = true;
      if (priority === 'visible' && inflight.priority === 'prefetch') {
        inflight.priority = 'visible';
        const qIdx = this.queue.indexOf(inflight);
        if (qIdx > 0) {
          this.queue.splice(qIdx, 1);
          const insertIdx = this.queue.findIndex((j) => j.priority === 'prefetch');
          if (insertIdx >= 0) this.queue.splice(insertIdx, 0, inflight);
          else this.queue.push(inflight);
        }
      }
      return;
    }
    const cached = this.cache.get(key);
    if (cached && !cached.error && (!wantAsm || cached.mn)) return;
    const job = { regionId, chunk, wantAsm: !!wantAsm, priority, key, gen: this.gen, dispatchedWantAsm: null };
    this.inflight.set(key, job);
    const dispatched = this.inflight.size - this.queue.length;
    if (dispatched > MAX_INFLIGHT) {
      if (priority === 'visible') {
        const insertIdx = this.queue.findIndex((j) => j.priority === 'prefetch');
        if (insertIdx >= 0) this.queue.splice(insertIdx, 0, job);
        else this.queue.push(job);
      } else {
        this.queue.push(job);
      }
    } else {
      this._dispatch(job);
    }
  }

  _drainChunkQueue() {
    const next = this.queue.shift();
    if (next) this._dispatch(next);
  }

  _finishChunk(job, result, error = null) {
    this.inflight.delete(job.key);
    if (job.gen !== this.gen || error?.stale) {
      this._drainChunkQueue();
      return;
    }
    if (error) {
      this.cache.set(job.key, { bytes: new Uint8Array(0), rows: 0, mn: null, ops: null, error: error.message });
      this.onChunk?.(job.regionId, job.chunk, error);
      this._drainChunkQueue();
      return;
    }

    try {
      const entry = normalizeChunk(result);
      this.cache.set(job.key, entry);
      this.onChunk?.(job.regionId, job.chunk);

      if (job.wantAsm && !job.dispatchedWantAsm && !entry.mn) {
        const retry = { ...job, wantAsm: true, dispatchedWantAsm: null };
        this.inflight.set(job.key, retry);
        this.queue.unshift(retry);
      }
    } catch (failure) {
      this.cache.set(job.key, { bytes: new Uint8Array(0), rows: 0, mn: null, ops: null, error: failure.message });
      this.onChunk?.(job.regionId, job.chunk, failure);
    }
    this._drainChunkQueue();
  }

  _dispatch(job) {
    job.dispatchedWantAsm = !!job.wantAsm;
    this.call('chunk', { regionId: job.regionId, chunk: job.chunk, wantAsm: job.dispatchedWantAsm }, undefined, { trackLastRequest: false })
      .then(
        (res) => this._finishChunk(job, res),
        (err) => this._finishChunk(job, null, err),
      );
  }
  pruneVisibleChunks(regionId, firstChunk, lastChunk, prefetchMargin = 1) {
    if (!this.queue.length) return;
    const keepMin = firstChunk - prefetchMargin;
    const keepMax = lastChunk + prefetchMargin;
    const visible = [];
    const prefetch = [];
    for (const job of this.queue) {
      if (job.regionId !== regionId || job.chunk < keepMin || job.chunk > keepMax) {
        this.inflight.delete(job.key);
        continue;
      }
      if (job.chunk >= firstChunk && job.chunk <= lastChunk) {
        job.priority = 'visible';
        visible.push(job);
      } else {
        job.priority = 'prefetch';
        prefetch.push(job);
      }
    }
    this.queue.length = 0;
    this.queue.push(...visible, ...prefetch);
  }

  dropQueued() {
    for (const job of this.queue) this.inflight.delete(job.key);
    this.queue.length = 0;
  }
}

function normalizeChunk(res) {
  return { bytes: res.bytes, rows: res.rows, mn: res.mn ? res.mn.split('\n') : null, ops: res.ops ? res.ops.split('\n') : null };
}

function legacyFallbackFormatId(legacy) {
  if (!legacy || typeof legacy !== 'object') return null;
  const slices = Array.isArray(legacy.slices) ? legacy.slices : null;
  if (!slices) return null;
  if (slices.some((slice) => slice && typeof slice.info === 'object' && slice.info !== null)) return 'macho';
  if (slices.length === 0 && legacy.raw && typeof legacy.raw === 'object' && legacy.raw.exec === true) return 'unknown';
  return null;
}

function legacySliceCapability(slice) {
  const info = slice?.info || {};
  const architecture = info.architecture || (info.ilp32 ? 'arm64_32' : info.cpuSub === 'arm64e' ? 'arm64e' : info.isArm64 ? 'arm64' : String(info.cpu || 'unknown').toLowerCase());
  const aarch64 = architecture === 'arm64' || architecture === 'arm64e' || architecture === 'arm64_32';
  const partial = architecture === 'arm64e' || architecture === 'arm64_32';
  const limitations = architecture === 'arm64e' ? ['pointer-authentication'] : architecture === 'arm64_32' ? ['ilp32-pointer-abi'] : [];
  return Object.freeze({
    format:'macho', architecture, endianness:'little', bits:info.is64===false?32:64,
    pointerBits:info.pointerBits || (info.ilp32?32:(info.is64===false?32:64)), ilp32:!!info.ilp32,
    canDisassemble:aarch64, canAnalyzeDataflow:aarch64, canEmulate:false, viewerCanDisassemble:aarch64,
    instructionAlignment:aarch64?4:(architecture==='arm'?2:1), fixedInstructionSize:aarch64?4:null,
    analysisLevel:partial?'partial':aarch64?'full':'data-only', limitations, engineVerified:false,
  });
}
