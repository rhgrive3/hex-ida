/**
 * #8821 fixture builder for aliased `DT_SYMTAB` `st_name` offsets.
 *
 * Also runs as the constrained-heap child entrypoint: `node
 * --max-old-space-size=128 <this file>` must parse the 600-record / 100,000-byte
 * shared-name counterexample through the public `parseELF()` path instead of
 * aborting the V8 heap.
 */

import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseELF } from '../../../js/binary/elf.js';

const PHENT = 56;
const DYN_ENT = 16;
const SYM_ENT = 24;
const LOAD_FILE_OFF = 0x100;
const DYNAMIC_FILE_OFF = 0x200;
const STRTAB_FILE_OFF = 0x300;
// Linear PT_LOAD mapping: VA = FILE_OFFSET + VA_BIAS.
const VA_BIAS = 0x1000 - LOAD_FILE_OFF;

const DT_STRTAB = 5n;
const DT_SYMTAB = 6n;
const DT_STRSZ = 10n;
const DT_SYMENT = 11n;
const DT_SYMTABSZ = 39n;
const DT_NULL = 0n;

/**
 * @param mode 'shared' points every `st_name` at one long entry, 'distinct'
 *   gives every symbol its own long entry so memoization cannot help.
 */
export function buildAliasedDynsymElf({ records = 600, nameLength = 100000, mode = 'shared' } = {}) {
  const nameOffsets = [];
  let cursor = 1;
  for (let i = 1; i < records; i++) {
    nameOffsets.push(mode === 'shared' ? 1 : cursor);
    if (mode !== 'shared') cursor += nameLength + 1;
  }
  const strtabLength = mode === 'shared' ? nameLength + 2 : cursor;
  const table = new Uint8Array(strtabLength);
  table.fill(0x41, 1);
  for (const off of new Set(nameOffsets)) table[off + nameLength] = 0;
  table[strtabLength - 1] = 0;

  const symtabFileOff = STRTAB_FILE_OFF + strtabLength;
  const dynamicEntries = [
    [DT_STRTAB, STRTAB_FILE_OFF + VA_BIAS],
    [DT_SYMTAB, symtabFileOff + VA_BIAS],
    [DT_STRSZ, strtabLength],
    [DT_SYMENT, SYM_ENT],
    [DT_SYMTABSZ, records * SYM_ENT],
    [DT_NULL, 0],
  ];
  const dynamicLength = dynamicEntries.length * DYN_ENT;
  const size = symtabFileOff + records * SYM_ENT;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  const u8 = (p, v) => view.setUint8(p, v);
  const u16 = (p, v) => view.setUint16(p, v, true);
  const u32 = (p, v) => view.setUint32(p, v, true);
  const u64 = (p, v) => view.setBigUint64(p, BigInt(v), true);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  u16(16, 3);                       // ET_DYN
  u16(18, 62);                      // x86-64
  u32(20, 1);                       // e_version
  u64(24, LOAD_FILE_OFF + VA_BIAS); // e_entry
  u64(32, 64);                      // e_phoff
  u64(40, 0);                       // e_shoff: sectionless
  u32(48, 0);                       // e_flags
  u16(52, 64);                      // e_ehsize
  u16(54, PHENT);                   // e_phentsize
  u16(56, 2);                       // e_phnum
  u16(58, PHENT);                   // e_shentsize
  u16(60, 0);                       // e_shnum
  u16(62, 0);                       // e_shstrndx

  const phdr = (index, type, fileOff, span, flags, align) => {
    const p = 64 + index * PHENT;
    u32(p, type);
    u32(p + 4, flags);
    u64(p + 8, fileOff);
    u64(p + 16, fileOff + VA_BIAS);
    u64(p + 24, fileOff + VA_BIAS);
    u64(p + 32, span);
    u64(p + 40, span);
    u64(p + 48, align);
  };
  phdr(0, 1, LOAD_FILE_OFF, size - LOAD_FILE_OFF, 5, 0x100);  // PT_LOAD R+X
  phdr(1, 2, DYNAMIC_FILE_OFF, dynamicLength, 6, 8);          // PT_DYNAMIC R+W

  dynamicEntries.forEach(([tag, value], index) => {
    const p = DYNAMIC_FILE_OFF + index * DYN_ENT;
    view.setBigInt64(p, tag, true);
    view.setBigUint64(p + 8, BigInt(value), true);
  });
  bytes.set(table, STRTAB_FILE_OFF);
  // Symbol 0 is the canonical null symbol; every other record is an ordinary
  // undefined global (STB_GLOBAL | STT_NOTYPE, SHN_UNDEF) naming the shared entry.
  nameOffsets.forEach((nameOff, index) => {
    const p = symtabFileOff + (index + 1) * SYM_ENT;
    u32(p, nameOff);
    u8(p + 4, 0x10);
  });
  return { bytes, strtabLength, symtabFileOff, dynamicLength, nameOffsets };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { bytes } = buildAliasedDynsymElf({ records: 600, nameLength: 100000 });
  const image = parseELF(bytes);
  const budget = image.metadata.programDynamicSymbolBudget;
  process.stdout.write(JSON.stringify({
    fixtureBytes: bytes.length,
    symbols: image.symbols.length,
    imports: image.imports.length,
    partial: image.metadata.programDynamicPartial ?? false,
    budget: {
      stringBytes: budget.stringBytes,
      estimatedBytes: budget.estimatedBytes,
      stopped: budget.stopped,
      reason: budget.reason,
    },
  }) + '\n');
}
