import assert from 'node:assert/strict';
import { parseDex } from '../../../js/managed/dex/parser.js';

console.log('[phase11] running DEX MUTF-8 regression #3726...');

function buildStringDex(data) {
  const fileSize = 0x74 + data.length;
  const bytes = new Uint8Array(fileSize);
  const view = new DataView(bytes.buffer);

  bytes.set([0x64, 0x65, 0x78, 0x0a, 0x30, 0x33, 0x35, 0x00], 0); // dex\n035\0
  view.setUint32(32, fileSize, true);
  view.setUint32(36, 0x70, true);
  view.setUint32(40, 0x12345678, true);
  view.setUint32(56, 1, true); // string_ids_size
  view.setUint32(60, 0x70, true); // string_ids_off
  view.setUint32(0x70, 0x74, true); // string_data_off
  bytes.set(data, 0x74);
  return bytes;
}

function rejects(data) {
  assert.throws(() => parseDex(buildStringDex(data)), /dex-malformed-string-data/);
}

assert.deepEqual(parseDex(buildStringDex([1, 0x41, 0])).strings, ['A']);
rejects([3, 0x41, 0]); // utf16_size mismatch

assert.deepEqual(parseDex(buildStringDex([1, 0xc0, 0x80, 0])).strings, ['\0']); // encoded NUL
assert.deepEqual(
  parseDex(buildStringDex([2, 0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80, 0])).strings,
  ['😀'],
); // supplementary code point encoded as a surrogate pair

rejects([1, 0xc2, 0x41, 0]); // invalid continuation
rejects([1, 0xc2]); // truncated multi-byte sequence
rejects([1, 0x41]); // missing terminator
rejects([1, 0xf0, 0x90, 0x80, 0x80, 0]); // 4-byte UTF-8 form is not DEX MUTF-8
rejects([1, 0xc1, 0x81, 0]); // non-NUL overlong encoding

console.log('  ok DEX MUTF-8 regression #3726 passed');
