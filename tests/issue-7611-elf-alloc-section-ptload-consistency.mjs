// Issue #7611 regression: for runtime ELF images (ET_EXEC/ET_DYN), a file-backed
// SHF_ALLOC section must not become virtual mapping authority when its
// sh_addr→sh_offset relation contradicts the owning PT_LOAD's VA→file mapping.
// The runtime loader (and the Linux execution oracle) executes the PT_LOAD
// bytes; a forged section header pointing the same VA at different in-file
// bytes used to silently replace the canonical runtime code.
import assert from 'node:assert/strict';
import { parseELF } from '../js/binary/elf-core.js';

// 64-bit LE x86-64 ET_EXEC builder.
// loads: [{ offset, vaddr, filesz, memsz, flags }]
// sections: [{ type, flags, addr, offset, size, align }] (entry #0 NULL implied)
function buildELF({ loads, sections, exitA = 11, exitB = 22 }) {
  const size = 0x4000;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  const w8 = (o, v) => { buf[o] = v; };
  const w16 = (o, v) => dv.setUint16(o, v, true);
  const w32 = (o, v) => dv.setUint32(o, v >>> 0, true);
  const w64 = (o, v) => dv.setBigUint64(o, BigInt(v), true);
  const exitBytes = (code) => [0xb8, 0x3c, 0, 0, 0, 0xbf, code & 0xff, 0, 0, 0, 0x0f, 0x05];
  w32(0, 0x464c457f); w8(4, 2); w8(5, 1); w8(6, 1);
  w16(0x10, 2); w16(0x12, 0x3e); w32(0x14, 1);
  w64(0x18, 0x400000n); w64(0x20, 0x40n); w64(0x28, 0x3000n);
  w32(0x30, 0); w16(0x34, 0x40); w16(0x36, 0x38); w16(0x38, loads.length);
  w16(0x3a, 0x40); w16(0x3c, sections.length + 1); w16(0x3e, 0);
  loads.forEach((p, i) => {
    const o = 0x40 + i * 0x38;
    w32(o, 1); w32(o + 4, p.flags ?? 5);
    w64(o + 8, BigInt(p.offset)); w64(o + 16, BigInt(p.vaddr)); w64(o + 24, BigInt(p.vaddr));
    w64(o + 32, BigInt(p.filesz)); w64(o + 40, BigInt(p.memsz ?? p.filesz)); w64(o + 48, BigInt(p.align ?? 0x1000));
  });
  for (const s of sections) if (s.offset != null && s.size > 0 && s.exit != null) buf.set(exitBytes(s.exit), Number(s.offset));
  buf.set(exitBytes(exitA), Number(loads[0].offset));
  sections.forEach((s, i) => {
    const o = 0x3040 + i * 0x40;
    w32(o + 0x00, 0);
    w32(o + 0x04, s.type ?? 1);
    w64(o + 0x08, BigInt(s.flags ?? 0));
    w64(o + 0x10, BigInt(s.addr ?? 0));
    w64(o + 0x18, BigInt(s.offset ?? 0));
    w64(o + 0x20, BigInt(s.size ?? 0));
    w32(o + 0x28, 0); w32(o + 0x2c, 0);
    w64(o + 0x30, BigInt(s.align ?? 0)); w64(o + 0x38, 0n);
  });
  return buf;
}

const ALLOC_EXEC = 0x3n;

// The issue's attack: same VA as the PT_LOAD, different in-file sh_offset.
// Linux executes the PT_LOAD's exit(11) bytes; Hex must canonicalize the same.
{
  const buf = buildELF({
    loads: [{ offset: 0x1000, vaddr: 0x400000, filesz: 0x1000 }],
    sections: [{ type: 1, flags: ALLOC_EXEC, addr: 0x400000, offset: 0x2000, size: 0x100, align: 16, exit: 22 }],
  });
  const image = parseELF(buf);
  assert.equal(image.addressToOffset(0x400000n), 0x1000n, 'the PT_LOAD mapping must own the runtime VA');
  const bytes = image.readVirtual(0x400000n, 12);
  assert.equal(bytes[6], 11, 'canonical runtime bytes must be the PT_LOAD exit(11) bytes');
  assert.ok(image.sections.some((s) => s.source === 'unmapped-section' && s.address === 0x400000n),
    'the inconsistent section must lose mapping authority');
  assert.ok(image.warnings.some((w) => w.includes('inconsistent with the runtime PT_LOAD mapping')),
    'the de-authorization must be reported as a warning, not silent');
}

