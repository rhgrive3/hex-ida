import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSampleBinary } from '../../../js/sample.js';
import { parseMachO } from '../../../js/binary/macho.js';
import { analysisFromBinaryImage } from '../../../js/platform/analysis-result.js';
import { MemoryByteSource } from '../../../js/binary/source.js';
import { openBinarySource } from '../../../js/binary/source-loaders.js';

const LC_SEGMENT = 0x1;
const LC_SYMTAB = 0x2;
const LC_DYSYMTAB = 0xb;
const LC_SEGMENT_64 = 0x19;
const INDIRECT_SYMBOL_LOCAL = 0x80000000;
const INDIRECT_SYMBOL_ABS = 0x40000000;

function cstr(bytes, offset, length = 16) {
  let end = offset;
  const limit = Math.min(bytes.length, offset + length);
  while (end < limit && bytes[end] !== 0) end++;
  return Buffer.from(bytes.subarray(offset, end)).toString('ascii');
}

function commands64(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ncmds = v.getUint32(16, true);
  const out = [];
  let p = 32;
  for (let i = 0; i < ncmds; i++) {
    const cmd = v.getUint32(p, true);
    const size = v.getUint32(p + 4, true);
    out.push({ cmd, offset: p, size });
    p += size;
  }
  return out;
}

function sampleLayout(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const commands = commands64(bytes);
  const sections = new Map();
  for (const command of commands) {
    if (command.cmd !== LC_SEGMENT_64) continue;
    const nsects = v.getUint32(command.offset + 64, true);
    let q = command.offset + 72;
    for (let i = 0; i < nsects; i++, q += 80) {
      sections.set(cstr(bytes, q), { offset: q });
    }
  }
  const dysymtab = commands.find((c) => c.cmd === LC_DYSYMTAB);
  const symtab = commands.find((c) => c.cmd === LC_SYMTAB);
  assert.ok(dysymtab, 'sample must contain LC_DYSYMTAB');
  assert.ok(symtab, 'sample must contain LC_SYMTAB');
  return {
    v,
    sections,
    dysymtab,
    symtab,
    indirectOffset: v.getUint32(dysymtab.offset + 56, true),
    indirectCount: v.getUint32(dysymtab.offset + 60, true),
  };
}

function putsSites(image) {
  const imp = image.imports.find((entry) => entry.name === '_puts');
  return imp?.sites ?? [];
}

function siteKinds(image) {
  return putsSites(image).map((site) => site.kind).sort();
}

function buildMacho32IndirectFixture() {
  const bytes = new Uint8Array(0x300);
  const v = new DataView(bytes.buffer);
  const u8 = (o, x) => v.setUint8(o, x);
  const u16 = (o, x) => v.setUint16(o, x, true);
  const u32 = (o, x) => v.setUint32(o, x >>> 0, true);
  const i32 = (o, x) => v.setInt32(o, x, true);
  const put = (o, text) => bytes.set(Buffer.from(text), o);

  const sectionOffset = 0x180;
  const symoff = 0x200;
  const indirectsymoff = 0x20c;
  const stroff = 0x210;

  u32(0, 0xfeedface); // MH_MAGIC
  i32(4, 7); // CPU_TYPE_I386
  i32(8, 3);
  u32(12, 6); // MH_DYLIB
  u32(16, 3);
  u32(20, 124 + 24 + 80);
  u32(24, 0);

  let p = 28;
  u32(p, LC_SEGMENT);
  u32(p + 4, 124);
  put(p + 8, '__DATA');
  u32(p + 24, 0x1000);
  u32(p + 28, 0x1000);
  u32(p + 32, 0);
  u32(p + 36, bytes.length);
  i32(p + 40, 3);
  i32(p + 44, 3);
  u32(p + 48, 1);
  u32(p + 52, 0);

  const q = p + 56;
  put(q, '__got');
  put(q + 16, '__DATA');
  u32(q + 32, 0x1180);
  u32(q + 36, 4); // exactly one 32-bit pointer entry
  u32(q + 40, sectionOffset);
  u32(q + 44, 2);
  u32(q + 48, 0);
  u32(q + 52, 0);
  u32(q + 56, 0x6); // S_NON_LAZY_SYMBOL_POINTERS
  u32(q + 60, 0); // reserved1: first indirect entry
  u32(q + 64, 0x12345678); // reserved2 retained verbatim for 32-bit section
  p += 124;

  u32(p, LC_SYMTAB);
  u32(p + 4, 24);
  u32(p + 8, symoff);
  u32(p + 12, 1);
  u32(p + 16, stroff);
  u32(p + 20, 7);
  p += 24;

  u32(p, LC_DYSYMTAB);
  u32(p + 4, 80);
  u32(p + 56, indirectsymoff);
  u32(p + 60, 1);

  // nlist: undefined external _puts
  u32(symoff, 1);
  u8(symoff + 4, 0x01); // N_UNDF | N_EXT
  u8(symoff + 5, 0);
  u16(symoff + 6, 0);
  u32(symoff + 8, 0);
  u32(indirectsymoff, 0);
  bytes.set([0, 0x5f, 0x70, 0x75, 0x74, 0x73, 0], stroff);
  return bytes;
}

