import { analyzeFunctionCached, supportsArm64SemanticAnalysis } from '../analyze.js';
import { CHUNK_ROWS } from '../backend.js';

const DEFAULT_PER_FUNCTION_BUDGET_MS = 1500;
const DEFAULT_WORKER_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_PINPOINT_WORKER_URL = new URL('../analysis/pinpoint-worker.js', import.meta.url);

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(reason == null ? 'Analysis cancelled.' : String(reason));
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  if (reason !== undefined) error.reason = reason;
  return error;
}

function isAbortError(error, signal = null) {
  return !!(signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR');
}

function hydrateModelBlockOfRow(model) {
  if (!model || typeof model !== 'object' || typeof model.blockOfRow === 'function') return model;
  if (!Array.isArray(model.semantic)) return model;
  model.blockOfRow = (row) => model.semantic.find((block) => row >= block.startRow && row <= block.endRow) || null;
  return model;
}

function combineSignals(...signals) {
  const active = signals.filter(Boolean);
  if (!active.length) return { signal: null, dispose() {} };
  if (active.length === 1) return { signal: active[0], dispose() {} };

  const controller = new AbortController();
  const listeners = [];
  const forward = (signal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason ?? 'cancelled');
  };
  for (const signal of active) {
    if (signal.aborted) {
      forward(signal);
      break;
    }
    const listener = () => forward(signal);
    signal.addEventListener('abort', listener, { once: true });
    listeners.push([signal, listener]);
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
    },
  };
}

function bindCancellation(request, signals) {
  if (!request || typeof request.then !== 'function') return request;
  const listeners = [];
  let settled = false;
  let cancelled = false;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
  };
  const cancel = () => {
    if (settled || cancelled) return;
    cancelled = true;
    try { request.cancel?.(); } catch { /* cancellation remains best-effort */ }
  };
  for (const signal of signals.filter(Boolean)) {
    if (signal.aborted) {
      cancel();
      continue;
    }
    const listener = cancel;
    signal.addEventListener('abort', listener, { once: true });
    listeners.push([signal, listener]);
  }
  Promise.resolve(request).then(cleanup, cleanup);
  return request;
}

function storeValue(app, key) {
  try { return typeof app?.store?.get === 'function' ? app.store.get(key) : (app?.store?.[key] ?? null); }
  catch { return null; }
}

function activeArchitecture(app) {
  const val = storeValue(app, 'architecture')
    ?? storeValue(app, 'capability')?.architecture
    ?? (typeof app?.currentSlice === 'function' ? app.currentSlice()?.capability?.architecture : null);
  return typeof val === 'string' ? val.trim().toLowerCase() : '';
}

function fixedInstructionSize(app) {
  const cap = storeValue(app, 'capability');
  const explicit = cap && typeof cap === 'object' ? cap.fixedInstructionSize : null;
  return explicit != null && Number.isFinite(Number(explicit)) ? Number(explicit) : null;
}

function isLegacyArm64Candidate(app) {
  const arch = activeArchitecture(app);
  const fixed = fixedInstructionSize(app);
  // Positive proof only: the row-based fallback is valid for proven 4-byte
  // ARM64/AArch64 streams, so an absent/unknown architecture is not ARM64
  // evidence and must fail closed (#5818).
  if (!supportsArm64SemanticAnalysis(arch)) return false;
  if (fixed != null && fixed !== 4) return false;
  return true;
}

function analysisRegionFor(app, addr, fallbackRegion) {
  if (typeof app?.executableRegionFor === 'function') {
    return app.executableRegionFor(BigInt(addr));
  }
  return fallbackRegion || null;
}

async function canonicalPinpointModel(app, addr, signal, options) {
  const queries = app?.analysisQueries;
  if (!queries || typeof queries.snapshot !== 'function' || typeof queries.function !== 'function') return undefined;
  const queryOptions = { ...(options || {}), texts:false, signal };
  const snapshot = await queries.snapshot(queryOptions);
  const result = await queries.function(snapshot, addr, queryOptions);
  if (!result || result.completeness === 'unsupported' || result.value == null) return null;
  // Pinpoint's preserved heuristics consume the legacy semantic-model surface.
  // Architecture-specific producers may not expose that projection yet; in that
  // case we keep the candidate but add no fabricated ARM64 verification evidence.
  return result.value.model ?? result.value.semanticAnalysis?.model ?? null;
}

