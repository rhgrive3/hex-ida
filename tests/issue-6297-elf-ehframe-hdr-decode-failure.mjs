// Issue #6297: mark elfMetadata partial on .eh_frame_hdr decode failure
import assert from 'node:assert/strict';
import { ByteView } from '../js/binary/reader.js';
import { BinaryImage } from '../js/binary/model.js';
import { parseEhFrameHeader } from '../js/binary/elf-unwind.js';
import { createELFMetadataBudget } from '../js/binary/elf-budget.js';

const HEADER_ADDR = 0x3000n;
const TEXT_ADDR = 0x1000n;
const EH_FRAME_ADDR = 0x2000n;
const TEXT_OFFSET = 0x80;
const EH_FRAME_OFFSET = 0x100;

function makeFixture({
  entries = [{ initial: 0x1010n, fdeAddress: 0x2020n, fdeInitial: 0x1010n, range: 0x20n }],
  ehFramePointer = EH_FRAME_ADDR,
  ehFrameEnc = 0x03, // DW_EH_PE_udata4
  countEnc = 0x03,
  tableEnc = 0x03,
  headerSize = 0x40n,
  countOverride = null,
} = {}) {
  const bytes = new Uint8Array(0x300);
  const view = new DataView(bytes.buffer);
  const u8 = (o, x) => view.setUint8(o, x);
  const u32 = (o, x) => view.setUint32(o, Number(BigInt(x) & 0xffffffffn), true);

  let p = 0;
  u8(p++, 1); // version
  u8(p++, ehFrameEnc);
  u8(p++, countEnc);
  u8(p++, tableEnc);
  u32(p, ehFramePointer); p += 4;
  const count = countOverride != null ? countOverride : entries.length;
  u32(p, count); p += 4;
  for (const entry of entries) {
    u32(p, entry.initial); p += 4;
    u32(p, entry.fdeAddress); p += 4;
  }

  // CIE: length=13, CIE id=0, version=1, augmentation="zR", FDE encoding=udata4.
  p = EH_FRAME_OFFSET;
  u32(p, 13); p += 4;
  u32(p, 0); p += 4;
  u8(p++, 1); u8(p++, 0x7a); u8(p++, 0x52); u8(p++, 0);
  u8(p++, 1); u8(p++, 0x78); u8(p++, 30); u8(p++, 1); u8(p++, 0x03);

  for (const entry of entries) {
    if (entry.fdeAddress < EH_FRAME_ADDR || entry.fdeAddress >= EH_FRAME_ADDR + 0x100n) continue;
    const off = EH_FRAME_OFFSET + Number(entry.fdeAddress - EH_FRAME_ADDR);
    if (off + 17 > EH_FRAME_OFFSET + 0x100) continue;
    u32(off, 13);
    const ciePointerField = entry.fdeAddress + 4n;
    u32(off + 4, ciePointerField - EH_FRAME_ADDR);
    u32(off + 8, entry.fdeInitial ?? entry.initial);
    u32(off + 12, entry.range ?? 0x20n);
    u8(off + 16, 0);
  }

  const image = new BinaryImage(bytes, { format: 'elf', arch: 'x86_64', bits: 64, metadata: {} });
  image.addSection({ name: '.eh_frame_hdr', address: HEADER_ADDR, size: headerSize, fileOffset: 0n, fileSize: headerSize, perms: { read: true } });
  image.addSection({ name: '.text', address: TEXT_ADDR, size: 0x80n, fileOffset: BigInt(TEXT_OFFSET), fileSize: 0x80n, perms: { read: true, execute: true } });
  image.addSection({ name: '.eh_frame', address: EH_FRAME_ADDR, size: 0x100n, fileOffset: BigInt(EH_FRAME_OFFSET), fileSize: 0x100n, perms: { read: true } });

  const budget = createELFMetadataBudget(image);

  return {
    r: new ByteView(bytes, { littleEndian: true }),
    image,
    budget,
    header: { name: '.eh_frame_hdr', addr: HEADER_ADDR, offset: 0n, size: headerSize },
  };
}

// 1. 正常な .eh_frame_hdr -> 既存 verified validation を維持し、budget.complete === true
{
  const fixture = makeFixture();
  parseEhFrameHeader(fixture.r, fixture.header, fixture.image, 64, fixture.budget);
  assert.equal(fixture.image.metadata.ehFrameHeader.validation, 'verified');
  assert.equal(fixture.budget.snapshot().complete, true);
  assert.deepEqual(fixture.budget.snapshot().reasons, []);
}

