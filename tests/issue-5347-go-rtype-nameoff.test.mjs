import assert from 'node:assert/strict';
import { parseGoTypeDescriptor } from '../js/metadata/go.js';

function putEncodedName(bytes, offset, text, flags = 0) {
  const encoded = new TextEncoder().encode(text);
  assert.ok(encoded.length < 0x80, 'fixture helper only supports single-byte name lengths');
  bytes[offset] = flags;
  bytes[offset + 1] = encoded.length;
  bytes.set(encoded, offset + 2);
}

function makeTypeFixture({ ptrSize, little = true, strOffset = 0x60, equalLow32 = 0, kind = 25 }) {
  const bytes = new Uint8Array(0x100);
  const view = new DataView(bytes.buffer);
  const fixed = ptrSize * 2;
  if (ptrSize === 8) {
    view.setBigUint64(0, 24n, little);
    view.setBigUint64(8, 8n, little);
    view.setBigUint64(fixed + 8, BigInt(equalLow32 >>> 0), little);
    view.setBigUint64(fixed + 8 + ptrSize, 0n, little);
  } else {
    view.setUint32(0, 24, little);
    view.setUint32(4, 8, little);
    view.setUint32(fixed + 8, equalLow32 >>> 0, little);
    view.setUint32(fixed + 8 + ptrSize, 0, little);
  }
  view.setUint32(fixed, 0x12345678, little);
  bytes[fixed + 4] = 2;
  bytes[fixed + 5] = ptrSize;
  bytes[fixed + 6] = ptrSize;
  bytes[fixed + 7] = kind;
  view.setInt32(ptrSize * 4 + 8, strOffset, little);
  view.setInt32(ptrSize * 4 + 12, 0, little);
  return bytes;
}

// 64-bit abi.Type: Str is after the Equal and GCData pointer fields.
{
  const bytes = makeTypeFixture({ ptrSize: 8, equalLow32: 0x70 });
  putEncodedName(bytes, 0x60, 'actual64');
  putEncodedName(bytes, 0x70, 'equal-decoy');
  const desc = parseGoTypeDescriptor(bytes, 0, { ptrSize: 8, little: true, typesBase: 0 });
  assert.equal(desc?.name, 'actual64');
  assert.equal(desc?.kind, 'struct');
  assert.equal(desc?.size, 24);
  assert.equal(desc?.ptrdata, 8);
  assert.equal(desc?.hash, 0x12345678);
  assert.equal(desc?.tflag, 2);
  assert.equal(desc?.align, 8);
  assert.equal(desc?.fieldAlign, 8);
}

// 32-bit abi.Type has the same fields with pointer-width-dependent offsets.
{
  const bytes = makeTypeFixture({ ptrSize: 4, equalLow32: 0x70 });
  putEncodedName(bytes, 0x60, 'actual32');
  putEncodedName(bytes, 0x70, 'equal-decoy');
  const desc = parseGoTypeDescriptor(bytes, 0, { ptrSize: 4, little: true, typesBase: 0 });
  assert.equal(desc?.name, 'actual32');
}

// Endianness applies to NameOff just like the other scalar fields.
{
  const bytes = makeTypeFixture({ ptrSize: 8, little: false, equalLow32: 0x70 });
  putEncodedName(bytes, 0x60, 'big-endian');
  putEncodedName(bytes, 0x70, 'equal-decoy');
  const desc = parseGoTypeDescriptor(bytes, 0, { ptrSize: 8, little: false, typesBase: 0 });
  assert.equal(desc?.name, 'big-endian');
}

// A valid Equal low word must never become type-name authority when Str is invalid.
{
  const bytes = makeTypeFixture({ ptrSize: 8, strOffset: 0x7fffffff, equalLow32: 0x70, kind: 24 });
  putEncodedName(bytes, 0x70, 'wrong-name');
  const desc = parseGoTypeDescriptor(bytes, 0, { ptrSize: 8, little: true, typesBase: 0 });
  assert.equal(desc?.name, 'go_type_string_0');
}

// The complete 4-byte NameOff field must be present before decoding a descriptor.
{
  const bytes = new Uint8Array(47); // 64-bit abi.Type is 48 bytes through PtrToThis.
  bytes[23] = 24;
  assert.equal(parseGoTypeDescriptor(bytes, 0, { ptrSize: 8, little: true, typesBase: 0 }), null);
}

// Unsupported pointer-width layouts are not guessed.
{
  const bytes = new Uint8Array(128);
  assert.equal(parseGoTypeDescriptor(bytes, 0, { ptrSize: 16, little: true, typesBase: 0 }), null);
}

// Extracted from a real linux/amd64 Go 1.23.2 binary. runtime.types was at
// file offset 0x91000 and reflect.TypeOf((*main.Sample)(nil)) at 0x96820,
// so the descriptor is 0x5820 bytes from the types base. Only the exact
// descriptor and referenced encoded-name bytes are retained here.
{
  const bytes = new Uint8Array(0x5850);
  bytes.set(Buffer.from('0800000000000000080000000000000009f410bf0808083688944b000000000060484d00000000005028000000000000', 'hex'), 0x5820);
  bytes.set(Buffer.from('010c2a6d61696e2e53616d706c65000c777269746550616464696e67000c2a5b', 'hex'), 0x2850);
  const desc = parseGoTypeDescriptor(bytes, 0x5820, { ptrSize: 8, little: true, typesBase: 0 });
  assert.equal(desc?.kind, 'pointer');
  assert.equal(desc?.name, '*main.Sample');
  assert.equal(desc?.size, 8);
  assert.equal(desc?.ptrdata, 8);
}

console.log('issue-5347 Go abi.Type NameOff regression passed');