function buildMacho64ClassicBindDedupFixture() {
  const bytes = new Uint8Array(0x600);
  const v = new DataView(bytes.buffer);
  const u8 = (o, x) => v.setUint8(o, x);
  const u16 = (o, x) => v.setUint16(o, x, true);
  const u32 = (o, x) => v.setUint32(o, x >>> 0, true);
  const i32 = (o, x) => v.setInt32(o, x, true);
  const u64 = (o, x) => v.setBigUint64(o, BigInt(x), true);
  const put = (o, text) => bytes.set(Buffer.from(text), o);
  const dylib = '/usr/lib/libSystem.B.dylib';
  const bind = Uint8Array.from([
    0x11, // SET_DYLIB_ORDINAL_IMM(1)
    0x40, ...Buffer.from('_puts'), 0x00, // SET_SYMBOL_TRAILING_FLAGS_IMM
    0x51, // SET_TYPE_IMM(pointer)
    0x71, 0x00, // SET_SEGMENT_AND_OFFSET_ULEB(segment 1, offset 0)
    0x90, // DO_BIND
    0x00, // DONE
  ]);
  const bindOff = 0x500;
  const symoff = 0x520;
  const indirectsymoff = 0x530;
  const stroff = 0x540;
  const dylibCmdSize = 56;
  const sizeofcmds = 72 + 152 + 24 + 80 + 48 + dylibCmdSize;

  u32(0, 0xfeedfacf);
  i32(4, 0x0100000c); // ARM64
  i32(8, 0);
  u32(12, 2); // MH_EXECUTE
  u32(16, 6);
  u32(20, sizeofcmds);
  u32(24, 0);
  u32(28, 0);

  let p = 32;
  // __TEXT segment, no sections.
  u32(p, LC_SEGMENT_64); u32(p + 4, 72); put(p + 8, '__TEXT');
  u64(p + 24, 0x1000n); u64(p + 32, 0x1000n); u64(p + 40, 0n); u64(p + 48, 0x400n);
  i32(p + 56, 5); i32(p + 60, 5); u32(p + 64, 0); u32(p + 68, 0);
  p += 72;

  // __DATA,__got, exactly one 64-bit pointer slot.
  u32(p, LC_SEGMENT_64); u32(p + 4, 152); put(p + 8, '__DATA');
  u64(p + 24, 0x2000n); u64(p + 32, 0x1000n); u64(p + 40, 0x400n); u64(p + 48, 0x100n);
  i32(p + 56, 3); i32(p + 60, 3); u32(p + 64, 1); u32(p + 68, 0);
  let q = p + 72;
  put(q, '__got'); put(q + 16, '__DATA'); u64(q + 32, 0x2000n); u64(q + 40, 8n);
  u32(q + 48, 0x400); u32(q + 52, 3); u32(q + 56, 0); u32(q + 60, 0);
  u32(q + 64, 0x6); u32(q + 68, 0); u32(q + 72, 0); u32(q + 76, 0);
  p += 152;

  u32(p, LC_SYMTAB); u32(p + 4, 24); u32(p + 8, symoff); u32(p + 12, 1); u32(p + 16, stroff); u32(p + 20, 7);
  p += 24;
  u32(p, LC_DYSYMTAB); u32(p + 4, 80); u32(p + 56, indirectsymoff); u32(p + 60, 1);
  p += 80;
  u32(p, 0x22); u32(p + 4, 48); // LC_DYLD_INFO
  u32(p + 16, bindOff); u32(p + 20, bind.length);
  p += 48;
  u32(p, 0xc); u32(p + 4, dylibCmdSize); u32(p + 8, 24); u32(p + 12, 0); u32(p + 16, 0); u32(p + 20, 0); put(p + 24, dylib);

  bytes.set(bind, bindOff);
  u32(symoff, 1); u8(symoff + 4, 0x01); u8(symoff + 5, 0); u16(symoff + 6, 0x0100); u64(symoff + 8, 0n);
  u32(indirectsymoff, 0);
  bytes.set([0, 0x5f, 0x70, 0x75, 0x74, 0x73, 0], stroff);
  return bytes;
}

