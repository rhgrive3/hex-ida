import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTpiStream, PdbDebugInfoProvider } from '../../../js/analysis/debug/pdb.js';

// Only LF_MEMBER is modeled inside an LF_FIELDLIST. Any other valid field-list
// subrecord (LF_STMEMBER, LF_BCLASS, LF_METHOD, ...) cannot be skipped
// reliably, so the field list — and the whole TPI result — must fail closed
// instead of publishing a partial member list as an exact layout (#5773).

function tpi(recordBytes, { firstIndex = 0x1000, records = 1 } = {}) {
  const bytes = new Uint8Array(56 + recordBytes.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 56, true);
  view.setUint32(8, firstIndex, true);
  view.setUint32(12, firstIndex + records, true);
  view.setUint32(16, recordBytes.length, true);
  bytes.set(recordBytes, 56);
  return bytes;
}

const fieldlistRecord = (...children) => {
  const body = [0x03, 0x12, ...children.flat()]; // LF_FIELDLIST + children
  const length = body.length;
  return Uint8Array.from([length & 0xff, length >> 8, ...body]);
};

test('#5773: an unsupported field-list subrecord fails the stream closed', () => {
  // LF_STMEMBER (0x150e) child after the fieldlist leaf.
  const record = fieldlistRecord([0x0e, 0x15, 0x00, 0x00]);
  const parsed = parseTpiStream(tpi(record));
  const fieldList = parsed.types.get(0x1000);
  assert.equal(fieldList?.kind, 'field-list');
  assert.equal(fieldList?.members.length, 0);
  assert.equal(fieldList?.complete, false, 'the field list is not a complete fact');
  assert.equal(parsed.complete, false, 'the stream does not claim completeness');
  assert.ok(parsed.unmodelled.has(0x150e), 'the unmodeled child kind is recorded');
});

test('#5773: members after an unsupported child are not claimed as the full layout', () => {
  // LF_STMEMBER first (unmodeled), then an LF_MEMBER that must not be parsed.
  const record = fieldlistRecord(
    [0x0e, 0x15, 0x00, 0x00],
    [0x0d, 0x15, 0x00, 0x00, 0x74, 0x00, 0x00, 0x00, 0x08, 0x00, 0x66, 0x00], // LF_MEMBER "f"
  );
  const parsed = parseTpiStream(tpi(record));
  const fieldList = parsed.types.get(0x1000);
  assert.equal(fieldList?.members.length, 0, 'children after the unmodeled kind are unreachable');
  assert.equal(fieldList?.complete, false);
  assert.equal(parsed.complete, false);
  assert.ok(parsed.unmodelled.has(0x150e));
});

test('#5773: a member-only field list stays complete', () => {
  const member = [
    0x0d, 0x15,             // LF_MEMBER
    0, 0,                   // attributes
    0x74, 0x00, 0x00, 0x00, // typeIndex
    0x08, 0x00,             // offset 8 (plain numeric)
    0x66, 0x00,             // "f\0"
  ];
  const record = fieldlistRecord(member);
  const parsed = parseTpiStream(tpi(record));
  const fieldList = parsed.types.get(0x1000);
  assert.deepEqual(fieldList?.members, [{ name: 'f', typeIndex: 0x74, offset: 8 }]);
  assert.equal(fieldList?.complete, true);
  assert.equal(parsed.complete, true);
  assert.equal(parsed.unmodelled.size, 0);
});

test('#5773: a truncated member child fails closed', () => {
  const record = fieldlistRecord([0x0d, 0x15, 0x00, 0x00, 0x74, 0x00]); // LF_MEMBER cut short
  const parsed = parseTpiStream(tpi(record));
  const fieldList = parsed.types.get(0x1000);
  assert.equal(fieldList?.complete, false);
  assert.equal(parsed.complete, false);
});

test('#5773: an empty field list is a complete (trivial) fact', () => {
  const record = fieldlistRecord();
  const parsed = parseTpiStream(tpi(record));
  const fieldList = parsed.types.get(0x1000);
  assert.deepEqual(fieldList?.members, []);
  assert.equal(fieldList?.complete, true);
  assert.equal(parsed.complete, true);
});

test('#5773: unresolved numeric offsets do not become complete members', () => {
  // These supported numeric encodings have no exact JavaScript value.
  // Knowing their encoded length must not imply knowing a member offset.
  for (const [leaf, width] of [[0x8007, 10], [0x8008, 16], [0x800b, 6]]) {
    const record = fieldlistRecord([
      0x0d, 0x15, 0, 0, 0x74, 0, 0, 0,
      leaf & 0xff, leaf >> 8, ...new Array(width).fill(0),
      0x66, 0,
    ]);
    const parsed = parseTpiStream(tpi(record));
    const fieldList = parsed.types.get(0x1000);
    assert.deepEqual(fieldList?.members, [], `numeric leaf ${leaf} has no known offset`);
    assert.equal(fieldList?.complete, false);
    assert.equal(parsed.complete, false);
  }
});

test('#5773: aggregate publication requires the entire field list', () => {
  const member = [0x0d, 0x15, 0, 0, 0x74, 0, 0, 0, 0, 0, 0x66, 0];
  const provider = new PdbDebugInfoProvider();
  for (const partial of [false, true]) {
    const tail = partial ? [0x0e, 0x15, 0, 0] : [];
    const parsed = parseTpiStream(tpi(fieldlistRecord(member, tail)));
    assert.equal(parsed.types.get(0x1000).members.length, 1, 'the known prefix remains available to the parser');
    parsed.types.set(0x1001, {
      kind: 'aggregate', name: 'Example', sizeBytes: 8,
      fieldList: 0x1000, forwardReference: false,
    });
    const aggregates = provider.aggregates({ parsed: { tpi: parsed } });
    assert.equal(aggregates.length, partial ? 0 : 1, 'a partial prefix cannot stand for the complete aggregate');
    if (!partial) assert.deepEqual(aggregates[0].members.map(({ name, offset }) => ({ name, offset })), [{ name: 'f', offset: 0 }]);
  }
});

test('#5773: a trailing byte must be consumed as padding, not an unfinished child', () => {
  // This member's name leaves one byte to reach the record's 4-byte alignment.
  const member = [0x0d, 0x15, 0, 0, 0x74, 0, 0, 0, 0, 0, 0x66, 0x66, 0x66, 0x66, 0];
  const provider = new PdbDebugInfoProvider();
  for (const [tail, complete] of [[0xf1, true], [0x01, false]]) {
    const parsed = parseTpiStream(tpi(fieldlistRecord(member, [tail])));
    const fields = parsed.types.get(0x1000);
    assert.equal(fields.members.length, 1, 'the known member remains parsed');
    assert.equal(fields.complete, complete, 'completion requires consuming the final byte');
    assert.equal(parsed.complete, complete);
    parsed.types.set(0x1001, {
      kind: 'aggregate', name: 'Example', sizeBytes: 8,
      fieldList: 0x1000, forwardReference: false,
    });
    assert.equal(provider.aggregates({ parsed: { tpi: parsed } }).length, complete ? 1 : 0);
  }
});
