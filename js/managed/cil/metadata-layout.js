// ECMA-335 II.22 / II.24.2.6: one row-layout authority for both metadata readers.
function fail(code) { throw new TypeError(code); }

export const MAX_METADATA_TABLE = 0x2c;
const VALID_METADATA_TABLE_MASK = (1n << BigInt(MAX_METADATA_TABLE + 1)) - 1n;

export function validateMetadataTableValidMask(valid, code = 'cil-metadata-valid-mask-invalid') {
  if (typeof valid !== 'bigint' || valid < 0n || (valid & ~VALID_METADATA_TABLE_MASK) !== 0n) fail(code);
  return valid;
}

export function codedIndexSize(rowCounts, tables, tagBits) {
  const maxRows = Math.max(...tables.map((table) => rowCounts[table] || 0));
  return maxRows < (1 << (16 - tagBits)) ? 2 : 4;
}

export function tableIndexSize(rowCounts, table) {
  return (rowCounts[table] || 0) < 0x10000 ? 2 : 4;
}

export function metadataRowSize(table, rowCounts, heapSizes) {
  const s = (heapSizes & 0x01) !== 0 ? 4 : 2;
  const g = (heapSizes & 0x02) !== 0 ? 4 : 2;
  const b = (heapSizes & 0x04) !== 0 ? 4 : 2;
  const t = (id) => tableIndexSize(rowCounts, id);
  const c = (tables, bits) => codedIndexSize(rowCounts, tables, bits);
  switch (table) {
    case 0x00: return 2 + s + g * 3;
    case 0x01: return c([0x00, 0x1a, 0x23, 0x01], 2) + s * 2;
    case 0x02: return 4 + s * 2 + c([0x02, 0x01, 0x1b], 2) + t(0x04) + t(0x06);
    case 0x03: return t(0x04);
    case 0x04: return 2 + s + b;
    case 0x05: return t(0x06);
    case 0x06: return 8 + s + b + t(rowCounts[0x07] ? 0x07 : 0x08);
    case 0x07: return t(0x08);
    case 0x08: return 4 + s;
    case 0x09: return t(0x02) + c([0x02, 0x01, 0x1b], 2);
    case 0x0a: return c([0x02, 0x01, 0x1a, 0x06, 0x1b], 3) + s + b;
    case 0x0b: return 2 + c([0x04, 0x08, 0x17], 2) + b;
    case 0x0c: return c([0x06, 0x04, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x00, 0x0e, 0x17, 0x14,
      0x11, 0x1a, 0x1b, 0x20, 0x23, 0x26, 0x27, 0x28, 0x2a, 0x2c, 0x2b], 5)
      + c([0x06, 0x0a], 3) + b;
    case 0x0d: return c([0x04, 0x08], 1) + b;
    case 0x0e: return 2 + c([0x02, 0x06, 0x20], 2) + b;
    case 0x0f: return 6 + t(0x02);
    case 0x10: return 4 + t(0x04);
    case 0x11: return b;
    case 0x12: return t(0x02) + t(rowCounts[0x13] ? 0x13 : 0x14);
    case 0x13: return t(0x14);
    case 0x14: return 2 + s + c([0x02, 0x01, 0x1b], 2);
    case 0x15: return t(0x02) + t(rowCounts[0x16] ? 0x16 : 0x17);
    case 0x16: return t(0x17);
    case 0x17: return 2 + s + b;
    case 0x18: return 2 + t(0x06) + c([0x14, 0x17], 1);
    case 0x19: return t(0x02) + c([0x06, 0x0a], 1) * 2;
    case 0x1a: return s;
    case 0x1b: return b;
    case 0x1c: return 2 + c([0x04, 0x06], 1) + s + t(0x1a);
    case 0x1d: return 4 + t(0x04);
    case 0x1e: return 8;
    case 0x1f: return 4;
    case 0x20: return 16 + b + s * 2;
    case 0x21: return 4;
    case 0x22: return 12;
    case 0x23: return 12 + b * 2 + s * 2;
    case 0x24: return 4 + t(0x23);
    case 0x25: return 12 + t(0x23);
    case 0x26: return 4 + s + b;
    case 0x27: return 8 + s * 2 + c([0x26, 0x23, 0x27], 2);
    case 0x28: return 8 + s + c([0x26, 0x23, 0x27], 2);
    case 0x29: return t(0x02) * 2;
    case 0x2a: return 4 + c([0x02, 0x06], 1) + s;
    case 0x2b: return c([0x06, 0x0a], 1) + b;
    case 0x2c: return t(0x2a) + c([0x02, 0x01, 0x1b], 2);
    default: fail(`cil-metadata-table-unsupported:${table}`);
  }
}

