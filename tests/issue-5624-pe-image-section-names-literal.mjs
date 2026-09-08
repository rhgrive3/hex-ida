import assert from 'node:assert/strict';
import { resolveCoffSectionName } from '../js/binary/pe-loader.js';
import { parsePE } from '../js/binary/pe.js';

// Issue #5624: parsePE() routed every section header name through
// resolveCoffSectionName(), so a PE *image* whose literal section name is
// "/NNN" had that name replaced with string-table bytes whenever a COFF
// symbol/string table was present. The PE/COFF spec reserves the "/NNN"
// long-name indirection for object files; executable images never use the
// string table for section names.

class ByteViewForTest {
  constructor(bytes) {
    this.bytes = bytes;
    this.length = bytes.length;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u32(offset) { return this.view.getUint32(offset, true); }
  slice(start, length) { return this.bytes.slice(start, start + length); }
  cstring(start, max) {
    const limit = Math.min(this.length, start + max);
    let end = start;
    while (end < limit && this.bytes[end] !== 0) end++;
    return String.fromCharCode(...this.bytes.subarray(start, end));
  }
}

// Helper-level semantics are unchanged (object-file context keeps resolving).
{
  const bytes = new Uint8Array(64);
  const view = new DataView(bytes.buffer);
  const stringBase = 26;
  view.setUint32(stringBase, 16, true);
  bytes.set(new TextEncoder().encode('other\0'), stringBase + 4);
  const resolved = resolveCoffSectionName(new ByteViewForTest(bytes), '/4', 8, 1);
  assert.equal(resolved, 'other', 'the object-file helper contract is unchanged');
}

// Production parsePE path: the literal "/4" name survives a resolvable
// string table.
function makePEWithSectionName(name, { ptrSymbols = 8, numberOfSymbols = 1 } = {}) {
  const bytes = new Uint8Array(0x400);
  const view = new DataView(bytes.buffer);
  const pe = 0x80, coff = pe + 4;
  const optionalSize = 0xe0;
  const opt = coff + 20, section = opt + optionalSize;
  view.setUint16(0, 0x5a4d, true);
  view.setUint32(0x3c, pe, true);
  view.setUint32(pe, 0x00004550, true);
  view.setUint16(coff, 0x014c, true);
  view.setUint16(coff + 2, 1, true);
  view.setUint32(coff + 8, ptrSymbols, true);
  view.setUint32(coff + 12, numberOfSymbols, true);
  view.setUint16(coff + 16, optionalSize, true);
  view.setUint16(coff + 18, 0x0002, true);
  view.setUint16(opt, 0x10b, true);
  view.setUint32(opt + 28, 0x400000, true);
  view.setUint32(opt + 32, 0x1000, true);
  view.setUint32(opt + 36, 0x200, true);
  view.setUint32(opt + 56, 0x2000, true);
  view.setUint32(opt + 60, 0x200, true);
  view.setUint16(opt + 68, 3, true);
  view.setUint32(opt + 92, 0, true);
  bytes.set(new TextEncoder().encode(name), section);
  view.setUint32(section + 8, 0x60, true);
  view.setUint32(section + 12, 0x1000, true);
  view.setUint32(section + 16, 0x60, true);
  view.setUint32(section + 20, 0x200, true);
  view.setUint32(section + 36, 0x40000040, true);
  // A COFF string table at ptrSymbols + numberOfSymbols*18 = 26 with a
  // resolvable entry at offset 4 ("other").
  view.setUint32(26, 16, true);
  bytes.set(new TextEncoder().encode('other\0'), 30);
  return bytes;
}

{
  const image = parsePE(makePEWithSectionName('/4'));
  assert.equal(image.sections[0].name, '/4', 'the image section name is the literal header bytes');
}

// Regular names are untouched too.
{
  const image = parsePE(makePEWithSectionName('.rsrc'));
  assert.equal(image.sections[0].name, '.rsrc');
}

// A name with no string table present is equally unchanged.
{
  const image = parsePE(makePEWithSectionName('/4', { ptrSymbols: 0, numberOfSymbols: 0 }));
  assert.equal(image.sections[0].name, '/4');
}

console.log('issue #5624 PE image section names keep literal bytes regression: PASS');
