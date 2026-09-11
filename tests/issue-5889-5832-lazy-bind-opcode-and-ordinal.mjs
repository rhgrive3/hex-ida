// Issue #5889 regression: dyld's lazy-bind decoder accepts only DONE, the
// dylib-ordinal setters, SET_SYMBOL_TRAILING_FLAGS_IMM, SET_ADDEND_SLEB,
// SET_SEGMENT_AND_OFFSET_ULEB and DO_BIND. Everything else is "bad lazy bind
// opcode" — including SET_TYPE_IMM (lazy binds carry an implicit pointer type)
// and the normal-bind location arithmetic opcodes.
// Issue #5832 regression: normal/lazy binds must have set a library ordinal
// explicitly; only weak-bind carries dyld's implicit ordinal (-3).
import assert from 'node:assert/strict';
import { parseClassicBindings } from '../js/binary/macho-dyld.js';

function reader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const leb = (p, end) => {
    let value = 0n, shift = 0n; const start = p;
    while (p < end && p - start < 10) {
      const b = bytes[p++];
      value |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return { value, next: p };
      shift += 7n;
    }
    throw new Error('truncated uleb');
  };
  return {
    length: bytes.length, bytes,
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
    bits: 64, metadata: {}, warnings: [], imports: [], libraries: ['libA.dylib'],
    addressToOffset(address) { return address >= 0x1000n && address < 0x1080n ? address - 0x1000n : null; },
  };
  const status = parseClassicBindings(reader(bytes), { offset: 0, size: stream.length }, image, [segment], source);
  return { status, image };
}

// #5889 — each forbidden opcode in a lazy-bind stream must make it partial.
const FORBIDDEN = [
  ['SET_TYPE_IMM', [0x52]],
  ['ADD_ADDR_ULEB', [0x80, 0x08]],
  ['DO_BIND_ADD_ADDR_ULEB', [0xa0, 0x08]],
  ['DO_BIND_ADD_ADDR_IMM_SCALED', [0xb2]],
  ['DO_BIND_ULEB_TIMES_SKIPPING_ULEB', [0xc0, 0x01, 0x00]],
];
for (const [name, bytes] of FORBIDDEN) {
  const stream = Uint8Array.from([0x11, 0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00, 0x70, 0x00, ...bytes, 0x90, 0x00]);
  const { status, image } = fixture(stream, 'lazy-bind');
  assert.equal(status.complete, false, `lazy-bind ${name} must make the stream partial`);
  assert.equal(status.decodedBinds, 0, `lazy-bind ${name} must not mint a bind site`);
  assert.equal(image.imports.length, 0);
  assert.ok(image.warnings.some((x) => x.includes('bad lazy bind opcode')), `warning must name the bad lazy-bind opcode: ${name}`);
}

// The same opcodes remain valid in a normal bind stream (control).
{
  const { status, image } = fixture(Uint8Array.from([0x11, 0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00, 0x70, 0x00, 0x52, 0x90, 0x00]), 'bind');
  assert.equal(status.complete, true, 'SET_TYPE_IMM stays valid in a normal bind');
  assert.equal(status.decodedBinds, 1);
}

// A clean lazy-bind stream (implicit pointer type, explicit ordinal) stays valid.
{
  const { status, image } = fixture(Uint8Array.from([0x11, 0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00, 0x70, 0x00, 0x90, 0x00]), 'lazy-bind');
  assert.equal(status.complete, true);
  assert.equal(status.decodedBinds, 1);
  assert.equal(image.imports[0].sites[0].type, 1);
}

// #5832 — a normal bind without any ordinal setter fails closed.
{
  const { status, image } = fixture(Uint8Array.from([0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00, 0x51, 0x70, 0x00, 0x90, 0x00]), 'bind');
  assert.equal(status.complete, false, 'normal bind without SET_DYLIB_ORDINAL must be partial');
  assert.equal(status.decodedBinds, 0);
  assert.equal(image.imports.length, 0);
  assert.ok(image.warnings.some((x) => x.includes('missing preceding BIND_OPCODE_SET_DYLIB_ORDINAL')));
}

// #5832 — a lazy-bind entry without an ordinal setter (after DONE reset) fails closed.
{
  const { status, image } = fixture(Uint8Array.from([
    0x11, 0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00, 0x70, 0x00, 0x90, 0x00, // entry 1 with ordinal
    0x40, 0x5f, 0x62, 0x61, 0x72, 0x00, 0x90, 0x00,                   // entry 2 without
  ]), 'lazy-bind');
  assert.equal(status.complete, false, 'lazy entry without SET_DYLIB_ORDINAL must be partial');
  assert.equal(status.decodedBinds, 1, 'only the entry with an explicit ordinal decodes');
  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].ordinal, 1);
}

// #5832 — weak-bind keeps dyld's implicit ordinal (-3) without any setter.
{
  const { status, image } = fixture(Uint8Array.from([0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00, 0x51, 0x70, 0x00, 0x90, 0x00]), 'weak-bind');
  assert.equal(status.complete, true, 'weak bind keeps its implicit ordinal contract');
  assert.equal(status.decodedBinds, 1);
  assert.equal(image.imports[0].ordinal, -3);
}

console.log('issues #5889/#5832 lazy-bind opcode + ordinal provenance regressions: PASS');
