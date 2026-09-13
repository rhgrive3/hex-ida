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

function malformedDynsym({ link = 3, linkedType = SHT_PROGBITS, entsize = 24n } = {}) {
  return withSectionHeaders(({ writeSection }) => {
    writeSection(1, { type: SHT_DYNSYM, offset: 0x340n, size: 48n, link, align: 8n, entsize });
    if (link >= 0 && link < 4) {
      writeSection(link, { type: linkedType, offset: 0x300n, size: 16n, align: 1n });
    }
  });
}

function validDynsym() {
  return withSectionHeaders(({ writeSection }) => {
    writeSection(1, { type: SHT_DYNSYM, offset: 0x340n, size: 48n, link: 2, align: 8n, entsize: 24n });
    writeSection(2, { type: SHT_STRTAB, offset: 0x300n, size: 16n, align: 1n });
  });
}

function partiallyDecodedMalformedDynsym() {
  return withSectionHeaders(({ bytes, view, writeSection }) => {
    bytes.set(bytes.subarray(0x340, 0x370), 0x440);
    view.setUint32(0x470, 0xffff, true); // invalid st_name after valid null + puts entries
    writeSection(1, { type: SHT_DYNSYM, offset: 0x440n, size: 72n, link: 2, align: 8n, entsize: 24n });
    writeSection(2, { type: SHT_STRTAB, offset: 0x300n, size: 16n, align: 1n });
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
}

assertFallback(malformedDynsym({ link: 99 }), 'out-of-range sh_link');
assertFallback(malformedDynsym({ link: 3, linkedType: SHT_PROGBITS }), 'wrong linked section type');
assertFallback(malformedDynsym({ link: 2, linkedType: SHT_STRTAB, entsize: 0n }), 'zero sh_entsize');

{
  const image = assertFallback(partiallyDecodedMalformedDynsym(), 'partially decoded malformed SHT_DYNSYM', {}, 'elf-dynsym');
  assert.equal(image.metadata.programDynamic?.symbols, 2, 'partial SHT_DYNSYM must still enable PT_DYNAMIC symbol decoding');
  assert.equal(image.imports.filter((entry) => entry.name === 'puts').length, 1, 'section + PT_DYNAMIC fallback must deduplicate puts');
  assert.equal(image.imports.find((entry) => entry.name === 'puts')?.sites?.length, 1, 'deduplicated fallback import must keep relocation provenance');
}

{
  const image = assertFallback(validDynsym(), 'budget-truncated SHT_DYNSYM', { metadataLimits: { records: 1 } });
  assert.ok(image.metadata.elfMetadata.reasons.some((reason) => reason.startsWith('budget:')), 'budget truncation must remain explicit');
}

console.log('issue-3961-elf-malformed-dynsym-fallback: PASS');
