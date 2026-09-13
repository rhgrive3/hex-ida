import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMachO } from '../../../js/binary/macho.js';

const CPU_ARM64 = 0x0100000c;
const CPU_ARM64_32 = 0x0200000c;
const CPU_I386 = 7;
const S_MOD_INIT = 0x9;
const RET64 = [0xc0, 0x03, 0x5f, 0xd6];

function build64({ cpu, subtype = 0, pointers, entryWidth, modInitSize = null, modInitFlags = S_MOD_INIT }) {
  const entryBytes = modInitSize != null ? modInitSize : pointers.length * entryWidth;
  const bytes = new Uint8Array(0x600);
  const view = new DataView(bytes.buffer);
  const u32 = (o, x) => view.setUint32(o, x, true);
  const i32 = (o, x) => view.setInt32(o, x, true);
  const u64 = (o, x) => view.setBigUint64(o, BigInt(x), true);
  const put = (o, s) => bytes.set(Buffer.from(s), o);

  bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  i32(4, cpu);
  i32(8, subtype);
  u32(12, 6);
  u32(16, 2);
  u32(20, 304);
  u32(24, 0);

  let p = 32;
  u32(p, 0x19);
  u32(p + 4, 152);
  put(p + 8, '__TEXT');
  u64(p + 24, 0x1000n);
  u64(p + 32, 0x1000n);
  u64(p + 40, 0n);
  u64(p + 48, 0x200n);
  i32(p + 56, 5);
  i32(p + 60, 5);
  u32(p + 64, 1);
  let q = p + 72;
  put(q, '__text');
  put(q + 16, '__TEXT');
  u64(q + 32, 0x1180n);
  u64(q + 40, 16n);
  u32(q + 48, 0x180);
  u32(q + 52, 2);
  u32(q + 64, 0x80000400);
  for (let i = 0; i < 4; i++) bytes.set(RET64, 0x180 + i * 4);

  p = 32 + 152;
  u32(p, 0x19);
  u32(p + 4, 152);
  put(p + 8, '__DATA');
  u64(p + 24, 0x2000n);
  u64(p + 32, 0x1000n);
  u64(p + 40, 0x200n);
  u64(p + 48, 0x100n);
  i32(p + 56, 3);
  i32(p + 60, 3);
  u32(p + 64, 1);
  q = p + 72;
  put(q, '__mod_init_func');
  put(q + 16, '__DATA');
  u64(q + 32, 0x2000n);
  u64(q + 40, BigInt(entryBytes));
  u32(q + 48, 0x200);
  u32(q + 52, 2);
  u32(q + 64, modInitFlags);

  pointers.forEach((target, i) => {
    if (entryWidth === 8) u64(0x200 + i * 8, BigInt(target));
    else u32(0x200 + i * 4, Number(target));
  });
  return bytes;
}

function build32({ pointers }) {
  const bytes = new Uint8Array(0x400);
  const view = new DataView(bytes.buffer);
  const u32 = (o, x) => view.setUint32(o, x, true);
  const i32 = (o, x) => view.setInt32(o, x, true);
  const put = (o, s) => bytes.set(Buffer.from(s), o);

  bytes.set([0xce, 0xfa, 0xed, 0xfe], 0);
  i32(4, CPU_I386);
  i32(8, 3);
  u32(12, 6);
  u32(16, 2);
  u32(20, 248);
  u32(24, 0);

  let p = 28;
  u32(p, 1);
  u32(p + 4, 124);
  put(p + 8, '__TEXT');
  u32(p + 24, 0x1000);
  u32(p + 28, 0x1000);
  u32(p + 32, 0);
  u32(p + 36, 0x200);
  i32(p + 40, 5);
  i32(p + 44, 5);
  u32(p + 48, 1);
  let q = p + 56;
  put(q, '__text');
  put(q + 16, '__TEXT');
  u32(q + 32, 0x1180);
  u32(q + 36, 4);
  u32(q + 40, 0x180);
  u32(q + 44, 2);
  u32(q + 56, 0x80000400);
  bytes[0x180] = 0xc3;

  p = 28 + 124;
  u32(p, 1);
  u32(p + 4, 124);
  put(p + 8, '__DATA');
  u32(p + 24, 0x2000);
  u32(p + 28, 0x1000);
  u32(p + 32, 0x200);
  u32(p + 36, 0x100);
  i32(p + 40, 3);
  i32(p + 44, 3);
  u32(p + 48, 1);
  q = p + 56;
  put(q, '__mod_init_func');
  put(q + 16, '__DATA');
  u32(q + 32, 0x2000);
  u32(q + 36, pointers.length * 4);
  u32(q + 40, 0x200);
  u32(q + 44, 2);
  u32(q + 56, S_MOD_INIT);
  pointers.forEach((target, i) => u32(0x200 + i * 4, target));
  return bytes;
}

