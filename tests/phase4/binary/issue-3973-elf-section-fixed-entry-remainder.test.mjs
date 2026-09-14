import assert from 'node:assert/strict';
import test from 'node:test';

import { parseELF } from '../../../js/binary/elf.js';

const ET_REL = 1;
const ET_DYN = 3;
const SHT_NULL = 0;
const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;
const SHT_DYNAMIC = 6;
const SHT_REL = 9;

function setHeader(view, bits, { type, shoff, shnum }) {
  const bytes = new Uint8Array(view.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, bits === 64 ? 2 : 1, 1, 1, 0], 0);
  view.setUint16(16, type, true);
  view.setUint16(18, bits === 64 ? 62 : 3, true);
  view.setUint32(20, 1, true);
  if (bits === 64) {
    view.setBigUint64(40, BigInt(shoff), true);
    view.setUint16(52, 64, true); view.setUint16(54, 56, true); view.setUint16(56, 0, true);
    view.setUint16(58, 64, true); view.setUint16(60, shnum, true); view.setUint16(62, 0, true);
  } else {
    view.setUint32(32, shoff, true);
    view.setUint16(40, 52, true); view.setUint16(42, 32, true); view.setUint16(44, 0, true);
    view.setUint16(46, 40, true); view.setUint16(48, shnum, true); view.setUint16(50, 0, true);
  }
}

function setSection(view, bits, shoff, index, { type = SHT_NULL, flags = 0n, offset = 0, size = 0, link = 0, info = 0, align = 1, entsize = 0 } = {}) {
  const width = bits === 64 ? 64 : 40;
  const p = shoff + index * width;
  if (bits === 64) {
    view.setUint32(p + 4, type, true); view.setBigUint64(p + 8, BigInt(flags), true);
    view.setBigUint64(p + 24, BigInt(offset), true); view.setBigUint64(p + 32, BigInt(size), true);
    view.setUint32(p + 40, link, true); view.setUint32(p + 44, info, true);
    view.setBigUint64(p + 48, BigInt(align), true); view.setBigUint64(p + 56, BigInt(entsize), true);
  } else {
    view.setUint32(p + 4, type, true); view.setUint32(p + 8, Number(flags), true);
    view.setUint32(p + 16, offset, true); view.setUint32(p + 20, size, true);
    view.setUint32(p + 24, link, true); view.setUint32(p + 28, info, true);
    view.setUint32(p + 32, align, true); view.setUint32(p + 36, entsize, true);
  }
}

function writeSymbolTable(view, bits, offset) {
  const ent = bits === 64 ? 24 : 16;
  const p = offset + ent;
  if (bits === 64) { view.setUint32(p, 1, true); view.setUint8(p + 4, 0x11); view.setUint16(p + 6, 0, true); }
  else { view.setUint32(p, 1, true); view.setUint8(p + 12, 0x11); view.setUint16(p + 14, 0, true); }
  return ent;
}

function buildSymbolTableELF(bits, remainder) {
  const strOffset = 0x80, symOffset = 0x100, shoff = 0x300, shnum = 3;
  const shsize = bits === 64 ? 64 : 40;
  const bytes = new Uint8Array(shoff + shnum * shsize); const view = new DataView(bytes.buffer);
  setHeader(view, bits, { type: ET_REL, shoff, shnum }); bytes.set(new TextEncoder().encode('\0ext\0'), strOffset);
  const ent = writeSymbolTable(view, bits, symOffset); if (remainder) bytes[symOffset + 2 * ent] = 0xa5;
  setSection(view, bits, shoff, 0);
  setSection(view, bits, shoff, 1, { type: SHT_STRTAB, offset: strOffset, size: 5 });
  setSection(view, bits, shoff, 2, { type: SHT_SYMTAB, offset: symOffset, size: 2 * ent + remainder, link: 1, align: bits === 64 ? 8 : 4, entsize: ent });
  return bytes;
}

