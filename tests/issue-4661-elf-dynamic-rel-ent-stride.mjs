import assert from 'node:assert/strict';
import { parseELF } from '../js/binary/elf.js';

// Issue #4661: DT_RELENT / DT_RELAENT larger than the standard Elf*_Rel /
// Elf*_Rela entry was accepted as a stride authority, so a malformed ELF could
// walk a dynamic relocation table across real record boundaries.

const BASE = 0x400000n;
const TABLE = 0x200, HASHOFF = 0x260, SYMOFF = 0x280, STROFF = 0x2c0;
const DT_NULL = 0n, DT_PLTRELSZ = 2n, DT_HASH = 4n, DT_STRTAB = 5n, DT_SYMTAB = 6n;
const DT_RELA = 7n, DT_RELASZ = 8n, DT_RELAENT = 9n, DT_STRSZ = 10n, DT_SYMENT = 11n;
const DT_REL = 17n, DT_RELSZ = 18n, DT_RELENT = 19n, DT_PLTREL = 20n, DT_JMPREL = 23n;
const R_RELATIVE = 8;
const RECORDS = 3;

function layout(bits) {
  return {
    ehsize: bits === 64 ? 64 : 52,
    phentsize: bits === 64 ? 56 : 32,
    dynEnt: bits === 64 ? 16 : 8,
    symEnt: bits === 64 ? 24 : 16,
  };
}

function relEnt(bits, rela) {
  return bits === 64 ? (rela ? 24 : 16) : (rela ? 12 : 8);
}

