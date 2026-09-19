import assert from 'node:assert/strict';
import test from 'node:test';
import { ByteView } from '../../../js/binary/reader.js';
import { BinaryImage } from '../../../js/binary/model.js';
import { parseEhFrameHeader } from '../../../js/binary/elf-unwind.js';

// A verified FDE proves an exact PC range [initial, initial + range), but the
// header path used to drop the range and keep only the start. The range is
// retained as seed extent only with a unique FDE claim per start and a
// file-backed single-PT_LOAD span; anything else stays start-only.

const HEADER_ADDR = 0x3000n;
const TEXT_ADDR = 0x1000n;
const EH_FRAME_ADDR = 0x2000n;
const EH_FRAME_OFFSET = 0x100;

function writeU32(view, offset, value) {
  view.setUint32(offset, Number(BigInt(value) & 0xffffffffn), true);
}

function writeHeader(view, rows) {
  let p = 0;
  view.setUint8(p++, 1);
  view.setUint8(p++, 0x03);
  view.setUint8(p++, 0x03);
  view.setUint8(p++, 0x03);
  writeU32(view, p, EH_FRAME_ADDR); p += 4;
  writeU32(view, p, rows.length); p += 4;
  for (const [initial, fde] of rows) {
    writeU32(view, p, initial); p += 4;
    writeU32(view, p, fde); p += 4;
  }
  return p;
}

function writeCie(view, p, fdeOffset) {
  // CIE: version 1, `zR`, uleb(1), sleb(-8), uleb(30), augLength=1 (0x03).
  const body = [0x01, 0x7a, 0x52, 0x00, 0x01, 0x78, 30, 0x01, 0x03];
  writeU32(view, p, body.length + 4); p += 4;
  writeU32(view, p, 0); p += 4;
  for (const b of body) view.setUint8(p++, b);
  return p;
}

function writeFde(view, p, initial, range) {
  const start = p;
  writeU32(view, p + 4, 0); // placeholder CIE delta, fixed below
  writeU32(view, p + 8, initial);
  writeU32(view, p + 12, range);
  view.setUint8(p + 16, 0);
  const length = 13;
  writeU32(view, start, length);
  return { next: start + 4 + length, fieldOffset: start + 4 };
}

function buildFixture({ rows, ranges, textSize = 0x80, segmentFileSize = 0x80, withSegment = true }) {
  const bytes = new Uint8Array(0x400);
  const view = new DataView(bytes.buffer);
  const headerBytes = writeHeader(view, rows);
  let p = EH_FRAME_OFFSET;
  const cieStart = p;
  p = writeCie(view, p, p);
  const fdeOffsets = [];
  const fields = [];
  for (let i = 0; i < ranges.length; i++) {
    // Fixed stride so header rows can name each FDE address up front.
    p = EH_FRAME_OFFSET + 0x20 + i * 0x20;
    const fde = writeFde(view, p, 0, ranges[i]);
    fdeOffsets.push(p);
    fields.push(fde);
    p = fde.next;
  }
  // CIE delta = field address - CIE start (both as file addresses in .eh_frame).
  for (let i = 0; i < fields.length; i++) {
    const fieldVa = EH_FRAME_ADDR + BigInt(fdeOffsets[i] + 4 - EH_FRAME_OFFSET);
    const delta = fieldVa - (EH_FRAME_ADDR + BigInt(cieStart - EH_FRAME_OFFSET));
    writeU32(view, fields[i].fieldOffset, delta);
  }
  // Patch FDE initial locations per row order.
  for (let i = 0; i < rows.length; i++) {
    writeU32(view, fdeOffsets[i] + 8, rows[i][0]);
  }

  const image = new BinaryImage(bytes, { format: 'elf', arch: 'arm64', bits: 64, metadata: {} });
  image.addSection({ name: '.text', address: TEXT_ADDR, size: BigInt(textSize), fileOffset: 0x80n, fileSize: BigInt(textSize), perms: { read: true, execute: true } });
  image.addSection({ name: '.eh_frame', address: EH_FRAME_ADDR, size: 0x200n, fileOffset: BigInt(EH_FRAME_OFFSET), fileSize: 0x200n, perms: { read: true } });
  if (withSegment) {
    image.addSegment({ name: 'LOAD', address: TEXT_ADDR, size: BigInt(textSize), fileOffset: 0x80n, fileSize: BigInt(segmentFileSize), perms: { read: true, execute: true }, source: 'PT_LOAD' });
  }
  return {
    r: new ByteView(bytes, { littleEndian: true }),
    image,
    header: { name: '.eh_frame_hdr', addr: HEADER_ADDR, offset: 0n, size: BigInt(headerBytes) },
  };
}

