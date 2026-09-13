import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMachO } from '../../../js/binary/macho.js';
import { parseClassicBindings } from '../../../js/binary/macho-dyld.js';

const CPU_TYPE_ARM64_32 = 0x0200000c;

function reader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const leb = (p, end) => {
    let value = 0n;
    let shift = 0n;
    const start = p;
    while (p < end && p - start < 10) {
      const byte = bytes[p++];
      value |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return { value, next: p };
      shift += 7n;
    }
    throw new Error('truncated uleb');
  };
  return {
    length: bytes.length,
    bytes,
    u8: (offset) => view.getUint8(offset),
    u64: (offset) => view.getBigUint64(offset, true),
    uleb: (p, _max, end) => leb(p, end),
    sleb: (p, _max, end) => leb(p, end),
    slice: (p, n) => bytes.slice(p, p + n),
  };
}

function directFixture(stream, { arch = 'arm64_32', bits = 64, source = 'bind', segmentSize = 0x40n } = {}) {
  const bytes = new Uint8Array(0x100);
  bytes.set(stream, 0);
  const segment = { address: 0x1000n, size: segmentSize };
  const image = {
    arch,
    bits,
    metadata: {},
    warnings: [],
    imports: [],
    libraries: ['libX.dylib'],
    addressToOffset(address) {
      return address >= segment.address && address < segment.address + segment.size
        ? address - segment.address
        : null;
    },
  };
  const status = parseClassicBindings(reader(bytes), { offset: 0, size: stream.length }, image, [segment], source);
  return { image, status };
}

const PREFIX = [0x11, 0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00, 0x51, 0x70, 0x00];
const LAZY_PREFIX = [0x11, 0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00, 0x70, 0x00];
const WEAK_PREFIX = [0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00, 0x51, 0x70, 0x00];

function sites(image) {
  return image.imports.flatMap((imp) => imp.sites.map((site) => site.address));
}

function publicFixture({ cpu = CPU_TYPE_ARM64_32, segmentSize = 4n } = {}) {
  const bytes = new Uint8Array(0x300);
  const view = new DataView(bytes.buffer);
  const u32 = (offset, value) => view.setUint32(offset, value >>> 0, true);
  const i32 = (offset, value) => view.setInt32(offset, value | 0, true);
  const u64 = (offset, value) => view.setBigUint64(offset, BigInt(value), true);
  const put = (offset, value) => bytes.set(new TextEncoder().encode(value), offset);

  u32(0, 0xfeedfacf);
  i32(4, cpu);
  i32(8, 1);
  u32(12, 6);
  u32(16, 3);
  u32(20, 72 + 32 + 48);

  let p = 32;
  u32(p, 0x19); u32(p + 4, 72); put(p + 8, '__DATA');
  u64(p + 24, 0x1000n); u64(p + 32, segmentSize);
  u64(p + 40, 0x180n); u64(p + 48, segmentSize);
  i32(p + 56, 3); i32(p + 60, 3); u32(p + 64, 0); u32(p + 68, 0);
  p += 72;

  u32(p, 0x0c); u32(p + 4, 32); u32(p + 8, 24); put(p + 24, 'libX\0');
  p += 32;

  const bindOffset = 0x200;
  const stream = Uint8Array.from([...PREFIX, 0x90, 0x00]);
  u32(p, 0x80000022); u32(p + 4, 48);
  u32(p + 16, bindOffset); u32(p + 20, stream.length);
  bytes.set(stream, bindOffset);
  return bytes;
}

test('public parseMachO keeps ARM64_32 as a 64-bit Mach-O class but accepts a final 4-byte classic bind slot', () => {
  const image = parseMachO(publicFixture());
  assert.equal(image.arch, 'arm64_32');
  assert.equal(image.bits, 64);
  assert.equal(image.metadata.dyldBindings.streams.bind.complete, true);
  assert.equal(image.imports.length, 1);
  assert.deepEqual(sites(image), [0x1000n]);
});

test('ARM64_32 DO_BIND advances by the 4-byte native pointer width', () => {
  const { image, status } = directFixture(Uint8Array.from([...PREFIX, 0x90, 0x90, 0x00]), { segmentSize: 8n });
  assert.equal(status.complete, true);
  assert.deepEqual(sites(image), [0x1000n, 0x1004n]);
});

test('ARM64_32 DO_BIND_ADD_ADDR_ULEB advances by 4 plus the ULEB addend', () => {
  const { image, status } = directFixture(Uint8Array.from([...PREFIX, 0xa0, 0x02, 0x90, 0x00]), { segmentSize: 10n });
  assert.equal(status.complete, true);
  assert.deepEqual(sites(image), [0x1000n, 0x1006n]);
});

test('ARM64_32 DO_BIND_ADD_ADDR_IMM_SCALED scales by 4 bytes', () => {
  const { image, status } = directFixture(Uint8Array.from([...PREFIX, 0xb1, 0x90, 0x00]), { segmentSize: 12n });
  assert.equal(status.complete, true);
  assert.deepEqual(sites(image), [0x1000n, 0x1008n]);
});

test('ARM64_32 repeat/skip binding uses a 4-byte pointer step and capacity proof', () => {
  const { image, status } = directFixture(Uint8Array.from([...PREFIX, 0xc0, 0x02, 0x01, 0x00]), { segmentSize: 9n });
  assert.equal(status.complete, true);
  assert.deepEqual(sites(image), [0x1000n, 0x1005n]);
});

test('ARM64_32 weak and lazy binding share the 4-byte final-slot bound', () => {
  const weak = directFixture(Uint8Array.from([...WEAK_PREFIX, 0x90, 0x00]), { source: 'weak-bind', segmentSize: 4n });
  assert.equal(weak.status.complete, true);
  assert.deepEqual(sites(weak.image), [0x1000n]);

  const lazy = directFixture(Uint8Array.from([...LAZY_PREFIX, 0x90, 0x00]), { source: 'lazy-bind', segmentSize: 4n });
  assert.equal(lazy.status.complete, true);
  assert.deepEqual(sites(lazy.image), [0x1000n]);
});

test('LP64 ARM64 and ARM64e controls retain the 8-byte classic bind stride', () => {
  for (const arch of ['arm64', 'arm64e']) {
    const { image, status } = directFixture(Uint8Array.from([...PREFIX, 0x90, 0x90, 0x00]), { arch, segmentSize: 16n });
    assert.equal(status.complete, true, arch);
    assert.deepEqual(sites(image), [0x1000n, 0x1008n], arch);
  }
});

test('ARM64_32 threaded APPLY still requires its 8-byte encoded chain word', () => {
  const stream = Uint8Array.from([
    0xd0, 0x01,
    0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00,
    0x90,
    0x70, 0x00,
    0xd1,
    0x00,
  ]);
  const { image, status } = directFixture(stream, { segmentSize: 4n });
  assert.equal(status.complete, false);
  assert.equal(status.threadedApplies, 0);
  assert.ok(image.warnings.some((warning) => warning.includes('threaded APPLY starts outside its segment')));
});
