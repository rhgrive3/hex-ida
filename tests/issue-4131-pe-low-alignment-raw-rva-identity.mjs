// Issue #4131 regression: in a PE low-alignment image (SectionAlignment below
// the architecture page size), section data physically sits where it is
// loaded, so every file-backed section must satisfy
// `PointerToRawData == VirtualAddress`. The parser honored the declared raw
// offset (#5539) but never checked that identity, so a mismatched section was
// promoted to a canonical Windows image mapping and its RVA->file relation
// served entrypoint, import and function evidence like any conforming section.
// The mismatch must be fail-closed for exact evidence while the declared-raw
// read mapping that #5539 fixed keeps working.
import assert from 'node:assert/strict';
import { parsePE } from '../js/binary/pe.js';

const PE_OFFSET = 0x40;
const COFF_OFFSET = PE_OFFSET + 4;
const OPTIONAL_OFFSET = COFF_OFFSET + 20;
const OPTIONAL_SIZE = 240;
const SECTION_TABLE = OPTIONAL_OFFSET + OPTIONAL_SIZE;
const IMAGE_BASE = 0x140000000n;

// Section-relative layout: entrypoint code, import descriptor table (2
// descriptors), library name, ILT, IAT and one hint/name entry.
const CODE_AT = 0x00, DIR_AT = 0x40, NAME_AT = 0x80, ILT_AT = 0xa0, IAT_AT = 0xc0, IBN_AT = 0xe0;

function writeSectionPayload(view, fileBase, rvaBase) {
  const u8 = (o, x) => view.setUint8(fileBase + o, x);
  const u16 = (o, x) => view.setUint16(fileBase + o, x, true);
  const u32 = (o, x) => view.setUint32(fileBase + o, x >>> 0, true);
  const u64 = (o, x) => view.setBigUint64(fileBase + o, BigInt(x), true);
  const text = (o, value) => { [...value].forEach((ch, i) => u8(o + i, ch.charCodeAt(0))); u8(o + value.length, 0); };
  [0xb8, 0x3c, 0, 0, 0, 0xbf, 0x05, 0, 0, 0, 0x0f, 0x05].forEach((b, i) => u8(CODE_AT + i, b));
  u32(DIR_AT + 0, rvaBase + ILT_AT); u32(DIR_AT + 4, 0); u32(DIR_AT + 8, 0);
  u32(DIR_AT + 12, rvaBase + NAME_AT); u32(DIR_AT + 16, rvaBase + IAT_AT);
  text(NAME_AT, 'kernel32.dll');
  u64(ILT_AT, rvaBase + IBN_AT); u64(ILT_AT + 8, 0);
  u64(IAT_AT, rvaBase + IBN_AT); u64(IAT_AT + 8, 0);
  u16(IBN_AT, 0); text(IBN_AT + 2, 'puts');
}

function makePE({
  sectionAlignment = 0x200, fileAlignment = 0x200, sizeOfImage = 0x800,
  virtualAddress = 0x400, pointerToRawData = 0x400, size = 0x200,
} = {}) {
  const bytes = new Uint8Array(0x1000);
  const view = new DataView(bytes.buffer);
  const put16 = (o, x) => view.setUint16(o, x, true);
  const put32 = (o, x) => view.setUint32(o, x >>> 0, true);
  put16(0x00, 0x5a4d);
  put32(0x3c, PE_OFFSET);
  put32(PE_OFFSET, 0x00004550);
  put16(COFF_OFFSET + 0, 0x8664);
  put16(COFF_OFFSET + 2, 1);
  put16(COFF_OFFSET + 16, OPTIONAL_SIZE);
  put16(COFF_OFFSET + 18, 0x0022);
  put16(OPTIONAL_OFFSET + 0, 0x20b);
  put32(OPTIONAL_OFFSET + 16, virtualAddress);
  view.setBigUint64(OPTIONAL_OFFSET + 24, IMAGE_BASE, true);
  put32(OPTIONAL_OFFSET + 32, sectionAlignment);
  put32(OPTIONAL_OFFSET + 36, fileAlignment);
  put32(OPTIONAL_OFFSET + 56, sizeOfImage);
  put32(OPTIONAL_OFFSET + 60, 0x200);
  put16(OPTIONAL_OFFSET + 68, 3);
  put32(OPTIONAL_OFFSET + 108, 16);
  put32(OPTIONAL_OFFSET + 112 + 8, virtualAddress + DIR_AT);
  put32(OPTIONAL_OFFSET + 112 + 12, 0x28);
  bytes.set(Buffer.from('.text\0\0\0', 'latin1'), SECTION_TABLE);
  put32(SECTION_TABLE + 8, size);
  put32(SECTION_TABLE + 12, virtualAddress);
  put32(SECTION_TABLE + 16, size);
  put32(SECTION_TABLE + 20, pointerToRawData);
  put32(SECTION_TABLE + 36, 0x60000020);
  if (pointerToRawData !== 0) writeSectionPayload(view, pointerToRawData, virtualAddress);
  return bytes;
}

