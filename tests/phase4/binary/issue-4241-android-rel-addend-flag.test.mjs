import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAndroidPackedRelocations } from '../../../js/binary/elf-extended.js';

const DT_ANDROID_REL = 0x6000000fn;
const DT_ANDROID_RELSZ = 0x60000010n;
const DT_ANDROID_RELA = 0x60000011n;
const DT_ANDROID_RELASZ = 0x60000012n;

const GROUPED_BY_INFO = 1n;
const GROUPED_BY_OFFSET_DELTA = 2n;
const GROUPED_BY_ADDEND = 4n;
const GROUP_HAS_ADDEND = 8n;

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
    length: data.byteLength,
    u8(offset) { return view.getUint8(offset); },
    u16(offset) { return view.getUint16(offset, true); },
    u32(offset) { return view.getUint32(offset, true); },
    u64(offset) { return view.getBigUint64(offset, true); },
  };
}

function image(byteLength) {
  return {
    metadata: {},
    warnings: [],
    segments: [{
      address: 0x2000n,
      size: BigInt(byteLength),
      fileOffset: 0n,
      fileSize: BigInt(byteLength),
      perms: { read:true, write:false, execute:false },
    }],
  };
}

function table({
  rela = false,
  relocationCount = 1n,
  initialOffset = 0n,
  groups,
}) {
  const bytes = [0x41, 0x50, 0x53, 0x32, ...sleb(relocationCount), ...sleb(initialOffset)];
  for (const group of groups) {
    const flags = BigInt(group.flags ?? 0);
    const groupedDelta = (flags & GROUPED_BY_OFFSET_DELTA) !== 0n;
    const groupedInfo = (flags & GROUPED_BY_INFO) !== 0n;
    const hasAddend = (flags & GROUP_HAS_ADDEND) !== 0n;
    const groupedAddend = (flags & GROUPED_BY_ADDEND) !== 0n;
    bytes.push(...sleb(group.size), ...sleb(flags));
    if (groupedDelta) bytes.push(...sleb(group.delta));
    if (groupedInfo) bytes.push(...sleb(group.info));
    if (hasAddend && groupedAddend) bytes.push(...sleb(group.addend));
    if (!groupedDelta || !groupedInfo || (hasAddend && !groupedAddend)) {
      for (const entry of group.entries ?? []) {
        if (!groupedDelta) bytes.push(...sleb(entry.delta));
        if (!groupedInfo) bytes.push(...sleb(entry.info));
        if (hasAddend && !groupedAddend) bytes.push(...sleb(entry.addend));
      }
    }
  }
  const img = image(bytes.length);
  const tags = new Map(rela
    ? [[DT_ANDROID_RELA, [0x2000n]], [DT_ANDROID_RELASZ, [BigInt(bytes.length)]]]
    : [[DT_ANDROID_REL, [0x2000n]], [DT_ANDROID_RELSZ, [BigInt(bytes.length)]]]);
  const out = collectAndroidPackedRelocations(reader(bytes), tags, img, 64);
  return { out, image: img, bytes };
}

function assertClean(result) {
  assert.equal(result.image.metadata.programDynamicPartial, undefined);
  assert.deepEqual(result.image.metadata.programDynamicDiagnostics ?? [], []);
}

function assertMalformedRel(result) {
  assert.equal(result.out.length, 0, 'malformed Android REL must publish no canonical relocation');
  assert.equal(result.image.metadata.programDynamicPartial, true);
  assert.ok(
    result.image.metadata.programDynamicDiagnostics?.some((message) =>
      message.includes('unexpected r_addend in Android REL packed relocation group')),
    'format violation must retain an explicit partial diagnostic',
  );
}

test('#4241 normal Android REL without addend flag remains decodable', () => {
  const result = table({
    groups: [{ size:1n, flags:0n, entries:[{ delta:0x20n, info:(1n << 32n) | 7n }] }],
  });
  assertClean(result);
  assert.deepEqual(result.out, [{
    address:0x20n,
    symIndex:1,
    type:7,
    addend:null,
    source:'PT_DYNAMIC-ANDROID-REL',
  }]);
});

test('#4241 grouped Android REL without addends preserves grouped delta/info decoding', () => {
  const result = table({
    groups: [{
      size:1n,
      flags:GROUPED_BY_INFO | GROUPED_BY_OFFSET_DELTA,
      delta:0x20n,
      info:(2n << 32n) | 11n,
    }],
  });
  assertClean(result);
  assert.equal(result.out.length, 1);
  assert.equal(result.out[0].address, 0x20n);
  assert.equal(result.out[0].symIndex, 2);
  assert.equal(result.out[0].type, 11);
  assert.equal(result.out[0].addend, null);
});

test('#4241 Android REL rejects per-relocation GROUP_HAS_ADDEND before publishing output', () => {
  const result = table({
    groups: [{
      size:1n,
      flags:GROUP_HAS_ADDEND,
      entries:[{ delta:0x20n, info:7n, addend:5n }],
    }],
  });
  assertMalformedRel(result);
});

test('#4241 Android REL rejects grouped addends as the same REL/RELA format violation', () => {
  const result = table({
    groups: [{
      size:1n,
      flags:GROUP_HAS_ADDEND | GROUPED_BY_ADDEND,
      addend:5n,
      entries:[{ delta:0x20n, info:7n }],
    }],
  });
  assertMalformedRel(result);
});

test('#4241 malformed Android REL group does not consume/resynchronize into a later group', () => {
  const result = table({
    relocationCount:2n,
    groups: [
      {
        size:1n,
        flags:GROUP_HAS_ADDEND,
        entries:[{ delta:0x20n, info:7n, addend:5n }],
      },
      {
        size:1n,
        flags:GROUPED_BY_INFO | GROUPED_BY_OFFSET_DELTA,
        delta:8n,
        info:9n,
      },
    ],
  });
  assertMalformedRel(result);
});

test('#4241 Android RELA preserves per-relocation addend decoding', () => {
  const result = table({
    rela:true,
    groups: [{
      size:1n,
      flags:GROUP_HAS_ADDEND,
      entries:[{ delta:0x20n, info:(1n << 32n) | 7n, addend:5n }],
    }],
  });
  assertClean(result);
  assert.equal(result.out.length, 1);
  assert.equal(result.out[0].address, 0x20n);
  assert.equal(result.out[0].addend, 5n);
});

test('#4241 Android RELA preserves grouped addend decoding', () => {
  const result = table({
    rela:true,
    relocationCount:2n,
    groups: [{
      size:2n,
      flags:GROUPED_BY_INFO | GROUPED_BY_OFFSET_DELTA | GROUPED_BY_ADDEND | GROUP_HAS_ADDEND,
      delta:0x20n,
      info:(1n << 32n) | 7n,
      addend:3n,
    }],
  });
  assertClean(result);
  assert.equal(result.out.length, 2);
  assert.deepEqual(result.out.map((entry) => entry.address), [0x20n, 0x40n]);
  assert.deepEqual(result.out.map((entry) => entry.addend), [3n, 6n]);
});
