import assert from 'node:assert/strict';
import { parseELF } from '../../../js/binary/elf.js';
import { makeSectionlessElf64Fixture } from '../../universal-binary-sectionless.mjs';

const SHT_PROGBITS = 1;
const SHT_STRTAB = 3;
const SHT_DYNSYM = 11;
const SHOFF = 0x500;
const SHENT = 64;

function withSectionHeaders(configure) {
  const base = makeSectionlessElf64Fixture();
  const bytes = new Uint8Array(SHOFF + 4 * SHENT);
  bytes.set(base);
  const view = new DataView(bytes.buffer);

  // Enrich the sectionless fixture with one defined dynamic export so the
  // partial-section + PT_DYNAMIC fallback path proves symbol/export dedupe too.
  bytes.set(new TextEncoder().encode('foo\0'), 0x310);
  view.setBigUint64(0x200 + 2 * 16 + 8, 20n, true); // DT_STRSZ
  view.setBigUint64(0x200 + 5 * 16 + 8, 0x4003c0n, true); // DT_HASH
  view.setUint32(0x3c0, 1, true);
  view.setUint32(0x3c4, 3, true);
  view.setUint32(0x370, 16, true);
  view.setUint8(0x374, 0x12); // STB_GLOBAL | STT_FUNC
  view.setUint8(0x375, 0);
  view.setUint16(0x376, 1, true);
  view.setBigUint64(0x378, 0x400180n, true);
  view.setBigUint64(0x380, 4n, true);
  view.setBigUint64(40, BigInt(SHOFF), true);
  view.setUint16(58, SHENT, true);
  view.setUint16(60, 4, true);
  view.setUint16(62, 0, true);

  const writeSection = (index, { type = 0, offset = 0n, size = 0n, link = 0, align = 1n, entsize = 0n } = {}) => {
    const p = SHOFF + index * SHENT;
    view.setUint32(p + 4, type, true);
    view.setBigUint64(p + 24, BigInt(offset), true);
    view.setBigUint64(p + 32, BigInt(size), true);
    view.setUint32(p + 40, link, true);
    view.setBigUint64(p + 48, BigInt(align), true);
    view.setBigUint64(p + 56, BigInt(entsize), true);
  };

  configure({ bytes, view, writeSection });
  return bytes;
}

function malformedDynsym({ link = 3, linkedType = SHT_PROGBITS, entsize = 24n, size = 72n } = {}) {
  return withSectionHeaders(({ writeSection }) => {
    writeSection(1, { type: SHT_DYNSYM, offset: 0x340n, size, link, align: 8n, entsize });
    if (link >= 0 && link < 4) {
      writeSection(link, { type: linkedType, offset: 0x300n, size: 16n, align: 1n });
    }
  });
}

function validDynsym() {
  return withSectionHeaders(({ writeSection }) => {
    writeSection(1, { type: SHT_DYNSYM, offset: 0x340n, size: 72n, link: 2, align: 8n, entsize: 24n });
    writeSection(2, { type: SHT_STRTAB, offset: 0x300n, size: 20n, align: 1n });
  });
}

function partiallyDecodedMalformedDynsym() {
  return withSectionHeaders(({ bytes, view, writeSection }) => {
    bytes.set(bytes.subarray(0x340, 0x388), 0x440);
    view.setUint32(0x488, 0xffff, true); // invalid st_name after valid null + puts + foo entries
    writeSection(1, { type: SHT_DYNSYM, offset: 0x440n, size: 96n, link: 2, align: 8n, entsize: 24n });
    writeSection(2, { type: SHT_STRTAB, offset: 0x300n, size: 20n, align: 1n });
  });
}

function assertFallback(bytes, label, options = {}, expectedSource = 'PT_DYNAMIC') {
  const image = parseELF(bytes, options);
  const imp = image.imports.find((entry) => entry.name === 'puts');
  assert.ok(imp, `${label}: valid PT_DYNAMIC fallback must recover puts`);
  assert.equal(imp.source, expectedSource, `${label}: import provenance must match the surviving deduplicated record`);
  assert.equal(image.metadata.elfMetadata?.complete, false, `${label}: malformed/truncated section metadata must be partial`);
  return image;
}

{
  const image = parseELF(validDynsym());
  const puts = image.imports.filter((entry) => entry.name === 'puts');
  assert.equal(puts.length, 1, 'valid SHT_DYNSYM must remain authoritative and deduplicated');
  assert.equal(puts[0].source, 'elf-dynsym');
  assert.equal(image.symbols.filter((entry) => entry.name === 'foo').length, 1, 'valid section path must publish foo once');
  assert.equal(image.exports.filter((entry) => entry.name === 'foo').length, 1, 'valid section path must publish foo export once');
}

assertFallback(malformedDynsym({ link: 99 }), 'out-of-range sh_link');
assertFallback(malformedDynsym({ link: 3, linkedType: SHT_PROGBITS }), 'wrong linked section type');
assertFallback(malformedDynsym({ link: 2, linkedType: SHT_STRTAB, entsize: 0n }), 'zero sh_entsize');
assertFallback(malformedDynsym({ link: 2, linkedType: SHT_STRTAB, size: 73n }), 'non-integral symbol-table size');

{
  const image = assertFallback(partiallyDecodedMalformedDynsym(), 'partially decoded malformed SHT_DYNSYM');
  assert.equal(image.metadata.programDynamic?.symbols, 3, 'partial SHT_DYNSYM must still enable PT_DYNAMIC symbol decoding');
  assert.equal(image.imports.filter((entry) => entry.name === 'puts').length, 1, 'section + PT_DYNAMIC fallback must deduplicate puts import');
  assert.equal(image.imports.find((entry) => entry.name === 'puts')?.sites?.length, 1, 'deduplicated fallback import must keep relocation provenance');
  assert.equal(image.symbols.filter((entry) => entry.name === 'puts').length, 1, 'section + PT_DYNAMIC fallback must deduplicate puts symbol');
  assert.equal(image.symbols.filter((entry) => entry.name === 'foo').length, 1, 'section + PT_DYNAMIC fallback must deduplicate foo symbol');
  assert.equal(image.symbols.find((entry) => entry.name === 'foo')?.source, 'PT_DYNAMIC', 'fallback symbol should retain richer PT_DYNAMIC provenance');
  assert.equal(image.exports.filter((entry) => entry.name === 'foo').length, 1, 'section + PT_DYNAMIC fallback must deduplicate foo export');
  assert.equal(image.exports.find((entry) => entry.name === 'foo')?.source, 'PT_DYNAMIC', 'fallback export should retain richer PT_DYNAMIC provenance');
}

{
  const image = assertFallback(validDynsym(), 'budget-truncated SHT_DYNSYM', { metadataLimits: { records: 1 } });
  assert.ok(image.metadata.elfMetadata.reasons.some((reason) => reason.startsWith('budget:')), 'budget truncation must remain explicit');
}

console.log('issue-3961-elf-malformed-dynsym-fallback: PASS');
