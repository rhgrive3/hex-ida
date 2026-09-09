import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMachO } from '../../../js/binary/macho.js';

// Issue #5275: an LC_FUNCTION_STARTS load command flips export-derived
// function seeds into closed-world filtering even when the stream itself was
// parsed only partially (truncated LEB, missing terminator, metadata budget)
// — or never parsed at all (out-of-range/zero-size data command). An
// incomplete stream is recall evidence, never exclusion evidence.

function uleb(value) {
  let v = BigInt(value), out = [];
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return out;
}

/* stream: uleb deltas (or raw bytes via rawBytes); fsSize forces the data
   command's declared size (0 = zero-size command). The image exports one
   executable function `foo` at 0x1008 that the stream does not recover. */
function fixture(stream, { terminator = true, fsSize = null, rawBytes = false, limits = null, symbols = [] } = {}) {
  const bytes = new Uint8Array(0x400);
  const v = new DataView(bytes.buffer);
  const u32 = (o, x) => v.setUint32(o, x, true), i32 = (o, x) => v.setInt32(o, x, true);
  const u64 = (o, x) => v.setBigUint64(o, BigInt(x), true);
  bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  const symtabBytes = symbols.length ? 24 + symbols.length * 16 + 64 : 0;
  i32(4, 0x0100000c); i32(8, 0); u32(12, 2); u32(16, symbols.length ? 5 : 4); u32(20, 312 + symtabBytes); u32(24, 0); u32(28, 0);
  // __TEXT with one executable section
  u32(32, 0x19); u32(36, 152);
  bytes.set(new TextEncoder().encode('__TEXT'), 40);
  u64(56, 0x1000n); u64(64, 0x1000n); u64(72, 0n); u64(80, 0x200n);
  i32(88, 5); i32(92, 5); u32(96, 1); u32(100, 0);
  bytes.set(new TextEncoder().encode('__text'), 104);
  bytes.set(new TextEncoder().encode('__TEXT'), 120);
  u64(136, 0x1000n); u64(144, 0x100n); u32(152, 0); u32(168, 0x80000400); u32(176, 0);
  // __TEXT2
  u32(184, 0x19); u32(188, 72);
  bytes.set(new TextEncoder().encode('__TEXT2'), 192);
  u64(208, 0x4000n); u64(216, 0x1000n); u64(224, 0x200n); u64(232, 0x100n);
  i32(240, 5); i32(244, 5); u32(248, 0); u32(252, 0);
  // LC_FUNCTION_STARTS at 0x300
  const lc = 256;
  u32(lc, 0x26); u32(lc + 4, 16); u32(lc + 8, 0x300);
  const fsBytes = rawBytes ? [...stream] : stream.flatMap(uleb); if (terminator && !rawBytes) fsBytes.push(0);
  u32(lc + 12, fsSize ?? fsBytes.length); bytes.set(fsBytes, 0x300);
  // LC_DYLD_EXPORTS_TRIE: `foo` at imageBase+8 = 0x1008 (executable __text)
  const et = 272;
  u32(et, 0x80000033); u32(et + 4, 16); u32(et + 8, 0x380); u32(et + 12, 11);
  bytes.set([0x00, 0x01, 0x66, 0x6f, 0x6f, 0x00, 0x07, 0x02, 0x00, 0x08, 0x00], 0x380);
  // LC_SYMTAB (optional): defined N_SECT symbols over the executable __text
  if (symbols.length) {
    const symoff = 0x180, stroff = symoff + symbols.length * 16;
    const st = et + 16;
    u32(st, 0x2); u32(st + 4, 24); u32(st + 8, symoff); u32(st + 12, symbols.length);
    u32(st + 16, stroff); u32(st + 20, 64);
    symbols.forEach(([name, address], i) => {
      const p = symoff + i * 16;
      u32(p, i * 12);
      bytes[p + 4] = 0x0e; // N_SECT
      bytes[p + 5] = 1;    // n_sect
      u64(p + 8, address);
      bytes.set(Buffer.from(name), stroff + i * 12);
      bytes[stroff + i * 12 + name.length] = 0;
    });
  }
  return parseMachO(bytes, limits ? { metadataLimits: limits } : {});
}

test('#5275 a complete stream keeps its authoritative closed-world contract', () => {
  const image = fixture([4n]);
  assert.equal(image.metadata.functionStarts.complete, true);
  const sources = image.functions.map((f) => f.source);
  assert.ok(sources.includes('function_starts'), 'recovered start is kept');
  assert.ok(!sources.includes('export'), 'an unproven export is excluded by the complete stream');
});

for (const [name, build] of [
  ['a truncated-LEB stream', () => fixture([4, 0x80, 0x80], { rawBytes: true })],
  ['a stream missing its terminator', () => fixture([4n], { terminator: false })],
  ['a zero-size data command', () => fixture([4n], { fsSize: 0 })],
  ['an out-of-range data command', () => fixture([4n], { fsSize: 0x1000 })],
]) {
  test(`#5275 ${name} never excludes the export-derived seed`, () => {
    const image = build();
    assert.notEqual(image.metadata.functionStarts?.complete, true, 'the stream must report incompleteness');
    const exportSeed = image.functions.find((f) => f.source === 'export');
    assert.ok(exportSeed, 'the export-derived function seed must survive a partial stream');
    assert.equal(exportSeed.address, 0x1008n);
    assert.equal(exportSeed.name, 'foo');
  });
}

test('#5275 a partial stream keeps the starts it did recover', () => {
  const image = fixture([4n], { terminator: false });
  const starts = image.functions.filter((f) => f.source === 'function_starts');
  assert.deepEqual(starts.map((f) => f.address), [0x1004n], 'recovered starts stay alongside independent seeds');
});

test('#5275 a partial stream seeds unproven executable symbols without double-seeding', () => {
  /* LC_SYMTAB with two defined N_SECT symbols: `recovered` at 0x1004 (the
     address the partial function-starts stream did recover) and `fallback`
     at 0x100c (in __text, never seeded by the truncated stream). */
  const image = fixture([4n], { terminator: false, symbols: [['recovered', 0x1004n], ['fallback', 0x100cn]] });
  const at = (addr) => image.functions.filter((f) => f.address === addr);
  assert.equal(at(0x1004n).length, 1, 'the recovered start keeps its function_starts provenance (no duplicate)');
  assert.equal(at(0x1004n)[0].source, 'function_starts');
  const fallback = at(0x100cn);
  assert.equal(fallback.length, 1, 'the unproven executable symbol gains a symbol-fallback seed');
  assert.equal(fallback[0].source, 'symbol');
});

test('#5275 a partial stream does not double-seed a recovered address from symbols', () => {
  const image = fixture([4n], { terminator: false });
  const at = image.functions.filter((f) => f.address === 0x1004n);
  assert.equal(at.length, 1, 'one seed per address');
});

console.log('issue #5275 function-starts closed-world gate regression: ok');
