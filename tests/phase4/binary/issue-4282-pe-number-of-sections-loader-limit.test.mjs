/**
 * #4282 regression: parsePE() models Windows executable images, whose loader
 * accepts at most 96 sections. The parser's independent byte-safety guard
 * must not turn the old 4096-parser limit into format validity.
 */
import assert from 'node:assert/strict';
import { parsePE } from '../../../js/binary/pe.js';

const MAX_WINDOWS_IMAGE_SECTIONS = 96;
const PE_OFFSET = 0x40;
const COFF_OFFSET = PE_OFFSET + 4;
const OPTIONAL_OFFSET = COFF_OFFSET + 20;
const OPTIONAL_SIZE = 112;
const SECTION_HEADER_SIZE = 40;
const FILE_ALIGNMENT = 0x200;

function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function put16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function put32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function put64(view, offset, value) {
  view.setBigUint64(offset, BigInt(value), true);
}

function makePe64(numberOfSections) {
  const sectionTable = OPTIONAL_OFFSET + OPTIONAL_SIZE;
  const headerEnd = sectionTable + numberOfSections * SECTION_HEADER_SIZE;
  const sizeOfHeaders = alignUp(headerEnd, FILE_ALIGNMENT);
  const bytes = new Uint8Array(sizeOfHeaders);
  const view = new DataView(bytes.buffer);

  put16(view, 0x00, 0x5a4d);                 // MZ
  put32(view, 0x3c, PE_OFFSET);
  put32(view, PE_OFFSET, 0x00004550);         // PE\0\0
  put16(view, COFF_OFFSET + 0, 0x8664);       // AMD64
  put16(view, COFF_OFFSET + 2, numberOfSections);
  put16(view, COFF_OFFSET + 16, OPTIONAL_SIZE);
  put16(view, COFF_OFFSET + 18, 0x0022);      // executable, large-address-aware

  put16(view, OPTIONAL_OFFSET + 0, 0x20b);    // PE32+
  put64(view, OPTIONAL_OFFSET + 24, 0x140000000n);
  put32(view, OPTIONAL_OFFSET + 32, 0x1000);  // SectionAlignment
  put32(view, OPTIONAL_OFFSET + 36, FILE_ALIGNMENT);
  put32(view, OPTIONAL_OFFSET + 56, Math.max(0x1000, sizeOfHeaders));
  put32(view, OPTIONAL_OFFSET + 60, sizeOfHeaders);
  put16(view, OPTIONAL_OFFSET + 68, 3);       // console subsystem
  put32(view, OPTIONAL_OFFSET + 108, 0);      // no data directories

  // Zero-size section descriptors are sufficient here: this regression owns
  // only the COFF header's image-section count validity boundary.
  return bytes;
}

function assertLoaderLimit(numberOfSections) {
  assert.throws(
    () => parsePE(makePe64(numberOfSections)),
    (error) => error instanceof Error
      && /NumberOfSections/.test(error.message)
      && /96/.test(error.message),
    `${numberOfSections} image sections must fail at the Windows loader validity boundary`,
  );
}

// Exact boundary remains valid when the rest of the image is structurally valid.
{
  const image = parsePE(makePe64(MAX_WINDOWS_IMAGE_SECTIONS));
  assert.equal(image.metadata.peSectionRawMappings.length, MAX_WINDOWS_IMAGE_SECTIONS);
}

// One over the documented Windows image-loader limit must fail closed.
assertLoaderLimit(MAX_WINDOWS_IMAGE_SECTIONS + 1);

// The former parser/resource threshold is not format authority.
assertLoaderLimit(4096);

// Ordinary images remain unaffected.
{
  const image = parsePE(makePe64(1));
  assert.equal(image.metadata.peSectionRawMappings.length, 1);
}

console.log('issue #4282 PE NumberOfSections loader limit: PASS');