function buildRelocationELF(bits, remainder) {
  const strOffset = 0x80, symOffset = 0x100, textOffset = 0x180, relocOffset = 0x1c0, shoff = 0x300, shnum = 5;
  const shsize = bits === 64 ? 64 : 40; const bytes = new Uint8Array(shoff + shnum * shsize); const view = new DataView(bytes.buffer);
  setHeader(view, bits, { type: ET_REL, shoff, shnum }); bytes.set(new TextEncoder().encode('\0ext\0'), strOffset);
  const symEnt = writeSymbolTable(view, bits, symOffset); bytes.fill(0x90, textOffset, textOffset + 16);
  const relocEnt = bits === 64 ? 24 : 8;
  if (bits === 64) { view.setBigUint64(relocOffset, 0n, true); view.setBigUint64(relocOffset + 8, 2n, true); view.setBigInt64(relocOffset + 16, 0n, true); }
  else { view.setUint32(relocOffset, 0, true); view.setUint32(relocOffset + 4, 1, true); }
  if (remainder) bytes[relocOffset + relocEnt] = 0xa5;
  setSection(view, bits, shoff, 0);
  setSection(view, bits, shoff, 1, { type: SHT_STRTAB, offset: strOffset, size: 5 });
  setSection(view, bits, shoff, 2, { type: SHT_SYMTAB, offset: symOffset, size: 2 * symEnt, link: 1, align: bits === 64 ? 8 : 4, entsize: symEnt });
  setSection(view, bits, shoff, 3, { type: SHT_PROGBITS, flags: 0x6n, offset: textOffset, size: 16, align: bits === 64 ? 16 : 4 });
  setSection(view, bits, shoff, 4, { type: bits === 64 ? SHT_RELA : SHT_REL, offset: relocOffset, size: relocEnt + remainder, link: 2, info: 3, align: bits === 64 ? 8 : 4, entsize: relocEnt });
  return bytes;
}

function buildDynamicELF(bits, remainder) {
  const strOffset = 0x80, dynamicOffset = 0x100, shoff = 0x300, shnum = 3;
  const shsize = bits === 64 ? 64 : 40; const bytes = new Uint8Array(shoff + shnum * shsize); const view = new DataView(bytes.buffer);
  setHeader(view, bits, { type: ET_DYN, shoff, shnum }); bytes[strOffset] = 0;
  const ent = bits === 64 ? 16 : 8;
  if (bits === 64) { view.setBigInt64(dynamicOffset, 0n, true); view.setBigUint64(dynamicOffset + 8, 0n, true); }
  else { view.setInt32(dynamicOffset, 0, true); view.setUint32(dynamicOffset + 4, 0, true); }
  if (remainder) bytes[dynamicOffset + ent] = 0xa5;
  setSection(view, bits, shoff, 0);
  setSection(view, bits, shoff, 1, { type: SHT_STRTAB, offset: strOffset, size: 1 });
  setSection(view, bits, shoff, 2, { type: SHT_DYNAMIC, offset: dynamicOffset, size: ent + remainder, link: 1, align: bits === 64 ? 8 : 4, entsize: ent });
  return bytes;
}

for (const bits of [32, 64]) {
  test(`#3973 ELF${bits} aligned fixed-entry section tables stay complete`, () => {
    for (const build of [buildSymbolTableELF, buildRelocationELF, buildDynamicELF]) {
      const image = parseELF(build(bits, 0));
      assert.equal(image.metadata.elfMetadata.complete, true, JSON.stringify(image.metadata.elfMetadata));
    }
  });
  test(`#3973 ELF${bits} symbol-table trailing bytes are partial but full entries remain available`, () => {
    const ent = bits === 64 ? 24 : 16;
    for (let remainder = 1; remainder < ent; remainder++) {
      const image = parseELF(buildSymbolTableELF(bits, remainder));
      assert.equal(image.symbols.some((symbol) => symbol.name === 'ext'), true);
      assert.equal(image.metadata.elfMetadata.complete, false);
      assert.ok(image.metadata.elfMetadata.reasons.includes('symbols:2:trailing-bytes'), JSON.stringify(image.metadata.elfMetadata));
    }
  });
  test(`#3973 ELF${bits} relocation-table trailing bytes are partial but full entries remain available`, () => {
    const ent = bits === 64 ? 24 : 8;
    for (let remainder = 1; remainder < ent; remainder++) {
      const image = parseELF(buildRelocationELF(bits, remainder));
      assert.equal(image.relocations.length, 1);
      assert.equal(image.metadata.elfMetadata.complete, false);
      assert.ok(image.metadata.elfMetadata.reasons.includes('relocations:4:trailing-bytes'), JSON.stringify(image.metadata.elfMetadata));
    }
  });
  test(`#3973 ELF${bits} dynamic-table trailing bytes are partial despite an earlier DT_NULL`, () => {
    const ent = bits === 64 ? 16 : 8;
    for (let remainder = 1; remainder < ent; remainder++) {
      const image = parseELF(buildDynamicELF(bits, remainder));
      assert.equal(image.metadata.elfMetadata.complete, false);
      assert.ok(image.metadata.elfMetadata.reasons.includes('dynamic-section:2:trailing-bytes'), JSON.stringify(image.metadata.elfMetadata));
    }
  });
}
