import assert from 'node:assert/strict';
import { parseELF } from '../../../js/binary/elf.js';

function buildElf({ trailing = true } = {}) {
  const bytes = new Uint8Array(0x2200);
  const view = new DataView(bytes.buffer);
  const u16 = (offset, value) => view.setUint16(offset, value, true);
  const u32 = (offset, value) => view.setUint32(offset, value >>> 0, true);
  const u64 = (offset, value) => view.setBigUint64(offset, BigInt(value), true);
  const section = (index, type, offset, size, link, info, align, entrySize) => {
    const p = 0x2000 + index * 64;
    u32(p + 4, type);
    u64(p + 16, 0x400000n + BigInt(offset - 0x1000));
    u64(p + 24, offset);
    u64(p + 32, size);
    u32(p + 40, link);
    u32(p + 44, info);
    u64(p + 48, align);
    u64(p + 56, entrySize);
  };

  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  u16(16, 3); // ET_DYN
  u16(18, 62); // EM_X86_64
  u32(20, 1); // e_version = EV_CURRENT
  u64(32, 0x40); // e_phoff
  u64(40, 0x2000); // e_shoff
  u16(52, 64); u16(54, 56); u16(56, 1);
  u16(58, 64); u16(60, 5); u16(62, 0);

  // One file-backed PT_LOAD covers every section payload below.
  u32(0x40, 1); u32(0x44, 7);
  u64(0x48, 0x1000); u64(0x50, 0x400000);
  u64(0x58, 0x400000); u64(0x60, 0x800); u64(0x68, 0x800); u64(0x70, 0x1000);

  bytes[0x1100] = 0; // string-table sentinel
  bytes.fill(0, 0x1200, 0x1220); // one zero-valued Elf64_Sym + tail space
  bytes.fill(0, 0x1300, 0x1320); // one zero-valued Elf64_Rela + tail space
  bytes.fill(0, 0x1400, 0x1420); // DT_NULL + tail space
  if (trailing) {
    bytes[0x1218] = 0xaa;
    bytes[0x1318] = 0xbb;
    bytes[0x1410] = 0xcc;
  }

  section(1, 3, 0x1100, 1, 0, 0, 1, 0); // SHT_STRTAB
  section(2, 11, 0x1200, trailing ? 25 : 24, 1, 0, 8, 24); // SHT_DYNSYM
  section(3, 4, 0x1300, trailing ? 25 : 24, 2, 0, 8, 24); // SHT_RELA
  section(4, 6, 0x1400, trailing ? 17 : 16, 1, 0, 8, 16); // SHT_DYNAMIC
  return bytes;
}

const clean = parseELF(buildElf({ trailing: false }));
assert.equal(clean.metadata.elfMetadata.reasons.some((reason) => reason.includes('trailing-bytes')), false);

const malformed = parseELF(buildElf());
const reasons = malformed.metadata.elfMetadata.reasons;
assert.equal(malformed.metadata.elfMetadata.complete, false);
assert.ok(reasons.includes('symbols:2:trailing-bytes'));
assert.ok(reasons.includes('relocations:3:trailing-bytes'));
assert.ok(reasons.includes('dynamic-section:4:trailing-bytes'));

console.log('issue #3973 ELF fixed-table remainder: PASS');
