import assert from 'node:assert/strict';
import { openBinary } from '../js/binary/index.js';
import { resolveDynamicSectionIndex } from '../js/binary/elf-dynamic.js';

// Issue #4197: when a section header table is present, resolveDynamicSectionIndex
// must not promote an st_shndx / DT_SYMTAB_SHNDX value that is inside the
// reserved-range bound (< SHN_LORESERVE) but outside the ACTUAL section table to
// a known/defined section identity. Special indexes (UNDEF/ABS/COMMON) stay
// known; the sectionless policy (no table) stays unchanged; the #3630 tri-state
// contract (unknown !== undefined) is preserved.

const companion = new Uint8Array(96);
companion[0] = 0x01;
companion[4] = 0x64;
const reader = { length: companion.length, u32: (offset) => new DataView(companion.buffer).getUint32(offset, true) };
const tags = new Map([[34n, [0x1000n]]]);

const sectionedImage = {
  segments: [{ address: 0x1000n, size: 96n, fileOffset: 0n, fileSize: 96n, perms: {} }],
  sections: [{ index: 0 }, { index: 1 }],
  warnings: [],
  metadata: { machine: 62 },
};
const sectionlessImage = { ...sectionedImage, sections: [] };

// 1. Valid normal st_shndx against an existing section table stays known/defined.
assert.deepEqual(resolveDynamicSectionIndex(reader, sectionedImage, tags, 1, 1), { known: true, index: 1, source: 'st_shndx' });

// 2. Out-of-range normal st_shndx (== e_shnum / beyond) is unknown when the table exists.
const outOfRange = resolveDynamicSectionIndex(reader, sectionedImage, tags, 1, 100);
assert.equal(outOfRange.known, false, 'section-backed out-of-range st_shndx must be unknown');
assert.equal(outOfRange.index, null);
assert.equal(outOfRange.source, 'st_shndx');
assert.equal(outOfRange.reason, 'out-of-range-section-index-100');

// 2b. A reserved-range index equal to the section count is still out of range.
assert.equal(resolveDynamicSectionIndex(reader, sectionedImage, tags, 1, 2).known, false);

// 3. SHN_XINDEX companion value out of the real table is unknown too.
const extendedOutOfRange = resolveDynamicSectionIndex(reader, sectionedImage, tags, 1, 0xffff);
assert.equal(extendedOutOfRange.known, false, 'section-backed DT_SYMTAB_SHNDX out-of-range value must be unknown');
assert.equal(extendedOutOfRange.index, null);
assert.equal(extendedOutOfRange.source, 'DT_SYMTAB_SHNDX');
assert.equal(extendedOutOfRange.reason, 'out-of-range-section-index-100');

// 3b. An in-range companion value stays known.
assert.deepEqual(resolveDynamicSectionIndex(reader, sectionedImage, tags, 0, 0xffff), { known: true, index: 1, source: 'DT_SYMTAB_SHNDX' });

// 4. Special indexes keep their existing known status even with a section table.
assert.deepEqual(resolveDynamicSectionIndex(reader, sectionedImage, tags, 1, 0), { known: true, index: 0, source: 'st_shndx' });
assert.deepEqual(resolveDynamicSectionIndex(reader, sectionedImage, tags, 1, 0xfff1), { known: true, index: 0xfff1, source: 'st_shndx' });
assert.deepEqual(resolveDynamicSectionIndex(reader, sectionedImage, tags, 1, 0xfff2), { known: true, index: 0xfff2, source: 'st_shndx' });

// 5. Sectionless ELF policy is unchanged: reserved-range normal indexes stay known.
assert.deepEqual(resolveDynamicSectionIndex(reader, sectionlessImage, tags, 1, 100), { known: true, index: 100, source: 'st_shndx' });
assert.deepEqual(resolveDynamicSectionIndex(reader, sectionlessImage, tags, 1, 0xffff), { known: true, index: 100, source: 'DT_SYMTAB_SHNDX' });

// 6. The #3630 tri-state contract: unknown never equals a defined (false) answer.
assert.notEqual(outOfRange.known, undefined);

