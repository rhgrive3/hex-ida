import assert from 'node:assert/strict';
import { parseClassicBindings } from '../js/binary/macho-dyld.js';

function reader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const leb = (p, end) => {
    let value = 0n;
    let shift = 0n;
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

// SET_DYLIB_ORDINAL_IMM 1; SET_SYMBOL "_ok"; SET_SEGMENT 0 + 0; DO_BIND; DONE
{
  const { status, image } = fixture(Uint8Array.from([0x11, 0x40, 0x5f, 0x6f, 0x6b, 0x00, 0x70, 0x00, 0x90, 0x00]));
  assert.equal(status.complete, true);
  assert.equal(status.decodedBinds, 1);
  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].name, '_ok');
}

// A bind before SET_SYMBOL must fail closed instead of becoming a silent zero-result stream.
{
  const { status, image } = fixture(Uint8Array.from([0x70, 0x00, 0x90, 0x00]));
  assert.equal(status.complete, false);
  assert.equal(status.decodedBinds, 0);
  assert.equal(image.imports.length, 0);
  assert.ok(image.warnings.some((x) => x.includes('before a symbol was set')));
}

// A threaded ordinal table may collect exactly its declared number of templates.
{
  const { status, image } = fixture(Uint8Array.from([
    0xd0, 0x01,
    0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00,
    0x90,
    0x00,
  ]));
  assert.equal(status.complete, true);
  assert.equal(status.decodedBinds, 0);
  assert.equal(image.imports.length, 0);
}

// A second DO_BIND while collecting a size-1 threaded table is overflow, not an ordinary bind.
{
  const { status, image } = fixture(Uint8Array.from([
    0xd0, 0x01,
    0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00,
    0x90,
    0x40, 0x5f, 0x62, 0x61, 0x72, 0x00,
    0x90,
    0x00,
  ]));
  assert.equal(status.complete, false);
  assert.equal(status.decodedBinds, 0);
  assert.equal(image.imports.length, 0);
  assert.ok(image.warnings.some((x) => x.includes('exceeds declared 1 entries')));
}

// Lazy-bind DONE resets symbol state; a later DO_BIND without SET_SYMBOL must fail closed.
{
  const { status, image } = fixture(Uint8Array.from([
    0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00,
    0x70, 0x00,
    0x90,
    0x00,
    0x90,
    0x00,
  ]), 'lazy-bind');
  assert.equal(status.complete, false);
  assert.equal(status.decodedBinds, 1);
  assert.equal(image.imports.length, 1);
}