// A consistent SHF_ALLOC .text keeps its subrange authority: the section's
// VA→offset relation agrees with the PT_LOAD, so reads through the section
// span resolve to the same file bytes.
{
  const buf = buildELF({
    loads: [{ offset: 0x1000, vaddr: 0x400000, filesz: 0x1000 }],
    sections: [{ type: 1, flags: ALLOC_EXEC, addr: 0x400000, offset: 0x1000, size: 0x100, align: 16, exit: 11 }],
  });
  const image = parseELF(buf);
  assert.equal(image.addressToOffset(0x400000n), 0x1000n);
  assert.equal(image.readVirtual(0x400000n, 12)[6], 11);
  assert.ok(image.sections.some((s) => s.source === 'section-header' && s.address === 0x400000n),
    'a PT_LOAD-consistent section keeps mapping authority');
}

// A partial-range section that agrees with the PT_LOAD stays authoritative on
// its own range; a section that agrees on its first byte but diverges inside
// the range must be rejected.
{
  const buf = buildELF({
    loads: [
      { offset: 0x1000, vaddr: 0x400000, filesz: 0x1000 },
      // Second LOAD ends mid-way through the section's address range, so a
      // consistent single-owner check cannot hold across the whole span.
      { offset: 0x3000, vaddr: 0x401000, filesz: 0x100 },
    ],
    sections: [
      // straddles the boundary between two PT_LOADs with different VA→offset
      // relations: no single consistent mapping covers it.
      { type: 1, flags: ALLOC_EXEC, addr: 0x400800, offset: 0x1800, size: 0x1000, align: 16 },
      // fully inside LOAD0 with a consistent relation
      { type: 1, flags: ALLOC_EXEC, addr: 0x400010, offset: 0x1010, size: 0x20, align: 16 },
    ],
  });
  const image = parseELF(buf);
  assert.ok(image.sections.some((s) => s.source === 'unmapped-section' && s.address === 0x400800n),
    'a section straddling inconsistent PT_LOAD relations loses authority');
  assert.ok(image.sections.some((s) => s.source === 'section-header' && s.address === 0x400010n),
    'a section consistent inside one PT_LOAD keeps authority');
}

// #5888 keeps its coverage: an alloc section whose file span is past EOF is
// still excluded (and must not crash the consistency check).
{
  const buf = buildELF({
    loads: [{ offset: 0x1000, vaddr: 0x400000, filesz: 0x1000 }],
    sections: [{ type: 1, flags: ALLOC_EXEC, addr: 0x400000, offset: 0x8000, size: 0x100, align: 16 }],
  });
  const image = parseELF(buf);
  assert.equal(image.addressToOffset(0x400000n), 0x1000n);
  assert.ok(image.sections.some((s) => s.source === 'unmapped-section' && s.address === 0x400000n));
}

// Non-ALLOC sections stay excluded from mapping authority (#3737/#4297).
{
  const buf = buildELF({
    loads: [{ offset: 0x1000, vaddr: 0x400000, filesz: 0x1000 }],
    sections: [{ type: 1, flags: 0x6n, addr: 0x400000, offset: 0x2000, size: 0x100, align: 16 }],
  });
  const image = parseELF(buf);
  assert.equal(image.addressToOffset(0x400000n), 0x1000n);
  const sec = image.sections.find((s) => s.address === 0x400000n);
  assert.ok(sec, 'the non-alloc section is still listed');
  assert.equal(image.readVirtual(0x400000n, 12)[6], 11);
}

// ET_REL synthetic-section mapping is a separate contract: no program headers,
// section addresses assigned relative to the file — no PT_LOAD consistency
// requirement, no regression.
{
  const size = 0x2000;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  const w16 = (o, v) => dv.setUint16(o, v, true);
  const w32 = (o, v) => dv.setUint32(o, v >>> 0, true);
  const w64 = (o, v) => dv.setBigUint64(o, BigInt(v), true);
  w32(0, 0x464c457f); buf[4] = 2; buf[5] = 1; buf[6] = 1;
  w16(0x10, 1); w16(0x12, 0x3e); w32(0x14, 1);
  w64(0x20, 0x40n); w64(0x28, 0x300n);
  w16(0x34, 0x40); w16(0x36, 0x38); w16(0x38, 0);
  w16(0x3a, 0x40); w16(0x3c, 1); w16(0x3e, 0);
  // one SHF_ALLOC PROGBITS section at synthetic addr 0
  w32(0x300 + 0x00, 0); w32(0x300 + 0x04, 1);
  w64(0x300 + 0x08, 0x3n); w64(0x300 + 0x10, 0n);
  w64(0x300 + 0x18, 0x1000n); w64(0x300 + 0x20, 0x20n);
  const image = parseELF(buf);
  assert.equal(image.sections.length, 1);
  assert.equal(image.sections[0].source, 'ET_REL-synthetic-section');
}

console.log('issue #7611 ELF alloc-section PT_LOAD consistency regressions: PASS');