// 7. End to end: a real section header table must bound the PT_DYNAMIC path so
// an out-of-range st_shndx cannot be laundered into a defined export.
{
  const bytes = new Uint8Array(0x600);
  const view = new DataView(bytes.buffer);
  const w16 = (o, x) => view.setUint16(o, x, true);
  const w32 = (o, x) => view.setUint32(o, x, true);
  const w64 = (o, x) => view.setBigUint64(o, BigInt(x), true);
  const wi64 = (o, x) => view.setBigInt64(o, BigInt(x), true);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0], 0);
  w16(16, 3); w16(18, 62); w32(20, 1); w64(24, 0x400180n); w64(32, 64n); w64(40, 0x380n);
  w32(48, 0); w16(52, 64); w16(54, 56); w16(56, 2); w16(58, 64); w16(60, 2); w16(62, 0);
  w32(64, 1); w32(68, 7); w64(72, 0n); w64(80, 0x400000n); w64(88, 0x400000n); w64(96, 0x600n); w64(104, 0x600n); w64(112, 0x1000n);
  const dyn = 0x300;
  w32(64 + 56, 2); w32(64 + 60, 6); w64(64 + 64, dyn); w64(64 + 72, 0x400000n + BigInt(dyn)); w64(64 + 80, 0x400000n + BigInt(dyn)); w64(64 + 88, 5 * 16); w64(64 + 96, 5 * 16); w64(64 + 104, 8n);
  bytes.fill(0x90, 0x100, 0x110); bytes[0x10f] = 0xc3;
  bytes.set(new TextEncoder().encode('\0puts\0fake\0good\0abs\0xidx\0'), 0x290);
  const sym = (p, name, info, shndx, value, size) => { w32(p, name); bytes[p + 4] = info; bytes[p + 5] = 0; w16(p + 6, shndx); w64(p + 8, value); w64(p + 16, size); };
  sym(0x200, 0, 0, 0, 0, 0);
  sym(0x218, 6, 0x11, 100, 0x400180n, 0);
  sym(0x230, 11, 0x12, 1, 0x400180n, 0x10);
  sym(0x248, 16, 0x11, 0xfff1, 0x400180n, 0);
  sym(0x260, 20, 0x11, 0xffff, 0x400180n, 0);
  sym(0x278, 0, 0, 0, 0, 0);
  for (const [p, x] of [[0x1b0, 1], [0x1b4, 0], [0x1b8, 1], [0x1bc, 0], [0x1c0, 100], [0x1c4, 0]]) w32(p, x);
  const d = (i, tag, value) => { wi64(dyn + i * 16, tag); w64(dyn + i * 16 + 8, value); };
  d(0, 5n, 0x400290n); d(1, 10n, 25n); d(2, 6n, 0x400200n); d(3, 11n, 24n); d(4, 34n, 0x4001b0n);
  const image = openBinary(bytes);
  assert.equal(image.sections.length, 2, 'fixture has a section header table');
  const byName = new Map(image.symbols.filter((s) => s.source === 'PT_DYNAMIC').map((s) => [s.name, s]));
  const fake = byName.get('fake');
  assert.equal(fake.defined, null, 'out-of-range st_shndx must stay tri-state unknown');
  assert.equal(fake.sectionIndex, null, 'out-of-range st_shndx must not publish a section identity');
  assert.ok(!image.exports.some((e) => e.name === 'fake' && e.source === 'PT_DYNAMIC'), 'fake section must not be laundered into an export');
  assert.ok(!image.imports.some((e) => e.name === 'fake' && e.source === 'PT_DYNAMIC'), 'tri-state unknown must not become an import (#3630)');
  const xidx = byName.get('xidx');
  assert.equal(xidx.defined, null, 'out-of-range DT_SYMTAB_SHNDX companion value must stay unknown');
  assert.ok(!image.exports.some((e) => e.name === 'xidx' && e.source === 'PT_DYNAMIC'), 'out-of-range companion value must not export');
  assert.equal(byName.get('good').defined, true, 'valid in-table st_shndx keeps defined truth');
  assert.ok(image.exports.some((e) => e.name === 'good' && e.source === 'PT_DYNAMIC'), 'valid exports stay published');
  assert.equal(byName.get('abs').defined, true, 'SHN_ABS stays known even with a section table');
  assert.ok(image.metadata.programDynamicPartial === true, 'unresolved identities must be partial');
  const diagnostics = image.metadata.programDynamicDiagnostics || [];
  assert.ok(diagnostics.some((m) => m.includes('out-of-range-section-index-100')), `expected out-of-range diagnostics, got ${JSON.stringify(diagnostics)}`);
}

console.log('issue-4197-pt-dynamic-section-index-bounds: PASS');
