export const ELF_METADATA_LIMITS = Object.freeze({
  inputBytes: 64 * 1024 * 1024,
  records: 250_000,
  objects: 500_000,
  stringBytes: 16 * 1024 * 1024,
  operations: 2_000_000,
  estimatedHeapBytes: 96 * 1024 * 1024,
  // Wall-clock stops made parse output depend on host speed (OpenMW lost
  // symbols/types on loaded hosts). Work is strictly bounded by the deterministic
  // count/byte/operation limits above; a wall-clock stop applies only when a
  // caller explicitly requests an opt-in wallClockMs.
  wallClockMs: Infinity,
});

function metadataOf(image) {
  image.metadata ||= {};
  return image.metadata.elfMetadata ||= { complete:true, reasons:[] };
}

function metadataLimit(key, value, fallback) {
  if (key === 'wallClockMs') {
    if (value === Infinity) return Infinity;
    return typeof value === 'number' && (value === Infinity || (Number.isSafeInteger(value) && value >= 0)) ? value : fallback;
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function metadataCost(value) {
  if (value === undefined) return 0;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export const ELF_MAX_PARTIAL_REASONS = 256;
export const ELF_MAX_PARTIAL_WARNINGS = 256;

const partialTrackingByImage = new WeakMap();

function partialTrackingOf(image, meta) {
  let state = partialTrackingByImage.get(image);
  if (!state) {
    state = {
      reasons: new Set(meta.reasons),
      warnings: new Set(Array.isArray(image.warnings) ? image.warnings : []),
      warningsAdded: 0,
      warningsCapped: false,
    };
    partialTrackingByImage.set(image, state);
  }
  return state;
}

export function markELFMetadataPartial(image, reason, warning = null) {
  const meta = metadataOf(image);
  meta.complete = false;
  const state = partialTrackingOf(image, meta);
  if (reason && !state.reasons.has(reason) && state.reasons.size < ELF_MAX_PARTIAL_REASONS) {
    state.reasons.add(reason);
    meta.reasons.push(reason);
  }
  if (warning && Array.isArray(image.warnings) && !state.warnings.has(warning)) {
    if (state.warningsAdded < ELF_MAX_PARTIAL_WARNINGS - 1) {
      state.warnings.add(warning);
      state.warningsAdded++;
      image.warnings.push(warning);
    } else if (!state.warningsCapped) {
      state.warningsCapped = true;
      const capMessage = `ELF metadata partial warnings exceeded limit (${ELF_MAX_PARTIAL_WARNINGS}); further warnings suppressed`;
      if (!state.warnings.has(capMessage)) {
        state.warnings.add(capMessage);
        state.warningsAdded++;
        image.warnings.push(capMessage);
      }
    }
  }
}

/** Shared budget for SHT symbols/relocations/unwind decoded JS output. */
export function createELFMetadataBudget(image, options = {}) {
  const overrides = options.limits || options.metadataLimits || {};
  const limits = { ...ELF_METADATA_LIMITS, ...overrides };
  for (const key of Object.keys(ELF_METADATA_LIMITS)) {
    limits[key] = metadataLimit(key, limits[key], ELF_METADATA_LIMITS[key]);
  }
  const signal = options.signal || null;
  const started = Date.now();
  const used = { inputBytes:0, records:0, objects:0, stringBytes:0, operations:0, estimatedHeapBytes:0 };
  const meta = metadataOf(image);
  meta.limits = { ...limits };
  meta.used = used;
  let nextTimeCheck = 1024;
  // Budget exhaustion is irreversible for this instance, unlike partial metadata.
  let stopped = false;
  const stop = (reason) => {
    stopped = true;
    markELFMetadataPartial(image, `budget:${reason}`, `ELF metadata budget exhausted: ${reason}`);
    return false;
  };
  return {
    limits, used, signal,
    get stopped() { return stopped; },
    get remainingStringBytes() { return Math.max(0, limits.stringBytes - used.stringBytes); },
    checkpoint() {
      if (stopped) return false;
      if (signal?.aborted) return stop('aborted');
      if (Date.now() - started > limits.wallClockMs) return stop('wall-clock');
      return true;
    },
    take(cost = {}, reason = 'metadata') {
      if (stopped) return false;
      if (signal?.aborted) return stop('aborted');
      const amounts = Object.create(null);
      amounts.operations = metadataCost(cost.operations);
      if (amounts.operations == null) return stop(`${reason}:operations:invalid-cost`);
      if (used.operations + amounts.operations >= nextTimeCheck) {
        nextTimeCheck = used.operations + amounts.operations + 1024;
        if (Date.now() - started > limits.wallClockMs) return stop('wall-clock');
      }
      for (const key of Object.keys(used)) {
        const amount = key === 'operations' ? amounts.operations : metadataCost(cost[key]);
        if (amount == null) return stop(`${reason}:${key}:invalid-cost`);
        amounts[key] = amount;
        const next = used[key] + amount;
        if (!Number.isFinite(next) || next > limits[key]) return stop(`${reason}:${key}`);
      }
      for (const key of Object.keys(used)) used[key] += amounts[key];
      return true;
    },
    partial(reason, warning = null) { markELFMetadataPartial(image, reason, warning); return false; },
    snapshot() { return { complete:meta.complete, reasons:[...meta.reasons], limits:{...limits}, used:{...used} }; },
  };
}
