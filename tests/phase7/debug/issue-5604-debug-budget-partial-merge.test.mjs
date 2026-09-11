import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTpiStream, parseSymbolRecords } from '../../../js/analysis/debug/pdb.js';
import { parseDebugInfo } from '../../../js/analysis/debug/dwarf.js';
import { DEBUG_DEFAULT_BUDGET, resolveDebugBudget } from '../../../js/analysis/debug/provider.js';

// #5604: a partial budget override must merge over the defaults. The DWARF and
// PDB backends previously diverged on `budget:{maxDepth:8}`: DWARF lost its
// record cap (>= undefined is always false) while PDB parsed nothing
// (0 < undefined is false).

const header = (recordBytes, { firstIndex = 0x1000, lastIndex } = {}) => {
  const bytes = new Uint8Array(56 + recordBytes);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 20040203, true);
  view.setUint32(4, 56, true);
  view.setUint32(8, firstIndex, true);
  view.setUint32(12, lastIndex ?? firstIndex + recordBytes, true);
  view.setUint32(16, recordBytes, true);
  return bytes;
};

const UNION_RECORD = Uint8Array.from([
  0x0e, 0x00, // length 14
  0x06, 0x15, // LF_UNION
  0x01, 0x00, // memberCount 1
  0x00, 0x00, // properties 0 (no forward reference)
  0x01, 0x10, 0x00, 0x00, // FieldList = 0x1001
  0x04, 0x00, // size = 4 (literal numeric leaf)
  0x55, 0x00, // "U\0"
]);

const FIELDLIST_RECORD = Uint8Array.from([
  0x10, 0x00, // length 16
  0x03, 0x12, // LF_FIELDLIST
  0x0d, 0x15, // LF_MEMBER
  0x00, 0x00, // attributes 0
  0x74, 0x00, 0x00, 0x00, // typeIndex 0x74 (int32)
  0x00, 0x00, // offset 0 (literal numeric leaf)
  0x78, 0x00, // "x\0"
  0xf1, 0xf1, // pad to 4-byte boundary
]);

test('#5604: resolveDebugBudget merges partial budgets over the defaults', () => {
  assert.deepEqual(resolveDebugBudget({ maxDepth: 8 }), { ...DEBUG_DEFAULT_BUDGET, maxDepth: 8 });
  assert.deepEqual(resolveDebugBudget({}), DEBUG_DEFAULT_BUDGET);
  assert.deepEqual(resolveDebugBudget(undefined), DEBUG_DEFAULT_BUDGET);
  assert.deepEqual(resolveDebugBudget(null), DEBUG_DEFAULT_BUDGET);
  // Malformed values fall back per-field instead of poisoning the rest.
  assert.deepEqual(
    resolveDebugBudget({ maxRecords: NaN, maxDepth: 'many', maxBytesScanned: 5 }),
    { ...DEBUG_DEFAULT_BUDGET, maxBytesScanned: 5 },
  );
  assert.deepEqual(resolveDebugBudget({ maxRecords: 0 }), DEBUG_DEFAULT_BUDGET);
  assert.deepEqual(resolveDebugBudget({ maxRecords: -1 }), DEBUG_DEFAULT_BUDGET);
  assert.deepEqual(resolveDebugBudget({ maxRecords: 2.5 }), DEBUG_DEFAULT_BUDGET);
});

test('#5604: parseSymbolRecords with a partial budget parses records', () => {
  const pub32 = (name) => {
    const encoded = new TextEncoder().encode(name);
    const bytes = new Uint8Array(14 + encoded.length + 1);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, bytes.length - 2, true);
    view.setUint16(2, 0x110e, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, 0x10, true);
    view.setUint16(12, 1, true);
    bytes.set(encoded, 14);
    bytes[bytes.length - 1] = 0;
    return bytes;
  };
  const stream = Uint8Array.from([...pub32('aa'), ...pub32('bb')]);

  const parsed = parseSymbolRecords(stream, { maxDepth: 8 });
  assert.equal(parsed.symbols.length, 2, 'maxRecords stays at the default under a partial override');
  assert.equal(parsed.complete, true);

  const explicit = parseSymbolRecords(stream, { maxRecords: 1 });
  assert.equal(explicit.symbols.length, 1);
  assert.equal(explicit.complete, false, 'an explicit cap still applies');
});

test('#5604: parseTpiStream with a partial budget parses types', () => {
  const recordBytes = UNION_RECORD.length + FIELDLIST_RECORD.length;
  const bytes = header(recordBytes, { lastIndex: 0x1002 });
  bytes.set(UNION_RECORD, 56);
  bytes.set(FIELDLIST_RECORD, 56 + UNION_RECORD.length);

  const parsed = parseTpiStream(bytes, { maxDepth: 8 });
  assert.equal(parsed.types.size, 2, 'maxRecords stays at the default under a partial override');
  assert.equal(parsed.complete, true);

  const explicit = parseTpiStream(bytes, { maxRecords: 1 });
  assert.equal(explicit.types.size, 1);
  assert.equal(explicit.complete, false, 'an explicit cap still applies');
});

test('#5604: parseDebugInfo with a partial budget keeps the record cap', () => {
  // A unit whose DIE stream would run past a small explicit cap: with a
  // partial budget the default cap must still apply, so a partial budget and
  // no budget behave identically on the same input.
  const abbrev = Uint8Array.from([0x01, 0x2e, 0x00, 0x00, 0x00]);
  const die = new Uint8Array(200005).fill(0x01);
  const unitLen = 2 + 4 + 1 + die.length;
  const info = new Uint8Array(4 + unitLen);
  const view = new DataView(info.buffer);
  view.setUint32(0, unitLen, true);
  view.setUint16(4, 4, true);
  view.setUint32(6, 0, true);
  info[10] = 4;
  info.set(die, 11);
  const sections = { debug_info: info, debug_abbrev: abbrev };

  const partial = parseDebugInfo(sections, { maxDepth: 8 });
  assert.equal(partial.dies.size, DEBUG_DEFAULT_BUDGET.maxRecords, 'partial override keeps the default maxRecords cap');
  assert.equal(partial.complete, false);
  assert.ok(partial.diagnostics.includes('record budget exhausted'));

  const explicit = parseDebugInfo(sections, { maxRecords: 5 });
  assert.equal(explicit.dies.size, 5);
});