function yieldToEventLoop(signal = null) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    const onAbort = () => {
      if (done) return;
      done = true;
      if (timer != null) clearTimeout(timer);
      reject(abortError(signal));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, 0);
  });
}

function markWorkerFallbackError(error) {
  const err = error instanceof Error ? error : new Error(String(error ?? 'Pinpoint worker unavailable'));
  err.pinpointWorkerFallback = true;
  return err;
}

export function createPinpointWorkerClient({
  WorkerCtor = typeof globalThis.Worker === 'function' ? globalThis.Worker : null,
  workerUrl = DEFAULT_PINPOINT_WORKER_URL,
  idleTimeoutMs = DEFAULT_WORKER_IDLE_TIMEOUT_MS,
} = {}) {
  let worker = null;
  let nextId = 1;
  let idleTimer = null;
  let activeEntry = null;
  const queue = [];

  const clearIdleTimer = () => {
    if (idleTimer != null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const scheduleIdleCleanup = () => {
    clearIdleTimer();
    if (!worker || activeEntry || queue.length > 0) return;
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!activeEntry && queue.length === 0 && worker) {
        const w = worker;
        worker = null;
        try { w.terminate(); } catch { /* best-effort idle termination */ }
      }
    }, idleTimeoutMs);
    if (typeof idleTimer?.unref === 'function') idleTimer.unref();
  };

  let drainQueue = () => {};

  const terminateWorker = (reasonError, { rejectQueued = false } = {}) => {
    clearIdleTimer();
    const activeWorker = worker;
    worker = null;
    const current = activeEntry;
    activeEntry = null;
    if (activeWorker) {
      try { activeWorker.terminate(); } catch { /* best-effort hard termination */ }
    }
    if (current) {
      current.cleanup();
      current.reject(reasonError);
    }
    if (rejectQueued) {
      const queued = queue.splice(0);
      for (const entry of queued) {
        entry.cleanup();
        entry.reject(reasonError);
      }
      return;
    }
    drainQueue();
  };

  const ensureWorker = () => {
    if (worker) return worker;
    if (typeof WorkerCtor !== 'function') {
      throw markWorkerFallbackError(new Error('Pinpoint Worker constructor unavailable.'));
    }
    let created;
    try {
      created = new WorkerCtor(workerUrl, { type: 'module' });
    } catch (err) {
      throw markWorkerFallbackError(err);
    }
    const handleMessage = (event) => {
      if (worker !== created) return;
      const data = event?.data;
      if (!data || typeof data !== 'object') return;
      if (!activeEntry || activeEntry.id !== data.id) return;
      const entry = activeEntry;
      activeEntry = null;
      entry.cleanup();
      if (data.ok) {
        if (data.result?.model) hydrateModelBlockOfRow(data.result.model);
        entry.resolve(data.result);
      } else {
        entry.reject(new Error(data.error || 'Pinpoint worker analysis failed.'));
      }
      drainQueue();
    };
    const handleError = (event) => {
      if (worker !== created) return;
      const msg = event?.message || event?.error?.message || 'Pinpoint worker runtime error.';
      terminateWorker(markWorkerFallbackError(new Error(msg)));
    };
    if (typeof created.addEventListener === 'function') {
      created.addEventListener('message', handleMessage);
      created.addEventListener('error', handleError);
    } else {
      created.onmessage = handleMessage;
      created.onerror = handleError;
    }
    worker = created;
    return worker;
  };

  drainQueue = () => {
    while (!activeEntry && queue.length > 0) {
      const entry = queue.shift();
      if (entry.signal?.aborted) {
        entry.cleanup();
        entry.reject(abortError(entry.signal));
        continue;
      }
      clearIdleTimer();
      let activeWorker;
      try {
        activeWorker = ensureWorker();
      } catch (err) {
        entry.cleanup();
        entry.reject(err);
        continue;
      }
      activeEntry = entry;
      try {
        activeWorker.postMessage({
          id: entry.id,
          addr: entry.addr,
          rows: entry.rows,
          options: entry.options,
        });
        return;
      } catch (err) {
        if (activeEntry === entry) activeEntry = null;
        entry.cleanup();
        entry.reject(markWorkerFallbackError(err));
      }
    }
    if (!activeEntry && queue.length === 0) {
      scheduleIdleCleanup();
    }
  };

  return {
    run({ addr, rows, options = {}, signal = null }) {
      if (signal?.aborted) return Promise.reject(abortError(signal));
      clearIdleTimer();

      const id = nextId++;
      return new Promise((resolve, reject) => {
        const entry = {
          id,
          addr,
          rows,
          options,
          signal,
          resolve,
          reject,
          onAbort: null,
          cleanup() {
            if (signal && entry.onAbort) {
              signal.removeEventListener('abort', entry.onAbort);
              entry.onAbort = null;
            }
          },
        };
        if (signal) {
          entry.onAbort = () => {
            if (activeEntry === entry) {
              terminateWorker(abortError(signal));
              return;
            }
            const idx = queue.indexOf(entry);
            if (idx !== -1) {
              queue.splice(idx, 1);
              entry.cleanup();
              entry.reject(abortError(signal));
              if (!activeEntry && queue.length === 0) scheduleIdleCleanup();
            }
          };
          if (signal.aborted) {
            entry.reject(abortError(signal));
            return;
          }
          signal.addEventListener('abort', entry.onAbort, { once: true });
        }
        queue.push(entry);
        drainQueue();
      });
    },
    dispose(reason = 'pinpoint-worker-disposed') {
      const error = new Error(String(reason));
      error.name = 'AbortError';
      error.code = 'ABORT_ERR';
      error.reason = reason;
      terminateWorker(error, { rejectQueued: true });
    },
  };
}

