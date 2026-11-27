import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { ByteView } from '../js/binary/reader.js';
import { createMachOMetadataBudget } from '../js/binary/macho-budget.js';
import { parseClassicBindings } from '../js/binary/macho-dyld.js';
import { parsePE } from '../js/binary/pe.js';

function loadLegacyMachO() {
  const code = fs.readFileSync(new URL('../js/macho.js', import.meta.url), 'utf8');
  const ctx = {
    BigInt, DataView, Uint8Array, Int32Array, Uint32Array, ArrayBuffer,
    TextDecoder, Map, Set, Math, Number, String, Array, Object,
    Error, RangeError, TypeError, console,
  };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.runInNewContext(code, ctx, { filename: 'js/macho.js' });
  return ctx.MachO;
}

function makeEhRecord(idField, bodyBytes) {
  const length = 4 + bodyBytes.length;
  const out = new Uint8Array(4 + length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, length, true);
  dv.setUint32(4, idField, true);
  out.set(bodyBytes, 8);
  return out;
}

function concatBytes(...chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/* ── [W2-F-#1] js/macho.js: parseEhFrameRanges 'P' with DW_EH_PE_indirect (0x9b) continues to 'R' ── */
test('[W2-F-#1a] parseEhFrameRanges skips DW_EH_PE_indirect (0x9b) personality pointer and decodes R (0x1b)', () => {
  const { parseEhFrameRanges } = loadLegacyMachO();
  const sectionVM = 0x100004000n;

  // CIE: version=1, aug="zPLR\0", codeAlign=1, dataAlign=0x7c(-4), ra=30,
  // augLen=7: P(enc=0x9b + 4B sdata4), L(enc=0x1b), R(enc=0x1b)
  const cieBody = [
    1,
    0x7a, 0x50, 0x4c, 0x52, 0x00, // "zPLR\0"
    1, 0x7c, 30,
    7, // augLen
    0x9b, 0x10, 0x00, 0x00, 0x00, // 'P': DW_EH_PE_indirect|DW_EH_PE_pcrel|DW_EH_PE_sdata4 + 4B payload
    0x1b, // 'L'
    0x1b, // 'R': DW_EH_PE_pcrel | DW_EH_PE_sdata4
  ];
  const cie = makeEhRecord(0, cieBody);

  // FDE: ciePointer = (cie.length + 4) (backwards offset from idField to CIE start)
  // FDE content starts at offset cie.length + 8 -> VM = sectionVM + BigInt(cie.length + 8)
  const fdeContentOff = cie.length + 8;
  const targetStart = 0x100001000n;
  const targetRange = 0x80;
  const relStart = Number(targetStart - (sectionVM + BigInt(fdeContentOff)));
  const fdeBody = new Uint8Array(8);
  const fdeDv = new DataView(fdeBody.buffer);
  fdeDv.setInt32(0, relStart, true);
  fdeDv.setInt32(4, targetRange, true);
  const fde = makeEhRecord(cie.length + 4, fdeBody);

  const buf = concatBytes(cie, fde);
  const ranges = parseEhFrameRanges(buf, sectionVM);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].start, targetStart);
  assert.equal(ranges[0].end, targetStart + BigInt(targetRange));
});

test('[W2-F-#1b] parseEhFrameRanges fails closed when P has unknown encoding size before R', () => {
  const { parseEhFrameRanges } = loadLegacyMachO();
  const sectionVM = 0x100004000n;

  // CIE: aug="zPR\0", P has unknown format 0x0f -> must fail closed, not default fdeEncoding=0x00
  const cieBody = [
    1,
    0x7a, 0x50, 0x52, 0x00, // "zPR\0"
    1, 0x7c, 30,
    3, // augLen
    0x0f, // 'P' unknown format
    0x00,
    0x1b, // 'R'
  ];
  const cie = makeEhRecord(0, cieBody);

  const fdeBody = new Uint8Array(16);
  const fdeDv = new DataView(fdeBody.buffer);
  fdeDv.setBigUint64(0, 0x100001000n, true);
  fdeDv.setBigUint64(8, 0x40n, true);
  const fde = makeEhRecord(cie.length + 4, fdeBody);

  const ranges = parseEhFrameRanges(concatBytes(cie, fde), sectionVM);
  assert.equal(ranges.length, 0, 'CIE with unreadable P encoding must fail closed');
});

