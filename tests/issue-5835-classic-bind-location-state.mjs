// Issue #5835 regression: classic bind streams must track whether
// BIND_OPCODE_SET_SEGMENT_AND_OFFSET_ULEB actually ran. Unset location state
// must not default to segment 0 + offset 0 and mint a fake bind site.
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

// SET_DYLIB_ORDINAL_IMM 1; SET_SYMBOL "_foo"; SET_TYPE pointer; DO_BIND; DONE
// — no SET_SEGMENT_AND_OFFSET_ULEB: dyld invalidates the bind (segment 0 with a
// file-backed extent is large enough that the old defaults minted a fake site).
{
  const { status, image } = fixture(Uint8Array.from([0x11, 0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00, 0x51, 0x90, 0x00]));
  assert.equal(status.complete, false, 'location-unset bind must not publish a complete stream');
  assert.equal(status.decodedBinds, 0);
  assert.equal(image.imports.length, 0, 'no canonical import without a set bind location');
  assert.ok(image.warnings.some((x) => x.includes('outside segment 0')), 'warning names the unset location');
}

// The same stream with SET_SEGMENT_AND_OFFSET_ULEB seg=0 off=0x10 stays valid.
{
  const { status, image } = fixture(Uint8Array.from([0x11, 0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00, 0x51, 0x70, 0x10, 0x90, 0x00]));
  assert.equal(status.complete, true);
  assert.equal(status.decodedBinds, 1);
  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].sites[0].address, 0x1010n);
}

// Repeated DO_BINDs keep using the one set location state (offset advances).
{
  const { status, image } = fixture(Uint8Array.from([0x11, 0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00, 0x51, 0x70, 0x00, 0x90, 0x90, 0x00]));
  assert.equal(status.complete, true);
  assert.equal(status.decodedBinds, 2);
}

// Threaded APPLY without a set location must fail closed as well.
{
  const { status, image } = fixture(Uint8Array.from([
    0x11,
    0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00,
    0xd0, 0x01,
    0x90,
    0xd1,
    0x00,
  ]));
  assert.equal(status.complete, false, 'threaded APPLY without SET_SEGMENT_AND_OFFSET must be partial');
  assert.equal(image.imports.length, 0);
}

// Threaded APPLY with the location set stays complete (fixture mirrors the
// real opcode shape: table, DO_BIND template, SET_SEGMENT+offset, APPLY).
{
  const bindEntry = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0x40]); // 1n<<62n: bind, delta 0
  const stream2 = new Uint8Array(0x100);
  stream2.set(bindEntry, 0x20);
  stream2.set(Uint8Array.from([
    0x11,
    0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00,
    0xd0, 0x01,
    0x90,
    0x70, 0x20,
    0xd1,
    0x00,
  ]), 0);
  const bytes = new Uint8Array(0x100);
  const segment = { address: 0x1000n, size: 0x80n };
  const image = {
    bits: 64, metadata: {}, warnings: [], imports: [], libraries: ['libA.dylib'],
    addressToOffset(address) { return address >= 0x1000n && address < 0x1080n ? address - 0x1000n : null; },
  };
  const status = parseClassicBindings(reader(stream2), { offset: 0, size: 14 }, image, [segment], 'bind');
  assert.equal(status.complete, true);
  assert.equal(image.imports[0].sites[0].kind, 'threaded-bind');
  assert.equal(image.imports[0].sites[0].address, 0x1020n);
}

// Threaded table entries are pointer-form only: a later SET_TYPE_IMM must not
// publish a non-pointer template through APPLY.
{
  const bindEntry = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0x40]);
  const stream3 = new Uint8Array(0x100);
  stream3.set(bindEntry, 0x20);
  stream3.set(Uint8Array.from([
    0x11,
    0x40, 0x5f, 0x66, 0x6f, 0x6f, 0x00,
    0xd0, 0x01,
    0x5f,
    0x90,
    0x70, 0x20,
    0xd1,
    0x00,
  ]), 0);
  const bytes = new Uint8Array(0x100);
  const segment = { address: 0x1000n, size: 0x80n };
  const image = {
    bits: 64, metadata: {}, warnings: [], imports: [], libraries: ['libA.dylib'],
    addressToOffset(address) { return address >= 0x1000n && address < 0x1080n ? address - 0x1000n : null; },
  };
  const status = parseClassicBindings(reader(stream3), { offset: 0, size: 16 }, image, [segment], 'bind');
  assert.equal(status.complete, false);
  assert.equal(image.imports.length, 0, 'non-pointer threaded template must not publish an import');
  assert.ok(image.warnings.some((x) => x.includes('unknown threaded bind type 15')));
}

console.log('issue #5835 classic bind location state regressions: PASS');
