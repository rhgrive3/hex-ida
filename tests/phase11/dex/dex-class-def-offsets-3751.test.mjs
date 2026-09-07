import assert from 'node:assert/strict';
import { parseDex } from '../../../js/managed/dex/parser.js';

console.log('[phase11] running DEX class_def offset regression #3751...');

function buildClassDefDex({ withReferences = false } = {}) {
  const fileSize = 0x140;
  const bytes = new Uint8Array(fileSize);
  const view = new DataView(bytes.buffer);

  bytes.set([0x64, 0x65, 0x78, 0x0a, 0x30, 0x33, 0x35, 0x00], 0);
  view.setUint32(32, fileSize, true);
  view.setUint32(36, 0x70, true);
  view.setUint32(40, 0x12345678, true);
  const mapOff = 0xc0;
  view.setUint32(52, mapOff, true);
  view.setUint32(104, fileSize - 0x98, true);
  view.setUint32(108, 0x98, true);

  view.setUint32(56, 1, true);
  view.setUint32(60, 0x70, true);
  view.setUint32(64, 1, true);
  view.setUint32(68, 0x74, true);
  view.setUint32(96, 1, true);
  view.setUint32(100, 0x78, true);

  view.setUint32(0x70, 0xb0, true);
  view.setUint32(0x74, 0, true);

  view.setUint32(0x78, 0, true);
  view.setUint32(0x7c, 1, true);
  view.setUint32(0x80, 0xffffffff, true);
  view.setUint32(0x84, withReferences ? 0x98 : 0, true);
  view.setUint32(0x88, 0xffffffff, true);
  view.setUint32(0x8c, withReferences ? 0x9c : 0, true);
  view.setUint32(0x90, 0, true);
  view.setUint32(0x94, withReferences ? 0xac : 0, true);

  view.setUint32(0x98, 0, true);
  bytes[0xac] = 0;
  bytes.set([6, 0x4c, 0x54, 0x65, 0x73, 0x74, 0x3b, 0], 0xb0);

  const mapItems = [
    [0x0000, 1, 0x00], [0x0001, 1, 0x70], [0x0002, 1, 0x74], [0x0006, 1, 0x78],
    ...(withReferences ? [[0x1001, 1, 0x98], [0x2006, 1, 0x9c], [0x2005, 1, 0xac]] : []),
    [0x2002, 1, 0xb0], [0x1000, 1, mapOff],
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

function mutated(fieldOffset, value) {
  const bytes = buildClassDefDex();
  new DataView(bytes.buffer).setUint32(0x78 + fieldOffset, value, true);
  return bytes;
}

assert.doesNotThrow(() => parseDex(buildClassDefDex()));
assert.doesNotThrow(() => parseDex(buildClassDefDex({ withReferences: true })));

assert.throws(() => parseDex(mutated(12, 0x144)), /dex-invalid-interfaces-offset/);
assert.throws(() => parseDex(mutated(20, 0x148)), /dex-invalid-annotations-offset/);
assert.throws(() => parseDex(mutated(28, 0x14c)), /dex-invalid-static-values-offset/);
assert.throws(() => parseDex(mutated(12, 0x99)), /dex-invalid-interfaces-offset/);
assert.throws(() => parseDex(mutated(20, 0x9e)), /dex-invalid-annotations-offset/);

console.log('  ok DEX class_def offset regression #3751 passed');
