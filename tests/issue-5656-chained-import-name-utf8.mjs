import assert from 'node:assert/strict';
import test from 'node:test';
import { chainedImportSymbols } from '../js/chained.js';

// Issue #5656: chained-fixups import names are canonical UTF-8 strings. The
// default TextDecoder is non-fatal, so malformed symbol bytes were silently
// laundered into U+FFFD replacement characters and published as exact import
// names for stubs and GOT slots. The strict decoder must reject them.

const LE = true;

function fixture(pool, symbolsOffset, { importNameOffsets = [0] } = {}) {
  const file = new Uint8Array(0x9000);
  const dv = new DataView(file.buffer);
  dv.setUint32(0, 0xfeedfacf, LE);
  dv.setUint32(4, 0x0100000c, LE); dv.setUint32(8, 0, LE); dv.setUint32(12, 2, LE);
  dv.setUint32(16, 3, LE); dv.setUint32(20, 152 + 152 + 16, LE); dv.setUint32(24, 0, LE);
  let p = 32;
  dv.setUint32(p, 0x19, LE); dv.setUint32(p + 4, 152, LE);
  file.set(Buffer.from('__TEXT\0\0\0\0\0\0\0\0\0\0'), p + 8);
  dv.setBigUint64(p + 24, 0x100000000n, LE); dv.setBigUint64(p + 32, 0x4000n, LE);
  dv.setBigUint64(p + 40, 0n, LE); dv.setBigUint64(p + 48, 0x4000n, LE);
  dv.setUint32(p + 64, 1, LE);
  let q = p + 72;
  file.set(Buffer.from('__stubs\0\0\0\0\0\0\0\0\0'), q);
  file.set(Buffer.from('__TEXT\0\0\0\0\0\0\0\0\0'), q + 16);
  dv.setBigUint64(q + 32, 0x100000000n, LE); dv.setBigUint64(q + 40, 12n, LE);
  dv.setUint32(q + 48, 0x1000, LE); dv.setUint32(q + 64, 0x8, LE); dv.setUint32(q + 72, 12, LE);
  dv.setUint32(0x1000, 0x90000030, LE); dv.setUint32(0x1004, 0xf9408210, LE); dv.setUint32(0x1008, 0xd61f0200, LE);
  p += 152;
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
  const fixoff = 0x8000;
  const fixupSize = Math.max(0x60, symbolsOffset + (pool?.length ?? 0));
  dv.setUint32(p, 0x80000034, LE); dv.setUint32(p + 4, 16, LE);
  dv.setUint32(p + 8, fixoff, LE); dv.setUint32(p + 12, fixupSize, LE);
  const F = fixoff;
  dv.setUint32(F + 0, 0, LE);
  dv.setUint32(F + 4, 28, LE);
  dv.setUint32(F + 8, 76, LE);
  dv.setUint32(F + 12, symbolsOffset, LE);
  dv.setUint32(F + 16, importNameOffsets.length, LE);
  dv.setUint32(F + 20, 2, LE);
  dv.setUint32(F + 24, 0, LE);
  for (let i = 0; i < importNameOffsets.length; i++) {
    const entry = F + 76 + i * 8;
    dv.setUint32(entry, importNameOffsets[i] << 9, LE);
    dv.setUint32(entry + 4, 0, LE);
  }
  dv.setUint32(F + 28, 2, LE);
  dv.setUint32(F + 32, 0, LE);
  dv.setUint32(F + 36, 24, LE);
  const S = F + 52;
  dv.setUint32(S + 0, 24, LE);
  dv.setUint16(S + 4, 0x1000, LE);
  dv.setUint16(S + 6, 6, LE);
  dv.setBigUint64(S + 8, 0x4000n, LE);
  dv.setUint32(S + 16, 0, LE);
  dv.setUint16(S + 20, 1, LE);
  dv.setUint16(S + 22, 0x100, LE);
  dv.setBigUint64(0x4100, (1n << 63n) | (4n << 51n) | 0n, LE);
  if (pool) file.set(pool, F + symbolsOffset);
  return new Blob([file]);
}

test('#5656 a valid NUL-terminated ASCII name still recovers', async () => {
  const out = await chainedImportSymbols(fixture(Buffer.from('puts\0'), 91), 0);
  assert.deepEqual([...new Set(out.map((e) => e.name))], ['puts']);
});

test('#5656 malformed UTF-8 bytes fail closed instead of becoming U+FFFD names', async () => {
  // "fo" + standalone continuation byte 0x80 + "o" + NUL
  const out = await chainedImportSymbols(fixture(Buffer.from([0x66, 0x6f, 0x80, 0x6f, 0x00]), 91), 0);
  assert.deepEqual(out, [], 'a replacement-character name must never become symbol evidence');
});

test('#5656 a truncated multibyte sequence fails closed', async () => {
  // "put" + C3 lead byte with no continuation byte before the NUL
  const out = await chainedImportSymbols(fixture(Buffer.from([0x70, 0x75, 0x74, 0xc3, 0x00]), 91), 0);
  assert.deepEqual(out, []);
});

test('#5656 overlong/invalid C0/C1 lead bytes fail closed', async () => {
  const out = await chainedImportSymbols(fixture(Buffer.from([0x70, 0xc1, 0x75, 0x74, 0x00]), 91), 0);
  assert.deepEqual(out, []);
});

test('#5656 valid multibyte names still recover through the strict decoder', async () => {
  const out = await chainedImportSymbols(fixture(Buffer.from('日本語\0'), 86), 0);
  assert.deepEqual([...new Set(out.map((e) => e.name))], ['日本語']);
});

test('#5656 a malformed name later in the pool does not corrupt earlier entries', async () => {
  // Import 0 is valid and referenced by the GOT. Import 1 is malformed and
  // deliberately unreferenced: parsing it must not poison import 0.
  const pool = Buffer.concat([Buffer.from('one\0'), Buffer.from([0x74, 0x77, 0xff, 0x00])]);
  const out = await chainedImportSymbols(
    fixture(pool, 96, { importNameOffsets: [0, 4] }),
    0,
  );
  assert.deepEqual([...new Set(out.map((e) => e.name))], ['one']);
  assert.ok(out.every((e) => e.name === 'one'), 'the malformed second import must not become symbol evidence');
});

console.log('issue #5656 chained import name strict UTF-8 regression: ok');
