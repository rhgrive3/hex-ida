import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryByteSource } from '../js/binary/source.js';
import { parseMachOSource } from '../js/binary/source-loaders.js';

function thin64() {
  const b = new Uint8Array(64);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0xfeedfacf, true);
  v.setInt32(4, 0x0100000c, true);
  v.setInt32(8, 0, true);
  v.setUint32(12, 1, true);
  v.setUint32(16, 0, true);
  v.setUint32(20, 0, true);
  v.setUint32(24, 0, true);
  v.setUint32(28, 0, true);
  return b;
}

function fat32Single() {
  const data = thin64();
  const offset = 0x1000;
  const size = 0x10000;
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  b.set([0xca, 0xfe, 0xba, 0xbe], 0);
  v.setUint32(4, 1, false);
  v.setInt32(8, 0x0100000c, false);
  v.setInt32(12, 0, false);
  v.setUint32(16, offset, false);
  v.setUint32(20, data.length, false);
  v.setUint32(24, 12, false);
  b.set(data, offset);
  return b;
}

function fat64Single() {
  const data = thin64();
  const offset = 0x4000;
  const size = 0x10000;
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  b.set([0xca, 0xfe, 0xba, 0xbf], 0);
  v.setUint32(4, 1, false);
  v.setInt32(8, 0x0100000c, false);
  v.setInt32(12, 0, false);
  v.setBigUint64(16, BigInt(offset), false);
  v.setBigUint64(24, BigInt(data.length), false);
  v.setUint32(32, 12, false);
  v.setUint32(36, 0, false);
  b.set(data, offset);
  return b;
}

function thinX64() {
  const b = new Uint8Array(64);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0xfeedfacf, true);
  v.setInt32(4, 0x01000007, true);
  v.setInt32(8, 3, true);
  v.setUint32(12, 1, true);
  v.setUint32(16, 0, true);
  v.setUint32(20, 0, true);
  v.setUint32(24, 0, true);
  v.setUint32(28, 0, true);
  return b;
}

function fat32Double() {
  const d1 = thin64();
  const d2 = thinX64();
  const size = 0x10000;
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  b.set([0xca, 0xfe, 0xba, 0xbe], 0);
  v.setUint32(4, 2, false);
  v.setInt32(8, 0x0100000c, false);
  v.setInt32(12, 0, false);
  v.setUint32(16, 0x1000, false);
  v.setUint32(20, d1.length, false);
  v.setUint32(24, 12, false);
  v.setInt32(28, 0x01000007, false);
  v.setInt32(32, 3, false);
  v.setUint32(36, 0x2000, false);
  v.setUint32(40, d2.length, false);
  v.setUint32(44, 12, false);
  b.set(d1, 0x1000);
  b.set(d2, 0x2000);
  return b;
}

test('issue #6129 - FAT32 count=1 with maxReadLength=16 does not limit-error', async () => {
  const bytes = fat32Single();
  const source = new MemoryByteSource(bytes, { maxReadLength: 16 });
  const image = await parseMachOSource(source);
  assert.ok(image);
  assert.equal(image.metadata.fat.slices.length >= 1, true);
});

test('issue #6129 - FAT64 count=1 with maxReadLength=16 splits 32-byte entry', async () => {
  const bytes = fat64Single();
  const source = new MemoryByteSource(bytes, { maxReadLength: 16 });
  const image = await parseMachOSource(source);
  assert.ok(image);
});

test('issue #6129 - underlying reads never exceed maxReadLength', async () => {
  const bytes = fat32Double();
  let maxSeen = 0;
  const inner = new MemoryByteSource(bytes, { maxReadLength: 16 });
  const orig = inner.read.bind(inner);
  inner.read = async (off, len, opts) => {
    maxSeen = Math.max(maxSeen, Number(len));
    return orig(off, len, opts);
  };
  const image = await parseMachOSource(inner);
  assert.ok(image);
  assert.ok(maxSeen <= 16, `max read ${maxSeen} exceeds 16`);
});

test('issue #6129 - truncated table still rejected', async () => {
  const bytes = new Uint8Array(48);
  const v = new DataView(bytes.buffer);
  v.setUint32(0, 0xcafebabe, false);
  v.setUint32(4, 8, false);
  const source = new MemoryByteSource(bytes, { maxReadLength: 16 });
  await assert.rejects(parseMachOSource(source), /truncated|unreasonable/i);
});

test('issue #6129 - count>128 still rejected', async () => {
  const bytes = new Uint8Array(16);
  const v = new DataView(bytes.buffer);
  v.setUint32(0, 0xcafebabe, false);
  v.setUint32(4, 129, false);
  const source = new MemoryByteSource(bytes, { maxReadLength: 16 });
  await assert.rejects(parseMachOSource(source), /unreasonable/);
});
