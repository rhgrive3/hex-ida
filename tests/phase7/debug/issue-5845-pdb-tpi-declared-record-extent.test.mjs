import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTpiStream } from '../../../js/analysis/debug/pdb.js';

// The TPI header owns the record range: TypeRecordBytes bytes after
// HeaderSize, indexed TypeIndexBegin..TypeIndexEnd-1. Records outside that
// declared extent must never become types, and a parsed count that disagrees
// with TypeIndexEnd - TypeIndexBegin must not report complete (#5845).

const header = (length, { headerSize = 56, firstIndex = 0x1000, lastIndex = firstIndex, recordBytes = 0 } = {}) => {
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 20040203, true); // V80
  view.setUint32(4, headerSize, true);
  view.setUint32(8, firstIndex, true);
  view.setUint32(12, lastIndex, true);
  view.setUint32(16, recordBytes, true);
  return bytes;
};

const POINTER_RECORD = Uint8Array.from([0x0a, 0x00, 0x02, 0x10, 0x74, 0x00, 0x00, 0x00, 0, 0, 0, 0]);

test('#5845: declared-empty TPI stream does not parse trailing bytes as types', () => {
  // Header declares 0 records / 0 record bytes, then a plausible LF_POINTER
  // record sits beyond the declared extent.
  const bytes = header(68);
  bytes.set(POINTER_RECORD, 56);

  const parsed = parseTpiStream(bytes);
  assert.equal(parsed.types.size, 0, 'bytes the header does not own are not types');
  assert.equal(parsed.complete, true, 'an empty declared range is trivially complete');
  assert.ok(!parsed.types.has(0x1000));
});

test('#5845: a record crossing the declared TypeRecordBytes boundary is rejected', () => {
  // Declared 10 record bytes, but the record ends at byte 12 of the range.
  const bytes = header(56 + 12, { firstIndex: 0x1000, lastIndex: 0x1001, recordBytes: 10 });
  bytes.set(POINTER_RECORD, 56);

  const parsed = parseTpiStream(bytes);
  assert.equal(parsed.types.size, 0);
  assert.equal(parsed.complete, false);
});

test('#5845: a parsed count that disagrees with TypeIndexEnd-TypeIndexBegin is not complete', () => {
  // Two records of data but only one declared index slot.
  const twoRecords = Uint8Array.from([...POINTER_RECORD, ...POINTER_RECORD]);
  const bytes = header(56 + twoRecords.length, { firstIndex: 0x1000, lastIndex: 0x1001, recordBytes: twoRecords.length });
  bytes.set(twoRecords, 56);

  const parsed = parseTpiStream(bytes);
  assert.equal(parsed.types.size, 1, 'the declared slot still parses');
  assert.equal(parsed.complete, false, 'a second record is outside the declared index window');
});

test('#5845: TypeIndexEnd below TypeIndexBegin fails closed', () => {
  const bytes = header(56 + POINTER_RECORD.length, { firstIndex: 0x1001, lastIndex: 0x1000, recordBytes: POINTER_RECORD.length });
  bytes.set(POINTER_RECORD, 56);

  const parsed = parseTpiStream(bytes);
  assert.equal(parsed.types.size, 0);
  assert.equal(parsed.complete, false);
});

test('#5845: TypeRecordBytes beyond the stream fails closed', () => {
  const bytes = header(56 + POINTER_RECORD.length, { firstIndex: 0x1000, lastIndex: 0x1001, recordBytes: 1 << 20 });
  bytes.set(POINTER_RECORD, 56);

  const parsed = parseTpiStream(bytes);
  assert.equal(parsed.types.size, 0);
  assert.equal(parsed.complete, false);
});

test('#5845: a consistent declared range parses exactly its records and stays complete', () => {
  const twoRecords = Uint8Array.from([...POINTER_RECORD, ...POINTER_RECORD]);
  const bytes = header(56 + twoRecords.length, { firstIndex: 0x1000, lastIndex: 0x1002, recordBytes: twoRecords.length });
  bytes.set(twoRecords, 56);

  const parsed = parseTpiStream(bytes);
  assert.equal(parsed.types.size, 2);
  assert.equal(parsed.types.get(0x1000)?.kind, 'pointer');
  assert.equal(parsed.types.get(0x1001)?.kind, 'pointer');
  assert.equal(parsed.complete, true);
});

test('#5845: trailing bytes past the declared record range do not block completeness', () => {
  // One declared 12-byte record followed by trailing hash-style bytes that do
  // not form a record header inside the declared range.
  const trailing = Uint8Array.from([...POINTER_RECORD, 0xde, 0xad, 0xbe, 0xef]);
  const bytes = header(56 + trailing.length, { firstIndex: 0x1000, lastIndex: 0x1001, recordBytes: POINTER_RECORD.length });
  bytes.set(trailing, 56);

  const parsed = parseTpiStream(bytes);
  assert.equal(parsed.types.size, 1);
  assert.equal(parsed.complete, true, 'bytes past TypeRecordBytes are not type records');
});
