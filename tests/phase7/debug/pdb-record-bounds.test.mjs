import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSymbolRecords, parseTpiStream } from '../../../js/analysis/debug/pdb.js';

// Issue #1845: CodeView records declaring a known kind/leaf with too few bytes
// must fail closed. The parsers only checked the record length against the
// stream end, so a short S_PUB32/S_GPROC32 or TPI leaf read the *next* record's
// bytes as its fields — or threw a DataView RangeError at the stream end.

const symbolRecord = (payload) => Uint8Array.from([payload.length & 0xff, payload.length >> 8, ...payload]);

test('a short S_PUB32 record fails closed instead of throwing', () => {
  // length=2: kind only, no flags/offset/segment.
  const malformed = Uint8Array.from([0x02, 0x00, 0x0e, 0x11]);
  const result = parseSymbolRecords(malformed);
  assert.equal(result.symbols.length, 0, 'the short record must not become evidence');
  assert.equal(result.complete, false);
});

test('a short S_PUB32 cannot read the following record as its fields', () => {
  const pub = symbolRecord([0x0e, 0x11, 1, 0, 0, 0, 2, 0, 0, 0, 5, 0, 0x6f, 0x6b, 0x00]);
  const shortProc = symbolRecord([0x10, 0x11]);   // S_GPROC32, kind only
  const result = parseSymbolRecords(Uint8Array.from([...pub, ...shortProc]));
  assert.equal(result.symbols.length, 1, 'the valid record still parses');
  assert.equal(result.symbols[0].name, 'ok');
  assert.equal(result.complete, false, 'the short record stops the walk without inventing a second symbol');
});

test('a valid S_PUB32 still parses with its own fields', () => {
  const pub = symbolRecord([0x0e, 0x11, 1, 0, 0, 0, 2, 0, 0, 0, 5, 0, 0x6f, 0x6b, 0x00]);
  const result = parseSymbolRecords(pub);
  assert.equal(result.complete, true);
  assert.deepEqual(result.symbols[0], {
    kind: 'public', flags: 1, isFunction: false, offsetInSegment: 2, segment: 5,
    sizeBytes: null, name: 'ok', recordOffset: 0,
  });
});

const tpiStream = (records) => {
  const header = new Uint8Array(56);
  const view = new DataView(header.buffer);
  view.setUint32(4, 56, true);        // headerSize
  view.setUint32(8, 0x1000, true);    // firstIndex
  return Uint8Array.from([...header, ...records]);
};

test('a short LF_POINTER leaf fails closed instead of throwing', () => {
  const bytes = tpiStream(Uint8Array.from([0x02, 0x00, 0x02, 0x10]));  // len=2, leaf only
  const result = parseTpiStream(bytes);
  assert.equal(result.types.size, 0, 'the short leaf must not become a type');
  assert.equal(result.complete, false);
});

test('a short LF_STRUCTURE cannot read past its own end', () => {
  const pointer = Uint8Array.from([0x0a, 0x00, 0x02, 0x10, 1, 0, 0, 0, 2, 0, 0, 0]); // valid LF_POINTER
  const shortStruct = Uint8Array.from([0x04, 0x00, 0x05, 0x15, 1, 0]);                // LF_STRUCTURE, 2-byte body
  const result = parseTpiStream(tpiStream(Uint8Array.from([...pointer, ...shortStruct])));
  assert.equal(result.types.size, 1, 'the valid pointer still parses');
  const struct = [...result.types.values()].find((t) => t.kind === 'aggregate');
  assert.equal(struct, undefined, 'the short structure must not invent fields from the next record');
  assert.equal(result.complete, false);
});

test('a complete LF_STRUCTURE still parses with name and size', () => {
  // kind(2)+count(2)+props(2)+field(4)+derived(4)+vshape(4)+size(2)+name 'A\0'(2) = 22
  const structure = Uint8Array.from([
    22, 0, 0x05, 0x15, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0x41, 0,
  ]);
  const result = parseTpiStream(tpiStream(structure));
  assert.equal(result.complete, true);
  const type = [...result.types.values()][0];
  assert.equal(type.kind, 'aggregate');
  assert.equal(type.sizeBytes, 4);
  assert.equal(type.name, 'A');
});
