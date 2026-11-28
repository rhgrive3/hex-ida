import test from 'node:test';
import assert from 'node:assert/strict';
import '../js/macho.js';
import { scanSourceStrings } from '../js/bytesource/strings.js';
import { __chainedInternalsForTests } from '../js/chained.js';
import { ProgramIndex, KIND } from '../js/program.js';

const { stubSlot } = __chainedInternalsForTests;

function makeBufferSource(bytes) {
  return {
    size: BigInt(bytes.length),
    async read(offset, length) {
      const start = Number(offset);
      const end = Math.min(bytes.length, start + Number(length));
      if (start >= bytes.length || start < 0) return new Uint8Array(0);
      return bytes.subarray(start, end);
    },
  };
}

function makeFakeImage(size, endian = 'little') {
  return {
    endian,
    size: BigInt(size),
    sections: [],
    segments: [],
    offsetToAddress(off) { return 0x100000n + BigInt(off); },
  };
}

function encodeUtf16LE(str) {
  const out = new Uint8Array(str.length * 2);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    out[i * 2] = code & 0xff;
    out[i * 2 + 1] = (code >>> 8) & 0xff;
  }
  return out;
}

function concatBytes(...arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function encodeAdrp(rd, pc, targetPage) {
  const delta = Number((targetPage - (pc & ~0xfffn)) >> 12n);
  const imm21 = delta & 0x1fffff;
  const immlo = imm21 & 3;
  const immhi = (imm21 >>> 2) & 0x7ffff;
  return (0x90000000 | (immlo << 29) | (immhi << 5) | (rd & 31)) >>> 0;
}

function encodeAddImm64(rd, rn, imm12, shift = 0) {
  return (0x91000000 | ((shift & 1) << 22) | ((imm12 & 0xfff) << 10) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
}

function encodeLdrUoff64(rt, rn, offsetBytes) {
  const imm12 = (offsetBytes >>> 3) & 0xfff;
  return (0xf9400000 | (imm12 << 10) | ((rn & 31) << 5) | (rt & 31)) >>> 0;
}

function wordsToBytes(words) {
  const buf = new Uint8Array(words.length * 4);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < words.length; i++) dv.setUint32(i * 4, words[i] >>> 0, true);
  return buf;
}

test('scanSourceStrings UTF-16LE: ASCII strings emit no parity-1 CJK shadow and extract consecutive NUL-terminated strings', async () => {
  const raw = concatBytes(
    encodeUtf16LE('ABCD'),
    new Uint8Array([0, 0]),
    encodeUtf16LE('EFGH'),
    new Uint8Array([0, 0]),
  );
  const res = await scanSourceStrings(makeFakeImage(raw.length), makeBufferSource(raw), {
    minLength: 4,
    utf16: 'utf16le',
  });
  const utf16 = res.results.filter((s) => s.encoding === 'utf16le');
  assert.deepEqual(utf16.map((s) => s.text), ['ABCD', 'EFGH']);
  assert.deepEqual(utf16.map((s) => s.fileOffset), [0n, 10n]);
});

test('scanSourceStrings UTF-16LE: parity-1 odd-offset string after many parity-0 strings is not starved and limit fairness holds', async () => {
  const parts = [];
  for (let i = 0; i < 6; i++) {
    parts.push(encodeUtf16LE(`EVEN${i}`), new Uint8Array([0, 0]));
  }
  // 1 padding byte shifts the following UTF-16LE string to an odd offset
  parts.push(new Uint8Array([0]), encodeUtf16LE('ODDSTR'), new Uint8Array([0, 0]));
  const raw = concatBytes(...parts);

  const all = await scanSourceStrings(makeFakeImage(raw.length), makeBufferSource(raw), {
    minLength: 4,
    utf16: 'utf16le',
  });
  const utf16All = all.results.filter((s) => s.encoding === 'utf16le');
  assert.ok(utf16All.some((s) => s.text === 'ODDSTR' && (s.fileOffset & 1n) === 1n));
  assert.equal(utf16All.length, 7);

  // Limit fairness: an early odd-offset string must appear before later even-offset strings
  const fairRaw = concatBytes(
    new Uint8Array([0]),
    encodeUtf16LE('FIRST1'),
    new Uint8Array([0, 0, 0]),
    encodeUtf16LE('SECOND'),
    new Uint8Array([0, 0]),
  );
  const limited = await scanSourceStrings(makeFakeImage(fairRaw.length), makeBufferSource(fairRaw), {
    minLength: 4,
    utf16: 'utf16le',
    limit: 1,
  });
  const utf16Limited = limited.results.filter((s) => s.encoding === 'utf16le');
  assert.equal(utf16Limited.length, 1);
  assert.equal(utf16Limited[0].text, 'FIRST1');
  assert.equal(limited.capped, true);
});

function makeChunkedSource(bytes, maxReadLength) {
  const base = makeBufferSource(bytes);
  let reads = 0;
  return {
    get reads() { return reads; },
    source: {
      size: base.size,
      maxReadLength,
      async read(offset, length) {
        reads++;
        return base.read(offset, length);
      },
    },
  };
}

test('scanSourceStrings UTF-16LE: cross-block boundary extraction preserves string without duplicating seen spans', async () => {
  const raw = concatBytes(
    new Uint8Array([0, 0, 0, 0]),
    encodeUtf16LE('CROSSBLOCK'),
    new Uint8Array([0, 0]),
    new Uint8Array([0]),
    encodeUtf16LE('ODDCROSS'),
    new Uint8Array([0, 0]),
  );
  const chunked = makeChunkedSource(raw, 10);
  const res = await scanSourceStrings(makeFakeImage(raw.length), chunked.source, {
    minLength: 4,
    utf16: 'utf16le',
  });
  assert.ok(chunked.reads > 1, `expected multi-block reads, got ${chunked.reads}`);
  const utf16 = res.results.filter((s) => s.encoding === 'utf16le');
  assert.deepEqual(utf16.map((s) => s.text), ['CROSSBLOCK', 'ODDCROSS']);
});

test('scanSourceStrings UTF-16LE: cross-block odd-offset ASCII string is not eclipsed by parity-0 CJK shadow', async () => {
  const raw = new Uint8Array([0x00, 0x41, 0x00, 0x42, 0x00, 0x43, 0x00, 0x44, 0x00, 0x00, 0x00]);
  const chunked = makeChunkedSource(raw, 10);
  const res = await scanSourceStrings(makeFakeImage(raw.length), chunked.source, {
    minLength: 4,
    utf16: 'utf16le',
  });
  assert.ok(chunked.reads > 1, `expected multi-block reads, got ${chunked.reads}`);
  const utf16 = res.results.filter((s) => s.encoding === 'utf16le');
  assert.deepEqual(utf16.map((s) => s.text), ['ABCD']);
  assert.equal(utf16[0].fileOffset, 1n);
});

test('scanSourceStrings UTF-16LE: trailing string after non-ASCII string and opposite-parity unfinished carry is not dropped', async () => {
  const raw = concatBytes(
    encodeUtf16LE('猫犬鳥魚'),
    new Uint8Array([0, 0]),
    encodeUtf16LE('AfterBoundary'),
    new Uint8Array([0, 0]),
  );
  const chunked = makeChunkedSource(raw, 12);
  const res = await scanSourceStrings(makeFakeImage(raw.length), chunked.source, {
    minLength: 4,
    utf16: 'utf16le',
  });
  assert.ok(chunked.reads > 1, `expected multi-block reads, got ${chunked.reads}`);
  const utf16 = res.results.filter((s) => s.encoding === 'utf16le');
  assert.deepEqual(utf16.map((s) => s.text), ['猫犬鳥魚', 'AfterBoundary']);
});

test('chained.js stubSlot: decodes ARM64e ADRP + ADD (imm64) + LDR, Xd!==Xn, rd===31 guards, and preserves base on unrelated ADD', () => {
  const pc = 0x100004000n;
  const targetPage = 0x100008000n;

  // 1. ADRP x16, #page ; ADD x16, x16, #0x40 ; LDR x16, [x16, #0x18]
  const code1 = wordsToBytes([
    encodeAdrp(16, pc, targetPage),
    encodeAddImm64(16, 16, 0x40, 0),
    encodeLdrUoff64(16, 16, 0x18),
  ]);
  assert.equal(stubSlot(code1, 0, pc, 16), targetPage + 0x40n + 0x18n);

  // 2. Xd !== Xn tracking + shift=1 (LSL #12): ADRP x16 ; ADD x17, x16, #2, lsl #12 ; LDR x16, [x17, #0x10]
  const code2 = wordsToBytes([
    encodeAdrp(16, pc, targetPage),
    encodeAddImm64(17, 16, 2, 1),
    encodeLdrUoff64(16, 17, 0x10),
  ]);
  assert.equal(stubSlot(code2, 0, pc, 16), targetPage + 0x2000n + 0x10n);

  // 3. Unrelated ADD (x10 = x11 + 8) preserves baseReg x16
  const code3 = wordsToBytes([
    encodeAdrp(16, pc, targetPage),
    encodeAddImm64(10, 11, 8, 0),
    encodeLdrUoff64(16, 16, 0x20),
  ]);
  assert.equal(stubSlot(code3, 0, pc, 16), targetPage + 0x20n);

  // 4. ADRP to XZR (rd=31) is ignored
  const code4 = wordsToBytes([
    encodeAdrp(31, pc, targetPage),
    encodeLdrUoff64(16, 31, 0x10),
  ]);
  assert.equal(stubSlot(code4, 0, pc, 16), null);

  // 5. ADD to SP (rd=31) terminates tracking
  const code5 = wordsToBytes([
    encodeAdrp(16, pc, targetPage),
    encodeAddImm64(31, 16, 0x20, 0),
    encodeLdrUoff64(16, 31, 0x10),
  ]);
  assert.equal(stubSlot(code5, 0, pc, 16), null);

  // 6. Clobbering baseReg via unrelated ADD (x16 = x1 + 4) invalidates page
  const code6 = wordsToBytes([
    encodeAdrp(16, pc, targetPage),
    encodeAddImm64(16, 1, 4, 0),
    encodeLdrUoff64(16, 16, 0x10),
  ]);
  assert.equal(stubSlot(code6, 0, pc, 16), null);
});

test('macho.js parseFat: rejects slice offset overlapping the Fat header', () => {
  const buf = new ArrayBuffer(8 + 20);
  const dv = new DataView(buf);
  dv.setUint32(0, 0xcafebabe, false); // FAT_MAGIC
  dv.setUint32(4, 1, false);          // nfat_arch = 1 -> headerEnd = 28
  dv.setInt32(8, 0x0100000c, false);  // CPU_TYPE_ARM64
  dv.setInt32(12, 0, false);          // cpusubtype
  dv.setUint32(16, 16, false);        // offset = 16 < 28 (overlaps Fat header)
  dv.setUint32(20, 64, false);        // size = 64
  dv.setUint32(24, 12, false);        // align

  assert.equal(globalThis.MachO.parseFat(buf, 1024n), null);

  // Valid offset >= headerEnd succeeds
  dv.setUint32(16, 28, false);
  const parsed = globalThis.MachO.parseFat(buf, 1024n);
  assert.ok(Array.isArray(parsed) && parsed.length === 1);
  assert.equal(parsed[0].offset, 28n);
});

test('program.js statsOf & mostCalled: 1-arg statsOf works, empty/reversed range fails closed, mostCalled uses BigInt keys', () => {
  const kinds = new Uint8Array([KIND.ARITH, KIND.MUL, KIND.LOAD, KIND.RET]);
  const callFrom = new BigUint64Array([0x1000n, 0x1004n, 0x1008n]);
  const callTo = new BigUint64Array([0x2000n, 0x3000n, 0x2000n]);
  const prog = new ProgramIndex({
    vmAddr: 0x1000n,
    words: 4,
    kinds,
    kindsCovered: 4,
    callFrom,
    callTo,
    callCount: 3,
    refFrom: new BigUint64Array(0),
    refTo: new BigUint64Array(0),
    refKind: new Uint8Array(0),
    refCount: 0,
  }, null, null);

  // 1-argument statsOf(start) covers 1 instruction (4 bytes)
  const one = prog.statsOf(0x1004n);
  assert.equal(one.covered, true);
  assert.equal(one.total, 1);
  assert.equal(one.mul, 1);

  // Empty and reversed ranges return covered = false
  const empty = prog.statsOf(0x1004n, 0x1004n);
  assert.equal(empty.covered, false);
  assert.equal(empty.total, 0);

  const reversed = prog.statsOf(0x1008n, 0x1000n);
  assert.equal(reversed.covered, false);
  assert.equal(reversed.total, 0);

  // mostCalled returns BigInt addr and accurate counts
  const top = prog.mostCalled(5);
  assert.equal(top.length, 2);
  assert.equal(typeof top[0].addr, 'bigint');
  assert.equal(top[0].addr, 0x2000n);
  assert.equal(top[0].count, 2);
  assert.equal(top[1].addr, 0x3000n);
  assert.equal(top[1].count, 1);
});
