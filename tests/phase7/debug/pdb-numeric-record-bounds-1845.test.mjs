import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTpiStream } from '../../../js/analysis/debug/pdb.js';
function tpi(recordBytes) {
  const bytes = new Uint8Array(56 + recordBytes.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 56, true);
  view.setUint32(8, 0x1000, true);
  bytes.set(recordBytes, 56);
  return bytes;
}
test('LF_ARRAY without its numeric leaf fails closed at record end', () => {
  const record = Uint8Array.from([0x0a,0x00,0x03,0x15, 0,0,0,0, 0,0,0,0]);
  assert.doesNotThrow(() => parseTpiStream(tpi(record)));
  const parsed = parseTpiStream(tpi(record));
  assert.equal(parsed.types.size, 0);
  assert.equal(parsed.complete, false);
});
test('LF_ARRAY never consumes the next record as its numeric leaf', () => {
  const first = [0x0a,0x00,0x03,0x15, 0,0,0,0, 0,0,0,0];
  const next = [0x02,0x00,0x01,0x12];
  const parsed = parseTpiStream(tpi(Uint8Array.from([...first, ...next])));
  assert.equal(parsed.types.has(0x1000), false);
});
test('short LF_FIELDLIST member cannot read type or numeric data past its record', () => {
  const record = Uint8Array.from([0x06,0x00,0x03,0x12, 0x0d,0x15,0x00,0x00]);
  assert.doesNotThrow(() => parseTpiStream(tpi(record)));
  const parsed = parseTpiStream(tpi(record));
  assert.deepEqual(parsed.types.get(0x1000)?.members, []);
});