export function cilMetadataToken(table, rid) {
  if (!Number.isInteger(table) || table < 0 || table > 0xff
      || !Number.isInteger(rid) || rid < 1 || rid > 0xffffff) fail('cil-metadata-token-invalid');
  return `0x${(table * 0x1000000 + rid).toString(16).padStart(8, '0')}`;
}

// #8699/#8797: one aggregate admission budget for the CIL metadata readers. A
// single accounting surface covers unique decoded #Strings bytes, materialized
// definition rows, and bounded resolution/scan work so that aliased or repeated
// metadata references cannot expand a sub-MiB image into an unbounded
// synchronous CPU / retained-heap blow-up. Admission is charged BEFORE the
// decode/materialization it authorizes, so a rejected image never allocates the
// oversized value first. Limits are injectable via `options.resourceBudget`
// (parser/CI seam) with generous production defaults.
export const CIL_METADATA_BUDGET_DEFAULTS = Object.freeze({
  maxStrings: 4_000_000,
  maxStringBytes: 512 * 1024 * 1024,
  maxRows: 5_000_000,
  maxWork: 200_000_000,
  maxEstimatedHeapBytes: 384 * 1024 * 1024,
  deadlineMs: 30000,
});

export function createCilMetadataBudget(options = {}) {
  const limits = { ...CIL_METADATA_BUDGET_DEFAULTS, ...(options.resourceBudget || {}) };
  const signal = options.signal || null;
  const startedAt = Date.now();
  let strings = 0, stringBytes = 0, rows = 0, work = 0, heapBytes = 0;
  function checkpoint() {
    work++;
    if (work > limits.maxWork) fail('cil-metadata-resource-limit-work');
    if ((work & 0x3fff) === 0) {
      if (signal && signal.aborted) fail('cil-metadata-resource-limit-cancelled');
      if (Date.now() - startedAt > limits.deadlineMs) fail('cil-metadata-resource-limit-deadline');
    }
  }
  return {
    // Must be called only on a cache miss, immediately before decoding a #Strings entry.
    chargeString(byteLength) {
      strings++;
      if (strings > limits.maxStrings) fail('cil-metadata-resource-limit-strings');
      stringBytes += byteLength;
      if (stringBytes > limits.maxStringBytes) fail('cil-metadata-resource-limit-strings');
      heapBytes += byteLength * 2;
      if (heapBytes > limits.maxEstimatedHeapBytes) fail('cil-metadata-resource-limit-heap');
      checkpoint();
    },
    chargeRow(encodedByteLength = 0) {
      if (!Number.isSafeInteger(encodedByteLength) || encodedByteLength < 0)
        fail('cil-metadata-resource-limit-row-size');
      rows++;
      if (rows > limits.maxRows) fail('cil-metadata-resource-limit-rows');
      // A decoded row is retained as a JS object. Charge a conservative
      // object/property floor plus encoded width before materialization.
      const retainedBytes = 256 + encodedByteLength * 4;
      if (!Number.isSafeInteger(retainedBytes)) fail('cil-metadata-resource-limit-row-size');
      heapBytes += retainedBytes;
      if (heapBytes > limits.maxEstimatedHeapBytes) fail('cil-metadata-resource-limit-heap');
      checkpoint();
    },
    chargeWork() { checkpoint(); },
    checkpoint,
  };
}
