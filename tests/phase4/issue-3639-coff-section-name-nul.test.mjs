import assert from 'node:assert/strict';
import test from 'node:test';

import { ByteView } from '../../js/binary/reader.js';
import { resolveCoffSectionName } from '../../js/binary/pe-loader.js';

function readerWithStringTable(payload, declaredSize = payload.length + 4, trailing = []) {
  assert.ok(payload.length <= declaredSize - 4);
  const stringBase = 4;
  const bytes = new Uint8Array(stringBase + declaredSize + trailing.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(stringBase, declaredSize, true);
  bytes.set(payload, stringBase + 4);
  bytes.set(trailing, stringBase + declaredSize);
  return new ByteView(bytes, { littleEndian: true });
}

test('COFF long section names resolve only when NUL-terminated inside the declared string table', () => {
  const valid = readerWithStringTable([0x41, 0x42, 0x43, 0x44, 0x00]);
  assert.equal(resolveCoffSectionName(valid, '/4', 4, 0), 'ABCD');

  const unterminated = readerWithStringTable([0x41, 0x42, 0x43, 0x44]);
  assert.equal(resolveCoffSectionName(unterminated, '/4', 4, 0), '/4');

  const nulPastDeclaredEnd = readerWithStringTable([0x41, 0x42, 0x43, 0x44], 8, [0x00]);
  assert.equal(resolveCoffSectionName(nulPastDeclaredEnd, '/4', 4, 0), '/4');
});

test('COFF section-name validation preserves existing bounds and inline-name behavior', () => {
  const valid = readerWithStringTable([0x4c, 0x4f, 0x4e, 0x47, 0x4e, 0x41, 0x4d, 0x45, 0x00]);
  assert.equal(resolveCoffSectionName(valid, '/4', 4, 0), 'LONGNAME');
  assert.equal(resolveCoffSectionName(valid, '/3', 4, 0), '/3');
  assert.equal(resolveCoffSectionName(valid, '/13', 4, 0), '/13');
  assert.equal(resolveCoffSectionName(valid, '.text', 4, 0), '.text');

  const tooShort = new ByteView(new Uint8Array(8), { littleEndian: true });
  assert.equal(resolveCoffSectionName(tooShort, '/4', 6, 0), '/4');
});
