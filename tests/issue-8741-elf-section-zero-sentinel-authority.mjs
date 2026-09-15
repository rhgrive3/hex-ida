// Issue #8741 regression: an extended-count ET_REL file stores the real section
// COUNT in section header 0's sh_size while e_shnum == 0, and e_shstrndx == 0
// (SHN_UNDEF) means the file has NO section-name string table. Section header 0
// is the reserved SHT_NULL sentinel and can never be a string table or a mapped
// section. The old parser (a) read section 0 as a name table, decoding arbitrary
// file/header bytes as fabricated section names, and (b) published section 0 at
// synthetic address 0 with size == the extended count, fabricating a VA-0 mapped
// extent. Both are withheld now; valid string tables and extended counts keep
// working.
import assert from 'node:assert/strict';
import { parseELF } from '../js/binary/elf.js';
import { sectionHasMappedAddress } from '../js/binary/model.js';

// Build a minimal, standards-valid ELF64 little-endian relocatable object.
//   sectionCount: real number of section headers; encoded in section header 0's
//                 sh_size when eShnum === 0 (extended-count form).
//   eShnum: raw e_shnum field (0 triggers the extended-count read).
//   eShstrndx: raw e_shstrndx (0 == SHN_UNDEF == "no section-name string table").
function buildElf({ sectionCount = 20, eShnum = 0, eShstrndx = 0, withRealStrtab = false } = {}) {
  const shEnt = 64;
  const shoff = 64;
  const strOff = shoff + sectionCount * shEnt;
  const buf = new Uint8Array(strOff + 64);
  const dv = new DataView(buf.buffer);
  const w16 = (o, x) => dv.setUint16(o, x, true);
  const w32 = (o, x) => dv.setUint32(o, x >>> 0, true);
  const w64 = (o, x) => dv.setBigUint64(o, BigInt(x), true);

  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0); // e_ident
  w16(16, 1);          // e_type = ET_REL
  w16(18, 62);         // e_machine = x86-64 (little-endian header writes NUL at 19)
  w32(20, 1);          // e_version
  w64(24, 0);          // e_entry
  w64(32, 0);          // e_phoff = 0 (no program headers)
  w64(40, shoff);      // e_shoff
  w16(52, 64);         // e_ehsize
  w16(54, 56);         // e_phentsize
  w16(56, 0);          // e_phnum
  w16(58, shEnt);      // e_shentsize
  w16(60, eShnum);     // e_shnum (0 => extended count in section header 0 sh_size)
  w16(62, eShstrndx);  // e_shstrndx

  // Section header 0: SHT_NULL sentinel, sh_offset 0, sh_size = extended count.
  const s0 = shoff;
  w32(s0 + 4, 0);            // sh_type = SHT_NULL
  w64(s0 + 32, sectionCount);// sh_size = real extended section count
  w64(s0 + 48, 1);           // sh_addralign

  // Section header 1: SHT_PROGBITS whose sh_name (16) points back into the ELF
  // header (e_type little-endian byte 0x01 at offset 16, NUL at 17). If section 0
  // is misread as the string table, this resolves to a non-empty garbage name.
  const s1 = s0 + shEnt;
  w32(s1 + 0, 16);           // sh_name
  w32(s1 + 4, 1);            // sh_type = SHT_PROGBITS
  w64(s1 + 24, 8);           // sh_offset (valid in-file span)
  w64(s1 + 32, 8);           // sh_size
  w64(s1 + 48, 1);           // sh_addralign

  if (withRealStrtab && sectionCount > 2) {
    // Real SHT_STRTAB at section index 2 holding "\0.text\0".
    const s2 = s0 + 2 * shEnt;
    w32(s2 + 4, 3);          // sh_type = SHT_STRTAB
    w64(s2 + 24, strOff);    // sh_offset
    w64(s2 + 32, 8);         // sh_size
    w64(s2 + 48, 1);
    buf.set([0x00, 0x2e, 0x74, 0x65, 0x78, 0x74, 0x00, 0x00], strOff);
    w32(s1 + 0, 1);          // section 1 -> ".text"
  }
  return buf;
}

function sectionAt(image, index) {
  return image.sections.find((s) => s.index === index);
}

// 1. The reserved section-0 sentinel must not carry mapping authority, and no
//    fabricated VA-0 extent sized to the extended count may exist.
{
  const image = parseELF(buildElf({ sectionCount: 20, eShnum: 0 }));
  const sec0 = sectionAt(image, 0);
  assert.ok(sec0, 'section 0 remains listed for metadata');
  assert.equal(sec0.source, 'unmapped-section', 'section-0 sentinel has no mapping authority');
  assert.equal(sectionHasMappedAddress(sec0), false, 'section-0 is not a mapped section');
  const fakeZeroExtent = image.sections.find(
    (s) => sectionHasMappedAddress(s) && s.address === 0n && s.size === 20n,
  );
  assert.equal(fakeZeroExtent, undefined, 'no fabricated VA-0 mapped extent sized to the count');
}

// 2. e_shstrndx == 0 (no string table) must not decode section-0/header bytes as
//    a fabricated section name for section 1.
{
  const image = parseELF(buildElf({ sectionCount: 20, eShnum: 0 }));
  const sec1 = sectionAt(image, 1);
  assert.ok(sec1, 'section 1 is parsed');
  assert.equal(sec1.name, 'section_1', 'no garbage name is minted from header bytes when there is no strtab');
}

// 3. Control: a real SHT_STRTAB at a non-zero index still resolves names, and the
//    string-table section itself is not the sentinel path.
{
  const image = parseELF(buildElf({
    sectionCount: 4, eShnum: 4, eShstrndx: 2, withRealStrtab: true,
  }));
  assert.equal(sectionAt(image, 1).name, '.text', 'a genuine string table still names sections');
  assert.notEqual(sectionAt(image, 2).source, 'unmapped-section', 'a real strtab is not treated as the sentinel');
}

// 4. Control: extended-count resolution still works after the sentinel fix.
{
  const image = parseELF(buildElf({ sectionCount: 6, eShnum: 0 }));
  assert.equal(image.sections.length, 6, 'section count still comes from section header 0');
}

// 5. Control: an ordinary (non-extended) ET_REL keeps working — the sentinel is
//    unmapped while a real section retains mapping authority.
{
  const image = parseELF(buildElf({ sectionCount: 2, eShnum: 2 }));
  assert.equal(sectionAt(image, 0).source, 'unmapped-section', 'sentinel stays unmapped');
  assert.equal(sectionHasMappedAddress(sectionAt(image, 1)), true, 'a real section keeps mapping authority');
}

console.log('issue #8741 ELF section-0 sentinel authority regressions: PASS');