function buildFixture({ bits, rela, ent, via = 'dyn' }) {
  const L = layout(bits);
  const stride = relEnt(bits, rela);
  const size = 0x500;
  const buf = new Uint8Array(size);
  const v = new DataView(buf.buffer);
  const b8 = (p, x) => v.setUint8(p, x);

  buf.set([0x7f, 0x45, 0x4c, 0x46, bits === 64 ? 2 : 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0);
  v.setUint16(16, 3, true);
  v.setUint16(18, bits === 64 ? 62 : 3, true);
  v.setUint32(20, 1, true);
  const addr = (p, x) => (bits === 64 ? v.setBigUint64(p, BigInt(x), true) : v.setUint32(p, Number(x), true));
  const addend = (p, x) => (bits === 64 ? v.setBigInt64(p, BigInt(x), true) : v.setInt32(p, Number(x), true));
  if (bits === 64) {
    v.setBigUint64(24, 0n, true);
    v.setBigUint64(32, BigInt(L.ehsize), true);
    v.setBigUint64(40, 0n, true);
    v.setUint32(48, 0, true);
    v.setUint16(52, L.ehsize, true);
    v.setUint16(54, L.phentsize, true);
    v.setUint16(56, 2, true);
    v.setUint16(58, 64, true);
    v.setUint16(60, 0, true);
    v.setUint16(62, 0, true);
  } else {
    v.setUint32(24, 0, true);
    v.setUint32(28, L.ehsize, true);
    v.setUint32(32, 0, true);
    v.setUint32(36, 0, true);
    v.setUint16(40, L.ehsize, true);
    v.setUint16(42, L.phentsize, true);
    v.setUint16(44, 2, true);
    v.setUint16(46, 40, true);
    v.setUint16(48, 0, true);
    v.setUint16(50, 0, true);
  }

  const ph = (i, type, off, va, filesz, memsz, flags) => {
    const p = L.ehsize + i * L.phentsize;
    if (bits === 64) {
      v.setUint32(p, type, true);
      v.setUint32(p + 4, flags, true);
      addr(p + 8, off); addr(p + 16, va); addr(p + 24, va);
      addr(p + 32, filesz); addr(p + 40, memsz); addr(p + 48, 0x1000);
    } else {
      v.setUint32(p, type, true);
      addr(p + 4, off); addr(p + 8, va); addr(p + 12, va);
      addr(p + 16, filesz); addr(p + 20, memsz);
      addr(p + 24, flags); addr(p + 28, 0x1000);
    }
  };
  ph(0, 1, 0, BASE, size, size, 6);

  const dynstr = new TextEncoder().encode('\0ext\0libc.so.6\0');
  buf.set(dynstr, STROFF);
  v.setUint32(HASHOFF, 1, true);
  v.setUint32(HASHOFF + 4, 2, true);

  const sym = (p, name, info, shndx, value) => {
    v.setUint32(p, name, true);
    b8(p + (bits === 64 ? 4 : 12), info);
    b8(p + (bits === 64 ? 5 : 13), 0);
    v.setUint16(p + (bits === 64 ? 6 : 14), shndx, true);
    addr(p + (bits === 64 ? 8 : 4), value);
    addr(p + (bits === 64 ? 16 : 8), 0);
  };
  sym(SYMOFF, 0, 0, 0, 0);
  sym(SYMOFF + L.symEnt, 1, 0x11, 0, 0);

  for (let i = 0; i < RECORDS; i++) {
    const p = TABLE + i * stride;
    addr(p, BASE + 0x40n + BigInt(i * 8));
    if (bits === 64) v.setBigUint64(p + 8, BigInt(R_RELATIVE), true);
    else v.setUint32(p + 4, R_RELATIVE, true);
    if (rela) addend(p + (bits === 64 ? 16 : 8), 0xa0 + i * 0x10);
  }

  const tags = [
    [DT_HASH, BigInt(HASHOFF) + BASE],
    [DT_STRTAB, BigInt(STROFF) + BASE],
    [DT_STRSZ, BigInt(dynstr.length)],
    [DT_SYMTAB, BigInt(SYMOFF) + BASE],
    [DT_SYMENT, BigInt(L.symEnt)],
  ];
  if (via === 'jmprel') {
    tags.push([DT_JMPREL, BigInt(TABLE) + BASE], [DT_PLTRELSZ, BigInt(stride * RECORDS)], [DT_PLTREL, rela ? DT_RELA : DT_REL]);
  } else {
    tags.push([rela ? DT_RELA : DT_REL, BigInt(TABLE) + BASE], [rela ? DT_RELASZ : DT_RELSZ, BigInt(stride * RECORDS)]);
  }
  if (ent !== undefined) tags.push([rela ? DT_RELAENT : DT_RELENT, BigInt(ent)]);
  tags.push([DT_NULL, 0n]);

  tags.forEach(([tag, value], i) => {
    const p = 0x100 + i * L.dynEnt;
    if (bits === 64) {
      v.setBigInt64(p, tag, true);
      v.setBigUint64(p + 8, BigInt(value), true);
    } else {
      v.setInt32(p, Number(tag), true);
      v.setUint32(p + 4, Number(value), true);
    }
  });
  ph(1, 2, 0x100, BASE + 0x100n, tags.length * L.dynEnt, tags.length * L.dynEnt, 6);
  return buf;
}

function publishedFrom(image, source) {
  return image.relocations.filter((rel) => rel.source === source);
}

function assertFailClosed(image, source, label) {
  assert.equal(publishedFrom(image, source).length, 0, `${label}: rejected ${source} stride must publish no relocations`);
  assert.equal(image.metadata.programDynamicPartial, true, `${label}: ${source} stride mismatch must be fail-closed/partial`);
  assert.ok(
    (image.metadata.programDynamicDiagnostics || []).some((d) => d.startsWith(`${source} entry size`)),
    `${label}: expected a ${source} entry-size diagnostic, got ${JSON.stringify(image.metadata.programDynamicDiagnostics || [])}`,
  );
}

// 1. Exact standard strides keep decoding every record (positive control).
for (const bits of [64, 32]) {
  for (const rela of [true, false]) {
    const tag = rela ? 'RELA' : 'REL';
    const image = parseELF(buildFixture({ bits, rela, ent: relEnt(bits, rela) }));
    const rels = publishedFrom(image, `PT_DYNAMIC-${tag}`);
    assert.equal(rels.length, RECORDS, `ELF${bits} ${tag} exact stride ${relEnt(bits, rela)} must decode all ${RECORDS} records`);
    assert.deepEqual(rels.map((r) => r.address), [BASE + 0x40n, BASE + 0x48n, BASE + 0x50n]);
    assert.equal(image.metadata.programDynamicPartial, undefined, `ELF${bits} ${tag} exact stride must not be partial`);
  }
}

// 2. A missing DT_RELENT/DT_RELAENT keeps using the standard class stride.
for (const bits of [64, 32]) {
  for (const rela of [true, false]) {
    const tag = rela ? 'RELA' : 'REL';
    const image = parseELF(buildFixture({ bits, rela, ent: undefined }));
    assert.equal(publishedFrom(image, `PT_DYNAMIC-${tag}`).length, RECORDS,
      `ELF${bits} ${tag} without an explicit ent stays on the standard stride`);
    assert.equal(image.metadata.programDynamicPartial, undefined);
  }
}

// 3. Oversized strides are rejected fail-closed for every class/kind pair.
for (const { bits, rela, ent } of [
  { bits: 64, rela: true, ent: 32 },
  { bits: 64, rela: false, ent: 24 },
  { bits: 32, rela: true, ent: 16 },
  { bits: 32, rela: false, ent: 12 },
]) {
  const image = parseELF(buildFixture({ bits, rela, ent }));
  assertFailClosed(image, `PT_DYNAMIC-${rela ? 'RELA' : 'REL'}`, `ELF${bits} ent=${ent}`);
}

// 4. The same oversized authority must not survive into the JMPREL walk.
for (const { bits, rela, ent } of [
  { bits: 64, rela: true, ent: 32 },
  { bits: 32, rela: false, ent: 12 },
]) {
  const image = parseELF(buildFixture({ bits, rela, ent, via: 'jmprel' }));
  assertFailClosed(image, `PT_DYNAMIC-JMPREL-${rela ? 'RELA' : 'REL'}`, `ELF${bits} JMPREL ent=${ent}`);
}

// 5. Undersized strides stay rejected (the pre-existing guard must not weaken).
for (const { bits, rela, ent } of [
  { bits: 64, rela: true, ent: 8 },
  { bits: 64, rela: false, ent: 4 },
  { bits: 32, rela: true, ent: 8 },
  { bits: 32, rela: false, ent: 4 },
]) {
  const image = parseELF(buildFixture({ bits, rela, ent }));
  assertFailClosed(image, `PT_DYNAMIC-${rela ? 'RELA' : 'REL'}`, `ELF${bits} ent=${ent}`);
}

console.log('issue #4661 ELF DT_RELENT/DT_RELAENT exact-stride fail-closed regressions: PASS');
