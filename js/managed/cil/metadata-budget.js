// ECMA-335 metadata tables are attacker-influenced object factories: a valid
// layout can declare hundreds of thousands of ordinary rows that all fit
// physically inside the stream, so bounds-checking alone never bounds the heap
// (#8704). One admission budget is therefore charged before any row object is
// materialized, and it covers every table the readers decode.
export const CIL_METADATA_BUDGET_VERSION = 'hex-cil-metadata-budget-v1';

export const DEFAULT_CIL_METADATA_LIMITS = Object.freeze({
  maxRows: 200_000,
  maxObjects: 1_000_000,
  maxStringBytes: 8 * 1024 * 1024,
  maxOperations: 8_000_000,
  maxElapsedMs: 10_000,
});

const CLOCK_CHECK_INTERVAL = 1024;

// A budget stop is a distinct availability outcome: it must never be reported
// as malformed metadata, because the caller can still retry the same image
// with a larger admission budget.
export class CilMetadataResourceLimitError extends Error {
  constructor(code, resource, used, limit) {
    super(`${code} (${resource}: ${used} > ${limit})`);
    this.name = 'CilMetadataResourceLimitError';
    this.code = code;
    this.resource = resource;
    this.used = used;
    this.limit = limit;
    this.resourceLimited = true;
    this.cancelled = false;
  }
}

export class CilMetadataCancelledError extends Error {
  constructor(signal) {
    super('cil-metadata-cancelled');
    this.name = 'AbortError';
    this.code = 'cil-metadata-cancelled';
    this.resourceLimited = true;
    this.cancelled = true;
    this.cause = signal?.reason ?? null;
  }
}

function limitValue(options, key) {
  const raw = options[key] === undefined ? DEFAULT_CIL_METADATA_LIMITS[key] : options[key];
  // `null` disables one dimension explicitly; an unset dimension keeps the
  // default. Any other non-integer value is a caller bug, not a licence to
  // fall back to unbounded admission.
  if (raw === null) return null;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw new TypeError(`cil-metadata-budget-limit-invalid:${key}`);
  }
  return raw;
}

function monotonicNowOf(options) {
  if (options.monotonicNow === undefined) {
    return () => {
      const perf = globalThis.performance;
      return typeof perf?.now === 'function' ? perf.now() : Date.now();
    };
  }
  if (typeof options.monotonicNow !== 'function') {
    throw new TypeError('cil-metadata-budget-clock-invalid');
  }
  return options.monotonicNow;
}

export function createCilMetadataAdmission(options = {}) {
  const limits = Object.freeze({
    maxRows: limitValue(options, 'maxRows'),
    maxObjects: limitValue(options, 'maxObjects'),
    maxStringBytes: limitValue(options, 'maxStringBytes'),
    maxOperations: limitValue(options, 'maxOperations'),
    maxElapsedMs: limitValue(options, 'maxElapsedMs'),
  });
  const signal = options.signal === undefined ? null : options.signal;
  if (signal != null && typeof signal.aborted !== 'boolean') {
    throw new TypeError('cil-metadata-budget-signal-invalid');
  }
  const monotonicNow = monotonicNowOf(options);
  const startedAt = limits.maxElapsedMs == null ? null : monotonicNow();
  const usage = { rows: 0, objects: 0, stringBytes: 0, operations: 0 };
  let sinceClockCheck = 0;

  function charge(field, resource, limit, code, amount) {
    if (signal?.aborted) throw new CilMetadataCancelledError(signal);
    const value = amount;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`cil-metadata-budget-charge-invalid:${resource}`);
    }
    const next = usage[field] + value;
    usage[field] = next;
    if (limit != null && next > limit) {
      throw new CilMetadataResourceLimitError(code, resource, next, limit);
    }
    if (limits.maxElapsedMs != null && ++sinceClockCheck >= CLOCK_CHECK_INTERVAL) {
      sinceClockCheck = 0;
      const elapsed = monotonicNow() - startedAt;
      if (elapsed > limits.maxElapsedMs) {
        throw new CilMetadataResourceLimitError('cil-metadata-resource-limit-elapsed', 'elapsedMs', elapsed, limits.maxElapsedMs);
      }
    }
    return next;
  }

  return Object.freeze({
    version: CIL_METADATA_BUDGET_VERSION,
    limits,
    chargeRows: (count, table = 'aggregate') => charge('rows', `rows:${table}`, limits.maxRows, 'cil-metadata-resource-limit-rows', count),
    chargeObjects: (count) => charge('objects', 'objects', limits.maxObjects, 'cil-metadata-resource-limit-objects', count),
    chargeStringBytes: (count) => charge('stringBytes', 'stringBytes', limits.maxStringBytes, 'cil-metadata-resource-limit-string-bytes', count),
    // Every decode step charges work here, which is also where cancellation and
    // the wall-clock stop are observed inside the large row loops (#8704).
    chargeOperations: (count = 1) => charge('operations', 'operations', limits.maxOperations, 'cil-metadata-resource-limit-operations', count),
    usage: () => Object.freeze({ ...usage }),
    snapshot: () => Object.freeze({
      version: CIL_METADATA_BUDGET_VERSION,
      limits,
      usage: Object.freeze({ ...usage }),
    }),
  });
}

// Aggregate admission: every row any reader will materialize from this layout
// is charged before the first row object exists.
export function admitCilMetadataTables(admission, layout) {
  if (!admission || !layout?.rowCounts) return 0;
  let total = 0;
  for (const count of layout.rowCounts) total += count;
  if (!Number.isSafeInteger(total)) throw new TypeError('cil-metadata-budget-charge-invalid:rows');
  admission.chargeRows(total, 'tables');
  return total;
}

export function isCilMetadataResourceLimit(error) {
  return error?.resourceLimited === true;
}

// A malformed budget is a caller configuration bug, not a statement about the
// image; it must never be reported as malformed metadata.
export function isCilMetadataBudgetConfigError(error) {
  return typeof error?.message === 'string' && error.message.startsWith('cil-metadata-budget-');
}
