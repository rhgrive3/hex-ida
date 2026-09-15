import assert from 'node:assert/strict';
import { test } from 'node:test';
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

  bytes.set(new TextEncoder().encode('foo\0'), 0x310);
  view.setBigUint64(0x200 + 2 * 16 + 8, 20n, true);
  view.setBigUint64(0x200 + 5 * 16 + 8, 0x4003c0n, true);
  view.setUint32(0x3c0, 1, true);
  view.setUint32(0x3c4, 3, true);
  view.setUint32(0x370, 16, true);
  view.setUint8(0x374, 0x12);
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
      writeSection(link, { type: linkedType, offset: 0x300n, size: 20n, align: 1n });
    }
  });
}

function validDynsym() {
  return withSectionHeaders(({ writeSection }) => {
    writeSection(1, { type: SHT_DYNSYM, offset: 0x340n, size: 72n, link: 2, align: 8n, entsize: 24n });
    writeSection(2, { type: SHT_STRTAB, offset: 0x300n, size: 20n, align: 1n });
  });
}

function partiallyDecodedMalformedDynsym(configure = () => {}) {
  return withSectionHeaders(({ bytes, view, writeSection }) => {
    bytes.set(bytes.subarray(0x340, 0x388), 0x440);
    view.setUint32(0x488, 0xffff, true);
    writeSection(1, { type: SHT_DYNSYM, offset: 0x440n, size: 96n, link: 2, align: 8n, entsize: 24n });
    writeSection(2, { type: SHT_STRTAB, offset: 0x300n, size: 20n, align: 1n });
    configure({ bytes, view, writeSection });
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

test('complete SHT_DYNSYM remains authoritative', () => {
  const image = parseELF(validDynsym());
  const puts = image.imports.filter((entry) => entry.name === 'puts');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].source, 'elf-dynsym');
  assert.equal(image.symbols.filter((entry) => entry.name === 'foo').length, 1);
  assert.equal(image.exports.filter((entry) => entry.name === 'foo').length, 1);
  assert.equal(image.metadata.elfMetadata.complete, true);
});

for (const [label, options] of [
  ['out-of-range sh_link', { link: 99 }],
  ['wrong linked section type', { link: 3, linkedType: SHT_PROGBITS }],
  ['zero sh_entsize', { link: 2, linkedType: SHT_STRTAB, entsize: 0n }],
]) {
  test(label, () => assertFallback(malformedDynsym(options), label));
}

for (const size of [0n, 23n, 25n, 73n]) {
  test(`non-whole/non-empty DYNSYM size ${size} enables fallback`, () => {
    const image = assertFallback(malformedDynsym({ link: 2, linkedType: SHT_STRTAB, size }), `size ${size}`);
    assert.ok(image.metadata.elfMetadata.reasons.includes('symbols:1:table-size'));
    assert.equal(image.metadata.programDynamic.symbols, 3);
    assert.equal(image.symbols.filter((entry) => entry.name === 'puts').length, 1);
    assert.equal(image.exports.filter((entry) => entry.name === 'foo').length, 1);
  });
}

test('partial DYNSYM fallback reconciles symbols, imports and exports', () => {
  const image = assertFallback(partiallyDecodedMalformedDynsym(), 'partially decoded malformed SHT_DYNSYM');
  assert.equal(image.metadata.programDynamic.symbols, 3);
  assert.equal(image.imports.filter((entry) => entry.name === 'puts').length, 1);
  assert.equal(image.imports.find((entry) => entry.name === 'puts').sites.length, 1, 'keep relocation provenance');
  assert.equal(image.symbols.filter((entry) => entry.name === 'puts').length, 1);
  assert.equal(image.symbols.filter((entry) => entry.name === 'foo').length, 1);
  assert.equal(image.symbols.find((entry) => entry.name === 'foo').source, 'PT_DYNAMIC');
  assert.equal(image.exports.filter((entry) => entry.name === 'foo').length, 1);
  assert.equal(image.exports.find((entry) => entry.name === 'foo').source, 'PT_DYNAMIC');
});

test('budget exhaustion keeps section metadata partial', () => {
  const image = assertFallback(validDynsym(), 'budget-truncated SHT_DYNSYM', { metadataLimits: { records: 1 } });
  assert.ok(image.metadata.elfMetadata.reasons.some((reason) => reason.startsWith('budget:')));
});

test('fallback preserves nonmatching partial section records', () => {
  const bytes = partiallyDecodedMalformedDynsym(({ view }) => {
    view.setUint32(0x470, 17, true);
  });
  const image = assertFallback(bytes, 'nonmatching partial record');
  assert.equal(image.symbols.find((entry) => entry.name === 'oo').source, 'dynsym');
  assert.equal(image.exports.find((entry) => entry.name === 'oo').source, 'dynsym');
  assert.equal(image.symbols.find((entry) => entry.name === 'foo').source, 'PT_DYNAMIC');
  assert.equal(image.exports.find((entry) => entry.name === 'foo').source, 'PT_DYNAMIC');
});

test('fallback preserves independent SYMTAB records', () => {
  const bytes = partiallyDecodedMalformedDynsym(({ writeSection }) => {
    writeSection(3, { type: 2, offset: 0x340n, size: 72n, link: 2, align: 8n, entsize: 24n });
  });
  const image = parseELF(bytes);
  for (const name of ['puts', 'foo']) {
    assert.deepEqual(image.symbols.filter((entry) => entry.name === name).map((entry) => entry.source).sort(), ['PT_DYNAMIC', 'symtab']);
  }
  assert.deepEqual(image.exports.filter((entry) => entry.name === 'foo').map((entry) => entry.source).sort(), ['PT_DYNAMIC', 'symtab']);
});

test('fallback keeps section relocation sites on the surviving import', () => {
  const bytes = partiallyDecodedMalformedDynsym(({ view, writeSection }) => {
    view.setBigUint64(0x3e0, 0x4003a0n, true);
    view.setBigUint64(0x3e8, (1n << 32n) | 7n, true);
    view.setBigInt64(0x3f0, 0n, true);
    writeSection(3, { type: 4, offset: 0x3e0n, size: 24n, link: 1, align: 8n, entsize: 24n });
  });
  const image = assertFallback(bytes, 'section relocation');
  const puts = image.imports.find((entry) => entry.name === 'puts');
  assert.equal(puts.sites.length, 1);
  assert.equal(puts.sites[0].address, 0x4003a0n);
  assert.equal(image.relocations[0].source, 'RELA');
});