// 2. unsupported eh_frame_ptr_enc format -> warning + elfMetadata.complete === false
{
  const fixture = makeFixture({ ehFrameEnc: 0x07 }); // format 0x07 is invalid
  parseEhFrameHeader(fixture.r, fixture.header, fixture.image, 64, fixture.budget);
  const snap = fixture.budget.snapshot();
  assert.equal(snap.complete, false);
  assert.ok(snap.reasons.includes('eh-frame-header:decode'));
  assert.ok(fixture.image.warnings.some((w) => w.includes('.eh_frame_hdr') && w.includes('unsupported DW_EH_PE format')));
}

// 3. unsupported application encoding -> partial
{
  const fixture = makeFixture({ ehFrameEnc: 0x60 }); // 0x60 is unsupported application
  parseEhFrameHeader(fixture.r, fixture.header, fixture.image, 64, fixture.budget);
  const snap = fixture.budget.snapshot();
  assert.equal(snap.complete, false);
  assert.ok(snap.reasons.includes('eh-frame-header:decode'));
  assert.ok(fixture.image.warnings.some((w) => w.includes('.eh_frame_hdr') && w.includes('unsupported DW_EH_PE application')));
}

// 4. truncated encoded value -> partial
{
  // udata8 format (0x04) requires 8 bytes, but section has only 8 bytes total (p starts at 4, needs 8 bytes so crosses section end)
  const fixture = makeFixture({ ehFrameEnc: 0x04, headerSize: 8n });
  parseEhFrameHeader(fixture.r, fixture.header, fixture.image, 64, fixture.budget);
  const snap = fixture.budget.snapshot();
  assert.equal(snap.complete, false);
  assert.ok(snap.reasons.includes('eh-frame-header:decode'));
  assert.ok(fixture.image.warnings.some((w) => w.includes('.eh_frame_hdr') && w.includes('crosses bounded record')));
}

// 5. unreadable indirect pointer -> partial
{
  // 0x83: indirect udata4, pointing to an address where addressToOffset returns null
  const fixture = makeFixture({ ehFrameEnc: 0x83, ehFramePointer: 0x99999999n });
  parseEhFrameHeader(fixture.r, fixture.header, fixture.image, 64, fixture.budget);
  const snap = fixture.budget.snapshot();
  assert.equal(snap.complete, false);
  assert.ok(snap.reasons.includes('eh-frame-header:decode'));
  assert.ok(fixture.image.warnings.some((w) => w.includes('.eh_frame_hdr') && w.includes('is not readable')));
}

// 6. BINARY_SOURCE_RANGE_MISSING -> 従来どおり rethrow し source-range retry を壊さない
{
  const fixture = makeFixture();
  const missingRangeError = new Error('range missing');
  missingRangeError.code = 'BINARY_SOURCE_RANGE_MISSING';
  const throwingReader = {
    length: fixture.r.length,
    u8: (offset) => fixture.r.u8(offset),
    u32: () => { throw missingRangeError; },
  };
  assert.throws(
    () => parseEhFrameHeader(throwingReader, fixture.header, fixture.image, 64, fixture.budget),
    (err) => err?.code === 'BINARY_SOURCE_RANGE_MISSING',
  );
}

// 7. individual FDE rejection が既存 ehFrameHeader.validation='partial' と整合する (budget は complete のまま)
{
  const entries = [
    { initial: 0x1010n, fdeAddress: 0x2020n, fdeInitial: 0x1010n, range: 0x20n },
    { initial: 0x1040n, fdeAddress: 0x2040n, fdeInitial: 0x1099n, range: 0x20n },
  ];
  const fixture = makeFixture({ entries });
  parseEhFrameHeader(fixture.r, fixture.header, fixture.image, 64, fixture.budget);
  assert.equal(fixture.image.metadata.ehFrameHeader.validation, 'partial');
  assert.equal(fixture.image.metadata.ehFrameHeader.invalidEntries, 1);
  assert.equal(fixture.image.metadata.ehFrameHeader.validatedEntries, 1);
  const snap = fixture.budget.snapshot();
  assert.equal(snap.complete, true);
  assert.ok(!snap.reasons.includes('eh-frame-header:decode'));
}

// 8. #6110 の count-cap diagnostic contract と reason を混同しない
{
  const fixture = makeFixture({ countOverride: 20_000_000 }); // > MAX_EH_RECORDS (10_000_000)
  parseEhFrameHeader(fixture.r, fixture.header, fixture.image, 64, fixture.budget);
  const snap = fixture.budget.snapshot();
  assert.equal(snap.complete, true);
  assert.ok(!snap.reasons.includes('eh-frame-header:decode'));
}

console.log('issue #6297 elf eh_frame_hdr decode error budget regression: PASS');
