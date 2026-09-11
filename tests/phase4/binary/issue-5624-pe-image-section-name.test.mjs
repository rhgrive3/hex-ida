/**
 * #5624 regression: PE executable-image section-table Name is a literal
 * 8-byte field. COFF object-file /NNN section-name indirection must not be
 * applied to it, while COFF symbol long names remain resolvable.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePE } from '../../../js/binary/pe.js';
import { ByteView } from '../../../js/binary/reader.js';
import { resolveCoffSectionName } from '../../../js/binary/pe-loader.js';

const PE_OFFSET = 0x40;
const COFF_OFFSET = PE_OFFSET + 4;
const OPTIONAL_OFFSET = COFF_OFFSET + 20;
const OPTIONAL_SIZE = 112 + 16 * 8;
const SECTION_OFFSET = OPTIONAL_OFFSET + OPTIONAL_SIZE;
const SYMBOL_OFFSET = 0x400;
const SYMBOL_SIZE = 18;
const STRING_TABLE_OFFSET = SYMBOL_OFFSET + SYMBOL_SIZE;
const FILE_SIZE = 0x500;
const COFF_SYMBOL_NAME = 'coff-long-symbol';
const encoder = new TextEncoder();
const COFF_SYMBOL_NAME_BYTES = new Uint8Array([
  ...encoder.encode(COFF_SYMBOL_NAME),
  0,
]);
const VALID_STRING_TABLE_SIZE = 4 + COFF_SYMBOL_NAME_BYTES.length;

function put16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function put32(view, offset, value) {
  view.setUint32(offset, value, true);
}

function put64(view, offset, value) {
  view.setBigUint64(offset, value, true);
}

function buildPE({
  sectionName = '/4',
  stringTableSize = VALID_STRING_TABLE_SIZE,
  stringTableBytes = COFF_SYMBOL_NAME_BYTES,
} = {}) {
  const bytes = new Uint8Array(FILE_SIZE);
  const view = new DataView(bytes.buffer);

  bytes.set([0x4d, 0x5a]); // MZ
  put32(view, 0x3c, PE_OFFSET);
  put32(view, PE_OFFSET, 0x00004550); // PE\0\0

  put16(view, COFF_OFFSET, 0x8664); // AMD64
  put16(view, COFF_OFFSET + 2, 1); // NumberOfSections
  put32(view, COFF_OFFSET + 8, SYMBOL_OFFSET);
  put32(view, COFF_OFFSET + 12, 1); // one COFF symbol
  put16(view, COFF_OFFSET + 16, OPTIONAL_SIZE);
  put16(view, COFF_OFFSET + 18, 0x22);

  put16(view, OPTIONAL_OFFSET, 0x20b); // PE32+
  put64(view, OPTIONAL_OFFSET + 24, 0x140000000n); // ImageBase
  put32(view, OPTIONAL_OFFSET + 32, 0x1000); // SectionAlignment
  put32(view, OPTIONAL_OFFSET + 36, 0x200); // FileAlignment
  put32(view, OPTIONAL_OFFSET + 56, 0x2000); // SizeOfImage
  put32(view, OPTIONAL_OFFSET + 60, 0x200); // SizeOfHeaders
  put16(view, OPTIONAL_OFFSET + 68, 3); // Subsystem
  put32(view, OPTIONAL_OFFSET + 108, 16); // NumberOfRvaAndSizes

  const sectionNameBytes = encoder.encode(sectionName);
  bytes.set(sectionNameBytes.subarray(0, 8), SECTION_OFFSET);
  put32(view, SECTION_OFFSET + 8, 0x20); // VirtualSize
  put32(view, SECTION_OFFSET + 12, 0x1000); // VirtualAddress
  put32(view, SECTION_OFFSET + 16, 0x200); // SizeOfRawData
  put32(view, SECTION_OFFSET + 20, 0x200); // PointerToRawData
  put32(view, SECTION_OFFSET + 36, 0x60000020); // read/execute/code

  // IMAGE_SYMBOL: zeroed name + offset 4 means a long COFF symbol name.
  put32(view, SYMBOL_OFFSET + 4, 4);
  put32(view, SYMBOL_OFFSET + 8, 0x10); // Value inside section 1
  view.setInt16(SYMBOL_OFFSET + 12, 1, true); // SectionNumber
  put16(view, SYMBOL_OFFSET + 14, 0x20); // function type
  view.setUint8(SYMBOL_OFFSET + 16, 2); // external storage class
  put32(view, STRING_TABLE_OFFSET, stringTableSize);
  bytes.set(stringTableBytes, STRING_TABLE_OFFSET + 4);

  return bytes;
}

function sectionFacts(image) {
  const section = image.sections.find((candidate) => candidate.source === 'PE-section');
  assert.ok(section, 'the fixture must produce a canonical PE section');
  return {
    section,
    rawMapping: image.metadata.peSectionRawMappings[0],
    rawSize: image.metadata.peSectionRawSizes[0],
  };
}

test('#5624 keeps /NNN literal for an executable-image section', () => {
  const bytes = buildPE({ sectionName: '/4' });
  const image = parsePE(bytes);
  const { section, rawMapping, rawSize } = sectionFacts(image);

  assert.equal(section.name, '/4');
  assert.equal(rawMapping.name, '/4');
  assert.equal(rawSize.name, '/4');
  assert.equal(image.metadata.peMetadata.complete, true);

  // The object-file helper remains available for its own /NNN contract.
  assert.equal(
    resolveCoffSectionName(new ByteView(bytes), '/4', SYMBOL_OFFSET, 1),
    COFF_SYMBOL_NAME,
  );
});
test('#5624 preserves ordinary section names and COFF symbol long names', () => {
  const image = parsePE(buildPE({ sectionName: '.text' }));
  const { section, rawMapping, rawSize } = sectionFacts(image);

  assert.equal(section.name, '.text');
  assert.equal(rawMapping.name, '.text');
  assert.equal(rawSize.name, '.text');
  assert.equal(image.symbols.length, 1);
  assert.equal(image.symbols[0].name, COFF_SYMBOL_NAME);
  assert.equal(image.symbols[0].sectionIndex, 1);
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].name, COFF_SYMBOL_NAME);
});

test('#5624 malformed COFF string tables cannot change image section identity', () => {
  for (const sectionName of ['/4', '.text']) {
    const image = parsePE(buildPE({
      sectionName,
      stringTableSize: 3,
      stringTableBytes: [],
    }));
    const { section, rawMapping, rawSize } = sectionFacts(image);

    assert.equal(section.name, sectionName);
    assert.equal(rawMapping.name, sectionName);
    assert.equal(rawSize.name, sectionName);
    assert.equal(image.symbols.length, 0, sectionName);
    assert.equal(image.metadata.peMetadata.complete, false, sectionName);
    assert.ok(
      image.metadata.peMetadata.reasons.includes('coff:string-table-size'),
      sectionName,
    );
  }
});
