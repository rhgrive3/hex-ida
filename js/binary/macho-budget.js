export const MACHO_METADATA_LIMITS = Object.freeze({
  inputBytes: 64 * 1024 * 1024,
  records: 250_000,
  objects: 500_000,
  stringBytes: 16 * 1024 * 1024,
  operations: 2_000_000,
  warnings: 2048,
  estimatedHeapBytes: 128 * 1024 * 1024,
  // Wall-clock stops made parse output depend on host speed. Work is strictly
  // bounded by the deterministic count/byte/operation limits above; a wall-clock
  // stop applies only when a caller explicitly requests an opt-in wallClockMs.
  wallClockMs: Infinity,
});

function metadataOf(image) {
  image.metadata ||= {};
  return image.metadata.machoMetadata ||= { complete: true, reasons: [] };
}

export function markMachOMetadataPartial(image, reason) {
  const meta = metadataOf(image);
  meta.complete = false;
  if (!meta.reasons.includes(reason)) meta.reasons.push(reason);
}

/*
 * Caller-supplied limits used to be merged over the defaults unvalidated, so
 * `records: NaN` made `next > limits.records` permanently false and removed the
 * ceiling entirely, while `stringBytes: NaN` leaked a non-finite value out
 * through `remainingStringBytes` and `remaining()` into bounded decode paths
 * (#1376). Preserve explicit numeric zero as a zero budget (#4299), without
 * turning omitted or coercive zero values (null/false/blank) into zero limits.
 * Other values retain the positive-integer compatibility policy.
 */
function metadataLimit(key, value, fallback) {
  if (key === 'wallClockMs') {
    if (value === Infinity) return Infinity;
    return typeof value === 'number' && (value === Infinity || (Number.isSafeInteger(value) && value >= 0)) ? value : fallback;
  }
  if (value === 0) return 0;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function metadataCost(value) {
  if (value === undefined) return 0;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function resolveMachOMetadataLimits(overrides = {}) {
  const out = {};
  for (const [key, fallback] of Object.entries(MACHO_METADATA_LIMITS)) {
    out[key] = metadataLimit(key, overrides[key], fallback);
  }
  return out;
}

export function createMachOMetadataBudget(image, options = {}) {
  const limits = resolveMachOMetadataLimits(options.limits || options.metadataLimits || {});
  const signal = options.signal || null;
  const started = Date.now();
  const used = {
    inputBytes: 0, records: 0, objects: 0, stringBytes: 0,
    operations: 0, warnings: Math.min(image.warnings?.length || 0, limits.warnings),
    estimatedHeapBytes: 0,
  };
  const meta = metadataOf(image);
  meta.limits = { ...limits }; meta.used = used;
  let nextTimeCheck = 1024;
  // Budget exhaustion is irreversible for this instance, unlike partial metadata.
  let stopped = false;
  const stop = (reason) => { stopped = true; markMachOMetadataPartial(image, `budget:${reason}`); return false; };
  return {
    limits, used, signal,
    get stopped() { return stopped; },
    get remainingStringBytes() { return Math.max(0, limits.stringBytes - used.stringBytes); },
    remaining(key) { return Math.max(0, Number(limits[key] ?? 0) - Number(used[key] ?? 0)); },
    take(cost = {}, reason = 'metadata') {
      if (stopped) return false;
      if (signal?.aborted) return stop('aborted');
      const cInputBytes = metadataCost(cost.inputBytes);
      if (cInputBytes === null) return stop(`${reason}:inputBytes`);
      const cRecords = metadataCost(cost.records);
      if (cRecords === null) return stop(`${reason}:records`);
      const cObjects = metadataCost(cost.objects);
      if (cObjects === null) return stop(`${reason}:objects`);
      const cStringBytes = metadataCost(cost.stringBytes);
      if (cStringBytes === null) return stop(`${reason}:stringBytes`);
      const cOperations = metadataCost(cost.operations);
      if (cOperations === null) return stop(`${reason}:operations`);
      const cWarnings = metadataCost(cost.warnings);
      if (cWarnings === null) return stop(`${reason}:warnings`);
      const cEstimatedHeapBytes = metadataCost(cost.estimatedHeapBytes);
      if (cEstimatedHeapBytes === null) return stop(`${reason}:estimatedHeapBytes`);

      if (used.operations + cOperations >= nextTimeCheck) {
        nextTimeCheck = used.operations + cOperations + 1024;
        if (limits.wallClockMs !== Infinity && Date.now() - started > limits.wallClockMs) return stop('wall-clock');
      }

      const nInputBytes = used.inputBytes + cInputBytes;
      if (!Number.isSafeInteger(nInputBytes) || nInputBytes > limits.inputBytes) return stop(`${reason}:inputBytes`);
      const nRecords = used.records + cRecords;
      if (!Number.isSafeInteger(nRecords) || nRecords > limits.records) return stop(`${reason}:records`);
      const nObjects = used.objects + cObjects;
      if (!Number.isSafeInteger(nObjects) || nObjects > limits.objects) return stop(`${reason}:objects`);
      const nStringBytes = used.stringBytes + cStringBytes;
      if (!Number.isSafeInteger(nStringBytes) || nStringBytes > limits.stringBytes) return stop(`${reason}:stringBytes`);
      const nOperations = used.operations + cOperations;
      if (!Number.isSafeInteger(nOperations) || nOperations > limits.operations) return stop(`${reason}:operations`);
      const nWarnings = used.warnings + cWarnings;
      if (!Number.isSafeInteger(nWarnings) || nWarnings > limits.warnings) return stop(`${reason}:warnings`);
      const nEstimatedHeapBytes = used.estimatedHeapBytes + cEstimatedHeapBytes;
      if (!Number.isSafeInteger(nEstimatedHeapBytes) || nEstimatedHeapBytes > limits.estimatedHeapBytes) return stop(`${reason}:estimatedHeapBytes`);

      used.inputBytes = nInputBytes;
      used.records = nRecords;
      used.objects = nObjects;
      used.stringBytes = nStringBytes;
      used.operations = nOperations;
      used.warnings = nWarnings;
      used.estimatedHeapBytes = nEstimatedHeapBytes;
      return true;
    },
    partial(reason, warning = null) {
      markMachOMetadataPartial(image, reason);
      if (warning) this.warn(warning);
      return false;
    },
    warn(message) {
      const text = String(message);
      if (image.warnings?.includes(text)) return true;
      if (!this.take({ warnings:1, objects:1, stringBytes:text.length*2, estimatedHeapBytes:text.length*2+32 }, 'warning')) return false;
      image.warnings.push(text); return true;
    },
    snapshot() {
      const current = metadataOf(image);
      return { complete:current.complete, reasons:[...current.reasons], limits:{...limits}, used:{...used} };
    },
  };
}

export function ensureMachOMetadataBudget(image, budget = null) {
  if (budget) {
    if (!image.__machoMetadataBudget)
      Object.defineProperty(image, '__machoMetadataBudget', { value:budget, configurable:true, enumerable:false, writable:false });
    return budget;
  }
  if (image.__machoMetadataBudget) return image.__machoMetadataBudget;
  const created = createMachOMetadataBudget(image);
  Object.defineProperty(image, '__machoMetadataBudget', { value:created, configurable:true, enumerable:false, writable:false });
  return created;
}
