/**
 * #5562 — e_shstrndx referential integrity.
 *
 * An out-of-range normal index, or SHN_XINDEX whose section-0 sh_link does not
 * resolve inside the table, is a broken reference — not "this ELF has no
 * section names" (SHN_UNDEF). It must be recorded as partial metadata
 * (elfMetadata.complete === false + a section-names reason) instead of
 * silently dropping every section name.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseELF } from '../../../js/binary/elf.js';

const SHN_XINDEX = 0xffff;

function buildELF({ shstrndx, sec0Link = 0, shstrType = 3 } = {}) {
  const shstrtab = new TextEncoder().encode('\0.shstrtab\0');
  const shoff = 0x80;
  const bytes = new Uint8Array(0x400);
  const b = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  b.setUint16(16, 2, true);            // ET_EXEC
  b.setUint16(18, 62, true);           // x86_64
  b.setUint32(20, 1, true);
  b.setBigUint64(32, 0x40n, true);     // e_phoff
  b.setBigUint64(40, BigInt(shoff), true);
  b.setUint16(52, 64, true);
  b.setUint16(54, 56, true);
  b.setUint16(56, 0, true);            // e_phnum = 0
  b.setUint16(58, 64, true);
  b.setUint16(60, 2, true);            // e_shnum = 2
  b.setUint16(62, shstrndx, true);

  const sh = (i, name, type, { link = 0, offset = 0, size = 0 } = {}) => {
    const p = shoff + i * 64;
    b.setUint32(p, name, true);
    b.setUint32(p + 4, type, true);
    b.setBigUint64(p + 24, BigInt(offset), true);
    b.setBigUint64(p + 32, BigInt(size), true);
    b.setUint32(p + 40, link, true);
  };
  sh(0, 0, 0, { link: sec0Link });
  sh(1, 1, shstrType, { offset: 0x70, size: shstrtab.length }); // .shstrtab (SHT_STRTAB unless overridden)
  bytes.set(shstrtab, 0x70);
  return bytes;
}

function summarize(bytes) {
  const image = parseELF(bytes);
  return {
    names: image.sections.map((s) => s.name),
    warnings: image.warnings,
    complete: image.metadata.elfMetadata?.complete ?? null,
    reasons: image.metadata.elfMetadata?.reasons ?? [],
  };
}

test('#5562: SHN_UNDEF keeps the no-section-name-table policy and stays complete', () => {
  const r = summarize(buildELF({ shstrndx: 0 }));
  assert.deepEqual(r.reasons, []);
  assert.equal(r.complete, true);
  assert.deepEqual(r.names, ['section_0', 'section_1']);
});

test('#5562: a valid normal index decodes section names and stays complete', () => {
  const r = summarize(buildELF({ shstrndx: 1 }));
  assert.deepEqual(r.names, ['section_0', '.shstrtab']);
  assert.equal(r.complete, true);
  assert.deepEqual(r.reasons, []);
});

test('#5562: a normal index at the section count is a broken reference, not silence', () => {
  const r = summarize(buildELF({ shstrndx: 2 }));
  assert.equal(r.complete, false);
  assert.ok(r.reasons.includes('section-names:shstrndx-invalid'));
  assert.ok(r.warnings.some((w) => w.includes('e_shstrndx 2')));
});

test('#5562: a normal index beyond the section count is a broken reference', () => {
  const r = summarize(buildELF({ shstrndx: 5 }));
  assert.equal(r.complete, false);
  assert.ok(r.reasons.includes('section-names:shstrndx-invalid'));
});

test('#5562: SHN_XINDEX with a valid section-0 sh_link decodes section names', () => {
  const r = summarize(buildELF({ shstrndx: SHN_XINDEX, sec0Link: 1 }));
  assert.deepEqual(r.names, ['section_0', '.shstrtab']);
  assert.equal(r.complete, true);
  assert.deepEqual(r.reasons, []);
});

test('#5562: SHN_XINDEX with an out-of-range sh_link is partial', () => {
  const r = summarize(buildELF({ shstrndx: SHN_XINDEX, sec0Link: 5 }));
  assert.equal(r.complete, false);
  assert.ok(r.reasons.includes('section-names:shstrndx-invalid'));
  assert.ok(r.warnings.some((w) => w.includes('SHN_XINDEX')));
});

test('#5562: SHN_XINDEX resolving to section 0 is not a valid resolution', () => {
  const r = summarize(buildELF({ shstrndx: SHN_XINDEX, sec0Link: 0 }));
  assert.equal(r.complete, false);
  assert.ok(r.reasons.includes('section-names:shstrndx-invalid'));
});

test('#5562: an in-range e_shstrndx that is not SHT_STRTAB is a diagnostic, not absence', () => {
  const r = summarize(buildELF({ shstrndx: 1, shstrType: 1 }));
  assert.equal(r.complete, false);
  assert.ok(r.reasons.includes('section-names:shstrndx-not-strtab'));
});
