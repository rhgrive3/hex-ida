// Issue #4096 regression: an ELF header that declares table entries must not be
// accepted with a zero table offset. `e_phoff == 0` / `e_shoff == 0` mean "this
// image has no such table", so a non-zero (possibly extended) entry count with
// a zero offset is a contradiction. The parser used to silently drop the whole
// declared table (`parseProgramHeaders` returned [] on `off <= 0`,
// `parseSectionHeaders` returned [] on `!off`), promoting a malformed ELF to a
// canonical BinaryImage whose segment/section model is missing PT_LOAD and all
// section-backed metadata without any error or warning.
import assert from 'node:assert/strict';
import { parseELF } from '../js/binary/elf.js';

// ELF64/ELF32, little/big endian builder. Section header 0 is always NULL and
// carries the extended-count fields that PN_XNUM / e_shnum == 0 rely on.
function buildElf({
  bits = 64, littleEndian = true, type = 3,
  phoff = 0x40, phnum = 1,
  shoff = 0x3000, shnum = 2,
  sectionZeroInfo = 0, sectionZeroSize = 0,
} = {}) {
  const le = littleEndian;
  const is64 = bits === 64;
  const buf = new Uint8Array(0x4000);
  const dv = new DataView(buf.buffer);
  const w8 = (o, x) => { buf[o] = x; };
  const w16 = (o, x) => dv.setUint16(o, x, le);
  const w32 = (o, x) => dv.setUint32(o, x >>> 0, le);
  const w64 = (o, x) => dv.setBigUint64(o, BigInt(x), le);
  const wPtr = (o, x) => (is64 ? w64(o, x) : w32(o, x));
  const phEnt = is64 ? 56 : 32, shEnt = is64 ? 64 : 40;
  const ph = is64
    ? { size: 56, addr: 16, offset: 8, filesz: 32, memsz: 40 }
    : { size: 16, addr: 8, offset: 4, filesz: 16, memsz: 20 };
  const sh = is64
    ? { size: 32, addr: 16, offset: 24, info: 44 }
    : { size: 20, addr: 12, offset: 16, info: 28 };
  const hd = is64
    ? { entry: 24, phoff: 32, shoff: 40, flags: 48, ehsize: 52, phentsize: 54, phnum: 56, shentsize: 58, shnum: 60, shstrndx: 62 }
    : { entry: 24, phoff: 28, shoff: 32, flags: 36, ehsize: 40, phentsize: 42, phnum: 44, shentsize: 46, shnum: 48, shstrndx: 50 };

  buf.set([0x7f, 0x45, 0x4c, 0x46, is64 ? 2 : 1, littleEndian ? 1 : 2, 1, 0, 0], 0);
  w16(16, type); w16(18, 62); w32(20, 1);
  wPtr(hd.entry, 0x400000); w32(hd.flags, 0);
  w16(hd.ehsize, is64 ? 64 : 52);
  w16(hd.phentsize, phEnt); w16(hd.phnum, phnum);
  w16(hd.shentsize, shEnt); w16(hd.shnum, shnum); w16(hd.shstrndx, 0);
  wPtr(hd.phoff, phoff); wPtr(hd.shoff, shoff);

  const effectivePhnum = phnum === 0xffff ? sectionZeroInfo : phnum;
  if (phoff !== 0 && effectivePhnum > 0) {
    for (let i = 0; i < effectivePhnum; i++) {
      const p = phoff + i * phEnt;
      w32(p, 1);
      w32(p + (is64 ? 4 : 24), 5);
      wPtr(p + ph.offset, 0x1000); wPtr(p + ph.addr, 0x400000);
      wPtr(p + ph.size, 0x1000); wPtr(p + ph.memsz, 0x1000);
      wPtr(p + (is64 ? 48 : 28), 0x1000);
    }
  }
  buf.fill(0xb8, 0x1000, 0x1010);

  if (shoff !== 0) {
    w32(shoff, 0); w32(shoff + 4, 0);
    wPtr(shoff + sh.size, sectionZeroSize);
    w32(shoff + sh.info, sectionZeroInfo);
    const p = shoff + shEnt;
    w32(p, 0); w32(p + 4, 1);
    wPtr(p + 8, 0x6); wPtr(p + sh.addr, 0x400000);
    wPtr(p + sh.offset, 0x1000); wPtr(p + sh.size, 0x100);
  }
  return buf;
}

// 1. Baseline: consistent non-zero offsets with non-zero counts are accepted.
{
  const image = parseELF(buildElf());
  assert.equal(image.segments.length, 1, 'baseline PT_LOAD table is parsed');
  assert.equal(image.sections.length, 2, 'baseline section table is parsed');
}

// 2. e_phoff = 0 with a non-zero effective e_phnum must be rejected, not
//    silently downgraded to an empty program header table.
{
  assert.throws(() => parseELF(buildElf({ phoff: 0, phnum: 1 })), /e_phoff/);
  assert.throws(() => parseELF(buildElf({ bits: 32, phoff: 0, phnum: 1 })), /e_phoff/);
  assert.throws(() => parseELF(buildElf({ littleEndian: false, phoff: 0, phnum: 2 })), /e_phoff/);
}

// 3. e_shoff = 0 with a non-zero e_shnum must be rejected, not silently
//    downgraded to "no sections".
{
  assert.throws(() => parseELF(buildElf({ shoff: 0, shnum: 1 })), /e_shoff/);
  assert.throws(() => parseELF(buildElf({ bits: 32, shoff: 0, shnum: 2 })), /e_shoff/);
  assert.throws(() => parseELF(buildElf({ littleEndian: false, shoff: 0, shnum: 1 })), /e_shoff/);
}

// 4. Zero offset with zero count stays the documented "no table here" encoding.
{
  const noPrograms = parseELF(buildElf({ type: 1, phoff: 0, phnum: 0 }));
  assert.equal(noPrograms.segments.length, 0, 'ET_REL without a program header table is accepted');
  const sectionless = parseELF(buildElf({ shoff: 0, shnum: 0 }));
  assert.equal(sectionless.sections.length, 0, 'sectionless ELF is accepted');
  assert.equal(sectionless.segments.length, 1, 'its program header table is still parsed');
}

// 5. PN_XNUM is judged by the effective count resolved from section header 0.
{
  const extended = parseELF(buildElf({ phnum: 0xffff, sectionZeroInfo: 1 }));
  assert.equal(extended.metadata.extendedProgramHeaderCount, 1, 'valid PN_XNUM keeps working');
  assert.equal(extended.segments.length, 1);
  assert.throws(() => parseELF(buildElf({ phoff: 0, phnum: 0xffff, sectionZeroInfo: 3 })), /e_phoff/);
  const emptyExtended = parseELF(buildElf({ type: 1, phoff: 0, phnum: 0xffff, sectionZeroInfo: 0 }));
  assert.equal(emptyExtended.segments.length, 0, 'PN_XNUM whose extended count is 0 is a real absent table');
  assert.throws(() => parseELF(buildElf({ shoff: 0, phnum: 0xffff })), /PN_XNUM requires section header 0/);
}

// 6. Extended section numbering (e_shnum = 0, count in section header 0) is unchanged.
{
  const image = parseELF(buildElf({ shnum: 0, sectionZeroSize: 2 }));
  assert.equal(image.sections.length, 2, 'the section count still comes from section header 0');
}

console.log('issue #4096 ELF header table presence regressions: PASS');
