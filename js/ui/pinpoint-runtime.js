import { analyzeFunctionCached, supportsArm64SemanticAnalysis } from '../analyze.js';

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(reason == null ? 'Analysis cancelled.' : String(reason));
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
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
  return String(
    storeValue(app, 'architecture')
      ?? storeValue(app, 'capability')?.architecture
      ?? app?.currentSlice?.()?.capability?.architecture
      ?? '',
  ).trim().toLowerCase();
}

function fixedInstructionSize(app) {
  const explicit = storeValue(app, 'capability')?.fixedInstructionSize;
  return Number.isFinite(Number(explicit)) ? Number(explicit) : null;
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

export function makePinpointAnalyzer(app, region, parentSignal = null, analyze = analyzeFunctionCached) {
  if (!region || !app?.store?.get?.('canDisassemble')) return null;
  const architecture = activeArchitecture(app);
  const legacyArm64 = supportsArm64SemanticAnalysis(architecture) && fixedInstructionSize(app) === 4;
  const totalRows = legacyArm64 ? Number(region.size / 4n) : 0;

  return async (addr, end, options = {}) => {
    const linked = combineSignals(parentSignal, options?.signal || null);
    try {
      if (linked.signal?.aborted) throw abortError(linked.signal);

      const canonical = await canonicalPinpointModel(app, addr, linked.signal, options);
      if (canonical !== undefined) return canonical;

      // Compatibility fallback is deliberately finite: the row-based analyzer is
      // valid only for proven 4-byte ARM64/AArch64 instruction streams.
      if (!legacyArm64) return null;
      const startRow = Number((addr - region.vmAddr) / 4n);
      if (!(startRow >= 0) || startRow >= totalRows) return null;
      /* end が未証明でも隣接関数へは伸びない: 局所的な境界（証明済み end か
         次の関数開始、#464 ガード付き）で窓を締める。 */
      const stop = end != null ? end : app.symbols?.functionWindowBound?.(addr) ?? null;
      const endRow = stop != null
        ? Math.min(totalRows - 1, Number((stop - region.vmAddr) / 4n) - 1)
        : Math.min(totalRows - 1, startRow + 512);
      if (endRow < startRow) return null;
      const res = await analyze(app.backend, region, startRow, endRow,
        app.symbols, null, { ...(options || {}), texts: false, signal: linked.signal });
      return res?.model || null;
    } finally {
      linked.dispose();
    }
  };
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
