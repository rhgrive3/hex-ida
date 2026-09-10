import assert from 'node:assert/strict';
import { parseELF } from '../../../js/binary/elf.js';

const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_DYNSYM = 11;
const SHT_RELA = 4;
const SHT_REL = 9;

function buildRelocatable({ bits = 64, link = 2, symIndex = 1, target = 3, symbolTableType = SHT_SYMTAB } = {}) {
  const is64 = bits === 64;
  const sectionCount = 5;
  const shoff = 0x200;
  const shentsize = is64 ? 64 : 40;
  const strOff = 0x60;
  const textOff = 0x80;
  const symOff = 0xa0;
  const symEnt = is64 ? 24 : 16;
  const relOff = 0xe0;
  const relEnt = is64 ? 24 : 8;
  const bytes = new Uint8Array(shoff + sectionCount * shentsize);
  const view = new DataView(bytes.buffer);

  bytes.set([0x7f, 0x45, 0x4c, 0x46, is64 ? 2 : 1, 1, 1, 0], 0);
  view.setUint16(16, 1, true); // ET_REL
  view.setUint16(18, is64 ? 62 : 3, true);
  view.setUint32(20, 1, true);
  if (is64) {
    view.setBigUint64(40, BigInt(shoff), true);
    view.setUint16(52, 64, true);
    view.setUint16(54, 56, true);
    view.setUint16(58, shentsize, true);
    view.setUint16(60, sectionCount, true);
  } else {
    view.setUint32(32, shoff, true);
    view.setUint16(40, 52, true);
    view.setUint16(42, 32, true);
    view.setUint16(46, shentsize, true);
    view.setUint16(48, sectionCount, true);
  }

  const strtab = new TextEncoder().encode('\0named\0');
  bytes.set(strtab, strOff);
  bytes.fill(0x90, textOff, textOff + 16);
  if (is64) {
    view.setUint32(symOff + symEnt, 1, true);
    view.setUint8(symOff + symEnt + 4, 0x12); // global function
    view.setUint16(symOff + symEnt + 6, 3, true);
    view.setBigUint64(symOff + symEnt + 8, 0n, true);
    view.setBigUint64(symOff + symEnt + 16, 4n, true);
    view.setBigUint64(relOff, 0n, true);
    view.setBigUint64(relOff + 8, (BigInt(symIndex) << 32n) | 1n, true);
    view.setBigInt64(relOff + 16, 0n, true);
  } else {
    view.setUint32(symOff + symEnt, 1, true);
    view.setUint32(symOff + symEnt + 4, 0, true);
    view.setUint32(symOff + symEnt + 8, 4, true);
    view.setUint8(symOff + symEnt + 12, 0x12);
    view.setUint16(symOff + symEnt + 14, 3, true);
    view.setUint32(relOff, 0, true);
    view.setUint32(relOff + 4, (symIndex << 8) | 1, true);
  }

  const writeSection = (index, { type = 0, flags = 0n, offset = 0n, size = 0n, link: sectionLink = 0, info = 0, align = 0n, entsize = 0n }) => {
    const p = shoff + index * shentsize;
    if (is64) {
      view.setUint32(p + 4, type, true);
      view.setBigUint64(p + 8, flags, true);
      view.setBigUint64(p + 24, offset, true);
      view.setBigUint64(p + 32, size, true);
      view.setUint32(p + 40, sectionLink, true);
      view.setUint32(p + 44, info, true);
      view.setBigUint64(p + 48, align, true);
      view.setBigUint64(p + 56, entsize, true);
    } else {
      view.setUint32(p + 4, type, true);
      view.setUint32(p + 8, Number(flags), true);
      view.setUint32(p + 16, Number(offset), true);
      view.setUint32(p + 20, Number(size), true);
      view.setUint32(p + 24, sectionLink, true);
      view.setUint32(p + 28, info, true);
      view.setUint32(p + 32, Number(align), true);
      view.setUint32(p + 36, Number(entsize), true);
    }
  };

  writeSection(0, {});
  writeSection(1, { type:SHT_STRTAB, offset:BigInt(strOff), size:BigInt(strtab.length), align:1n });
  writeSection(2, { type:symbolTableType, offset:BigInt(symOff), size:BigInt(symEnt * 2), link:1, info:1, align:BigInt(is64 ? 8 : 4), entsize:BigInt(symEnt) });
  writeSection(3, { type:SHT_PROGBITS, flags:0x6n, offset:BigInt(textOff), size:16n, align:BigInt(is64 ? 16 : 4) });
  writeSection(4, { type:is64 ? SHT_RELA : SHT_REL, offset:BigInt(relOff), size:BigInt(relEnt), link, info:target, align:BigInt(is64 ? 8 : 4), entsize:BigInt(relEnt) });
  return bytes;
}

function assertInvalidLink(options) {
  const image = parseELF(buildRelocatable(options));
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(image.metadata.elfMetadata.reasons.includes('relocations:4:symbol-table-link'));
  assert.equal(image.relocations.length, 0, 'invalid associated symbol-table link must not publish canonical relocations');
}

{
  const image = parseELF(buildRelocatable());
  assert.equal(image.metadata.elfMetadata.complete, true);
  assert.equal(image.relocations.length, 1);
  assert.equal(image.relocations[0].symbol, 'named');
}

{
  const image = parseELF(buildRelocatable({ symbolTableType:SHT_DYNSYM }));
  assert.equal(image.metadata.elfMetadata.complete, true);
  assert.equal(image.relocations.length, 1);
  assert.equal(image.relocations[0].symbol, 'named');
}

assertInvalidLink({ bits:64, link:99, symIndex:1 });
assertInvalidLink({ bits:64, link:0, symIndex:1 });
assertInvalidLink({ bits:64, link:1, symIndex:1 });
assertInvalidLink({ bits:64, link:3, symIndex:1 });
assertInvalidLink({ bits:64, link:3, symIndex:0 });
assertInvalidLink({ bits:64, link:4, symIndex:1 });
assertInvalidLink({ bits:32, link:99, symIndex:1 });
assertInvalidLink({ bits:32, link:3, symIndex:0 });

{
  const image = parseELF(buildRelocatable({ bits:32 }));
  assert.equal(image.metadata.elfMetadata.complete, true);
  assert.equal(image.relocations.length, 1);
  assert.equal(image.relocations[0].symbol, 'named');
}

{
  const image = parseELF(buildRelocatable({ symIndex:2 }));
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(image.metadata.elfMetadata.reasons.includes('relocations:4:symbol-index-range'));
  assert.equal(image.relocations.length, 0);
}

{
  const image = parseELF(buildRelocatable({ target:99 }));
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(image.metadata.elfMetadata.reasons.includes('relocations:4:target-section'));
  assert.equal(image.relocations.length, 0);
}

console.log('issue-3977 ELF relocation sh_link regression: PASS');