function parse(options) {
  const fixture = buildFixture(options);
  parseEhFrameHeader(fixture.r, fixture.header, fixture.image, 64, null);
  return fixture.image;
}

function unwindSeeds(image) {
  return image.functions.filter((fn) => fn.source === 'unwind');
}

test('FDE extent: unique verified FDE retains its address range as seed extent', () => {
  const image = parse({
    rows: [[0x1010n, EH_FRAME_ADDR + 0x20n]],
    ranges: [0x20n],
  });
  const seeds = unwindSeeds(image);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].address, 0x1010n);
  assert.equal(seeds[0].size, 0x20n);
  // Raw seeds carry size; end is derived at seed-merge time.
  assert.equal(seeds[0].address + seeds[0].size, 0x1030n);
  assert.equal(seeds[0].exactFunctionStart, true);
  assert.equal(image.metadata.ehFrameHeader.validation, 'verified');
});

test('FDE extent: duplicate FDE claims on one start suppress the table', () => {
  // Equal initials violate the header table sortedness contract, so the
  // existing fail-closed path suppresses every seed instead of guessing.
  // (The materialization loop additionally keeps ambiguous starts
  // start-only as defense in depth.)
  const image = parse({
    rows: [[0x1010n, EH_FRAME_ADDR + 0x20n], [0x1010n, EH_FRAME_ADDR + 0x40n]],
    ranges: [0x20n, 0x30n],
  });
  assert.equal(unwindSeeds(image).length, 0);
  assert.equal(image.metadata.ehFrameHeader.validation, 'partial');
});

test('FDE extent: range crossing file-backed coverage stays start-only', () => {
  const image = parse({
    rows: [[0x1010n, EH_FRAME_ADDR + 0x20n]],
    ranges: [0x20n],
    segmentFileSize: 0x10,
  });
  const seeds = unwindSeeds(image);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].address, 0x1010n);
  assert.equal(seeds[0].size, null);
  assert.equal(seeds[0].end, null);
});

test('FDE extent: overlapping non-executable PT_LOAD cannot lend file bytes to executable zero-fill', () => {
  const fixture = buildFixture({
    rows: [[0x1010n, EH_FRAME_ADDR + 0x20n]],
    ranges: [0x20n],
    segmentFileSize: 0x10,
  });
  fixture.image.addSegment({
    name: 'LOAD-ro-overlap',
    address: TEXT_ADDR,
    size: 0x80n,
    fileOffset: 0x80n,
    fileSize: 0x80n,
    perms: { read: true, execute: false },
    source: 'PT_LOAD',
  });
  parseEhFrameHeader(fixture.r, fixture.header, fixture.image, 64, null);
  const seeds = unwindSeeds(fixture.image);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].size, null);
  assert.equal(seeds[0].end, null);
});

test('FDE extent: any overlapping second PT_LOAD keeps an otherwise file-backed extent start-only', () => {
  const fixture = buildFixture({
    rows: [[0x1010n, EH_FRAME_ADDR + 0x20n]],
    ranges: [0x20n],
  });
  fixture.image.addSegment({
    name: 'LOAD-ro-overlap',
    address: TEXT_ADDR,
    size: 0x80n,
    fileOffset: 0x80n,
    fileSize: 0x80n,
    perms: { read: true, execute: false },
    source: 'PT_LOAD',
  });
  parseEhFrameHeader(fixture.r, fixture.header, fixture.image, 64, null);
  const seeds = unwindSeeds(fixture.image);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].size, null);
  assert.equal(seeds[0].end, null);
});

test('FDE extent: section-only image without PT_LOAD stays start-only', () => {
  const image = parse({
    rows: [[0x1010n, EH_FRAME_ADDR + 0x20n]],
    ranges: [0x20n],
    withSegment: false,
  });
  const seeds = unwindSeeds(image);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].address, 0x1010n);
  assert.equal(seeds[0].size, null);
  assert.equal(seeds[0].end, null);
});

test('FDE extent: range escaping the executable mapping mints no seed at all', () => {
  const image = parse({
    rows: [[0x1070n, EH_FRAME_ADDR + 0x20n]],
    ranges: [0x20n],
  });
  assert.equal(unwindSeeds(image).length, 0);
  assert.equal(image.metadata.ehFrameHeader.validation, 'partial');
});
