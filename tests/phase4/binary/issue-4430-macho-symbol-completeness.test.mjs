import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMachO } from '../../../js/binary/macho.js';

function machoWithSymbol({ strx, stringBytes, type = 0x01, value = 0n, desc = 0 } = {}) {
  const symoff = 0x80;
  const stroff = symoff + 16;
  const bytes = new Uint8Array(stroff + stringBytes.length);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, 0xfeedfacf, true);
  view.setInt32(4, 0x0100000c, true);
  view.setInt32(8, 0, true);
  view.setUint32(12, 2, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, 24, true);
  view.setUint32(24, 0, true);
  view.setUint32(28, 0, true);

  view.setUint32(32, 0x2, true); // LC_SYMTAB
  view.setUint32(36, 24, true);
  view.setUint32(40, symoff, true);
  view.setUint32(44, 1, true);
  view.setUint32(48, stroff, true);
  view.setUint32(52, stringBytes.length, true);

  view.setUint32(symoff, strx, true);
  view.setUint8(symoff + 4, type);
  view.setUint8(symoff + 5, 1);
  view.setUint16(symoff + 6, desc, true);
  view.setBigUint64(symoff + 8, value, true);
  bytes.set(stringBytes, stroff);
  return bytes;
}

function reasons(image) {
  return image.metadata.machoMetadata.reasons;
}

test('#4430 marks out-of-range n_strx partial instead of silently complete', () => {
  const image = parseMachO(machoWithSymbol({
    strx: 2,
    stringBytes: Uint8Array.from([0, 0]),
  }));

  assert.equal(image.symbols.length, 0);
  assert.equal(image.imports.length, 0);
  assert.equal(image.metadata.machoMetadata.complete, false);
  assert.ok(reasons(image).includes('symbol-name-index-out-of-range'));
  assert.ok(image.warnings.some((warning) => /n_strx.*outside string table/.test(warning)));
});

test('#4430 marks an in-range unterminated symbol name partial', () => {
  const image = parseMachO(machoWithSymbol({
    strx: 1,
    stringBytes: Uint8Array.from([0, 0x5f, 0x75, 0x6e, 0x74, 0x65, 0x72, 0x6d]),
  }));

  assert.equal(image.symbols.length, 0);
  assert.equal(image.imports.length, 0);
  assert.equal(image.metadata.machoMetadata.complete, false);
  assert.ok(reasons(image).includes('symbol-name-not-terminated'));
  assert.ok(image.warnings.some((warning) => /NUL terminator/.test(warning)));
});

test('#4430 does not treat a valid empty entry or terminated symbol as malformed', () => {
  const empty = parseMachO(machoWithSymbol({
    strx: 0,
    stringBytes: Uint8Array.from([0]),
  }));
  assert.equal(empty.metadata.machoMetadata.complete, true);
  assert.deepEqual(reasons(empty), []);

  const valid = parseMachO(machoWithSymbol({
    strx: 1,
    type: 0x0f,
    value: 0x1000n,
    stringBytes: Uint8Array.from([0, 0x5f, 0x6f, 0x6b, 0]),
  }));
  assert.equal(valid.metadata.machoMetadata.complete, true);
  assert.equal(valid.symbols[0].name, '_ok');
  assert.equal(valid.exports[0].name, '_ok');
});

test('#4430 malformed defined and undefined symbols never publish import/export truth', () => {
  for (const [type, value] of [[0x01, 0n], [0x0f, 0x1000n]]) {
    const image = parseMachO(machoWithSymbol({
      strx: 1,
      type,
      value,
      stringBytes: Uint8Array.from([0, 0x62, 0x61, 0x64]),
    }));
    assert.equal(image.metadata.machoMetadata.complete, false);
    assert.equal(image.imports.length, 0);
    assert.equal(image.exports.length, 0);
  }
});
