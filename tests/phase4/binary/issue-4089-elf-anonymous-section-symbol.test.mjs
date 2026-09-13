import assert from 'node:assert/strict';
import test from 'node:test';
import { parseELF } from '../../../js/binary/elf-core.js';
import { makeElf64Fixture } from '../../universal-binary.mjs';

test('issue #4089: anonymous STT_SECTION symbol (st_name=0) is retained in image.symbols and resolves relocations', () => {
  const bytes = makeElf64Fixture();
  const view = new DataView(bytes.buffer);

  // Set ET_REL type
  view.setUint16(16, 1, true);

  // Symbol 1 at 0x178 was puts. Change it to an anonymous STT_SECTION for section 1 (.text):
  // name = 0 (st_name = 0)
  view.setUint32(0x178, 0, true);
  // info = (STB_LOCAL << 4) | STT_SECTION (3) = 0x03
  bytes[0x178 + 4] = 0x03;
  bytes[0x178 + 5] = 0; // other
  view.setUint16(0x178 + 6, 1, true); // shndx = 1 (.text)
  view.setBigUint64(0x178 + 8, 0n, true); // value = 0
  view.setBigUint64(0x178 + 16, 0n, true); // size = 0

  const image = parseELF(bytes);

  // Symbol 1 must be retained in image.symbols
  const sectSym = image.symbols.find((s) => s.index === 1);
  assert.ok(sectSym, 'anonymous STT_SECTION symbol must be retained in image.symbols');
  assert.equal(sectSym.kind, 'section');
  assert.equal(sectSym.sectionIndex, 1);
  assert.equal(sectSym.defined, true);

  // Symbol 0 (STN_UNDEF) must still NOT be retained as a regular symbol
  const nullSym = image.symbols.find((s) => s.index === 0);
  assert.equal(nullSym, undefined, 'symbol 0 (STN_UNDEF) must not be retained as a valid symbol');
});
