import assert from 'node:assert/strict';
import { parseELF } from '../../../js/binary/elf.js';

const BASE = 0x400000n;
const DYNAMIC_OFF = 0x100;
const TABLE_OFF = 0x200;
const TARGET_VA = BASE + 0x380n;
const DT_NULL = 0n;
const DT_PLTRELSZ = 2n;
const DT_HASH = 4n;
const DT_STRTAB = 5n;
const DT_SYMTAB = 6n;
const DT_RELA = 7n;
const DT_RELASZ = 8n;
const DT_RELAENT = 9n;
const DT_STRSZ = 10n;
const DT_SYMENT = 11n;
const DT_REL = 17n;
const DT_RELSZ = 18n;
const DT_RELENT = 19n;
const DT_PLTREL = 20n;
const DT_JMPREL = 23n;
const R_X86_64_RELATIVE = 8n;

function buildFixture({ rela = true, addends = [5n, 9n], types = null, aliasJmprel = false, secondPhysicalTable = false, symbolIndex = 0 } = {}) {
  const stride = rela ? 24 : 16;
  const records = addends.length;
  const SECOND_TABLE_OFF = 0x280;
  const HASH_OFF = 0x300, SYMTAB_OFF = 0x320, STRTAB_OFF = 0x360;
  const size = 0x500;
  const b = new Uint8Array(size); const v = new DataView(b.buffer);
  const u16 = (o, x) => v.setUint16(o, x, true);
  const u32 = (o, x) => v.setUint32(o, x >>> 0, true);
  const u64 = (o, x) => v.setBigUint64(o, BigInt(x), true);
  const i64 = (o, x) => v.setBigInt64(o, BigInt(x), true);

  b.set([0x7f,0x45,0x4c,0x46,2,1,1,0,0,0,0,0,0,0,0,0], 0);
  u16(16, 3); u16(18, 62); u32(20, 1); u64(24, 0); u64(32, 64); u64(40, 0); u32(48, 0);
  u16(52, 64); u16(54, 56); u16(56, 2); u16(58, 64); u16(60, 0); u16(62, 0);
  function ph(i, type, flags, off, va, filesz, memsz) {
    const p = 64 + i * 56;
    u32(p, type); u32(p + 4, flags); u64(p + 8, off); u64(p + 16, va); u64(p + 24, va);
    u64(p + 32, filesz); u64(p + 40, memsz); u64(p + 48, 0x1000);
  }
  ph(0, 1, 6, 0, BASE, size, size);

  function writeTable(off) {
    for (let i = 0; i < records; i++) {
      const p = off + i * stride;
      u64(p, TARGET_VA);
      const type = BigInt(types?.[i] ?? R_X86_64_RELATIVE);
      u64(p + 8, (BigInt(symbolIndex) << 32n) | type);
      if (rela) i64(p + 16, addends[i]);
    }
  }
  writeTable(TABLE_OFF);
  if (secondPhysicalTable) writeTable(SECOND_TABLE_OFF);

  u32(HASH_OFF, 1); u32(HASH_OFF + 4, 2);
  b.set(new TextEncoder().encode('\0ext\0'), STRTAB_OFF);
  u32(SYMTAB_OFF + 24, 1); b[SYMTAB_OFF + 28] = 0x11; u16(SYMTAB_OFF + 30, 0);

  const tags = [
    [DT_HASH, BASE + BigInt(HASH_OFF)], [DT_STRTAB, BASE + BigInt(STRTAB_OFF)], [DT_STRSZ, 5n],
    [DT_SYMTAB, BASE + BigInt(SYMTAB_OFF)], [DT_SYMENT, 24n],
  ];
  if (rela) tags.push([DT_RELA, BASE + BigInt(TABLE_OFF)], [DT_RELASZ, BigInt(records * stride)], [DT_RELAENT, BigInt(stride)]);
  else tags.push([DT_REL, BASE + BigInt(TABLE_OFF)], [DT_RELSZ, BigInt(records * stride)], [DT_RELENT, BigInt(stride)]);
  if (aliasJmprel) tags.push([DT_JMPREL, BASE + BigInt(TABLE_OFF)], [DT_PLTRELSZ, BigInt(records * stride)], [DT_PLTREL, rela ? DT_RELA : DT_REL]);
  if (secondPhysicalTable) tags.push([DT_JMPREL, BASE + BigInt(SECOND_TABLE_OFF)], [DT_PLTRELSZ, BigInt(records * stride)], [DT_PLTREL, rela ? DT_RELA : DT_REL]);
  tags.push([DT_NULL, 0n]);

  for (let i = 0; i < tags.length; i++) { const p = DYNAMIC_OFF + i * 16; i64(p, tags[i][0]); u64(p + 8, tags[i][1]); }
  ph(1, 2, 6, DYNAMIC_OFF, BASE + BigInt(DYNAMIC_OFF), tags.length * 16, tags.length * 16);
  return b;
}

function dynamicRelocs(image) { return image.relocations.filter((r) => String(r.source || '').startsWith('PT_DYNAMIC-')); }

{
  const rels = dynamicRelocs(parseELF(buildFixture({ rela: true, addends: [5n, 9n] })));
  assert.equal(rels.length, 2); assert.deepEqual(rels.map((r) => r.addend), [5n, 9n]);
  assert.deepEqual(rels.map((r) => r.recordIndex), [0, 1]); assert.deepEqual(rels.map((r) => r.recordFileOffset), [0x200n, 0x218n]);
}
{
  const rels = dynamicRelocs(parseELF(buildFixture({ rela: true, addends: [7n, 7n] })));
  assert.equal(rels.length, 2); assert.deepEqual(rels.map((r) => r.recordFileOffset), [0x200n, 0x218n]);
}
{
  const rels = dynamicRelocs(parseELF(buildFixture({ rela: false, addends: [0n, 0n] })));
  assert.equal(rels.length, 2); assert.deepEqual(rels.map((r) => r.recordFileOffset), [0x200n, 0x210n]);
}
{
  const rels = dynamicRelocs(parseELF(buildFixture({ rela: true, addends: [1n, 2n], aliasJmprel: true })));
  assert.equal(rels.length, 2); assert.deepEqual(rels.map((r) => r.addend), [1n, 2n]);
}
{
  const rels = dynamicRelocs(parseELF(buildFixture({ rela: true, addends: [3n, 4n], secondPhysicalTable: true })));
  assert.equal(rels.length, 4); assert.deepEqual(rels.map((r) => r.recordFileOffset), [0x200n, 0x218n, 0x280n, 0x298n]);
}
{
  const rels = dynamicRelocs(parseELF(buildFixture({ rela: true, addends: [0n, 0n], types: [8, 6] })));
  assert.equal(rels.length, 2); assert.deepEqual(rels.map((r) => r.type), [8, 6]);
}
{
  const image = parseELF(buildFixture({ rela: true, addends: [0n, 0n], types: [6, 6], symbolIndex: 1 }));
  const ext = image.imports.find((i) => i.name === 'ext');
  assert.ok(ext); assert.equal(ext.sites.length, 2); assert.deepEqual(ext.sites.map((s) => s.recordFileOffset), [0x200n, 0x218n]);
}

console.log('issue #4276 ELF dynamic relocation physical-record identity regressions: PASS');
