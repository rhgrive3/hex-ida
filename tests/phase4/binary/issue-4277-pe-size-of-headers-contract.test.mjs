/**
 * #4277 regression: SizeOfHeaders is loader-format authority for the complete
 * PE headers, including the section table, and must be FileAlignment-rounded
 * when that alignment is otherwise valid.
 */
import assert from 'node:assert/strict';
import { parsePE } from '../../../js/binary/pe.js';

const PE_OFFSET = 0x80;
const COFF_OFFSET = PE_OFFSET + 4;
const OPTIONAL_OFFSET = COFF_OFFSET + 20;
const OPTIONAL_SIZE = 0xf0;
const SECTION_HEADER_SIZE = 40;
const FILE_ALIGNMENT = 0x200;
const SECTION_ALIGNMENT = 0x1000;

function put16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function put32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function put64(view, offset, value) {
  view.setBigUint64(offset, BigInt(value), true);
}

function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function makePe64({ sizeOfHeaders, fileLength = 0x400 } = {}) {
  const sectionTable = OPTIONAL_OFFSET + OPTIONAL_SIZE;
  const actualHeaderEnd = sectionTable + SECTION_HEADER_SIZE;
  const declaredHeaders = sizeOfHeaders ?? alignUp(actualHeaderEnd, FILE_ALIGNMENT);
  const bytes = new Uint8Array(Math.max(fileLength, actualHeaderEnd));
  const view = new DataView(bytes.buffer);

  put16(view, 0x00, 0x5a4d);                 // MZ
  put32(view, 0x3c, PE_OFFSET);
  put32(view, PE_OFFSET, 0x00004550);         // PE\0\0
  put16(view, COFF_OFFSET + 0, 0x8664);       // AMD64
  put16(view, COFF_OFFSET + 2, 1);            // one section
  put16(view, COFF_OFFSET + 16, OPTIONAL_SIZE);
  put16(view, COFF_OFFSET + 18, 0x0022);      // executable, large-address-aware

  put16(view, OPTIONAL_OFFSET + 0, 0x20b);    // PE32+
  put64(view, OPTIONAL_OFFSET + 24, 0x140000000n);
  put32(view, OPTIONAL_OFFSET + 32, SECTION_ALIGNMENT);
  put32(view, OPTIONAL_OFFSET + 36, FILE_ALIGNMENT);
  put32(view, OPTIONAL_OFFSET + 56, 0x1000);  // SizeOfImage
  put32(view, OPTIONAL_OFFSET + 60, declaredHeaders);
  put16(view, OPTIONAL_OFFSET + 68, 3);       // console subsystem
  put32(view, OPTIONAL_OFFSET + 108, 7);      // keep one unused directory entry

  // Debug directory entry is retained but not semantically consumed here. Put
  // its target inside the canonical header span so the valid-control case also
  // proves header-resident directory mapping is preserved.
  const directoryBase = OPTIONAL_OFFSET + 112;
  put32(view, directoryBase + 6 * 8, 0x1c0);
  put32(view, directoryBase + 6 * 8 + 4, 0x20);

  return { bytes, actualHeaderEnd, declaredHeaders };
}

function assertHeaderReject(sizeOfHeaders, message) {
  const { bytes } = makePe64({ sizeOfHeaders });
  assert.throws(
    () => parsePE(bytes),
    (error) => error instanceof Error && /SizeOfHeaders/.test(error.message),
    message,
  );
}

// Normal rounded headers remain valid, including header-resident RVA mapping.
{
  const { bytes, actualHeaderEnd, declaredHeaders } = makePe64();
  assert.ok(declaredHeaders >= actualHeaderEnd);
  assert.equal(declaredHeaders % FILE_ALIGNMENT, 0);
  const image = parsePE(bytes);
  assert.equal(image.metadata.sizeOfHeaders, declaredHeaders);
  assert.equal(image.metadata.directories[6].rva, 0x1c0);
  assert.equal(image.addressToOffset(image.imageBase + 0x1c0n), 0x1c0n);
}

// A declaration that ends inside the PE/optional headers cannot authorize the
// bytes the parser itself consumed as header structure.
assertHeaderReject(0x100, 'SizeOfHeaders ending inside the optional header must fail closed');

// Covering the optional header but ending inside the section table is equally
// invalid even when the physical file contains the full table.
{
  const { actualHeaderEnd } = makePe64();
  assertHeaderReject(actualHeaderEnd - 1, 'SizeOfHeaders ending inside the section table must fail closed');
}

// With an otherwise-valid FileAlignment, SizeOfHeaders is the rounded header
// size and may not be an arbitrary byte count.
assertHeaderReject(0x201, 'non-FileAlignment-multiple SizeOfHeaders must fail closed');

console.log('issue #4277 PE SizeOfHeaders contract: PASS');
