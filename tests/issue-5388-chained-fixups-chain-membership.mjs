import assert from 'node:assert/strict';
import test from 'node:test';
import { chainedImportSymbols } from '../js/chained.js';

// Issue #5388: chainedImportSymbols named a GOT slot whenever the file value
// happened to look like a bind pointer in the segment's format. Apple dyld's
// dyld_chained_starts_in_segment is the authority: only slots reachable via
// page_start[] chains (with multi-start pools) are chained fixups. START_NONE
// pages, off-chain slots and malformed chains must fail closed.

const LE = true;

/* adrp x16, <GOT page> ; ldr x16, [x16, <slot page offset>] ; br x16 */
function stubWords(slot) {
  const pageDiff = 4 + (slot >>> 12);
  const immlo = pageDiff & 3, immhi = pageDiff >>> 2;
  const adrp = 0x90000000 | (immlo << 29) | (immhi << 5) | 16;
  const ldr = 0xf9400000 | (((slot & 0xfff) >>> 3) << 10) | (16 << 5) | 16;
  return [adrp >>> 0, ldr >>> 0, 0xd61f0200];
}

/* nodes: page offset -> { ordinal, next } format-6 fixup values; slot: page offset. */
function fixture({ pageStarts, overflow = [], pageCount = pageStarts.length, nodes, slot = 0x300 }) {
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
  const [adrp, ldr, br] = stubWords(slot);
  dv.setUint32(0x1000, adrp, LE); dv.setUint32(0x1004, ldr, LE); dv.setUint32(0x1008, br, LE);
  p += 152;
  dv.setUint32(p, 0x19, LE); dv.setUint32(p + 4, 152, LE);
  file.set(Buffer.from('__DATA_CONST\0\0\0\0'), p + 8);
  dv.setBigUint64(p + 24, 0x100004000n, LE); dv.setBigUint64(p + 32, 0x4000n, LE);
  dv.setBigUint64(p + 40, 0x4000n, LE); dv.setBigUint64(p + 48, 0x4000n, LE);
  dv.setUint32(p + 64, 1, LE);
  q = p + 72;
  file.set(Buffer.from('__got\0\0\0\0\0\0\0\0\0\0\0'), q);
  file.set(Buffer.from('__DATA_CONST\0\0\0\0'), q + 16);
  dv.setBigUint64(q + 32, 0x100004000n + BigInt(slot), LE); dv.setBigUint64(q + 40, 8n, LE);
  dv.setUint32(q + 48, 0x4000 + slot, LE); dv.setUint32(q + 64, 0, LE); dv.setUint32(q + 72, 0, LE);
  p += 152;
  const fixoff = 0x8000;
  dv.setUint32(p, 0x80000034, LE); dv.setUint32(p + 4, 16, LE);
  dv.setUint32(p + 8, fixoff, LE); dv.setUint32(p + 12, 0x80, LE);
  const F = fixoff;
  dv.setUint32(F + 0, 0, LE);
  dv.setUint32(F + 4, 28, LE);
  dv.setUint32(F + 8, 80, LE);
  dv.setUint32(F + 12, 92, LE);
  dv.setUint32(F + 16, 1, LE);
  dv.setUint32(F + 20, 2, LE);
  dv.setUint32(F + 24, 0, LE);
  dv.setUint32(F + 80, 0, LE); // imports entry 0: name_offset 0, ordinal 0
  dv.setUint32(F + 28, 2, LE);
  dv.setUint32(F + 32, 0, LE);
  dv.setUint32(F + 36, 24, LE); // seg_info_offset[1]: starts record at F+28+24
  const S = F + 52;
  const structSize = 22 + pageCount * 2 + overflow.length * 2;
  dv.setUint32(S + 0, structSize, LE);
  dv.setUint16(S + 4, 0x1000, LE);
  dv.setUint16(S + 6, 6, LE); // DYLD_CHAINED_PTR_64_OFFSET
  dv.setBigUint64(S + 8, 0x4000n, LE);
  dv.setUint32(S + 16, 0, LE);
  dv.setUint16(S + 20, pageCount, LE);
  pageStarts.forEach((start, i) => dv.setUint16(S + 22 + i * 2, start, LE));
  overflow.forEach((x, i) => dv.setUint16(S + 22 + pageCount * 2 + i * 2, x, LE));
  for (const [offset, node] of Object.entries(nodes)) {
    const raw = (1n << 63n) | (BigInt(node.next ?? 0) << 51n) | BigInt(node.ordinal ?? 0);
    dv.setBigUint64(0x4000 + Number(offset), raw, LE);
  }
  file.set(Buffer.from('puts\0'), F + 92);
  return new Blob([file]);
}

const stub = 0x100000000n;
const slotAddr = (slot) => 0x100004000n + BigInt(slot);

