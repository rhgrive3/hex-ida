import assert from 'node:assert/strict';
import { parseDex } from '../../../js/managed/dex/parser.js';
import { buildMinimalDex } from './dex-parser.test.mjs';

console.log('[phase11] running DEX class_data field-index regression #3729...');

function buildFieldDex(fieldCount, classData) {
  const bytes = buildMinimalDex();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  view.setUint32(80, fieldCount, true);
  view.setUint32(84, 0xd0, true);
  for (let i = 0; i < fieldCount; i++) {
    const off = 0xd0 + i * 8;
    view.setUint16(off, 1, true);
    view.setUint16(off + 2, 1, true);
    view.setUint32(off + 4, 2, true);
  }

  bytes.fill(0, 0x120, 0x140);
  bytes.set(classData, 0x120);

  const mapOff = view.getUint32(52, true);
  const mapItems = [
    [0x0000, 1, 0x000], [0x0001, 3, 0x070], [0x0002, 2, 0x080],
    [0x0003, 1, 0x090], [0x0005, 1, 0x0a0], [0x0006, 1, 0x0b0],
    [0x0004, fieldCount, 0x0d0], [0x2002, 3, 0x100], [0x2000, 1, 0x120],
    [0x2001, 1, 0x140], [0x1000, 1, mapOff],
  ];
  view.setUint32(mapOff, mapItems.length, true);
  for (let i = 0; i < mapItems.length; i++) {
    const [type, size, offset] = mapItems[i];
    const pos = mapOff + 4 + i * 12;
    view.setUint16(pos, type, true);
    view.setUint16(pos + 2, 0, true);
    view.setUint32(pos + 4, size, true);
    view.setUint32(pos + 8, offset, true);
  }
  return bytes;
}

function rejects(fieldCount, classData) {
  assert.throws(
    () => parseDex(buildFieldDex(fieldCount, classData)),
    /dex-invalid-class-data-field-index/,
  );
}

rejects(1, [0x01, 0x00, 0x00, 0x00, 0x02, 0x01]);
rejects(1, [0x00, 0x01, 0x00, 0x00, 0x02, 0x01]);
assert.doesNotThrow(() =>
  parseDex(buildFieldDex(2, [0x02, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01])),
);
rejects(2, [0x02, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01, 0x01]);
assert.doesNotThrow(() =>
  parseDex(buildFieldDex(2, [0x01, 0x01, 0x00, 0x00, 0x01, 0x01, 0x01, 0x01])),
);

console.log('  ok DEX class_data field-index regression #3729 passed');