test('valid LC_DYSYMTAB attaches classic __stubs and __got import sites and preserves reserved fields', () => {
  const bytes = buildSampleBinary();
  const image = parseMachO(bytes);
  const stubs = image.sections.find((s) => s.name === '__stubs');
  const got = image.sections.find((s) => s.name === '__got');

  assert.equal(stubs.reserved1, 0);
  assert.equal(stubs.reserved2, 12);
  assert.equal(got.reserved1, 1);
  assert.equal(got.reserved2, 0);
  assert.deepEqual(siteKinds(image), ['indirect-symbol-pointer', 'indirect-symbol-stub']);
  assert.deepEqual(putsSites(image).map((site) => site.address).sort((a, b) => a < b ? -1 : 1), [stubs.address, got.address].sort((a, b) => a < b ? -1 : 1));
  assert.equal(image.metadata.indirectSymbols?.complete, true);
  assert.equal(image.metadata.indirectSymbols?.sites, 2);

  const result = analysisFromBinaryImage(image);
  const putsAddrs = result.names
    .map((name, index) => ({ name, address: result.addrs[index] }))
    .filter((entry) => entry.name === '_puts')
    .map((entry) => entry.address)
    .sort((a, b) => a < b ? -1 : 1);
  assert.deepEqual(putsAddrs, [stubs.address, got.address].sort((a, b) => a < b ? -1 : 1));
});

test('source-backed parser fetches and decodes the indirect table too', async () => {
  const bytes = buildSampleBinary();
  const image = await openBinarySource(new MemoryByteSource(bytes), {
    ranges: { pageSize: 64, maxPageSize: 256, maxCachedBytes: 128 * 1024, maxReads: 512 },
  });
  assert.deepEqual(siteKinds(image), ['indirect-symbol-pointer', 'indirect-symbol-stub']);
  assert.equal(image.metadata.indirectSymbols?.complete, true);
  assert.equal(image.metadata.sourceBacked, true);
});

test('32-bit pointer sections use 4-byte entries and preserve reserved1/reserved2', () => {
  const image = parseMachO(buildMacho32IndirectFixture());
  const got = image.sections.find((s) => s.name === '__got');
  assert.equal(got.reserved1, 0);
  assert.equal(got.reserved2, 0x12345678);
  assert.equal(got.reserved3, undefined);
  assert.deepEqual(putsSites(image), [{ address:0x1180n, offset:0x180n, kind:'indirect-symbol-pointer' }]);
  assert.equal(image.metadata.indirectSymbols?.complete, true);
});

test('INDIRECT_SYMBOL_LOCAL and INDIRECT_SYMBOL_ABS entries never become imports', () => {
  const bytes = buildSampleBinary();
  const { v, indirectOffset } = sampleLayout(bytes);
  v.setUint32(indirectOffset, INDIRECT_SYMBOL_LOCAL, true);
  v.setUint32(indirectOffset + 4, INDIRECT_SYMBOL_ABS, true);
  const image = parseMachO(bytes);
  assert.equal(putsSites(image).length, 0);
  assert.equal(image.metadata.indirectSymbols?.complete, true);
});

test('out-of-range indirect symbol index is partial and cannot fabricate that site', () => {
  const bytes = buildSampleBinary();
  const { v, indirectOffset } = sampleLayout(bytes);
  v.setUint32(indirectOffset, 0x3fffffff, true);
  const image = parseMachO(bytes);
  assert.equal(putsSites(image).some((site) => site.kind === 'indirect-symbol-stub'), false);
  assert.equal(putsSites(image).some((site) => site.kind === 'indirect-symbol-pointer'), true);
  assert.equal(image.metadata.indirectSymbols?.complete, false);
  assert.match(image.metadata.indirectSymbols?.partialReason ?? '', /symbol-index/);
  assert.ok(image.metadata.machoMetadata.reasons.some((reason) => reason.includes('indirect-symbol')));
});

