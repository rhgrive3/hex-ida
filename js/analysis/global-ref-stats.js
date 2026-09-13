function abortError(signal) {
  let reason;
  try { reason = signal?.reason; } catch { /* unavailable reason uses fallback */ }
  let errorReason = false;
  try { errorReason = reason instanceof Error; } catch { /* hostile reason stays opaque */ }
  if (errorReason) {
    try { if (reason.name === 'AbortError') return reason; } catch { /* wrap below */ }
  }

  let message = 'Operation aborted';
  if (reason !== undefined) {
    if (errorReason) {
      try {
        if (typeof reason.message === 'string') message = reason.message;
        else message = String(reason);
      } catch { /* preserve the reason as cause and keep fallback message */ }
    } else {
      try { message = String(reason); } catch { /* preserve the reason as cause and keep fallback message */ }
    }
  }

  const error = reason === undefined ? new Error(message) : new Error(message, { cause:reason });
  error.name = 'AbortError';
  return error;
}

export function globalReferenceStats(program, _regions, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  if (!program) return Promise.resolve({
    counts:new Map(), scannedRefs:0, complete:false, reason:'program-index-unavailable', producer:'program-region-ref-aggregate/v1',
  });

  // Reference frequencies are derived while raw region scan facts are consumed by
  // the shared ProgramIndex producer. Do not walk program.refTo again here: that
  // would reintroduce the O(refCount) UI-side pass this artifact exists to remove.
  const stats = program.globalReferenceStats;
  if (!stats) return Promise.resolve({
    counts:new Map(), scannedRefs:0, complete:false, reason:'program-ref-aggregate-unavailable', producer:'program-region-ref-aggregate/v1',
  });
  return Promise.resolve(stats);
}

// Kept for compatibility with existing invalidation call sites. The derived
// artifact is owned by its ProgramIndex and disappears with that object.
export function clearGlobalReferenceStats(_program) {}
