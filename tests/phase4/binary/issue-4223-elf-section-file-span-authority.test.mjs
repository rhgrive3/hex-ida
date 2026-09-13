/**
 * #4223 — a file-backed (non-SHT_NOBITS) section whose `sh_offset + sh_size`
 * escapes EOF has no payload in the file.  It must not be registered as
 * canonical section mapping authority, and its phantom tail must not authorize
 * an executable extent.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseELF } from '../../../js/binary/elf.js';

const ET_REL = 1;
const ET_EXEC = 2;
const EM_RISCV = 243;
const SHT_NULL = 0;
const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_NOBITS = 8;
const SHF_WRITE = 0x1n;
const SHF_ALLOC = 0x2n;
const SHF_EXECINSTR = 0x4n;
const STB_GLOBAL = 1;
const STT_FUNC = 2;
const PT_LOAD = 1;

const CLASS = {
  64:{ ehdr:64, shdr:64, phdr:56, sym:24 },
  32:{ ehdr:52, shdr:40, phdr:32, sym:16 },
};

const NAMES = ['', '.text', '.symtab', '.strtab', '.shstrtab'];

function stringTable(names) {
  const bytes = new Uint8Array(names.reduce((sum, name) => sum + name.length + 1, 1));
  const offsets = [];
  let cursor = 1;
  for (const name of names) {
    offsets.push(cursor);
    bytes.set(new TextEncoder().encode(name), cursor);
    cursor += name.length + 1;
  }
  return { bytes, offsets };
}

function writerFor(view, bits, littleEndian) {
  return {
    u8:(p, v) => view.setUint8(p, v),
    u16:(p, v) => view.setUint16(p, v, littleEndian),
    u32:(p, v) => view.setUint32(p, v, littleEndian),
    u64:(p, v) => view.setBigUint64(p, BigInt(v), littleEndian),
    word:(p, v) => (bits === 64 ? view.setBigUint64(p, BigInt(v), littleEndian) : view.setUint32(p, Number(v), littleEndian)),
  };
}

/*
 * Layout: ELF header, program headers, .text payload, .symtab, .strtab,
 * .shstrtab, section headers.  `declaredOffset`/`declaredSize` change only what
 * the section header claims, so a caller can push a file-backed section past EOF
 * while every table it reads stays inside the file.
 */
