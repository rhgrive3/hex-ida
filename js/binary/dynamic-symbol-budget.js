export const DEFAULT_DYNAMIC_SYMBOL_LIMITS = Object.freeze({
  maxSymbolRecords: 100_000,
  maxOutputObjects: 500_000,
  maxInputBytes: 64 * 1024 * 1024,
  maxOperations: 2_000_000,
  // Wall-clock stops made parse output depend on host speed (OpenMW lost
  // 25-60% of its RTTI classes on a loaded host). Work is bounded by the
  // deterministic limits above; a wall-clock stop applies only when a caller
  // passes an explicit maxWallMs.
  maxWallMs: Infinity,
  maxEstimatedBytes: 96 * 1024 * 1024,
  maxStringBytes: 16 * 1024 * 1024,
});

function positiveLimit(value, fallback) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function createDynamicSymbolBudget({ limits = {}, onLimit = null, signal = null } = {}) {
  const resolved = {
    maxSymbolRecords: positiveLimit(limits.maxSymbolRecords, DEFAULT_DYNAMIC_SYMBOL_LIMITS.maxSymbolRecords),
    maxOutputObjects: positiveLimit(limits.maxOutputObjects, DEFAULT_DYNAMIC_SYMBOL_LIMITS.maxOutputObjects),
    maxInputBytes: positiveLimit(limits.maxInputBytes, DEFAULT_DYNAMIC_SYMBOL_LIMITS.maxInputBytes),
    maxOperations: positiveLimit(limits.maxOperations, DEFAULT_DYNAMIC_SYMBOL_LIMITS.maxOperations),
    maxWallMs: limits.maxWallMs === undefined ? Infinity : positiveLimit(limits.maxWallMs, DEFAULT_DYNAMIC_SYMBOL_LIMITS.maxWallMs),
    maxEstimatedBytes: positiveLimit(limits.maxEstimatedBytes, DEFAULT_DYNAMIC_SYMBOL_LIMITS.maxEstimatedBytes),
    maxStringBytes: positiveLimit(limits.maxStringBytes, DEFAULT_DYNAMIC_SYMBOL_LIMITS.maxStringBytes),
  };
  const now = typeof limits.now === 'function' ? limits.now : Date.now;
  const started = now();
  let inputBytes = 0;
  let operations = 0;
  let outputObjects = 0;
  let estimatedBytes = 0;
  let stringBytes = 0;
  let stopped = false;
  let reason = null;
  let nextTimeCheck = 4096;

  const stop = (message) => {
    if (!stopped) {
      stopped = true;
      reason = message;
      if (typeof onLimit === 'function') onLimit(message);
    }
    return false;
  };
  const wallOkay = (stage) => {
    if (stopped) return false;
    if (signal?.aborted) return stop('aborted');
    if (now() - started > resolved.maxWallMs) return stop(`${stage} exceeded ${resolved.maxWallMs} ms wall-clock budget`);
    return true;
  };

  return {
    limits: resolved,
    get stopped() { return stopped; },
    get reason() { return reason; },
    // Remaining budget expressed as string-table characters, so a resolver can
    // bound its own scan window instead of allocating first and accounting later.
    get remainingStringChars() {
      return stopped ? 0 : Math.max(0, Math.floor((resolved.maxStringBytes - stringBytes) / 2));
    },
    claimInput(bytes, source = 'dynamic symbol table') {
      if (stopped) return false;
      if (signal?.aborted) return stop('aborted');
      if (!Number.isSafeInteger(bytes) || bytes < 0) return stop(`${source} input size is not safely representable`);
      if (bytes > resolved.maxInputBytes - inputBytes) return stop(`${source} input bytes exceed ${resolved.maxInputBytes}`);
      inputBytes += bytes;
      return true;
    },
    step(cost = 1, stage = 'dynamic symbol decode') {
      if (stopped) return false;
      if (signal?.aborted) return stop('aborted');
      if (!Number.isSafeInteger(cost) || cost < 0) return stop(`${stage} operation cost is invalid`);
      operations += cost;
      if (!Number.isSafeInteger(operations) || operations > resolved.maxOperations) return stop(`${stage} exceeds ${resolved.maxOperations} operations`);
      const shouldCheckWall = operations === 1 || operations >= nextTimeCheck;
      if (operations >= nextTimeCheck) nextTimeCheck = operations + 4096;
      return shouldCheckWall ? wallOkay(stage) : true;
    },
    claimOutput(count = 1, bytesPerObject = 128, source = 'dynamic symbol decode') {
      if (stopped) return false;
      if (signal?.aborted) return stop('aborted');
      if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(bytesPerObject) || bytesPerObject < 0) return stop(`${source} output estimate is invalid`);
      const bytes = count * bytesPerObject;
      if (!Number.isSafeInteger(bytes)) return stop(`${source} output estimate exceeds safe integer range`);
      if (count > resolved.maxOutputObjects - outputObjects) return stop(`${source} output objects exceed ${resolved.maxOutputObjects}`);
      if (bytes > resolved.maxEstimatedBytes - estimatedBytes) return stop(`${source} estimated memory exceeds ${resolved.maxEstimatedBytes} bytes`);
      outputObjects += count;
      estimatedBytes += bytes;
      return true;
    },
    // Decoded dynamic strings are retained JS text, so they need their own
    // aggregate dimension: per-record object estimates alone undercount a shared
    // long `st_name` by hundreds of times (#8821).
    claimString(chars = 1, source = 'dynamic string') {
      if (stopped) return false;
      if (signal?.aborted) return stop('aborted');
      if (!Number.isSafeInteger(chars) || chars < 0) return stop(`${source} decoded length is invalid`);
      const bytes = chars * 2;
      if (!Number.isSafeInteger(bytes)) return stop(`${source} decoded bytes exceed safe integer range`);
      if (bytes > resolved.maxStringBytes - stringBytes) return stop(`${source} decoded string bytes exceed ${resolved.maxStringBytes}`);
      if (bytes > resolved.maxEstimatedBytes - estimatedBytes) return stop(`${source} estimated memory exceeds ${resolved.maxEstimatedBytes} bytes`);
      stringBytes += bytes;
      estimatedBytes += bytes;
      return true;
    },
    checkWall(stage = 'dynamic symbol decode') { return wallOkay(stage); },
    snapshot() {
      return { ...resolved, maxWallMs: Number.isFinite(resolved.maxWallMs) ? resolved.maxWallMs : null, inputBytes, operations, outputObjects, stringBytes, estimatedBytes, stopped, reason };
    },
  };
}
