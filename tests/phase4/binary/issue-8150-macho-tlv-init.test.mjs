import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMachO } from '../../../js/binary/macho.js';
import { parseMachOSource } from '../../../js/binary/source-loaders.js';

function build64({
  pointers = [0x1180n],
  sectionSize = pointers.length * 8,
  codeAddr = 0x1180n,
  codeSize = 4,
  dataAddr = 0x2000n,
  dataOffset = 0x300,
  sectionType = 0x15,
  withTlvInit = true,
} = {}) {
  const bytes = new Uint8Array(0x700);
  const v = new DataView(bytes.buffer);
  const u32 = (o, x) => v.setUint32(o, x >>> 0, true);
  const i32 = (o, x) => v.setInt32(o, x | 0, true);
  const u64 = (o, x) => v.setBigUint64(o, BigInt(x), true);
  const put = (o, s) => bytes.set(Buffer.from(s), o);

  bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  i32(4, 0x0100000c); // ARM64
  i32(8, 0);
  u32(12, 6); // MH_DYLIB
  u32(16, withTlvInit ? 2 : 1);
  u32(20, 152 + (withTlvInit ? 152 : 0));

  let p = 32;
  u32(p, 0x19); u32(p + 4, 152); put(p + 8, '__TEXT');
  u64(p + 24, 0x1000); u64(p + 32, 0x1000);
  u64(p + 40, 0); u64(p + 48, 0x200);
  i32(p + 56, 5); i32(p + 60, 5); u32(p + 64, 1);
  let q = p + 72;
  put(q, '__text'); put(q + 16, '__TEXT');
  u64(q + 32, codeAddr); u64(q + 40, BigInt(codeSize));
  u32(q + 48, 0x180); u32(q + 52, 2); u32(q + 64, 0x80000400);

  if (withTlvInit) {
    p += 152;
    u32(p, 0x19); u32(p + 4, 152); put(p + 8, '__DATA');
    u64(p + 24, 0x2000); u64(p + 32, 0x1000);
    u64(p + 40, BigInt(dataOffset));
    u64(p + 48, BigInt(Math.max(sectionSize, 0x20)));
    i32(p + 56, 3); i32(p + 60, 3); u32(p + 64, 1);
    q = p + 72;
    put(q, '__thread_init'); put(q + 16, '__DATA');
    u64(q + 32, dataAddr); u64(q + 40, BigInt(sectionSize));
    u32(q + 48, dataOffset); u32(q + 52, 3); u32(q + 64, sectionType);
  }

  u32(0x180, 0xd65f03c0); // ARM64 ret
  for (let i = 0; i < pointers.length; i++) {
    if (dataOffset + (i + 1) * 8 <= bytes.length) u64(dataOffset + i * 8, pointers[i]);
  }
  return bytes;
}

function build32({ pointer = 0x1180, sectionType = 0x15 } = {}) {
  const bytes = new Uint8Array(0x500);
  const v = new DataView(bytes.buffer);
  const u32 = (o, x) => v.setUint32(o, x >>> 0, true);
  const i32 = (o, x) => v.setInt32(o, x | 0, true);
  const put = (o, s) => bytes.set(Buffer.from(s), o);

  bytes.set([0xce, 0xfa, 0xed, 0xfe], 0);
  i32(4, 7); i32(8, 3); u32(12, 6); u32(16, 2); u32(20, 248);
  let p = 28;
  u32(p, 1); u32(p + 4, 124); put(p + 8, '__TEXT');
  u32(p + 24, 0x1000); u32(p + 28, 0x1000); u32(p + 32, 0); u32(p + 36, 0x200);
  i32(p + 40, 5); i32(p + 44, 5); u32(p + 48, 1);
  let q = p + 56;
  put(q, '__text'); put(q + 16, '__TEXT');
  u32(q + 32, 0x1180); u32(q + 36, 1); u32(q + 40, 0x180); u32(q + 44, 0); u32(q + 56, 0x80000400);

  p += 124;
  u32(p, 1); u32(p + 4, 124); put(p + 8, '__DATA');
  u32(p + 24, 0x2000); u32(p + 28, 0x1000); u32(p + 32, 0x200); u32(p + 36, 0x100);
  i32(p + 40, 3); i32(p + 44, 3); u32(p + 48, 1);
  q = p + 56;
  put(q, '__thread_init'); put(q + 16, '__DATA');
  u32(q + 32, 0x2000); u32(q + 36, 4); u32(q + 40, 0x200); u32(q + 44, 2); u32(q + 56, sectionType);

  bytes[0x180] = 0xc3;
  u32(0x200, pointer);
  return bytes;
}

