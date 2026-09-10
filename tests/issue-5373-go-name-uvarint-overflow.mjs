import assert from 'node:assert/strict';
import { parseGoTypeDescriptor } from '../js/metadata/go.js';

function makeTypeWithNameBytes(nameBytes, { payloadBytes = null } = {}) {
  const typesBase = 128;
  const nameOff = 64;
  const strPos = typesBase + nameOff;
  const payload = payloadBytes ?? new Uint8Array();
  const buf = new Uint8Array(Math.max(512, strPos + 1 + nameBytes.length + payload.length + 8));
  const dv = new DataView(buf.buffer);

  // Minimal 64-bit abi.Type-shaped header. Keep the legacy/current reader field
  // (+24) and the actual Str slot (+40) pointed at the same name so this
  // regression stays focused on the uvarint decoder while the separate
  // abi.Type-layout issue is fixed independently.
  dv.setBigUint64(0, 8n, true);
  dv.setBigUint64(8, 0n, true);
  dv.setUint32(16, 0x12345678, true);
  buf[20] = 0;
  buf[21] = 8;
  buf[22] = 8;
  buf[23] = 25; // struct
  dv.setInt32(24, nameOff, true);
  dv.setInt32(40, nameOff, true);

  buf[strPos] = 0; // name flags
  buf.set(nameBytes, strPos + 1);
  buf.set(payload, strPos + 1 + nameBytes.length);
  return { buf, typesBase };
}

function parseName(nameBytes, payloadBytes = null) {
  const { buf, typesBase } = makeTypeWithNameBytes(nameBytes, { payloadBytes });
  return parseGoTypeDescriptor(buf, 0, { ptrSize:8, little:true, typesBase }).name;
}

// Positive controls: existing 1/2/3/4-byte uvarint decoding remains exact.
assert.equal(parseName(Uint8Array.of(0x01), Uint8Array.of(0x41)), 'A');
assert.equal(
  parseName(Uint8Array.of(0x80, 0x01), new Uint8Array(128).fill(0x41)).length,
  128,
);
assert.equal(
  parseName(Uint8Array.of(0x80, 0x80, 0x01), new Uint8Array(16384).fill(0x42)).length,
  16384,
);
assert.equal(
  parseName(Uint8Array.of(0x80, 0x80, 0x80, 0x01), new Uint8Array(1 << 21).fill(0x43)).length,
  1 << 21,
);

// #5373 minimal counterexample: 2^32 + 1 must not wrap to length 1.
const wrapped = parseName(
  Uint8Array.of(0x81, 0x80, 0x80, 0x80, 0x10),
  Uint8Array.of(0x41),
);
assert.match(wrapped, /^go_type_struct_0$/, 'huge declared name length must fail closed');
assert.notEqual(wrapped, 'A', '2^32+1 must never alias the one-byte length 1');

// Truncated / overlong continuation sequences remain fail-closed.
assert.match(parseName(Uint8Array.of(0x80)), /^go_type_struct_0$/);
assert.match(parseName(Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80)), /^go_type_struct_0$/);
assert.match(parseName(Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80, 0x00)), /^go_type_struct_0$/);

console.log('issue #5373 Go name uvarint overflow regression passed');
