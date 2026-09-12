/**
 * #4285 regression: SizeOfImage is the PE image-wide virtual extent authority.
 * It must cover SizeOfHeaders, be aligned to SectionAlignment when that
 * alignment is usable, and bound every canonical section mapping.
 */
import assert from 'node:assert/strict';
import { parsePE } from '../../../js/binary/pe.js';

const PE_OFFSET = 0x40;
const COFF_OFFSET = PE_OFFSET + 4;
const OPTIONAL_OFFSET = COFF_OFFSET + 20;
const OPTIONAL_SIZE = 112;
const SECTION_HEADER_SIZE = 40;

function put16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function put32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function put64(view, offset, value) {
  view.setBigUint64(offset, BigInt(value), true);
}

function makePe64({
  sectionAlignment = 0x1000,
  fileAlignment = 0x200,
  sizeOfImage = 0x2000,
  sizeOfHeaders = 0x200,
  section = { virtualAddress: 0x1000, virtualSize: 0x800 },
  entryRva = 0,
} = {}) {
  const sectionCount = section ? 1 : 0;
  const sectionTable = OPTIONAL_OFFSET + OPTIONAL_SIZE;
  const minimumBytes = Math.max(
    sizeOfHeaders,
    sectionTable + sectionCount * SECTION_HEADER_SIZE,
    0x400,
  );
  const bytes = new Uint8Array(minimumBytes);
  const view = new DataView(bytes.buffer);

  put16(view, 0x00, 0x5a4d);
  put32(view, 0x3c, PE_OFFSET);
  put32(view, PE_OFFSET, 0x00004550);
  put16(view, COFF_OFFSET + 0, 0x8664);
  put16(view, COFF_OFFSET + 2, sectionCount);
  put16(view, COFF_OFFSET + 16, OPTIONAL_SIZE);
  put16(view, COFF_OFFSET + 18, 0x0022);

  put16(view, OPTIONAL_OFFSET + 0, 0x20b);
  put32(view, OPTIONAL_OFFSET + 16, entryRva);
  put64(view, OPTIONAL_OFFSET + 24, 0x140000000n);
  put32(view, OPTIONAL_OFFSET + 32, sectionAlignment);
  put32(view, OPTIONAL_OFFSET + 36, fileAlignment);
  put32(view, OPTIONAL_OFFSET + 56, sizeOfImage);
  put32(view, OPTIONAL_OFFSET + 60, sizeOfHeaders);
  put16(view, OPTIONAL_OFFSET + 68, 3);
  put32(view, OPTIONAL_OFFSET + 108, 0);

  if (section) {
    const p = sectionTable;
    bytes.set(Buffer.from('.text\0\0\0', 'latin1'), p);
    put32(view, p + 8, section.virtualSize);
    put32(view, p + 12, section.virtualAddress);
    put32(view, p + 16, section.sizeRaw ?? 0);
    put32(view, p + 20, section.ptrRaw ?? 0);
    put32(view, p + 36, section.flags ?? 0x60000020);
  }

  return bytes;
}

function assertSizeOfImageRejected(options, pattern) {
  assert.throws(
    () => parsePE(makePe64(options)),
    (error) => error instanceof Error && pattern.test(error.message),
  );
}

// A normal aligned image whose section is contained remains valid.
{
  const image = parsePE(makePe64());
  assert.equal(image.sections.length, 1);
  assert.equal(image.sections[0].address, 0x140001000n);
}

// SizeOfImage is itself an aligned loader field, not an arbitrary upper bound.
assertSizeOfImageRejected(
  { sizeOfImage: 0x2800 },
  /SizeOfImage.*SectionAlignment|SectionAlignment.*SizeOfImage/,
);

// SizeOfImage must cover the declared header mapping. Use low alignment here
// so this case is independent of the alignment rejection above.
assertSizeOfImageRejected(
  {
    sectionAlignment: 0x200,
    fileAlignment: 0x200,
    sizeOfImage: 0x200,
    sizeOfHeaders: 0x400,
    section: null,
  },
  /SizeOfImage.*SizeOfHeaders|SizeOfHeaders.*SizeOfImage/,
);

// A zero-extent section cannot evade the start-RVA boundary by sitting exactly
// at the image's exclusive end. It is raw metadata, not a canonical mapping.
{
  const image = parsePE(makePe64({
    sizeOfImage: 0x2000,
    section: { virtualAddress: 0x2000, virtualSize: 0, sizeRaw: 0 },
  }));
  assert.equal(image.sections.length, 0);
  assert.ok(image.metadata.peMetadata.reasons.includes('pe:section-virtual-range-exceeds-size-of-image'));
}

// Existing #6097 containment remains part of the same image-extent authority:
// a section wholly beyond SizeOfImage is not canonical.
{
  const image = parsePE(makePe64({
    sizeOfImage: 0x2000,
    section: { virtualAddress: 0x3000, virtualSize: 0x100 },
  }));
  assert.equal(image.sections.length, 0);
  assert.ok(image.metadata.peMetadata.reasons.includes('pe:section-virtual-range-exceeds-size-of-image'));
}

// A section starting inside the image but extending past its exclusive end is
// likewise excluded (and therefore cannot back entrypoint/function evidence).
{
  const image = parsePE(makePe64({
    sizeOfImage: 0x2000,
    section: { virtualAddress: 0x1000, virtualSize: 0x1100 },
    entryRva: 0x1000,
  }));
  assert.equal(image.sections.length, 0);
  assert.equal(image.functions.some((fn) => fn.source === 'entrypoint'), false);
  assert.equal(image.metadata.entrypointValid, false);
}

console.log('issue #4285 PE SizeOfImage layout authority: PASS');