function buildELF({
  bits = 64, littleEndian = true, type = ET_REL,
  text = {}, symbols = [], segments = null, padTo = 0,
} = {}) {
  const l = CLASS[bits];
  const shstrtab = stringTable(NAMES);
  const strtab = stringTable(['', ...symbols.map((symbol) => symbol.name)]);
  const textBytes = text.bytes ?? new Uint8Array(0x20);
  const symCount = symbols.length + 1;

  const phoff = segments ? l.ehdr : 0;
  let cursor = Math.ceil((l.ehdr + (segments ? segments.length * l.phdr : 0)) / 8) * 8;
  const textAt = cursor;
  cursor += textBytes.length;
  const symOff = cursor; cursor += symCount * l.sym;
  const strOff = cursor; cursor += strtab.bytes.length;
  const shstrOff = cursor; cursor += shstrtab.bytes.length;
  const shoff = Math.ceil(cursor / 8) * 8;
  const total = Math.max(shoff + NAMES.length * l.shdr, padTo);

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  const w = writerFor(view, bits, littleEndian);
  w.u8(0, 0x7f); w.u8(1, 0x45); w.u8(2, 0x4c); w.u8(3, 0x46);
  w.u8(4, bits === 64 ? 2 : 1);
  w.u8(5, littleEndian ? 1 : 2);
  w.u8(6, 1);
  w.u16(16, type);
  w.u16(18, EM_RISCV);
  w.u32(20, 1);
  w.word(24, 0);
  const header = (offset64, size64, offset32, size32) => {
    if (bits === 64) { w.u32(48, 0); w.word(offset64, size64); }
    else { w.u32(36, 0); w.u32(offset32, size32); }
  };
  header(32, phoff, 28, phoff);
  header(40, shoff, 32, shoff);
  if (bits === 64) {
    w.u16(52, l.ehdr); w.u16(54, l.phdr); w.u16(56, segments?.length ?? 0);
    w.u16(58, l.shdr); w.u16(60, NAMES.length); w.u16(62, 4);
  } else {
    w.u16(40, l.ehdr); w.u16(42, l.phdr); w.u16(44, segments?.length ?? 0);
    w.u16(46, l.shdr); w.u16(48, NAMES.length); w.u16(50, 4);
  }

  (segments || []).forEach((segment, i) => {
    const p = phoff + i * l.phdr;
    const fileSize = segment.fileSize === 'file' ? total - segment.offset : segment.fileSize;
    if (bits === 64) {
      w.u32(p, segment.type); w.u32(p + 4, segment.flags);
      w.u64(p + 8, segment.offset); w.u64(p + 16, segment.addr); w.u64(p + 24, segment.addr);
      w.u64(p + 32, fileSize); w.u64(p + 40, segment.memSize); w.u64(p + 48, 0x1000);
    } else {
      w.u32(p, segment.type); w.u32(p + 4, segment.offset); w.u32(p + 8, segment.addr);
      w.u32(p + 12, segment.addr); w.u32(p + 16, fileSize); w.u32(p + 20, segment.memSize);
      w.u32(p + 24, segment.flags); w.u32(p + 28, 0x1000);
    }
  });

  bytes.set(textBytes, textAt);
  bytes.set(strtab.bytes, strOff);
  bytes.set(shstrtab.bytes, shstrOff);

  const section = (index, { sectionType, flags = 0n, addr = 0n, offset = 0, size = 0, link = 0, info = 0, addralign = 1n, entsize = 0n }) => {
    const p = shoff + index * l.shdr;
    w.u32(p, shstrtab.offsets[index]);
    w.u32(p + 4, sectionType);
    if (bits === 64) {
      w.u64(p + 8, flags); w.u64(p + 16, addr); w.u64(p + 24, offset); w.u64(p + 32, size);
      w.u32(p + 40, link); w.u32(p + 44, info); w.u64(p + 48, addralign); w.u64(p + 56, entsize);
    } else {
      w.u32(p + 8, Number(flags)); w.u32(p + 12, Number(addr)); w.u32(p + 16, Number(offset)); w.u32(p + 20, Number(size));
      w.u32(p + 24, link); w.u32(p + 28, info); w.u32(p + 32, Number(addralign)); w.u32(p + 36, Number(entsize));
    }
  };

  const textSize = text.declaredSize ?? textBytes.length;
  const textOffset = text.declaredOffset === 'eof' ? total - textSize
    : text.declaredOffset === 'past-eof' ? total + 0x100
    : (text.declaredOffset ?? textAt);
  section(0, { sectionType:SHT_NULL, addralign:0n });
  section(1, {
    sectionType:text.sectionType ?? SHT_PROGBITS,
    flags:text.flags ?? (SHF_ALLOC | SHF_EXECINSTR),
    addr:text.addr ?? 0n,
    offset:textOffset,
    size:textSize,
    addralign:text.addralign ?? 4n,
  });
  section(2, { sectionType:SHT_SYMTAB, offset:symOff, size:symCount * l.sym, link:3, info:1, addralign:8n, entsize:l.sym });
  section(3, { sectionType:SHT_STRTAB, offset:strOff, size:strtab.bytes.length });
  section(4, { sectionType:SHT_STRTAB, offset:shstrOff, size:shstrtab.bytes.length });

  symbols.forEach((symbol, i) => {
    const p = symOff + (i + 1) * l.sym;
    const info = ((symbol.bind ?? STB_GLOBAL) << 4) | (symbol.type ?? STT_FUNC);
    w.u32(p, strtab.offsets[i + 1]);
    if (bits === 64) {
      w.u8(p + 4, info); w.u8(p + 5, 0); w.u16(p + 6, symbol.shndx ?? 1);
      w.u64(p + 8, symbol.value); w.u64(p + 16, symbol.size ?? 0);
    } else {
      w.u32(p + 4, Number(symbol.value)); w.u32(p + 8, Number(symbol.size ?? 0));
      w.u8(p + 12, info); w.u8(p + 13, 0); w.u16(p + 14, symbol.shndx ?? 1);
    }
  });

  return { bytes, total, textOffset, textAt };
}

function imageOf(options) {
  const built = buildELF(options);
  const image = parseELF(built.bytes);
  return { ...built, image, textSection:() => image.sections.find((entry) => entry.name === '.text') };
}

