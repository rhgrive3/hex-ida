import assert from 'node:assert/strict';
import { parseDex } from '../../../js/managed/dex/parser.js';

console.log('[phase11] running DEX MUTF-8 regression #3726...');

function buildStringDex(data) {
  const mapOff = 0x74;
  const mapItemCount = 4;
  const stringDataOff = mapOff + 4 + mapItemCount * 12;
  const fileSize = stringDataOff + data.length;
  const mapItems = [
    [0x0000, 1, 0x00],
    [0x0001, 1, 0x70],
    [0x1000, 1, mapOff],
    [0x2002, 1, stringDataOff],
  ];
  const bytes = new Uint8Array(fileSize);
  const view = new DataView(bytes.buffer);

  bytes.set([0x64, 0x65, 0x78, 0x0a, 0x30, 0x33, 0x35, 0x00], 0);
  view.setUint32(32, fileSize, true);
  view.setUint32(36, 0x70, true);
  view.setUint32(40, 0x12345678, true);
  view.setUint32(52, mapOff, true);
  view.setUint32(56, 1, true);
  view.setUint32(60, 0x70, true);
  view.setUint32(104, fileSize - mapOff, true);
  view.setUint32(108, mapOff, true);
  view.setUint32(0x70, stringDataOff, true);

  view.setUint32(mapOff, mapItems.length, true);
  for (let i = 0; i < mapItems.length; i++) {
    const [type, size, offset] = mapItems[i];
    const pos = mapOff + 4 + i * 12;
    view.setUint16(pos, type, true);
    view.setUint16(pos + 2, 0, true);
    view.setUint32(pos + 4, size, true);
    view.setUint32(pos + 8, offset, true);
  }
  bytes.set(data, stringDataOff);
  return bytes;
}

function rejects(data) {
  assert.throws(() => parseDex(buildStringDex(data)), /dex-malformed-string-data/);
}

assert.deepEqual(parseDex(buildStringDex([1, 0x41, 0])).strings, ['A']);
rejects([3, 0x41, 0]);
assert.deepEqual(parseDex(buildStringDex([1, 0xc0, 0x80, 0])).strings, ['\0']);
assert.deepEqual(
  parseDex(buildStringDex([2, 0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80, 0])).strings,
  ['😀'],
);
rejects([1, 0xc2, 0x41, 0]);
rejects([1, 0xc2]);
rejects([1, 0x41]);
rejects([1, 0xf0, 0x90, 0x80, 0x80, 0]);
rejects([1, 0xc1, 0x81, 0]);

console.log('  ok DEX MUTF-8 regression #3726 passed');
