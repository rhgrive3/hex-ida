// ECMA-335 II.22 / II.24.2.6: one row-layout authority for both metadata readers.
function fail(code) { throw new TypeError(code); }

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
    case 0x06: return 8 + s + b + t(0x08);
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
    case 0x12: return t(0x02) + t(0x14);
    case 0x13: return t(0x14);
    case 0x14: return 2 + s + c([0x02, 0x01, 0x1b], 2);
    case 0x15: return t(0x02) + t(0x17);
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