test('#5388 a bind-shaped value on a START_NONE page names nothing', async () => {
  const file = fixture({ pageStarts: [0xffff], nodes: { 0x300: { ordinal: 0 } }, slot: 0x300 });
  const out = await chainedImportSymbols(file, 0);
  assert.deepEqual(out, [], 'START_NONE is explicit evidence that the page holds no fixups');
});

test('#5388 a slot on a declared chain still recovers its import name', async () => {
  const file = fixture({ pageStarts: [0x100], nodes: { 0x100: { ordinal: 0, next: 0 } }, slot: 0x100 });
  const out = await chainedImportSymbols(file, 0);
  assert.deepEqual(out.map((e) => ({ addr: e.addr, name: e.name, kind: e.kind })), [
    { addr: stub, name: 'puts', kind: 1 },
    { addr: slotAddr(0x100), name: 'puts', kind: 2 },
  ]);
});

test('#5388 a chain member beyond the first node is accepted (next is walked)', async () => {
  const file = fixture({ pageStarts: [0x100], nodes: { 0x100: { ordinal: 0, next: 4 }, 0x110: { ordinal: 0, next: 0 } }, slot: 0x110 });
  const out = await chainedImportSymbols(file, 0);
  assert.deepEqual(out.map((e) => ({ addr: e.addr, name: e.name, kind: e.kind })), [
    { addr: stub, name: 'puts', kind: 1 },
    { addr: slotAddr(0x110), name: 'puts', kind: 2 },
  ]);
});

test('#5388 a slot outside every chain on a fixup page names nothing', async () => {
  const file = fixture({ pageStarts: [0x100], nodes: { 0x100: { ordinal: 0, next: 0 } }, slot: 0x300 });
  const out = await chainedImportSymbols(file, 0);
  assert.deepEqual(out, [], 'the file value at an off-chain slot must not launder into a name');
});

test('#5388 a chain whose next leaves its page fails closed', async () => {
  const file = fixture({ pageStarts: [0x100], nodes: { 0x100: { ordinal: 0, next: 0xfff } }, slot: 0x100 });
  const out = await chainedImportSymbols(file, 0);
  assert.deepEqual(out, [], 'a malformed chain must not prove membership for any slot');
});

test('#5388 an unterminated multi-start pool fails closed', async () => {
  const file = fixture({ pageStarts: [0x8000], overflow: [0x100], nodes: { 0x100: { ordinal: 0, next: 0 } }, slot: 0x100 });
  const out = await chainedImportSymbols(file, 0);
  assert.deepEqual(out, []);
});

test('#5388 a slot on the second chain of a multi-start page is accepted', async () => {
  const file = fixture({
    pageStarts: [0x8000],
    overflow: [0x100, 0x300 | 0x8000],
    nodes: { 0x100: { ordinal: 0, next: 0 }, 0x300: { ordinal: 0, next: 0 } },
    slot: 0x300,
  });
  const out = await chainedImportSymbols(file, 0);
  assert.deepEqual(out.map((e) => ({ addr: e.addr, kind: e.kind })), [
    { addr: stub, kind: 1 },
    { addr: slotAddr(0x300), kind: 2 },
  ], 'only the second chain of the multi-start page covers the stub-referenced slot');
});

test('#5388 a slot on the first chain of a multi-start page is accepted', async () => {
  const file = fixture({
    pageStarts: [0x8000],
    overflow: [0x100, 0x300 | 0x8000],
    nodes: { 0x100: { ordinal: 0, next: 0 }, 0x300: { ordinal: 0, next: 0 } },
    slot: 0x100,
  });
  const out = await chainedImportSymbols(file, 0);
  assert.deepEqual(out.map((e) => ({ addr: e.addr, kind: e.kind })), [
    { addr: stub, kind: 1 },
    { addr: slotAddr(0x100), kind: 2 },
  ]);
});

test('#5388 an out-of-range multi-start pool index fails closed', async () => {
  const file = fixture({ pageStarts: [0x8000 | 5], overflow: [0x100 | 0x8000], nodes: { 0x100: { ordinal: 0, next: 0 } }, slot: 0x100 });
  const out = await chainedImportSymbols(file, 0);
  assert.deepEqual(out, []);
});

test('#5388 a slot beyond the declared page count names nothing', async () => {
  const file = fixture({ pageStarts: [0xffff, 0x100], pageCount: 1, nodes: { 0x100: { ordinal: 0, next: 0 } }, slot: 0x1100 });
  const out = await chainedImportSymbols(file, 0);
  assert.deepEqual(out, [], 'a page outside the declared page_count holds no provable fixups');
});

console.log('issue #5388 chained fixups chain-membership regression: ok');
