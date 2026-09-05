/**
 * #6110 regression: when .eh_frame_hdr's fde_count exceeds the parser record
 * cap (or is not a representable non-negative count), parseEhFrameHeader must
 * record explicit invalid metadata plus a warning instead of silently
 * returning and leaving the header indistinguishable from an absent one.
 */
import assert from 'node:assert/strict';
import { ByteView } from '../js/binary/reader.js';
import { BinaryImage } from '../js/binary/model.js';
import { parseEhFrameHeader } from '../js/binary/elf-unwind.js';

const HEADER_ADDR = 0x3000n;
const TEXT_ADDR = 0x1000n;
const EH_FRAME_ADDR = 0x2000n;
const TEXT_OFFSET = 0x80;
const EH_FRAME_OFFSET = 0x100;

function makeFixture({ count, entries = [], countEnc = 0x03 }) {
  const bytes = new Uint8Array(0x300);
  const view = new DataView(bytes.buffer);
  const u8 = (o, x) => view.setUint8(o, x);
  const u32 = (o, x) => view.setUint32(o, Number(BigInt(x) & 0xffffffffn), true);
  const u64 = (o, x) => view.setBigUint64(o, BigInt(x) & 0xffffffffffffffffn, true);

  let p = 0;
  u8(p++, 1); u8(p++, 0x03); u8(p++, countEnc); u8(p++, 0x03);
  u32(p, EH_FRAME_ADDR); p += 4;
  if (countEnc === 0x04) { u64(p, count); p += 8; }
  else { u32(p, count); p += 4; }
  for (const entry of entries) {
    u32(p, entry.initial); p += 4;
    u32(p, entry.fdeAddress); p += 4;
  }

  // Minimal CIE so a valid small table can still decode (fde_count=0 case).
  p = EH_FRAME_OFFSET;
  u32(p, 13); p += 4;
  u32(p, 0); p += 4;
  u8(p++, 1); u8(p++, 0x7a); u8(p++, 0x52); u8(p++, 0);
  u8(p++, 1); u8(p++, 0x78); u8(p++, 30); u8(p++, 1); u8(p++, 0x03);

  const image = new BinaryImage(bytes, { format: 'elf', arch: 'x86_64', bits: 64, metadata: {} });
  image.addSection({ name: '.eh_frame_hdr', address: HEADER_ADDR, size: 0x40n, fileOffset: 0n, fileSize: 0x40n, perms: { read: true } });
  image.addSection({ name: '.text', address: TEXT_ADDR, size: 0x80n, fileOffset: BigInt(TEXT_OFFSET), fileSize: 0x80n, perms: { read: true, execute: true } });
  image.addSection({ name: '.eh_frame', address: EH_FRAME_ADDR, size: 0x100n, fileOffset: BigInt(EH_FRAME_OFFSET), fileSize: 0x100n, perms: { read: true } });
  return {
    r: new ByteView(bytes, { littleEndian: true }),
    image,
    header: { name: '.eh_frame_hdr', addr: HEADER_ADDR, offset: 0n, size: 0x40n },
  };
}

function parse(options) {
  const fixture = makeFixture(options);
  parseEhFrameHeader(fixture.r, fixture.header, fixture.image, 64, null);
  return fixture.image;
}

// 1. fde_count = 0 keeps its valid-header policy: no false failure.
{
  const image = parse({ count: 0 });
  assert.equal(image.metadata.ehFrameHeader.declaredFunctions, 0);
  assert.equal(image.metadata.ehFrameHeader.validation, 'verified');
  assert.ok(!image.warnings.some((w) => /fde_count/.test(w)));
}

// 2. fde_count = 10_000_001 (one past the parser cap): explicit invalid
//    metadata and warning, never silent absence.
{
  const overCap = 10_000_001;
  const image = parse({ count: overCap });
  assert.ok(image.metadata.ehFrameHeader, 'ehFrameHeader metadata must exist');
  assert.equal(image.metadata.ehFrameHeader.validation, 'invalid');
  assert.equal(image.metadata.ehFrameHeader.reason, 'fde-count-exceeds-parser-cap');
  assert.equal(image.metadata.ehFrameHeader.declaredFunctions, overCap);
  assert.equal(image.metadata.ehFrameHeader.recoveredFunctions, 0);
  assert.ok(image.warnings.some((w) => /fde_count 10000001 exceeds/.test(w)));
  assert.equal(image.functions.length, 0, 'no unwind seeds from an unprocessed header');
}

// 3. An unsafe count encoding (udata8 value beyond Number.MAX_SAFE_INTEGER)
//    also fails closed, not silently.
{
  const unsafe = 2n ** 62n; // far beyond any safe-integer count
  const image = parse({ count: unsafe, countEnc: 0x04 });
  assert.ok(image.metadata.ehFrameHeader);
  assert.equal(image.metadata.ehFrameHeader.validation, 'invalid');
  assert.equal(image.metadata.ehFrameHeader.reason, 'fde-count-invalid');
  assert.equal(image.metadata.ehFrameHeader.declaredFunctions, null);
  assert.ok(image.warnings.some((w) => /not a representable non-negative count/.test(w)));
}

// 4. The cap-exceeded header must be distinguishable from a missing one:
//    a fixture without a parseable count still gets explicit metadata here,
//    and the metadata marks validation invalid rather than undefined.
{
  const image = parse({ count: 10_000_001 });
  assert.notEqual(image.metadata.ehFrameHeader, undefined);
  assert.equal(image.metadata.ehFrameHeader.tableComplete, false);
}

console.log('issue #6110 eh_frame_hdr fde_count cap validation: PASS');
