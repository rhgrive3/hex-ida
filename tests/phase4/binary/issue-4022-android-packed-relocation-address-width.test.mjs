import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAndroidPackedRelocations } from '../../../js/binary/elf-extended.js';

const DT_ANDROID_REL = 0x6000000fn;
const DT_ANDROID_RELSZ = 0x60000010n;
const GROUPED_BY_INFO = 1n;
const GROUPED_BY_OFFSET_DELTA = 2n;

function sleb(value) {
  let n = BigInt(value);
  const out = [];
  while (true) {
    let byte = Number(n & 0x7fn);
    const sign = (byte & 0x40) !== 0;
    n >>= 7n;
    const done = (n === 0n && !sign) || (n === -1n && sign);
    if (!done) byte |= 0x80;
    out.push(byte);
    if (done) return out;
  }
}

function reader(bytes) {
  const data = Uint8Array.from(bytes);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    length:data.byteLength,
    u8(offset) { return view.getUint8(offset); },
    u16(offset) { return view.getUint16(offset, true); },
    u32(offset) { return view.getUint32(offset, true); },
    u64(offset) { return view.getBigUint64(offset, true); },
  };
}

function image(byteLength) {
  return {
    metadata:{},
    warnings:[],
    segments:[{
      address:0x2000n,
      size:BigInt(byteLength),
      fileOffset:0n,
      fileSize:BigInt(byteLength),
      perms:{ read:true, write:false, execute:false },
    }],
  };
}

function packedTable({ bits, initialOffset, relocationCount = 1n, groups }) {
  const bytes = [0x41, 0x50, 0x53, 0x32, ...sleb(relocationCount), ...sleb(initialOffset)];
  for (const group of groups) {
    const flags = BigInt(group.flags ?? 0);
    const groupedDelta = (flags & GROUPED_BY_OFFSET_DELTA) !== 0n;
    const groupedInfo = (flags & GROUPED_BY_INFO) !== 0n;
    bytes.push(...sleb(group.size), ...sleb(flags));
    if (groupedDelta) bytes.push(...sleb(group.delta));
    if (groupedInfo) bytes.push(...sleb(group.info));
    if (!groupedDelta || !groupedInfo) {
      for (const entry of group.entries ?? []) {
        if (!groupedDelta) bytes.push(...sleb(entry.delta));
        if (!groupedInfo) bytes.push(...sleb(entry.info));
      }
    }
  }
  const img = image(bytes.length);
  const tags = new Map([
    [DT_ANDROID_REL, [0x2000n]],
    [DT_ANDROID_RELSZ, [BigInt(bytes.length)]],
  ]);
  const out = collectAndroidPackedRelocations(reader(bytes), tags, img, bits);
  return { out, image:img };
}

function assertPartial(result) {
  assert.equal(result.image.metadata.programDynamicPartial, true);
  assert.ok(
    result.image.metadata.programDynamicDiagnostics?.some((message) =>
      message.includes('relocation offset exceeds ELF address width')),
    'address-width violation must retain an explicit partial diagnostic',
  );
}

test('#4022 keeps normal ELF32 APS2 relocation offsets', () => {
  const result = packedTable({
    bits:32,
    initialOffset:0x1000n,
    groups:[{ size:1n, flags:0n, entries:[{ delta:0x20n, info:0x101n }] }],
  });
  assert.equal(result.image.metadata.programDynamicPartial, undefined);
  assert.deepEqual(result.out.map((entry) => entry.address), [0x1020n]);
  assert.equal(result.out[0].symIndex, 1);
  assert.equal(result.out[0].type, 1);
});

test('#4022 rejects an ELF32 per-relocation delta that crosses 2^32', () => {
  const result = packedTable({
    bits:32,
    initialOffset:0xfffffff0n,
    groups:[{ size:1n, flags:0n, entries:[{ delta:0x20n, info:1n }] }],
  });
  assert.deepEqual(result.out, []);
  assertPartial(result);
});

test('#4022 rejects an ELF32 initial offset outside its address domain', () => {
  const result = packedTable({
    bits:32,
    initialOffset:0x1_0000_0000n,
    groups:[{ size:1n, flags:0n, entries:[{ delta:0n, info:1n }] }],
  });
  assert.deepEqual(result.out, []);
  assertPartial(result);
});

test('#4022 validates grouped offset deltas against the ELF32 address width', () => {
  const result = packedTable({
    bits:32,
    initialOffset:0xfffffff0n,
    groups:[{
      size:1n,
      flags:GROUPED_BY_INFO | GROUPED_BY_OFFSET_DELTA,
      delta:0x20n,
      info:1n,
    }],
  });
  assert.deepEqual(result.out, []);
  assertPartial(result);
});

test('#4022 preserves a valid ELF64 boundary relocation then rejects cumulative overflow', () => {
  const result = packedTable({
    bits:64,
    initialOffset:0x7fffffffffffffffn,
    relocationCount:2n,
    groups:[{
      size:2n,
      flags:GROUPED_BY_INFO,
      info:1n,
      entries:[
        { delta:0x7fffffffffffffffn },
        { delta:2n },
      ],
    }],
  });
  assert.deepEqual(result.out.map((entry) => entry.address), [0xfffffffffffffffen]);
  assertPartial(result);
});

test('#4022 keeps the existing negative-offset rejection fail-closed', () => {
  const result = packedTable({
    bits:32,
    initialOffset:0n,
    groups:[{ size:1n, flags:0n, entries:[{ delta:-1n, info:1n }] }],
  });
  assert.deepEqual(result.out, []);
  assert.equal(result.image.metadata.programDynamicPartial, true);
});