const partialReasons = (image) => image.metadata.machoMetadata.reasons || [];

test('8118-1: ARM64_32 S_MOD_INIT_FUNC_POINTERS with one 4-byte entry seeds the constructor', () => {
  const image = parseMachO(build64({ cpu: CPU_ARM64_32, pointers: [0x1180n], entryWidth: 4 }));
  assert.equal(image.arch, 'arm64_32');
  assert.equal(image.bits, 64);
  assert.equal(image.metadata.initializers?.length, 1, 'initializer metadata must be retained');
  assert.equal(image.metadata.initializers[0].address, 0x1180n);
  assert.equal(image.metadata.initializers[0].valid, true);
  const seed = image.functions.find((f) => f.address === 0x1180n);
  assert.ok(seed, 'loader-invoked ARM64_32 constructor must become a function seed');
  assert.equal(seed.source, 'constructor');
  assert.deepEqual(partialReasons(image), []);
  assert.equal(image.metadata.machoMetadata.complete, true);
});

test('8118-2: two ARM64_32 entries at +0 and +4 are both recovered', () => {
  const image = parseMachO(build64({ cpu: CPU_ARM64_32, pointers: [0x1180n, 0x1184n], entryWidth: 4 }));
  assert.deepEqual(
    (image.metadata.initializers || []).map((i) => i.address),
    [0x1180n, 0x1184n],
  );
  assert.deepEqual(
    image.functions.filter((f) => f.source === 'constructor').map((f) => f.address),
    [0x1180n, 0x1184n],
  );
  assert.deepEqual(partialReasons(image), []);
});

test('8118-3: ARM64_32 remainder is diagnosed against the 4-byte native width', () => {
  const image = parseMachO(build64({ cpu: CPU_ARM64_32, pointers: [0x1180n, 0x1184n], entryWidth: 4, modInitSize: 10 }));
  const reasons = partialReasons(image);
  assert.ok(reasons.includes('mod-init:truncated-section'), `expected truncated-section, got ${JSON.stringify(reasons)}`);
  const warning = image.warnings.find((w) => w.includes('not a multiple of pointer width'));
  assert.ok(warning, `expected a pointer-width diagnostic, got ${JSON.stringify(image.warnings)}`);
  assert.match(warning, /pointer width 4\b/);
  assert.equal(image.metadata.initializers.length, 2);
});

test('8118-4: LP64 arm64 and arm64e keep 8-byte lifecycle entries', () => {
  for (const [cpu, subtype] of [[CPU_ARM64, 0], [CPU_ARM64, 0x00200000]]) {
    const image = parseMachO(build64({ cpu, subtype, pointers: [0x1180n], entryWidth: 8 }));
    assert.equal(image.metadata.initializers?.length, 1);
    assert.equal(image.metadata.initializers[0].address, 0x1180n);
    assert.deepEqual(partialReasons(image), []);
  }
});

test('8118-5: MH_MAGIC_32 lifecycle entries remain 4-byte', () => {
  const image = parseMachO(build32({ pointers: [0x1180] }));
  assert.equal(image.metadata.initializers?.length, 1);
  assert.equal(image.metadata.initializers[0].address, 0x1180n);
  assert.deepEqual(partialReasons(image), []);
});

test('8118-6: ARM64_32 slot is never reinterpreted as a 64-bit word', () => {
  const image = parseMachO(build64({ cpu: CPU_ARM64_32, pointers: [0x1180n, 0x1184n], entryWidth: 4 }));
  for (const entry of image.metadata.initializers || []) {
    assert.ok(entry.raw <= 0xffffffffn, `raw slot 0x${entry.raw?.toString(16)} exceeds the 32-bit native pointer ABI`);
  }
});
