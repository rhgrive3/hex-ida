import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTpiStream, PdbDebugInfoProvider } from '../../../js/analysis/debug/pdb.js';

// #6045: CodeView LF_UNION carries MemberCount/Properties/FieldList/Size/Name
// (LLVM UnionRecord). The parser must keep the union's declared FieldList type
// index so the member layout resolves; forcing it to 0 severed every union
// from its members.

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

test('#6045: LF_UNION keeps its declared FieldList type index', () => {
  const recordBytes = UNION_RECORD.length + FIELDLIST_RECORD.length;
  const bytes = header(recordBytes, { lastIndex: 0x1002 });
  bytes.set(UNION_RECORD, 56);
  bytes.set(FIELDLIST_RECORD, 56 + UNION_RECORD.length);

  const parsed = parseTpiStream(bytes);
  assert.equal(parsed.complete, true);
  const union = parsed.types.get(0x1000);
  assert.equal(union?.kind, 'aggregate');
  assert.equal(union?.keyword, 'union');
  assert.equal(union?.fieldList, 0x1001, 'union FieldList is real evidence, not 0');
});

test('#6045: union member layout resolves through the declared FieldList', () => {
  const recordBytes = UNION_RECORD.length + FIELDLIST_RECORD.length;
  const bytes = header(recordBytes, { lastIndex: 0x1002 });
  bytes.set(UNION_RECORD, 56);
  bytes.set(FIELDLIST_RECORD, 56 + UNION_RECORD.length);

  const parsed = parseTpiStream(bytes);
  const fields = parsed.types.get(0x1001);
  assert.equal(fields?.kind, 'field-list');
  assert.deepEqual(fields?.members, [{ name: 'x', typeIndex: 0x74, offset: 0 }]);
  // The aggregate walker (provider aggregates()) joins on record.fieldList:
  // with the fix the union exposes its member, with the old fieldList:0 it did not.
  const union = parsed.types.get(0x1000);
  assert.equal(parsed.types.get(union.fieldList), fields);
  const aggregates = new PdbDebugInfoProvider().aggregates({ parsed: { tpi: parsed } });
  assert.equal(aggregates.length, 1);
  assert.equal(aggregates[0].name, 'U');
  assert.equal(aggregates[0].sizeBytes, 4);
  assert.equal(aggregates[0].members.length, union.memberCount);
  assert.deepEqual(aggregates[0].members.map(({ name, offset }) => ({ name, offset })), [{ name: 'x', offset: 0 }]);
});

test('#6045: forward declarations and unresolved field lists do not publish layouts', () => {
  for (const mode of ['forward', 'missing-fields']) {
    const bytes = header(UNION_RECORD.length + FIELDLIST_RECORD.length, { lastIndex: 0x1002 });
    bytes.set(UNION_RECORD, 56);
    bytes.set(FIELDLIST_RECORD, 56 + UNION_RECORD.length);
    const view = new DataView(bytes.buffer);
    if (mode === 'forward') view.setUint16(56 + 6, 0x80, true);
    else view.setUint32(56 + 8, 0x1002, true);
    const parsed = parseTpiStream(bytes);
    assert.equal(parsed.types.get(0x1000).forwardReference, mode === 'forward');
    assert.deepEqual(new PdbDebugInfoProvider().aggregates({ parsed: { tpi: parsed } }), [], mode);
  }
});

test('#6045: struct and class records keep reading FieldList at body+4', () => {
  // LF_STRUCTURE: count(2) properties(2) fieldList(4) derived(4) vshape(4)
  // size(numeric) name — same 0x1001 fieldList, size literal, name "S".
  const struct = Uint8Array.from([
    0x16, 0x00, // length 22
    0x05, 0x15, // LF_STRUCTURE
    0x01, 0x00, // memberCount 1
    0x00, 0x00, // properties 0
    0x01, 0x10, 0x00, 0x00, // FieldList = 0x1001
    0x00, 0x00, 0x00, 0x00, // derived = 0
    0x00, 0x00, 0x00, 0x00, // vshape = 0
    0x04, 0x00, // size = 4 (literal)
    0x53, 0x00, // "S\0" (record ends here, already 4-byte aligned)
  ]);
  const recordBytes = struct.length + FIELDLIST_RECORD.length;
  const bytes = header(recordBytes, { lastIndex: 0x1002 });
  bytes.set(struct, 56);
  bytes.set(FIELDLIST_RECORD, 56 + struct.length);

  const parsed = parseTpiStream(bytes);
  assert.equal(parsed.complete, true);
  assert.equal(parsed.types.get(0x1000)?.fieldList, 0x1001);
  new DataView(bytes.buffer).setUint16(58, 0x1504, true); // LF_CLASS
  const classParsed = parseTpiStream(bytes);
  assert.equal(classParsed.complete, true);
  assert.equal(classParsed.types.get(0x1000)?.fieldList, 0x1001);
});