test('#4223: a file-backed section ending exactly at EOF keeps canonical mapping authority', () => {
  const { image, total, textSection } = imageOf({ text:{ declaredOffset:'eof' }, symbols:[] });
  const text = textSection();
  assert.equal(text.fileOffset + text.fileSize, BigInt(total), 'sh_offset + sh_size lands exactly on EOF');
  assert.equal(text.source, 'ET_REL-synthetic-section');
  assert.ok(!image.warnings.some((warning) => warning.includes('file span beyond EOF')));
  assert.equal(image.addressToOffset(text.address), text.fileOffset);
});

test('#4223: an ET_REL section whose sh_size runs past EOF is not canonical mapping authority', () => {
  const { image, total, textSection } = imageOf({ text:{ declaredSize:0x200 }, symbols:[] });
  const text = textSection();
  assert.equal(text.source, 'unmapped-section');
  assert.ok(text.fileOffset + text.fileSize > BigInt(total));
  assert.ok(image.warnings.some((warning) => warning.includes('file span beyond EOF')), JSON.stringify(image.warnings));
  assert.equal(image.addressToOffset(text.address + 0x100n), null, 'phantom bytes past EOF cannot map to a file offset');
});

test('#4223: an out-of-file sh_offset is rejected even with a zero declared size', () => {
  const { image, textSection } = imageOf({
    text:{ declaredOffset:'past-eof', declaredSize:0 },
    symbols:[],
  });
  assert.equal(textSection().source, 'unmapped-section');
});

test('#4223: SHT_NOBITS keeps its zero-fileSize semantics', () => {
  const { image, textSection } = imageOf({
    text:{ sectionType:SHT_NOBITS, flags:SHF_ALLOC | SHF_WRITE, declaredOffset:0x100000, declaredSize:0x40 },
    symbols:[],
  });
  assert.equal(textSection().fileSize, 0n);
});

for (const [bits, littleEndian] of [[64, true], [32, true], [64, false]]) {
  test(`#4223: a truncated executable ET_REL section cannot own a function extent (ELFCLASS${bits} ${littleEndian ? 'LE' : 'BE'})`, () => {
    const { image } = imageOf({
      bits, littleEndian,
      text:{ declaredSize:0x200 },
      symbols:[{ name:'phantom', value:0x100n, size:0x10n }],
    });
    const seeded = image.functions.map((seed) => seed.name);
    assert.equal(seeded.includes('phantom'), false, `a function inside the phantom tail must not be seeded: ${JSON.stringify(seeded)}`);
    assert.equal(image.sections.find((entry) => entry.name === '.text').source, 'unmapped-section');
  });
}

test('#4223: a truncated executable ET_EXEC section cannot own a function extent', () => {
  const { image } = imageOf({
    type:ET_EXEC,
    text:{ declaredOffset:0x1000, addr:0x401000n, declaredSize:0x200, addralign:0x1000n },
    segments:[{ type:PT_LOAD, flags:5, offset:0, addr:0x400000n, fileSize:'file', memSize:0x2000 }],
    padTo:0x1100,
    symbols:[{ name:'phantom', value:0x401100n, size:0x10n }],
  });
  assert.equal(image.sections.find((entry) => entry.name === '.text').source, 'unmapped-section');
  assert.equal(image.functions.find((seed) => seed.name === 'phantom'), undefined, JSON.stringify(image.functions.map((seed) => seed.name)));
});

test('#4223: an intact executable ET_EXEC section keeps its function evidence', () => {
  const { image, total } = imageOf({
    type:ET_EXEC,
    text:{ declaredOffset:0x1000, addr:0x401000n, declaredSize:0x20, addralign:0x1000n },
    segments:[{ type:PT_LOAD, flags:5, offset:0, addr:0x400000n, fileSize:'file', memSize:0x2000 }],
    padTo:0x1100,
    symbols:[{ name:'real', value:0x401004n, size:0x8n }],
  });
  assert.ok(BigInt(total) >= 0x1020n);
  assert.equal(image.sections.find((entry) => entry.name === '.text').source, 'section-header');
  assert.equal(image.functions.find((seed) => seed.name === 'real')?.address, 0x401004n);
});