function cloneableAnalyzeOptions(options) {
  const out = { texts: false };
  if (!options || typeof options !== 'object') return out;
  for (const [k, v] of Object.entries(options)) {
    if (
      k === 'signal' ||
      k === 'rows' ||
      k === 'useWorker' ||
      k === 'perFunctionBudgetMs' ||
      k === 'yieldBetweenFunctions'
    ) continue;
    if (typeof v === 'function' || typeof v === 'symbol') continue;
    out[k] = v;
  }
  out.texts = false;
  return out;
}

async function collectWorkerRows(app, owner, startRow, endRow, signal) {
  const first = Math.floor(startRow / CHUNK_ROWS);
  const last = Math.floor(endRow / CHUNK_ROWS);
  const chunks = [];
  const symbolNameEntries = [];
  const symbolLabelEntries = [];
  const seenAddrs = new Set();
  const symbols = app?.symbols || null;

  const recordSymbol = (addr) => {
    if (!symbols || addr == null || seenAddrs.has(addr)) return;
    seenAddrs.add(addr);
    const n = typeof symbols.nameAt === 'function' ? symbols.nameAt(addr) : null;
    if (n) symbolNameEntries.push([addr, n]);
    const l = typeof symbols.label === 'function' ? symbols.label(addr) : null;
    if (l) symbolLabelEntries.push([addr, l]);
  };

  recordSymbol(owner.vmAddr + BigInt(startRow) * 4n);

  const awaitAbortableChunk = (request) => {
    const bound = bindCancellation(request, [signal]);
    if (!signal) return bound;
    if (signal.aborted) {
      try { bound?.cancel?.(); } catch { /* cancellation remains best-effort */ }
      return Promise.reject(abortError(signal));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(abortError(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(bound).then(
        (value) => {
          if (settled) return;
          cleanup();
          resolve(value);
        },
        (err) => {
          if (settled) return;
          cleanup();
          reject(err);
        },
      );
    });
  };

  for (let c = first; c <= last; c++) {
    if (signal?.aborted) throw abortError(signal);
    const entry = await awaitAbortableChunk(app.backend.fetchChunk(owner.id, c, true, { signal }));
    if (signal?.aborted) throw abortError(signal);
    const mn = entry?.mn ? Array.from(entry.mn) : [];
    const ops = entry?.ops ? Array.from(entry.ops) : [];
    const bytes = entry?.bytes instanceof Uint8Array
      ? entry.bytes
      : (entry?.bytes ? new Uint8Array(entry.bytes) : null);
    chunks.push([c, { mn, ops, bytes }]);

    if (symbols) {
      const base = c * CHUNK_ROWS;
      const from = Math.max(startRow, base);
      const to = Math.min(endRow, base + CHUNK_ROWS - 1);
      for (let row = from; row <= to; row++) {
        const opStr = ops[row - base];
        if (!opStr || !opStr.includes('0x')) continue;
        const matches = opStr.match(/0x[0-9a-fA-F]+/g);
        if (!matches) continue;
        for (const hex of matches) {
          try { recordSymbol(BigInt(hex)); } catch { /* ignore malformed hex */ }
        }
      }
    }
  }

  return {
    region: {
      id: owner.id,
      vmAddr: owner.vmAddr,
      size: owner.size,
      revision: owner.revision ?? owner.gen ?? owner.generation ?? 0,
    },
    startRow,
    endRow,
    chunks,
    symbols: symbols ? { gen: symbols.gen ?? 0, names: symbolNameEntries, labels: symbolLabelEntries } : null,
  };
}

export function makePinpointAnalyzer(
  app,
  region,
  parentSignal = null,
  analyze = analyzeFunctionCached,
  runtimeOptions = {},
) {
  if (!app?.store?.get?.('canDisassemble')) return null;
  if (!region && typeof app?.executableRegionFor !== 'function') return null;
  const legacyArm64 = isLegacyArm64Candidate(app);
  let callCount = 0;

  const hasWorkerCtor = typeof runtimeOptions?.WorkerCtor === 'function' || typeof globalThis.Worker === 'function';
  const workerEnabledByDefault = runtimeOptions?.useWorker !== false
    && hasWorkerCtor
    && (analyze === analyzeFunctionCached || typeof runtimeOptions?.WorkerCtor === 'function');

  const workerClient = workerEnabledByDefault
    ? createPinpointWorkerClient({
        WorkerCtor: runtimeOptions?.WorkerCtor ?? globalThis.Worker,
        workerUrl: runtimeOptions?.workerUrl ?? DEFAULT_PINPOINT_WORKER_URL,
        idleTimeoutMs: runtimeOptions?.idleTimeoutMs ?? DEFAULT_WORKER_IDLE_TIMEOUT_MS,
      })
    : null;

  let onParentAbort = null;
  if (workerClient && parentSignal) {
    if (parentSignal.aborted) {
      workerClient.dispose(parentSignal.reason ?? 'parent-aborted');
    } else {
      onParentAbort = () => {
        onParentAbort = null;
        workerClient.dispose(parentSignal.reason ?? 'parent-aborted');
      };
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  const analyzer = async (addr, end, options = {}) => {
    const rawBudget = options?.perFunctionBudgetMs === undefined
      ? DEFAULT_PER_FUNCTION_BUDGET_MS
      : Number(options?.perFunctionBudgetMs);
    const budgetMs = options?.perFunctionBudgetMs === null
      ? null
      : (Number.isFinite(rawBudget) && rawBudget > 0 ? Math.floor(rawBudget) : null);
    const budgetController = budgetMs != null ? new AbortController() : null;
    const linked = combineSignals(parentSignal, options?.signal || null, budgetController?.signal || null);
    let budgetTimer = null;
    try {
      if (linked.signal?.aborted) throw abortError(linked.signal);
      if (callCount > 0 && options?.yieldBetweenFunctions !== false) {
        await yieldToEventLoop(linked.signal);
        if (linked.signal?.aborted) throw abortError(linked.signal);
      }
      callCount++;
      if (budgetController && budgetMs != null) {
        budgetTimer = setTimeout(() => {
          if (!budgetController.signal.aborted) budgetController.abort('per-function-budget-exceeded');
        }, budgetMs);
      }

      const canonical = await canonicalPinpointModel(app, addr, linked.signal, options);
      if (canonical !== undefined) return canonical;

      // Compatibility fallback is deliberately finite: the row-based analyzer is
      // valid only for proven 4-byte ARM64/AArch64 instruction streams. Resolve
      // the owning executable region from the candidate address; the caller's UI
      // region is only a presentation hint and must not select another byte range.
      if (!legacyArm64) return null;
      const owner = analysisRegionFor(app, addr, region);
      if (!owner) return null;
      const totalRows = Number(owner.size / 4n);
      const target = BigInt(addr);
      const delta = target - owner.vmAddr;
      if (delta < 0n || delta % 4n !== 0n) return null;
      const startRow = Number(delta / 4n);
      if (startRow >= totalRows) return null;
      /* end が未証明でも隣接関数へは伸びない: 局所的な境界（証明済み end か
         次の関数開始、#464 ガード付き）で窓を締める。 */
      const stop = end != null ? BigInt(end) : app.symbols?.functionWindowBound?.(target) ?? null;
      const ownerEnd = owner.vmAddr + owner.size;
      const boundedStop = stop != null && stop > ownerEnd ? ownerEnd : stop;
      if (boundedStop != null && boundedStop <= target) return null;
      const endRow = boundedStop != null
        ? Math.min(totalRows - 1, Number((boundedStop - owner.vmAddr) / 4n) - 1)
        : Math.min(totalRows - 1, startRow + 512);
      if (endRow < startRow) return null;

      const shouldUseWorker = !!workerClient
        && options?.useWorker !== false
        && (options?.rows != null || typeof app?.backend?.fetchChunk === 'function');

      if (shouldUseWorker) {
        try {
          const workerRows = options?.rows != null
            ? options.rows
            : await collectWorkerRows(app, owner, startRow, endRow, linked.signal);
          if (linked.signal?.aborted) throw abortError(linked.signal);
          const workerRes = await workerClient.run({
            addr: target,
            rows: workerRows,
            options: cloneableAnalyzeOptions(options),
            signal: linked.signal,
          });
          return workerRes?.model || null;
        } catch (workerErr) {
          if (isAbortError(workerErr, linked.signal) || !workerErr?.pinpointWorkerFallback) {
            throw workerErr;
          }
          // Fall back gracefully to in-thread analyzeFunctionCached when worker
          // instantiation, CSP/blob loading, or structured-clone transport fails.
        }
      }

      const res = await analyze(app.backend, owner, startRow, endRow,
        app.symbols, null, { ...(options || {}), texts: false, signal: linked.signal });
      return res?.model || null;
    } catch (err) {
      if (budgetController?.signal.aborted) {
        if (err && typeof err === 'object') {
          if (err.reason === undefined) err.reason = budgetController.signal.reason;
          throw err;
        }
        throw abortError(budgetController.signal);
      }
      throw err;
    } finally {
      if (budgetTimer != null) clearTimeout(budgetTimer);
      linked.dispose();
    }
  };

  analyzer.dispose = () => {
    if (parentSignal && onParentAbort) {
      parentSignal.removeEventListener('abort', onParentAbort);
      onParentAbort = null;
    }
    workerClient?.dispose();
  };

  return analyzer;
}

export function makePinpointAccessScanner(app, region, parentSignal = null) {
  if (!region) return null;
  return (list, options = {}) => {
    const offsets = (list || []).map((item) => ({ offset: item.offset, size: item.size || 0 }));
    if (!offsets.length) return Promise.resolve(new Map());
    const request = app.backend.fieldAccessMany(region.id, offsets);
    return bindCancellation(request, [parentSignal, options?.signal || null]);
  };
}
