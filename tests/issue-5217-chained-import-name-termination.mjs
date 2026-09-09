import assert from 'node:assert/strict';
import test from 'node:test';
import { chainedImportSymbols } from '../js/chained.js';

// Issue #5217: chained-fixups import names are NUL-terminated strings inside
// the symbol string pool. A scan that reaches the payload end without a NUL
// must fail closed — tail bytes must not be laundered into an exact import
// name that then decorates stubs and GOT slots.

const LE = true;

function fixture({ pool, symbolsOffset, nameOffset = 0, ordinal = 0 }) {
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
  dv.setUint32(p, 0x80000034, LE); dv.setUint32(p + 4, 16, LE);
  dv.setUint32(p + 8, fixoff, LE); dv.setUint32(p + 12, 0x60, LE);
  const F = fixoff;
  const payloadEnd = F + 0x60;
  dv.setUint32(F + 0, 0, LE);        // version
  dv.setUint32(F + 4, 28, LE);       // starts_offset
  dv.setUint32(F + 8, 76, LE);       // imports_offset (after the seg table)
  dv.setUint32(F + 12, symbolsOffset, LE); // symbols_offset
  dv.setUint32(F + 16, 1, LE);       // imports_count
  dv.setUint32(F + 20, 2, LE);       // imports_format (64)
  dv.setUint32(F + 24, 0, LE);       // symbols_format (uncompressed)
  dv.setUint32(F + 76, nameOffset << 9, LE); // imports entry 0
  // starts_in_image: two segment entries; __DATA_CONST (index 1) declares the bind chain.
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
  dv.setBigUint64(0x4100, (1n << 63n) | (4n << 51n) | BigInt(ordinal), LE);
  if (pool) file.set(pool, F + symbolsOffset);
  void payloadEnd;
  return new Blob([file]);
}

test('#5217 a terminated pool string still recovers the import name', async () => {
  const file = fixture({ pool: Buffer.from('puts\0'), symbolsOffset: 91, ordinal: 0 });
  const out = await chainedImportSymbols(file, 0);
  assert.deepEqual(out.map((e) => ({ addr: e.addr, name: e.name, kind: e.kind })), [
    { addr: 0x100000000n, name: 'puts', kind: 1 },
    { addr: 0x100004100n, name: 'puts', kind: 2 },
  ]);
});

test('#5217 an unterminated pool string resolves to no name at all', async () => {
  const file = fixture({ pool: Buffer.from('puts'), symbolsOffset: 92, ordinal: 0 });
  const out = await chainedImportSymbols(file, 0);
  assert.deepEqual(out, [], 'payload tail must not become an implicit NUL terminator');
});

test('#5217 a name_offset outside the pool resolves to no name (control)', async () => {
  const file = fixture({ pool: Buffer.from('puts\0'), symbolsOffset: 96, ordinal: 0 });
  const out = await chainedImportSymbols(file, 0);
  assert.deepEqual(out, []);
});

test('#5217 NUL boundaries between adjacent pool strings are preserved', async () => {
  const file = fixture({ pool: Buffer.from('one\0two\0'), symbolsOffset: 88, nameOffset: 4, ordinal: 0 });
  const out = await chainedImportSymbols(file, 0);
  assert.ok(out.length >= 1, 'a valid pool string still recovers the import');
  assert.deepEqual([...new Set(out.map((e) => e.name))], ['two'], 'the second string must stay independent of the first');
});

test('#5217 an unterminated later pool string fails closed even when an earlier one terminates', async () => {
  const file = fixture({ pool: Buffer.from('one\0two'), symbolsOffset: 89, nameOffset: 4, ordinal: 0 });
  const out = await chainedImportSymbols(file, 0);
  assert.deepEqual(out, [], 'a truncated string must not decorate stubs or GOT slots');
});

test('#5217 an empty pool region resolves to no name (control)', async () => {
  const file = fixture({ pool: null, symbolsOffset: 92, ordinal: 0 });
  const out = await chainedImportSymbols(file, 0);
  assert.deepEqual(out, []);
});

console.log('issue #5217 chained import name termination regression: ok');
