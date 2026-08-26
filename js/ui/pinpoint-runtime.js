import { analyzeFunctionCached } from '../analyze.js';

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

export function makePinpointAnalyzer(app, region, parentSignal = null, analyze = analyzeFunctionCached) {
  if (!region || !app?.store?.get?.('canDisassemble')) return null;
  const totalRows = Number(region.size / 4n);
  return async (addr, end, options = {}) => {
    const linked = combineSignals(parentSignal, options?.signal || null);
    try {
      if (linked.signal?.aborted) throw abortError(linked.signal);
      const startRow = Number((addr - region.vmAddr) / 4n);
      if (!(startRow >= 0) || startRow >= totalRows) return null;
      const endRow = end != null
        ? Math.min(totalRows - 1, Number((end - region.vmAddr) / 4n) - 1)
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
