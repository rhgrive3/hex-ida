/**
 * #8678 fixture builder for repeated `.shstrtab` offsets.
 *
 * Also runs as the constrained-heap child entrypoint: `node
 * --max-old-space-size=128 <this file>` must parse the shared-name counterexample
 * and exit cleanly instead of exhausting the V8 heap.
 */

import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseELF } from '../../../js/binary/elf.js';

const SHT_PROGBITS = 1;
const SHT_STRTAB = 3;

export function buildSectionNameELF({ bits = 64, littleEndian = true, table, nameOffsets, strtabIndex = 1 }) {
  const ehsize = bits === 64 ? 64 : 52;
  const shentsize = bits === 64 ? 64 : 40;
  const strOff = ehsize;
  const shoff = strOff + table.length;
  const count = nameOffsets.length;
  const bytes = new Uint8Array(shoff + count * shentsize);
  const view = new DataView(bytes.buffer);
  const u16 = (p, v) => view.setUint16(p, v, littleEndian);
  const u32 = (p, v) => view.setUint32(p, v, littleEndian);
  const u64 = (p, v) => view.setBigUint64(p, BigInt(v), littleEndian);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, bits === 64 ? 2 : 1, littleEndian ? 1 : 2, 1, 0], 0);
  u16(16, 1);                 // e_type = ET_REL
  u16(18, 62);                // e_machine
  u32(20, 1);                 // e_version
  if (bits === 64) {
    u64(24, 0);               // e_entry
    u64(32, 0);               // e_phoff
    u64(40, shoff);           // e_shoff
    u32(48, 0);               // e_flags
    u16(52, ehsize);
    u16(54, 56);
    u16(56, 0);               // e_phnum
    u16(58, shentsize);
    u16(60, count);           // e_shnum
    u16(62, strtabIndex);     // e_shstrndx
  } else {
    u32(24, 0);
    u32(28, 0);
    u32(32, shoff);
    u32(36, 0);
    u16(40, ehsize);
    u16(42, 32);
    u16(44, 0);
    u16(46, shentsize);
    u16(48, count);
    u16(50, strtabIndex);
  }
  bytes.set(table, strOff);
  for (let i = 1; i < count; i++) {
    const p = shoff + i * shentsize;
    u32(p, nameOffsets[i]);
    u32(p + 4, i === strtabIndex ? SHT_STRTAB : SHT_PROGBITS);
    if (bits === 64) {
      if (i === strtabIndex) { u64(p + 24, strOff); u64(p + 32, table.length); }
    } else if (i === strtabIndex) {
      u32(p + 16, strOff);
      u32(p + 20, table.length);
    }
  }
  return bytes;
}

export function sharedOffsetFixture({ bits = 64, littleEndian = true, shnum = 2500, nameLength = 262142, terminated = true } = {}) {
  const table = new Uint8Array(1 + nameLength + (terminated ? 1 : 0)).fill(0x41);
  table[0] = 0;
  if (terminated) table[table.length - 1] = 0;
  return buildSectionNameELF({
    bits, littleEndian, table,
    nameOffsets: Array.from({ length: shnum }, (_, i) => (i === 0 ? 0 : 1)),
  });
}

export function distinctNameFixture({ bits = 64, littleEndian = true, count = 6, nameLength = 1000 } = {}) {
  const table = new Uint8Array(1 + count * (nameLength + 1));
  let cursor = 1;
  const nameOffsets = [0];
  for (let i = 0; i < count; i++) {
    table.set(new TextEncoder().encode('N'.repeat(nameLength)), cursor);
    cursor += nameLength;
    table[cursor] = 0;
    cursor += 1;
    nameOffsets.push(cursor - nameLength - 1);
  }
  return buildSectionNameELF({ bits, littleEndian, table, nameOffsets });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const bytes = sharedOffsetFixture();
  const image = parseELF(bytes);
  const shared = image.sections.filter((s) => s.name && s.name.length === 262142).length;
  process.stdout.write(JSON.stringify({
    fixtureBytes: bytes.length,
    sections: image.sections.length,
    sharedNameSections: shared,
    metadata: image.metadata.elfMetadata,
  }) + '\n');
}
