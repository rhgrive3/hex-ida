import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTpiStream } from '../../js/analysis/debug/pdb.js';

const LF_UNION = [0x06, 0x15];
const LF_FIELDLIST = [0x03, 0x12];
const LF_MEMBER = [0x0d, 0x15];

function tpi(recordBytes) {
  const bytes = new Uint8Array(56 + recordBytes.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 56, true);
  view.setUint32(8, 0x1000, true);
  bytes.set(recordBytes, 56);
  return bytes;
}

function record(leaf, body) {
  const len = 2 + body.length;
  return [len & 0xff, (len >> 8) & 0xff, ...leaf, ...body];
}

function u32le(n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }

// union U { int x; }: fieldList -> 0x1001, size 4, name 'U'.
const unionBody = [
  0x01, 0x00, // MemberCount = 1
  0x00, 0x00, // Properties = 0
  ...u32le(0x1001), // FieldList
  0x04, 0x00, // Size = 4
  0x55, 0x00, // 'U' NUL
];

// LF_FIELDLIST with one LF_MEMBER: int @0 'x'.
const fieldListBody = [
  ...LF_MEMBER,
  0x00, 0x00, // attributes
  ...u32le(0x74), // TypeIndex = int
  0x00, 0x00, // Offset = 0
  0x78, 0x00, // 'x' NUL
];

test('6045: LF_UNION keeps its FieldList TypeIndex', () => {
  const parsed = parseTpiStream(tpi(Uint8Array.from([
    ...record(LF_UNION, unionBody),
    ...record(LF_FIELDLIST, fieldListBody),
  ])));
  const union = parsed.types.get(0x1000);
  assert.ok(union, 'union record must decode');
  assert.equal(union.kind, 'aggregate');
  assert.equal(union.keyword, 'union');
  assert.equal(union.fieldList, 0x1001);
  assert.equal(union.memberCount, 1);
  assert.equal(union.name, 'U');
  const fields = parsed.types.get(0x1001);
  assert.equal(fields?.kind, 'field-list');
  assert.equal(fields.members.length, 1);
  assert.equal(fields.members[0].name, 'x');
  assert.equal(parsed.complete, true);
});

test('6045: union members resolve through the FieldList', () => {
  const parsed = parseTpiStream(tpi(Uint8Array.from([
    ...record(LF_UNION, unionBody),
    ...record(LF_FIELDLIST, fieldListBody),
  ])));
  const union = parsed.types.get(0x1000);
  const fields = parsed.types.get(union.fieldList);
  assert.ok(fields && fields.kind === 'field-list', 'union fieldList must point at a field-list record');
  assert.deepEqual(fields.members.map((m) => m.name), ['x']);
});
