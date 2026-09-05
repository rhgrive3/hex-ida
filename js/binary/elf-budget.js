export const ELF_METADATA_LIMITS = Object.freeze({
  inputBytes: 64 * 1024 * 1024,
  records: 250_000,
  objects: 500_000,
  stringBytes: 16 * 1024 * 1024,
  operations: 2_000_000,
  estimatedHeapBytes: 96 * 1024 * 1024,
  wallClockMs: 5_000,
});

function metadataOf(image) {
  image.metadata ||= {};
  return image.metadata.elfMetadata ||= { complete:true, reasons:[] };
}

function metadataLimit(value, fallback) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function metadataCost(value) {
  if (value === undefined) return 0;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function markELFMetadataPartial(image, reason, warning = null) {
  const meta = metadataOf(image);
  meta.complete = false;
  if (!meta.reasons.includes(reason)) meta.reasons.push(reason);
  if (warning && !image.warnings.includes(warning)) image.warnings.push(warning);
}

/** Shared budget for SHT symbols/relocations/unwind decoded JS output. */
export function createELFMetadataBudget(image, options = {}) {
  const overrides = options.limits || options.metadataLimits || {};
  const limits = { ...ELF_METADATA_LIMITS, ...overrides };
  for (const key of Object.keys(ELF_METADATA_LIMITS)) {
    limits[key] = metadataLimit(limits[key], ELF_METADATA_LIMITS[key]);
  }
  const signal = options.signal || null;
  const started = Date.now();
  const used = { inputBytes:0, records:0, objects:0, stringBytes:0, operations:0, estimatedHeapBytes:0 };
  const meta = metadataOf(image);
  meta.limits = { ...limits };
  meta.used = used;
  let nextTimeCheck = 1024;
  const stop = (reason) => {
    markELFMetadataPartial(image, `budget:${reason}`, `ELF metadata budget exhausted: ${reason}`);
    return false;
  };
  return {
    limits, used, signal,
    get stopped() { return meta.complete === false && meta.reasons.some((r) => r.startsWith('budget:')); },
    get remainingStringBytes() { return Math.max(0, limits.stringBytes - used.stringBytes); },
    take(cost = {}, reason = 'metadata') {
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
