import assert from 'node:assert/strict';
import { ByteView } from '../js/binary/reader.js';
import { BinaryImage } from '../js/binary/model.js';
import { parseEhFrameHeader } from '../js/binary/elf-unwind.js';

const HEADER_ADDR = 0x3000n;
const EH_FRAME_ADDR = 0x2000n;
const EH_FRAME_OFFSET = 0x100;

function u32(bytes, offset, value) {
  new DataView(bytes.buffer).setUint32(offset, Number(BigInt(value) & 0xffffffffn), true);
}

function i32(bytes, offset, value) {
  new DataView(bytes.buffer).setInt32(offset, Number(value), true);
}

function addSections(image, { executable = true, ehFrame = true } = {}) {
  image.addSection({
    name: '.text', address: 0n, size: 0x100n,
    fileOffset: 0x300n, fileSize: 0x100n,
    perms: { read: true, execute: executable },
  });
  if (ehFrame) {
    image.addSection({
      name: '.eh_frame', address: EH_FRAME_ADDR, size: 0x100n,
      fileOffset: BigInt(EH_FRAME_OFFSET), fileSize: 0x100n,
      perms: { read: true },
    });
  }
  image.addSection({
    name: '.eh_frame_hdr', address: HEADER_ADDR, size: 0x80n,
    fileOffset: 0n, fileSize: 0x80n,
    perms: { read: true },
  });
}

function makeImage(bytes, options = {}) {
  const image = new BinaryImage(bytes, {
    format: 'elf', arch: 'arm64', bits: 64, metadata: {},
  });
  addSections(image, options);
  return image;
}

function writeHeader(bytes, { frame = EH_FRAME_ADDR, rows }) {
  let p = 0;
  bytes[p++] = 1;
  bytes[p++] = 0x03; // eh_frame_ptr: absolute udata4
  bytes[p++] = 0x03; // fde_count: absolute udata4
  bytes[p++] = 0x03; // table entries: absolute udata4
  u32(bytes, p, frame); p += 4;
  u32(bytes, p, rows.length); p += 4;
  for (const row of rows) {
    u32(bytes, p, row.initial); p += 4;
    u32(bytes, p, row.fde); p += 4;
  }
}

function writeCieAndFde(bytes, initial = 0n, range = 0x20n) {
  let p = EH_FRAME_OFFSET;
  // CIE: length 13, id 0, version 1, augmentation "zR", code/data
  // alignment 1, return register 30, one-byte FDE encoding 0x1b.
  u32(bytes, p, 13); p += 4;
  u32(bytes, p, 0); p += 4;
  bytes[p++] = 1;
  bytes[p++] = 0x7a; bytes[p++] = 0x52; bytes[p++] = 0;
  bytes[p++] = 1; bytes[p++] = 1; bytes[p++] = 30;
  bytes[p++] = 1; bytes[p++] = 0x1b; // pcrel sdata4

  const fdeOffset = p;
  const fdeAddress = EH_FRAME_ADDR + BigInt(fdeOffset - EH_FRAME_OFFSET);
  u32(bytes, p, 13); p += 4;
  const pointerFieldAddress = EH_FRAME_ADDR + BigInt(p - EH_FRAME_OFFSET);
  u32(bytes, p, pointerFieldAddress - EH_FRAME_ADDR); p += 4;
  const initialFieldAddress = EH_FRAME_ADDR + BigInt(p - EH_FRAME_OFFSET);
  i32(bytes, p, initial - initialFieldAddress); p += 4;
  i32(bytes, p, range); p += 4;
  bytes[p++] = 0; // FDE augmentation length
  return fdeAddress;
}

function parse(bytes, image) {
  const r = new ByteView(bytes, { littleEndian: true });
  parseEhFrameHeader(r, {
    name: '.eh_frame_hdr', addr: HEADER_ADDR, offset: 0n, size: 0x80n,
  }, image, 64, null);
}

// A valid ARM64 function at VA 0 is an ordinary FDE initial location.
{
  const bytes = new Uint8Array(0x500);
  const fde = writeCieAndFde(bytes, 0n, 0x20n);
  writeHeader(bytes, { rows: [{ initial: 0n, fde }] });
  const image = makeImage(bytes);
  parse(bytes, image);

  assert.equal(image.metadata.ehFrameHeader?.validation, 'verified');
  assert.equal(image.metadata.ehFrameHeader?.validatedEntries, 1);
  assert.equal(image.metadata.ehFrameHeader?.recoveredFunctions, 1);
  const seed = image.functions.find((f) => f.source === 'unwind');
  assert.equal(seed?.address, 0n);
  assert.equal(seed?.functionStartEvidence?.verified, true);
}

// VA 0 still fails normal architecture validation when it is not executable.
{
  const bytes = new Uint8Array(0x500);
  const fde = writeCieAndFde(bytes, 0n, 0x20n);
  writeHeader(bytes, { rows: [{ initial: 0n, fde }] });
  const image = makeImage(bytes, { executable: false });
  parse(bytes, image);

  assert.equal(image.metadata.ehFrameHeader?.recoveredFunctions, 0);
  assert.equal(image.metadata.ehFrameHeader?.invalidEntries, 1);
  assert.ok(image.warnings.some((w) => /not contained in executable mapping/.test(w)));
}

// If the validation domain is unavailable, a known function at VA 0 keeps
// unverified unwind provenance rather than being silently treated as missing.
{
  const bytes = new Uint8Array(0x500);
  writeHeader(bytes, {
    frame: 0x5000n,
    rows: [{ initial: 0n, fde: 0x2011n }],
  });
  const image = makeImage(bytes, { ehFrame: false });
  image.functions.push({ address: 0n, source: 'entrypoint' });
  parse(bytes, image);

  const evidence = image.functions.find((f) => f.source === 'unwind');
  assert.equal(evidence?.address, 0n);
  assert.equal(evidence?.functionStartEvidence?.verified, false);
  assert.equal(evidence?.functionStartEvidence?.reason, 'eh-frame-domain-unresolved');
}

// Zero participates in table ordering like every other valid address.
{
  const bytes = new Uint8Array(0x500);
  writeHeader(bytes, {
    frame: 0x5000n,
    rows: [
      { initial: 0x20n, fde: 0x2011n },
      { initial: 0n, fde: 0x2024n },
    ],
  });
  const image = makeImage(bytes, { ehFrame: false });
  parse(bytes, image);

  assert.equal(image.metadata.ehFrameHeader?.tableSorted, false);
  assert.equal(image.metadata.ehFrameHeader?.validation, 'partial');
}

// A zero FDE pointer is not classified as "missing" solely because its value
// is zero; the validated .eh_frame domain decides whether it is usable.
{
  const bytes = new Uint8Array(0x500);
  writeCieAndFde(bytes, 0n, 0x20n);
  writeHeader(bytes, { rows: [{ initial: 0n, fde: 0n }] });
  const image = makeImage(bytes);
  parse(bytes, image);

  assert.equal(image.metadata.ehFrameHeader?.invalidEntries, 1);
  assert.ok(image.warnings.some((w) => /FDE pointer is outside validated \.eh_frame domain/.test(w)));
}

console.log('issue #3760 ELF unwind address zero semantics: PASS');
