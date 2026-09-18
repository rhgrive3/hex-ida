import assert from 'node:assert/strict';
import { parseClassicBindings } from '../js/binary/macho-dyld.js';

function reader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const leb = (p, end) => {
    let value = 0n, shift = 0n;
    const start = p;
    while (p < end && p - start < 10) {
      const b = bytes[p++];
      value |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return { value, next: p };
      shift += 7n;
    }
    throw new Error('truncated uleb');
  };
  return {
    length: bytes.length,
    bytes,
    u8: (o) => view.getUint8(o),
    u64: (o) => view.getBigUint64(o, true),
    uleb: (p, _max, end) => leb(p, end),
    sleb: (p, _max, end) => leb(p, end),
    slice: (p, n) => bytes.slice(p, p + n),
  };
}

function fixture(stream, source = 'bind') {
  const bytes = new Uint8Array(0x100);
  bytes.set(stream, 0);
  const segment = { address: 0x1000n, size: 0x80n };
  const image = {
    bits: 64,
    metadata: {},
    warnings: [],
    imports: [],
    libraries: ['libA.dylib'],
    addressToOffset(address) {
      return address >= 0x1000n && address < 0x1080n ? address - 0x1000n : null;
    },
  };
  const status = parseClassicBindings(reader(bytes), { offset: 0, size: stream.length }, image, [segment], source);
  return { status, image };
}

function streamFor(flags, source = 'bind') {
  const prefix = source === 'weak-bind' ? [] : [0x11];
  const type = source === 'lazy-bind' ? [] : [0x51];
  return Uint8Array.from([
    ...prefix,
    0x40 | flags, 0x5f, 0x78, 0x00,
    ...type,
    0x70, 0x00,
    0x90,
    0x00,
  ]);
}

for (const flags of [0, 1, 8, 9]) {
  const { status, image } = fixture(streamFor(flags));
  assert.equal(status.complete, true, `defined symbol flags 0x${flags.toString(16)} must remain valid`);
  assert.equal(status.decodedBinds, 1);
  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].symbolFlags, flags);
  assert.equal(image.imports[0].weak, !!(flags & 1));
  assert.equal(image.imports[0].nonWeakDefinition, !!(flags & 8));
}

for (const flags of [2, 4, 6, 7, 10, 15]) {
  const { status, image } = fixture(streamFor(flags));
  assert.equal(status.complete, false, `reserved symbol flags 0x${flags.toString(16)} must make the stream partial`);
  assert.equal(status.decodedBinds, 0);
  assert.equal(image.imports.length, 0, 'reserved symbol flags must not mint canonical imports');
  assert.ok(image.warnings.some((warning) => warning.includes('reserved symbol flags')));
}

for (const source of ['bind', 'weak-bind', 'lazy-bind']) {
  const { status, image } = fixture(streamFor(2, source), source);
  assert.equal(status.complete, false, `${source} must reject reserved symbol flags`);
  assert.equal(image.imports.length, 0, `${source} must not publish invalid symbol flags`);
}

console.log('issue #4741 classic bind symbol flag validation regressions: PASS');