const LOW_ALIGNMENT_REASON = (image) => (image.metadata.peMetadata?.reasons || []).some((reason) => reason.includes('low-alignment'));
const LOW_ALIGNMENT_WARNING = (image) => image.warnings.some((warning) => warning.includes('low-alignment') && warning.includes('PointerToRawData'));

// The declared raw offset must stay the read mapping in every case: #5539
// established that low-alignment images are consumed at their declared
// PointerToRawData, so this issue is about evidence authority, not rounding.
function parseAndCheckReadMapping(options) {
  const image = parsePE(makePE(options));
  const ptrRaw = options.pointerToRawData ?? 0x400;
  assert.equal(image.sections[0].fileOffset, BigInt(ptrRaw), 'the declared raw offset stays the file mapping');
  assert.equal(image.addressToOffset(IMAGE_BASE + BigInt(options.virtualAddress ?? 0x400)), BigInt(ptrRaw), 'the RVA still resolves for reads');
  return image;
}

// 1. SectionAlignment == FileAlignment == 0x200 with PointerToRawData == RVA is
//    a conforming low-alignment image.
{
  const image = parseAndCheckReadMapping({});
  assert.equal(image.sections[0].source, 'PE-section', 'a conforming section keeps canonical mapping authority');
  assert.equal(image.metadata.entrypointValid, true);
  assert.ok(image.functions.some((f) => f.source === 'entrypoint'), 'the entrypoint seed is promoted');
  assert.equal(image.imports.length, 1, 'imports resolve through the conforming mapping');
  assert.equal(image.imports[0].name, 'puts');
  assert.equal(LOW_ALIGNMENT_WARNING(image), false);
  assert.equal(LOW_ALIGNMENT_REASON(image), false);
}

// 2. PointerToRawData above the section RVA is not a valid low-alignment mapping.
{
  const image = parseAndCheckReadMapping({ pointerToRawData: 0x600 });
  assert.notEqual(image.sections[0].source, 'PE-section', 'the mismatched section loses canonical mapping authority');
  assert.equal(image.metadata.entrypointValid, false, 'no entrypoint authority from the mismatched mapping');
  assert.ok(image.functions.every((f) => f.source !== 'entrypoint'), 'no entrypoint function seed');
  assert.equal(image.imports.length, 0, 'no import evidence from the mismatched mapping');
  assert.equal(image.libraries.length, 0, 'no library evidence from the mismatched mapping');
  assert.equal(LOW_ALIGNMENT_WARNING(image), true, 'the mismatch is reported, not silent');
  assert.equal(LOW_ALIGNMENT_REASON(image), true, 'the image metadata is marked partial');
}

// 3. PointerToRawData below the section RVA is the same contradiction.
{
  const image = parseAndCheckReadMapping({ virtualAddress: 0x600, pointerToRawData: 0x400 });
  assert.notEqual(image.sections[0].source, 'PE-section');
  assert.equal(image.metadata.entrypointValid, false);
  assert.equal(image.imports.length, 0);
  assert.equal(LOW_ALIGNMENT_WARNING(image), true);
}

// 4. A normal page-aligned image keeps distinct RVA and raw offsets untouched.
{
  const image = parsePE(makePE({
    sectionAlignment: 0x1000, fileAlignment: 0x200, sizeOfImage: 0x2000,
    virtualAddress: 0x1000, pointerToRawData: 0x200,
  }));
  assert.equal(image.sections[0].source, 'PE-section', 'a page-aligned image is not a low-alignment image');
  assert.equal(image.metadata.entrypointValid, true);
  assert.equal(image.imports.length, 1);
  assert.equal(LOW_ALIGNMENT_WARNING(image), false);
}

// 5. A zero PointerToRawData keeps its raw-uninitialized semantics (#5539 #5).
{
  const image = parsePE(makePE({ pointerToRawData: 0 }));
  const mapping = image.metadata.peSectionRawMappings[0];
  assert.equal(mapping.fileBacked, false, 'a zero raw pointer is still not file-backed');
  assert.equal(mapping.effectiveFileOffset, 0);
  assert.equal(LOW_ALIGNMENT_WARNING(image), false, 'the identity rule only constrains file-backed sections');
  assert.equal(LOW_ALIGNMENT_REASON(image), false);
}

// 6. The mismatch is judged on the declared offset, never after a round-down.
{
  const image = parseAndCheckReadMapping({ sectionAlignment: 0x10, fileAlignment: 0x10, pointerToRawData: 0x410 });
  assert.equal(image.metadata.peSectionRawMappings[0].effectiveFileOffset, 0x410, 'the declared offset is what gets mapped');
  assert.notEqual(image.sections[0].source, 'PE-section', 'a 0x10-granular offset slip is still not RVA identity');
  assert.equal(image.imports.length, 0);
}

console.log('issue #4131 PE low-alignment PointerToRawData/RVA identity regressions: PASS');
