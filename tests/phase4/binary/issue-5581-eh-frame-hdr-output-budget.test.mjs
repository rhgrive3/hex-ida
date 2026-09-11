/**
 * #5581 regression: when the shared output budget truncates eh_frame_hdr
 * function-seed materialization, the per-artifact metadata must not claim
 * validation:'verified' — unrecovered functions are lost coverage, not
 * verified-complete coverage.
 */
import assert from 'node:assert/strict';
import { ByteView } from '../../../js/binary/reader.js';
import { BinaryImage } from '../../../js/binary/model.js';
import { parseEhFrameHeader } from '../../../js/binary/elf-unwind.js';

const HEADER_ADDR = 0x3000n;
const TEXT_ADDR = 0x1000n;
const EH_FRAME_ADDR = 0x2000n;
const EH_FRAME_OFFSET = 0x100;

function u32(bytes, o, x) { new DataView(bytes.buffer).setUint32(o, x >>> 0, true); }
function i32(bytes, o, x) { new DataView(bytes.buffer).setInt32(o, x | 0, true); }

function buildFixture() {
  const bytes = new Uint8Array(0x400);
  let p = 0;
  bytes[p++] = 1; bytes[p++] = 0x03; bytes[p++] = 0x03; bytes[p++] = 0x03;
  u32(bytes, p, Number(EH_FRAME_ADDR)); p += 4;
  u32(bytes, p, 2); p += 4;
  const fde0Off = EH_FRAME_OFFSET + 0x11; // right after the 17-byte CIE
  const fde1Off = fde0Off + 0x13;
  const va = (off) => EH_FRAME_ADDR + BigInt(off - EH_FRAME_OFFSET);
  u32(bytes, p, 0x1000); p += 4; u32(bytes, p, Number(va(fde0Off))); p += 4;
  u32(bytes, p, 0x1008); p += 4; u32(bytes, p, Number(va(fde1Off))); p += 4;

  p = EH_FRAME_OFFSET;
  // CIE: length 13, id 0, version 1, aug "zR\0", codeAlign 1, dataAlign 1,
  // retReg 8, augLen 1, fdeEnc 0x1b (pcrel sdata4).
  u32(bytes, p, 13); p += 4;
  u32(bytes, p, 0); p += 4;
  bytes[p++] = 1; bytes[p++] = 0x7a; bytes[p++] = 0x52; bytes[p++] = 0;
  bytes[p++] = 1; bytes[p++] = 1; bytes[p++] = 8;
  bytes[p++] = 1; bytes[p++] = 0x1b;
  assert.equal(p, fde0Off);

  p = fde0Off;
  u32(bytes, p, 13); p += 4;
  u32(bytes, p, Number(va(p) - EH_FRAME_ADDR)); p += 4; // CIE delta (pcrel)
  i32(bytes, p, 0x1000 - Number(va(p))); p += 4; // initial sdata4 pcrel
  i32(bytes, p, 8); p += 4; // range
  bytes[p++] = 0; // augmentation length

  p = fde1Off;
  u32(bytes, p, 13); p += 4;
  u32(bytes, p, Number(va(p) - EH_FRAME_ADDR)); p += 4;
  i32(bytes, p, 0x1008 - Number(va(p))); p += 4;
  i32(bytes, p, 8); p += 4;
  bytes[p++] = 0;
  return bytes;
}

function run(budget) {
  const bytes = buildFixture();
  const image = new BinaryImage(bytes, { format: 'elf', arch: 'x86_64', bits: 64, metadata: {} });
  image.addSection({ name: '.text', address: TEXT_ADDR, size: 0x80n, fileOffset: 0x80n, fileSize: 0x80n, perms: { read: true, execute: true } });
  image.addSection({ name: '.eh_frame', address: EH_FRAME_ADDR, size: 0x200n, fileOffset: BigInt(EH_FRAME_OFFSET), fileSize: 0x200n, perms: { read: true } });
  image.addSection({ name: '.eh_frame_hdr', address: HEADER_ADDR, size: 0x40n, fileOffset: 0n, fileSize: 0x40n, perms: { read: true } });
  const r = new ByteView(bytes, { littleEndian: true });
  const header = { name: '.eh_frame_hdr', addr: HEADER_ADDR, offset: 0n, size: 0x40n };
  parseEhFrameHeader(r, header, image, 64, budget);
  return image;
}

// 1. Ample budget: both FDEs validate, both function seeds materialize,
//    validation stays 'verified'.
{
  const image = run(null);
  const meta = image.metadata.ehFrameHeader;
  assert.equal(meta.validation, 'verified');
  assert.equal(meta.recoveredFunctions, 2);
  assert.equal(meta.validatedEntries, 2);
  assert.equal(meta.declaredFunctions, 2);
  assert.equal(image.functions.length, 2);
}

// 2. Output budget truncates after one seed: partial, not verified, with an
//    explicit output-budget reason. The table itself stays complete.
{
  let adds = 0;
  const budget = { take(cost, stage) { if (stage !== 'eh-frame-function') return true; adds += 1; return adds <= 1; } };
  const image = run(budget);
  const meta = image.metadata.ehFrameHeader;
  assert.equal(image.functions.length, 1);
  assert.equal(meta.recoveredFunctions, 1);
  assert.equal(meta.validatedEntries, 2);
  assert.equal(meta.declaredFunctions, 2);
  assert.equal(meta.tableComplete, true, 'the table decode facts are unchanged');
  assert.equal(meta.validation, 'partial',
    'a truncated output is never verified coverage');
  assert.equal(meta.reason, 'output-budget-exhausted');
}

// 3. A budget that exhausts before any seed recovers nothing.
{
  const budget = { take(cost, stage) { return stage !== 'eh-frame-function'; } };
  const image = run(budget);
  const meta = image.metadata.ehFrameHeader;
  assert.equal(image.functions.length, 0);
  assert.equal(meta.recoveredFunctions, 0);
  assert.equal(meta.validation, 'partial');
  assert.equal(meta.reason, 'output-budget-exhausted');
}

// 4. The table-loop budget ('eh-frame-table') keeps its own semantics:
//    truncation there stays tableComplete:false (existing partial path).
{
  let takes = 0;
  const budget = { take() { takes += 1; return takes <= 1; } };
  const image = run(budget);
  const meta = image.metadata.ehFrameHeader;
  assert.equal(meta.tableComplete, false);
  assert.equal(meta.validation, 'partial');
}

console.log('issue #5581 eh_frame_hdr output-budget validation: PASS');