test('truncated indirect-symbol table is fail-closed and marks metadata partial', () => {
  const bytes = buildSampleBinary();
  const { v, dysymtab } = sampleLayout(bytes);
  v.setUint32(dysymtab.offset + 56, bytes.length - 4, true);
  v.setUint32(dysymtab.offset + 60, 2, true);
  const image = parseMachO(bytes);
  assert.equal(putsSites(image).length, 0);
  assert.equal(image.metadata.indirectSymbols?.complete, false);
  assert.match(image.metadata.indirectSymbols?.partialReason ?? '', /table-range/);
});

test('S_SYMBOL_STUBS reserved2=0 is rejected without divide-by-zero or fabricated stub sites', () => {
  const bytes = buildSampleBinary();
  const { v, sections } = sampleLayout(bytes);
  const stubs = sections.get('__stubs');
  v.setUint32(stubs.offset + 72, 0, true);
  const image = parseMachO(bytes);
  assert.equal(putsSites(image).some((site) => site.kind === 'indirect-symbol-stub'), false);
  assert.equal(putsSites(image).some((site) => site.kind === 'indirect-symbol-pointer'), true);
  assert.equal(image.metadata.indirectSymbols?.complete, false);
  assert.match(image.metadata.indirectSymbols?.partialReason ?? '', /stub-size/);
});

test('section indirect range beyond nindirectsyms is rejected as a whole section', () => {
  const bytes = buildSampleBinary();
  const { v, sections } = sampleLayout(bytes);
  const got = sections.get('__got');
  v.setUint32(got.offset + 68, 2, true); // reserved1 == nindirectsyms
  const image = parseMachO(bytes);
  assert.equal(putsSites(image).some((site) => site.kind === 'indirect-symbol-stub'), true);
  assert.equal(putsSites(image).some((site) => site.kind === 'indirect-symbol-pointer'), false);
  assert.equal(image.metadata.indirectSymbols?.complete, false);
  assert.match(image.metadata.indirectSymbols?.partialReason ?? '', /section-range/);
});

test('non-integral pointer-section entry count is partial and not rounded into a site', () => {
  const bytes = buildSampleBinary();
  const { v, sections } = sampleLayout(bytes);
  const got = sections.get('__got');
  v.setBigUint64(got.offset + 40, 9n, true); // section_64 size is not a pointer-width multiple
  const image = parseMachO(bytes);
  assert.equal(putsSites(image).some((site) => site.kind === 'indirect-symbol-pointer'), false);
  assert.equal(image.metadata.indirectSymbols?.complete, false);
  assert.match(image.metadata.indirectSymbols?.partialReason ?? '', /entry-size/);
});

test('classic dyld bind and LC_DYSYMTAB at the same pointer address do not publish duplicate sites', () => {
  const image = parseMachO(buildMacho64ClassicBindDedupFixture());
  const putsImports = image.imports.filter((entry) => entry.name === '_puts');
  const allSites = putsImports.flatMap((entry) => entry.sites || []);
  assert.equal(allSites.filter((site) => site.address === 0x2000n).length, 1);
  assert.equal(allSites[0]?.kind, 'bind');
  assert.equal(image.metadata.dyldBindings?.complete, true);
  assert.equal(image.metadata.indirectSymbols?.complete, true);
  assert.equal(image.metadata.indirectSymbols?.sites, 0, 'stronger existing dyld site wins dedup');
});

test('metadata budget exhaustion never emits an unbudgeted indirect site', () => {
  const bytes = buildSampleBinary();
  const baseline = parseMachO(bytes);
  const usedBeforeIndirect = baseline.metadata.machoMetadata.used.records - (baseline.metadata.indirectSymbols?.records ?? 0);
  const limited = parseMachO(bytes, { metadataLimits: { records: Math.max(1, usedBeforeIndirect) } });
  assert.equal(limited.metadata.machoMetadata.complete, false);
  assert.ok(limited.metadata.machoMetadata.reasons.some((reason) => reason.startsWith('budget:')));
  assert.ok((limited.metadata.indirectSymbols?.sites ?? 0) <= putsSites(limited).length);
});
