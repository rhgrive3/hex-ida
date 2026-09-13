/**
 * #4281 regression: executable-image section VirtualAddress values are loader
 * mapping authority only when aligned to OptionalHeader.SectionAlignment.
 */
import assert from 'node:assert/strict';
import { parsePE } from '../../../js/binary/pe.js';

const PE_OFFSET = 0x40;
const COFF_OFFSET = PE_OFFSET + 4;
const OPTIONAL_OFFSET = COFF_OFFSET + 20;
const OPTIONAL_SIZE = 112;
const SECTION_HEADER_SIZE = 40;

function put16(view, offset, value) { view.setUint16(offset, value, true); }
function put32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }
function put64(view, offset, value) { view.setBigUint64(offset, BigInt(value), true); }

function makePe64({
  sectionAlignment = 0x1000,
  fileAlignment = 0x200,
  sizeOfImage = 0x4000,
  entryRva = 0,
  sections = [{ name: '.text', virtualAddress: 0x1000, virtualSize: 0x200, ptrRaw: 0x200 }],
} = {}) {
  const sectionTable = OPTIONAL_OFFSET + OPTIONAL_SIZE;
  const maxRawEnd = sections.reduce((end, section) => Math.max(end, (section.ptrRaw ?? 0) + (section.sizeRaw ?? 0x200)), 0);
  const bytes = new Uint8Array(Math.max(0x600, sectionTable + sections.length * SECTION_HEADER_SIZE, maxRawEnd));
  const view = new DataView(bytes.buffer);

  put16(view, 0x00, 0x5a4d);
  put32(view, 0x3c, PE_OFFSET);
  put32(view, PE_OFFSET, 0x00004550);
  put16(view, COFF_OFFSET + 0, 0x8664);
  put16(view, COFF_OFFSET + 2, sections.length);
  put16(view, COFF_OFFSET + 16, OPTIONAL_SIZE);
  put16(view, COFF_OFFSET + 18, 0x0022);

  put16(view, OPTIONAL_OFFSET + 0, 0x20b);
  put32(view, OPTIONAL_OFFSET + 16, entryRva);
  put64(view, OPTIONAL_OFFSET + 24, 0x140000000n);
  put32(view, OPTIONAL_OFFSET + 32, sectionAlignment);
  put32(view, OPTIONAL_OFFSET + 36, fileAlignment);
  put32(view, OPTIONAL_OFFSET + 56, sizeOfImage);
  put32(view, OPTIONAL_OFFSET + 60, 0x200);
  put16(view, OPTIONAL_OFFSET + 68, 3);
  put32(view, OPTIONAL_OFFSET + 108, 0);

  sections.forEach((section, index) => {
    const p = sectionTable + index * SECTION_HEADER_SIZE;
    bytes.set(Buffer.from((section.name ?? `.s${index}`).padEnd(8, '\0').slice(0, 8), 'latin1'), p);
    put32(view, p + 8, section.virtualSize ?? 0x200);
    put32(view, p + 12, section.virtualAddress);
    put32(view, p + 16, section.sizeRaw ?? 0x200);
    put32(view, p + 20, section.ptrRaw ?? (0x200 + index * 0x200));
    put32(view, p + 36, section.flags ?? 0x60000020);
  });

  return bytes;
}

// Normal page-aligned image section remains canonical.
{
  const image = parsePE(makePe64());
  assert.equal(image.sections.length, 1);
  assert.equal(image.sections[0].address, 0x140001000n);
}

// RVA 0x1800 is not aligned to SectionAlignment 0x1000. It must not become
// canonical executable mapping or entrypoint evidence.
{
  const image = parsePE(makePe64({
    entryRva: 0x1800,
    sections: [{ name: '.bad', virtualAddress: 0x1800, virtualSize: 0x200, ptrRaw: 0x200 }],
  }));
  assert.equal(image.sections.length, 0, 'misaligned section must not become canonical');
  assert.equal(image.functions.some((fn) => fn.source === 'entrypoint'), false, 'misaligned mapping must not seed entrypoint');
  assert.equal(image.metadata.entrypointValid, false);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('pe:section-virtual-address-misaligned'));
}

// Valid low-alignment images keep their existing SectionAlignment contract.
{
  const image = parsePE(makePe64({
    sectionAlignment: 0x200,
    fileAlignment: 0x200,
    sizeOfImage: 0x800,
    sections: [{ name: '.low', virtualAddress: 0x400, virtualSize: 0x100, ptrRaw: 0x400 }],
  }));
  assert.equal(image.sections.length, 1);
  assert.equal(image.sections[0].address, 0x140000400n);
}

// Validation is per section: an aligned neighbour remains usable while the
// misaligned section is excluded rather than laundering its mapping.
{
  const image = parsePE(makePe64({
    sections: [
      { name: '.text', virtualAddress: 0x1000, virtualSize: 0x200, ptrRaw: 0x200 },
      { name: '.bad', virtualAddress: 0x2800, virtualSize: 0x200, ptrRaw: 0x400 },
    ],
  }));
  assert.deepEqual(image.sections.map((section) => section.name), ['.text']);
  assert.ok(image.metadata.peMetadata.reasons.includes('pe:section-virtual-address-misaligned'));
}

console.log('issue #4281 PE section VirtualAddress alignment: PASS');