/* ── [W2-F-#2] js/macho.js: CIE augmentation string >= 64 chars without NUL must not desynchronize ── */
test('[W2-F-#2] parseEhFrameRanges skips malformed CIE whose augmentation string exceeds 64 chars without NUL', () => {
  const { parseEhFrameRanges } = loadLegacyMachO();
  const sectionVM = 0x100004000n;

  // Malformed CIE: "z" + 65 'S' chars + '\0' + codeAlign=1 + dataAlign=-4 + ra=30 + augLen=1 + R=0x1b
  const longAug = new Array(65).fill(0x53); // 'S' x 65
  const badCieBody = [
    1,
    0x7a, ...longAug, 0x00,
    1, 0x7c, 30,
    1, 0x1b,
  ];
  const badCie = makeEhRecord(0, badCieBody);

  // FDE pointing to badCie
  const badFdeBody = new Uint8Array(8);
  const badFdeDv = new DataView(badFdeBody.buffer);
  badFdeDv.setInt32(0, -0x100, true);
  badFdeDv.setInt32(4, 0x40, true);
  const badFde = makeEhRecord(badCie.length + 4, badFdeBody);

  // Followed by a valid CIE + FDE to confirm scanning continues cleanly
  const goodCieBody = [
    1,
    0x7a, 0x52, 0x00, // "zR\0"
    1, 0x7c, 30,
    1, 0x1b,
  ];
  const goodCie = makeEhRecord(0, goodCieBody);
  const goodFdeContentOff = badCie.length + badFde.length + goodCie.length + 8;
  const targetStart = 0x100002000n;
  const relStart = Number(targetStart - (sectionVM + BigInt(goodFdeContentOff)));
  const goodFdeBody = new Uint8Array(8);
  const goodFdeDv = new DataView(goodFdeBody.buffer);
  goodFdeDv.setInt32(0, relStart, true);
  goodFdeDv.setInt32(4, 0x50, true);
  const goodFde = makeEhRecord(goodCie.length + 4, goodFdeBody);

  const ranges = parseEhFrameRanges(concatBytes(badCie, badFde, goodCie, goodFde), sectionVM);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].start, targetStart);
  assert.equal(ranges[0].end, targetStart + 0x50n);
});

/* ── [W2-F-#3] js/binary/macho-dyld.js: parseClassicBindings 0x40 bounds C-string scan by budget before decoding ── */
test('[W2-F-#3] parseClassicBindings 0x40 bounds symbol C-string scan before slice/decode', () => {
  const buf = new Uint8Array(1024);
  buf[0] = 0x40; // BIND_OPCODE_SET_SYMBOL_TRAILING_FLAGS_IMM
  buf.fill(0x41, 1, 1022); // 1021 'A's
  buf[1022] = 0x00; // NUL terminator
  buf[1023] = 0x00; // BIND_OPCODE_DONE

  let sliceCalled = false;
  const baseView = new ByteView(buf, { littleEndian: true });
  const instrumentedView = Object.create(baseView);
  instrumentedView.slice = (...args) => {
    sliceCalled = true;
    return baseView.slice(...args);
  };

  const image = { imports: [], warnings: [], metadata: {} };
  const tightBudget = createMachOMetadataBudget(image, { limits: { stringBytes: 16 } });
  const status = parseClassicBindings(instrumentedView, { offset: 0, size: buf.length }, image, [], 'bind', tightBudget);

  assert.equal(sliceCalled, false, 'must not slice or decode oversized C-string past budget');
  assert.equal(tightBudget.stopped, true);
  assert.equal(status.complete, false);
  assert.equal(image.metadata.dyldBindings.complete, false);
});

/* ── [W2-F-#4] js/binary/pe.js: virtualRangeInvalid section must not poison prevSectionLayout for subsequent valid sections ── */
test('[W2-F-#4] parsePE does not update prevSectionLayout from virtualRangeInvalid sections', () => {
  const u16 = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; };
  const u32 = (b, o, v) => {
    b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff;
    b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff;
  };
  const u64 = (b, o, v) => {
    let n = BigInt(v);
    for (let i = 0; i < 8; i++) { b[o + i] = Number(n & 0xffn); n >>= 8n; }
  };

  const bytes = new Uint8Array(0x1000);
  const pe = 0x80;
  const coff = pe + 4;
  const optional = coff + 20;
  const optionalSize = 0xf0;
  const secBase = optional + optionalSize;

  u16(bytes, 0, 0x5a4d);
  u32(bytes, 0x3c, pe);
  u32(bytes, pe, 0x00004550);
  u16(bytes, coff, 0x8664);
  u16(bytes, coff + 2, 3); // 3 sections
  u16(bytes, coff + 16, optionalSize);
  u16(bytes, optional, 0x20b);
  u64(bytes, optional + 24, 0x140000000n);
  u32(bytes, optional + 32, 0x1000); // SectionAlignment
  u32(bytes, optional + 36, 0x200);  // FileAlignment
  u32(bytes, optional + 56, 0x4000); // SizeOfImage
  u32(bytes, optional + 60, 0x400);  // SizeOfHeaders
  u16(bytes, optional + 68, 3);
  u32(bytes, optional + 108, 0);

  const writeSec = (idx, name, vsize, rva, rawSize, rawPtr, flags) => {
    const s = secBase + idx * 40;
    bytes.set(new TextEncoder().encode(name), s);
    u32(bytes, s + 8, vsize);
    u32(bytes, s + 12, rva);
    u32(bytes, s + 16, rawSize);
    u32(bytes, s + 20, rawPtr);
    u32(bytes, s + 36, flags);
  };

  // Section 1: valid .text [0x1000..0x2000)
  writeSec(0, '.text\0\0\0', 0x1000, 0x1000, 0x200, 0x400, 0x60000020);
  // Section 2: invalid .bad [0x2000..0x102000) exceeds SizeOfImage=0x4000
  writeSec(1, '.bad\0\0\0\0', 0x100000, 0x2000, 0x200, 0x600, 0x40000040);
  // Section 3: valid .rdata [0x3000..0x4000)
  writeSec(2, '.rdata\0\0', 0x1000, 0x3000, 0x200, 0x800, 0x40000040);

  const image = parsePE(bytes);
  const sectionNames = image.sections.map((s) => s.name);
  assert.deepEqual(sectionNames, ['.text', '.rdata']);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('pe:section-virtual-range-exceeds-size-of-image'));
  assert.ok(!image.metadata.peMetadata.reasons.includes('pe:section-virtual-range-overlap'));
});
