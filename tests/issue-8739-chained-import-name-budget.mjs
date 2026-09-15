import assert from 'node:assert/strict';
import test from 'node:test';
import { chainedImportSymbols, __chainedInternalsForTests } from '../js/chained.js';

// Issue #8739: the supplemental Mach-O chained-import recovery eagerly decoded
// every import record into a fresh string. Many records legally share one
// `name_offset`, so a structurally tiny file could retain tens of MiB of
// duplicated decoded text before resolving a single stub. Decoding must now be
// cached by string-pool offset so each distinct name is decoded/retained once.

const LE = true;

function fixture({ name, names = null, count, ordinal = 0, chain = true }) {
  const encoder = new TextEncoder();
  const entries = names == null ? [encoder.encode(name + '\0')] : names.map((entry) => encoder.encode(entry + '\0'));
  const nameOffsets = new Uint32Array(count);
  let poolLength = 0;
  if (names == null) {
    poolLength = entries[0].length;
  } else {
    assert.equal(names.length, count, 'distinct-name fixture must provide one pool entry per import');
    for (let i = 0; i < entries.length; i++) {
      nameOffsets[i] = poolLength;
      poolLength += entries[i].length;
    }
  }
  const poolBytes = new Uint8Array(poolLength);
  if (names == null) {
    poolBytes.set(entries[0], 0);
  } else {
    for (let i = 0; i < entries.length; i++) poolBytes.set(entries[i], nameOffsets[i]);
  }
  const stride = 8;               // imports_format 2 (64-bit import entries)
  const importsOffset = 76;       // relative to the fixup payload
  const symbolsOffset = importsOffset + count * stride + 4;
  const fixupPayload = symbolsOffset + poolBytes.length;
  const fixoff = 0x8000;
  const file = new Uint8Array(fixoff + fixupPayload);
  const dv = new DataView(file.buffer);

  // mach_header_64
  dv.setUint32(0, 0xfeedfacf, LE); dv.setUint32(4, 0x0100000c, LE);
  dv.setUint32(8, 0, LE); dv.setUint32(12, 2, LE);
  dv.setUint32(16, 3, LE); dv.setUint32(20, 152 + 152 + 16, LE);
  let p = 32;
  // __TEXT + __stubs
  dv.setUint32(p, 0x19, LE); dv.setUint32(p + 4, 152, LE);
  file.set(Buffer.from('__TEXT\0\0\0\0\0\0\0\0\0\0'), p + 8);
  dv.setBigUint64(p + 24, 0x100000000n, LE); dv.setBigUint64(p + 32, 0x4000n, LE);
  dv.setBigUint64(p + 40, 0n, LE); dv.setBigUint64(p + 48, 0x4000n, LE);
  dv.setUint32(p + 64, 1, LE);
  let q = p + 72;
  file.set(Buffer.from('__stubs\0\0\0\0\0\0\0\0\0'), q);
  file.set(Buffer.from('__TEXT\0\0\0\0\0\0\0\0\0\0'), q + 16);
  dv.setBigUint64(q + 32, 0x100000000n, LE); dv.setBigUint64(q + 40, 12n, LE);
  dv.setUint32(q + 48, 0x1000, LE); dv.setUint32(q + 64, 0x8, LE); dv.setUint32(q + 72, 12, LE);
  dv.setUint32(0x1000, 0x90000030, LE); dv.setUint32(0x1004, 0xf9408210, LE); dv.setUint32(0x1008, 0xd61f0200, LE);
  p += 152;
  // __DATA_CONST + __got
  dv.setUint32(p, 0x19, LE); dv.setUint32(p + 4, 152, LE);
  file.set(Buffer.from('__DATA_CONST\0\0\0\0'), p + 8);
  dv.setBigUint64(p + 24, 0x100004000n, LE); dv.setBigUint64(p + 32, 0x4000n, LE);
  dv.setBigUint64(p + 40, 0x4000n, LE); dv.setBigUint64(p + 48, 0x4000n, LE);
  dv.setUint32(p + 64, 1, LE);
  q = p + 72;
  file.set(Buffer.from('__got\0\0\0\0\0\0\0\0\0\0\0'), q);
  file.set(Buffer.from('__DATA_CONST\0\0\0\0'), q + 16);
  dv.setBigUint64(q + 32, 0x100004100n, LE); dv.setBigUint64(q + 40, 8n, LE);
  dv.setUint32(q + 48, 0x4100, LE); dv.setUint32(q + 64, 0, LE); dv.setUint32(q + 72, 0, LE);
  p += 152;
  // LC_DYLD_CHAINED_FIXUPS
  dv.setUint32(p, 0x80000034, LE); dv.setUint32(p + 4, 16, LE);
  dv.setUint32(p + 8, fixoff, LE); dv.setUint32(p + 12, fixupPayload, LE);
  const F = fixoff;
  dv.setUint32(F + 0, 0, LE);              // version
  dv.setUint32(F + 4, 28, LE);            // starts_offset
  dv.setUint32(F + 8, importsOffset, LE); // imports_offset
  dv.setUint32(F + 12, symbolsOffset, LE);// symbols_offset
  dv.setUint32(F + 16, count, LE);        // imports_count
  dv.setUint32(F + 20, 2, LE);            // imports_format
  dv.setUint32(F + 24, 0, LE);            // symbols_format
  for (let i = 0; i < count; i++) {
    assert.ok(nameOffsets[i] < 0x800000, 'format-2 name offset must fit 23 bits');
    dv.setUint32(F + importsOffset + i * stride, (nameOffsets[i] << 9) >>> 0, LE);
  }
  file.set(poolBytes, F + symbolsOffset);
  // starts_in_image: 2 segments; __DATA_CONST (index 1) declares the bind chain.
  dv.setUint32(F + 28, 2, LE);
  dv.setUint32(F + 32, 0, LE);
  dv.setUint32(F + 36, 24, LE);
  const S = F + 52;
  dv.setUint32(S + 0, 24, LE);
  dv.setUint16(S + 4, 0x1000, LE);        // page_size
  dv.setUint16(S + 6, 6, LE);             // pointer_format (PTR64)
  dv.setBigUint64(S + 8, 0x4000n, LE);    // segment_offset
  dv.setUint32(S + 16, 0, LE);
  dv.setUint16(S + 20, 1, LE);            // page_count
  dv.setUint16(S + 22, chain ? 0x100 : 0xffff, LE); // page_start[0]
  // GOT slot carries a chained-bind pointer to the requested ordinal.
  dv.setBigUint64(0x4100, (1n << 63n) | (4n << 51n) | BigInt(ordinal), LE);
  return new Blob([file]);
}