test('valid S_THREAD_LOCAL_INIT_FUNCTION_POINTERS retains TLV lifecycle metadata and exact seed', () => {
  const image = parseMachO(build64());
  assert.equal(image.metadata.tlvInitializers?.length, 1);
  assert.deepEqual(image.metadata.tlvInitializers[0], {
    address: 0x1180n,
    raw: 0x1180n,
    slotAddress: 0x2000n,
    section: '__thread_init',
    valid: true,
  });
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].address, 0x1180n);
  assert.equal(image.functions[0].source, 'constructor');
  assert.equal(image.functions[0].exactFunctionStart, true);
  assert.equal(image.functions[0].abiMetadata?.machoLifecycle, 'tlv-initializer');
  assert.match(image.functions[0].functionStartEvidence, /S_THREAD_LOCAL_INIT_FUNCTION_POINTERS/);
  assert.equal(image.metadata.machoMetadata.complete, true);
});

test('multiple TLV initializer entries preserve order and deduplicate function seeds', () => {
  const bytes = build64({ pointers: [0x1180n, 0x1184n, 0x1180n], codeSize: 8 });
  new DataView(bytes.buffer).setUint32(0x184, 0xd65f03c0, true);
  const image = parseMachO(bytes);
  assert.deepEqual(image.metadata.tlvInitializers.map((x) => x.address), [0x1180n, 0x1184n, 0x1180n]);
  assert.deepEqual(image.functions.map((x) => x.address), [0x1180n, 0x1184n]);
  assert.equal(image.functions[0].abiMetadata?.machoLifecycle, 'tlv-initializer');
  assert.equal(image.functions[1].abiMetadata?.machoLifecycle, 'tlv-initializer');
});

test('misaligned ARM64 TLV target is retained but not promoted', () => {
  const image = parseMachO(build64({ pointers: [0x1182n] }));
  assert.equal(image.functions.length, 0);
  assert.equal(image.metadata.tlvInitializers[0].valid, false);
  assert.ok(image.metadata.machoMetadata.reasons.some((r) => r.includes('tlv-init:misaligned')));
});

test('unmapped and non-executable TLV targets fail closed', () => {
  for (const pointer of [0x999990n, 0x2000n]) {
    const image = parseMachO(build64({ pointers: [pointer] }));
    assert.equal(image.functions.length, 0);
    assert.equal(image.metadata.tlvInitializers[0].valid, false);
    assert.equal(image.metadata.machoMetadata.complete, false);
  }
});

test('executable zero-fill TLV target is not static function evidence', () => {
  const image = parseMachO(build64({ pointers: [0x1400n] }));
  assert.equal(image.functions.length, 0);
  assert.equal(image.metadata.tlvInitializers[0].valid, false);
  assert.ok(image.metadata.machoMetadata.reasons.some((r) => r.includes('tlv-init:not-file-backed')));
});

test('trailing partial TLV pointer is diagnosed without tail read', () => {
  const image = parseMachO(build64({ pointers: [0x1180n], sectionSize: 12 }));
  assert.equal(image.metadata.tlvInitializers.length, 1);
  assert.equal(image.functions.length, 1);
  assert.ok(image.metadata.machoMetadata.reasons.some((r) => r.includes('tlv-init:truncated-section')));
});

test('32-bit Mach-O TLV initializers use four-byte pointers', () => {
  const image = parseMachO(build32());
  assert.equal(image.metadata.tlvInitializers.length, 1);
  assert.equal(image.metadata.tlvInitializers[0].address, 0x1180n);
  assert.equal(image.functions.length, 1);
});

test('source-backed Mach-O fetches and decodes TLV initializer pointer bytes', async () => {
  const bytes = build64();
  const source = {
    size: BigInt(bytes.length),
    maxReadLength: 64,
    reads: 0,
    async read(offset, length) {
      this.reads++;
      const start = Number(offset);
      return bytes.slice(start, start + length);
    },
  };
  const image = await parseMachOSource(source, {}, null, {
    pageSize: 32,
    maxPageSize: 64,
    maxCachedBytes: 0x2000,
    maxReads: 128,
  });
  assert.equal(image.metadata.sourceBacked, true);
  assert.equal(image.metadata.tlvInitializers?.length, 1);
  assert.equal(image.metadata.tlvInitializers[0].address, 0x1180n);
  assert.equal(image.functions.some((fn) => fn.address === 0x1180n && fn.abiMetadata?.machoLifecycle === 'tlv-initializer'), true);
  assert.ok(source.reads > 1);
});

test('ordinary S_MOD_INIT_FUNC_POINTERS keeps existing initializer contract', () => {
  const image = parseMachO(build64({ sectionType: 0x9 }));
  assert.equal(image.metadata.initializers?.length, 1);
  assert.equal(image.metadata.tlvInitializers, undefined);
  assert.equal(image.functions[0].abiMetadata, null);
  assert.match(image.functions[0].functionStartEvidence, /S_MOD_INIT_FUNC_POINTERS/);
});

test('Mach-O without TLV initializer section is unchanged', () => {
  const image = parseMachO(build64({ withTlvInit: false }));
  assert.equal(image.metadata.tlvInitializers, undefined);
  assert.equal(image.metadata.initializers, undefined);
  assert.equal(image.functions.length, 0);
  assert.equal(image.metadata.machoMetadata.complete, true);
});
