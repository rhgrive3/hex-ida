import assert from 'node:assert/strict';
import { parseEhFrameHeader } from '../../js/binary/elf-unwind.js';

function reader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    length: bytes.length,
    u8: (o) => view.getUint8(o),
    u16: (o) => view.getUint16(o, true),
    i16: (o) => view.getInt16(o, true),
    u32: (o) => view.getUint32(o, true),
    i32: (o) => view.getInt32(o, true),
    u64: (o) => view.getBigUint64(o, true),
    i64: (o) => view.getBigInt64(o, true),
  };
}

function image(textBase = 0x4000n) {
  return {
    warnings: [],
    metadata: {},
    functions: [],
    segments: [{ address: textBase, perms: { execute: true } }],
    sectionAt() { return null; },
    segmentAt() { return null; },
    addressToOffset() { return null; },
  };
}

function writeHeader(bytes, offset, ehFrameEnc, countEnc = 0x03) {
  bytes[offset] = 1;
  bytes[offset + 1] = ehFrameEnc;
  bytes[offset + 2] = countEnc;
  bytes[offset + 3] = 0x03;
}

function putPointer(view, offset, bits, value) {
  if (bits === 64) view.setBigUint64(offset, BigInt(value), true);
  else view.setUint32(offset, Number(BigInt(value) & 0xffffffffn), true);
}

function parseAligned({ bits, offset, address, size = 0x40, pointer = 0x3000n, countEnc = 0x03 }) {
  const bytes = new Uint8Array(0x400);
  const view = new DataView(bytes.buffer);
  writeHeader(bytes, offset, 0x50, countEnc);

  const ptrBytes = bits / 8;
  const p0 = offset + 4;
  const alignment = BigInt(ptrBytes);
  const fieldAddress = BigInt(address) + BigInt(p0 - offset);
  const padding = Number((alignment - (fieldAddress % alignment)) % alignment);
  const pointerOffset = p0 + padding;
  for (let p = p0; p < pointerOffset; p++) bytes[p] = 0xaa;
  putPointer(view, pointerOffset, bits, pointer);
  if (countEnc !== 0xff) view.setUint32(pointerOffset + ptrBytes, 0, true);

  const img = image();
  const sec = { addr: BigInt(address), offset: BigInt(offset), size: BigInt(size) };
  parseEhFrameHeader(reader(bytes), sec, img, bits, null);
  return { img, pointerOffset };
}

// 64-bit: file and runtime alignment phases differ by four bytes. The pointer
// starts at file 0x10c because p0=0x108 maps to VA 0x2004, whose next native
// pointer-aligned address is 0x2008.
{
  const { img, pointerOffset } = parseAligned({ bits: 64, offset: 0x104, address: 0x2000n });
  assert.equal(pointerOffset, 0x10c);
  assert.equal(img.metadata.ehFrameHeader?.ehFrameAddress, 0x3000n);
}

// Congruent file/VA phases preserve the previous result.
{
  const { img, pointerOffset } = parseAligned({ bits: 64, offset: 0x100, address: 0x2000n });
  assert.equal(pointerOffset, 0x108);
  assert.equal(img.metadata.ehFrameHeader?.ehFrameAddress, 0x3000n);
}

// 32-bit also aligns the mapped address rather than the file coordinate. Here
// p0=0x106 already maps to aligned VA 0x2004, so no file padding is allowed.
{
  const { img, pointerOffset } = parseAligned({ bits: 32, offset: 0x102, address: 0x2000n });
  assert.equal(pointerOffset, 0x106);
  assert.equal(img.metadata.ehFrameHeader?.ehFrameAddress, 0x3000n);
}

// Alignment padding remains inside the existing bounded-record contract. With
// only four bytes available after runtime alignment, an 8-byte pointer is
// rejected even though aligning the raw file offset would have fit it.
{
  const { img } = parseAligned({
    bits: 64,
    offset: 0x104,
    address: 0x2000n,
    size: 0x0c,
    countEnc: 0xff,
  });
  assert.equal(img.metadata.ehFrameHeader, undefined);
  assert.ok(img.warnings.some((w) => /DW_EH_PE value crosses bounded record/.test(w)));
}

// Other application bases are unchanged.
for (const [enc, expected] of [
  [0x13, 0x2104n], // pcrel: field VA 0x2004 + 0x100
  [0x23, 0x4100n], // textrel: text base 0x4000 + 0x100
  [0x33, 0x2100n], // datarel: section base 0x2000 + 0x100
]) {
  const bytes = new Uint8Array(0x200);
  const view = new DataView(bytes.buffer);
  const offset = 0x100;
  writeHeader(bytes, offset, enc);
  view.setUint32(offset + 4, 0x100, true);
  view.setUint32(offset + 8, 0, true);
  const img = image(0x4000n);
  parseEhFrameHeader(reader(bytes), { addr: 0x2000n, offset: 0x100n, size: 0x40n }, img, 64, null);
  assert.equal(img.metadata.ehFrameHeader?.ehFrameAddress, expected);
}

console.log('issue #3670 DW_EH_PE_aligned mapped-address alignment: PASS');