// 200,000 import records all reference the same ~200 KB symbol-pool string.
// Uncached, this re-scans/re-decodes/retains the string 200,000 times.
const BIG = 'X'.repeat(200_000);

test('#8739 repeated shared name_offset resolves exactly and stays bounded', async () => {
  const file = fixture({ name: BIG, count: 200_000 });
  const started = Date.now();
  const out = await Promise.race([
    chainedImportSymbols(file, 0),
    new Promise((_, reject) => setTimeout(() => reject(new Error('decode did not complete within the resource guard')), 8000)),
  ]);
  const elapsed = Date.now() - started;
  assert.ok(out.length > 0, 'the reachable chained import must still resolve');
  assert.equal(out[0].name, BIG, 'the resolved import name must be the exact shared string');
  assert.ok(elapsed < 5000, `offset-keyed decode must keep the parse bounded, took ${elapsed}ms`);
});

test('#8739 a small within-budget fixture still resolves the exact shared name', async () => {
  const out = await chainedImportSymbols(fixture({ name: 'aliasname', count: 50 }), 0);
  assert.ok(out.length > 0, 'a normal fixture must still recover the import');
  assert.equal(out[0].name, 'aliasname', 'the resolved name must be exact and shared across aliases');
});

test('#8739 review: distinct long names on a START_NONE page are never decoded', async () => {
  const names = Array.from({ length: 256 }, (_, index) => `name_${index}_` + 'Q'.repeat(16_000));
  const RealTextDecoder = globalThis.TextDecoder;
  let decodeCalls = 0;
  globalThis.TextDecoder = class CountingTextDecoder extends RealTextDecoder {
    decode(...args) {
      decodeCalls += 1;
      return super.decode(...args);
    }
  };
  try {
    const out = await chainedImportSymbols(fixture({ names, count: names.length, chain: false }), 0);
    assert.deepEqual(out, [], 'a page with START_NONE proves no import-name reachability');
    assert.equal(decodeCalls, 0, 'unreachable distinct names must not be decoded eagerly');
  } finally {
    globalThis.TextDecoder = RealTextDecoder;
  }
});

test('#8739 review: distinct reachable-name resolver admits retained bytes before decode', () => {
  const count = 600;
  const encoded = new TextEncoder().encode('R'.repeat(8192) + '\0');
  const raw = new Uint8Array(encoded.length * count);
  const offsets = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    offsets[i] = i * encoded.length;
    raw.set(encoded, offsets[i]);
  }
  const resolver = __chainedInternalsForTests.createImportNameResolver(raw, 0, offsets);
  let resolved = 0;
  for (let i = 0; i < count && !resolver.exhausted; i++) {
    if (resolver.resolve(i) != null) resolved += 1;
  }
  assert.equal(resolver.exhausted, true, 'distinct decoded names must hit the retained-output ceiling');
  assert.ok(resolver.retainedBytes <= 8 * 1024 * 1024,
    `retained-name accounting crossed its 8 MiB authority: ${resolver.retainedBytes}`);
  assert.ok(resolved < count, 'the resolver must stop before decoding every distinct long name');
});

console.log('issue-8739 chained import name decode cache: ok');
