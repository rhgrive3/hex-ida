import assert from 'node:assert/strict';
import test from 'node:test';
import { chainedImportSymbols } from '../js/chained.js';

const LE = true;
const BLOCK = 64 * 1024;
const CAP = 32 * 1024 * 1024;
const TEXT_VM = 0x100000000n;
const STUB_VM = TEXT_VM + 0x1000n;
const STUB_FILE = 0x1000;
const FIXOFF = 0x8000;
const DATA_FILE = 0x10000;
const DATA_VM = 0x100010000n;

function encodeStub(pc, slot) {
  const pcPage = pc & ~0xfffn;
  const slotPage = slot & ~0xfffn;
  const diff = Number((slotPage - pcPage) / 0x1000n);
  assert.ok(diff >= -(1 << 20) && diff < (1 << 20));
  const imm = diff & 0x1fffff;
  const immlo = imm & 3;
  const immhi = (imm >>> 2) & 0x7ffff;
  const adrp = (0x90000000 | (immlo << 29) | (immhi << 5) | 16) >>> 0;
  const ldr = (0xf9400000 | ((Number(slot & 0xfffn) >>> 3) << 10) | (16 << 5) | 16) >>> 0;
  return [adrp, ldr, 0xd61f0200];
}

class CountingFile {
  constructor(bytes) {
    this.bytes = bytes;
    this.size = bytes.length;
    this.reads = [];
  }
  slice(start, end) {
    const a = Math.max(0, Math.min(this.size, Number(start)));
    const b = Math.max(a, Math.min(this.size, Number(end)));
    this.reads.push({ start:a, length:b-a });
    const src = this.bytes;
    return {
      async arrayBuffer() {
        return src.slice(a, b).buffer;
      },
    };
  }
  supplementalBytes() {
    return this.reads
      .filter(({start}) => start === FIXOFF || start === STUB_FILE || start >= DATA_FILE)
      .reduce((n, x) => n + x.length, 0);
  }
  dataBlockReads() {
    return this.reads.filter(({start}) => start >= DATA_FILE && start % BLOCK === 0);
  }
}

function buildFixture(count, spacing) {
  const lastDelta = (count - 1) * spacing + 0x100;
  const pageCount = Math.floor(lastDelta / 0x1000) + 1;
  const structSize = 22 + pageCount * 2;
  const startsOffset = 28;
  const startsRecord = startsOffset + 12;
  const importsOffset = (startsRecord + structSize + 3) & ~3;
  const symbolsOffset = importsOffset + 8;
  const fixupSize = symbolsOffset + 5;
  const dataSize = count * spacing;
  const totalSize = Math.max(DATA_FILE + dataSize, FIXOFF + fixupSize, STUB_FILE + count * 12, 0x4000);
  const bytes = new Uint8Array(totalSize);
  const dv = new DataView(bytes.buffer);

  // Mach-O 64 header.
  dv.setUint32(0, 0xfeedfacf, LE);
  dv.setInt32(4, 0x0100000c, LE); // ARM64
  dv.setInt32(8, 0, LE);
  dv.setUint32(12, 2, LE); // MH_EXECUTE
  dv.setUint32(16, 3, LE);
  dv.setUint32(20, 152 + 72 + 16, LE);

  let p = 32;
  // __TEXT with __stubs.
  dv.setUint32(p, 0x19, LE); dv.setUint32(p + 4, 152, LE);
  bytes.set(Buffer.from('__TEXT\0\0\0\0\0\0\0\0\0\0'), p + 8);
  dv.setBigUint64(p + 24, TEXT_VM, LE); dv.setBigUint64(p + 32, 0x4000n, LE);
  dv.setBigUint64(p + 40, 0n, LE); dv.setBigUint64(p + 48, 0x4000n, LE);
  dv.setUint32(p + 64, 1, LE);
  let q = p + 72;
  bytes.set(Buffer.from('__stubs\0\0\0\0\0\0\0\0\0'), q);
  bytes.set(Buffer.from('__TEXT\0\0\0\0\0\0\0\0\0\0'), q + 16);
  dv.setBigUint64(q + 32, STUB_VM, LE);
  dv.setBigUint64(q + 40, BigInt(count * 12), LE);
  dv.setUint32(q + 48, STUB_FILE, LE);
  dv.setUint32(q + 64, 0x8, LE); // S_SYMBOL_STUBS
  dv.setUint32(q + 72, 12, LE);

  for (let i = 0; i < count; i++) {
    const stubAddr = STUB_VM + BigInt(i * 12);
    const slot = DATA_VM + BigInt(i * spacing + 0x100);
    const words = encodeStub(stubAddr, slot);
    const off = STUB_FILE + i * 12;
    for (let j = 0; j < 3; j++) dv.setUint32(off + j * 4, words[j], LE);
  }

  p += 152;
  // Large __DATA_CONST mapping, no section header needed for supplemental recovery.
  dv.setUint32(p, 0x19, LE); dv.setUint32(p + 4, 72, LE);
  bytes.set(Buffer.from('__DATA_CONST\0\0\0\0'), p + 8);
  dv.setBigUint64(p + 24, DATA_VM, LE); dv.setBigUint64(p + 32, BigInt(dataSize), LE);
  dv.setBigUint64(p + 40, BigInt(DATA_FILE), LE); dv.setBigUint64(p + 48, BigInt(dataSize), LE);
  dv.setUint32(p + 64, 0, LE);

  p += 72;
  dv.setUint32(p, 0x80000034, LE); dv.setUint32(p + 4, 16, LE);
  dv.setUint32(p + 8, FIXOFF, LE); dv.setUint32(p + 12, fixupSize, LE);

  const F = FIXOFF;
  dv.setUint32(F + 0, 0, LE);
  dv.setUint32(F + 4, startsOffset, LE);
  dv.setUint32(F + 8, importsOffset, LE);
  dv.setUint32(F + 12, symbolsOffset, LE);
  dv.setUint32(F + 16, 1, LE);
  dv.setUint32(F + 20, 2, LE); // DYLD_CHAINED_IMPORT_ADDEND
  dv.setUint32(F + 24, 0, LE);

  // starts_in_image: segment 0 has none; segment 1 owns the DATA chains.
  dv.setUint32(F + startsOffset, 2, LE);
  dv.setUint32(F + startsOffset + 4, 0, LE);
  dv.setUint32(F + startsOffset + 8, 12, LE);
  const S = F + startsRecord;
  dv.setUint32(S + 0, structSize, LE);
  dv.setUint16(S + 4, 0x1000, LE);
  dv.setUint16(S + 6, 6, LE); // DYLD_CHAINED_PTR_64_OFFSET
  dv.setBigUint64(S + 8, BigInt(DATA_FILE), LE);
  dv.setUint32(S + 16, 0, LE);
  dv.setUint16(S + 20, pageCount, LE);
  for (let pg = 0; pg < pageCount; pg++) dv.setUint16(S + 22 + pg * 2, 0xffff, LE);

  for (let i = 0; i < count; i++) {
    const delta = i * spacing + 0x100;
    const page = Math.floor(delta / 0x1000);
    dv.setUint16(S + 22 + page * 2, delta & 0xfff, LE);
    const fileOff = DATA_FILE + delta;
    dv.setBigUint64(fileOff, 1n << 63n, LE); // bind, ordinal 0, next 0
  }

  dv.setUint32(F + importsOffset, 0, LE);
  dv.setUint32(F + importsOffset + 4, 0, LE);
  bytes.set(Buffer.from('puts\0'), F + symbolsOffset);
  return new CountingFile(bytes);
}

test('#5044 normal recovery keeps repeated GOT reads cache-backed', async () => {
  const file = buildFixture(2, 0x1000); // two pages, same 64 KiB file block
  const out = await chainedImportSymbols(file, 0);
  assert.equal(out.length, 4);
  assert.deepEqual([...new Set(out.map((x) => x.name))], ['puts']);
  const dataBlocks = file.dataBlockReads();
  assert.equal(dataBlocks.length, 1, 'cache hits must not issue or charge a second 64 KiB file read');
  assert.ok(file.supplementalBytes() < CAP);
});

test('#5044 a dispersed workload just below the shared cap remains recoverable', async () => {
  const file = buildFixture(511, BLOCK);
  const out = await chainedImportSymbols(file, 0);
  assert.equal(out.length, 1022, '511 dispersed slots stay below the aggregate read cap');
  assert.equal(file.dataBlockReads().length, 511);
  assert.ok(file.supplementalBytes() <= CAP);
});

test('#5044 dispersed GOT cache misses cannot exceed the 32 MiB supplemental read cap', async () => {
  const file = buildFixture(513, BLOCK);
  const out = await chainedImportSymbols(file, 0);
  assert.deepEqual(out, [], 'budget exhaustion must fail closed instead of publishing a partial supplemental name set');
  assert.ok(file.supplementalBytes() <= CAP,
    `supplemental reads exceeded cap: ${file.supplementalBytes()} > ${CAP}`);
  assert.ok(file.dataBlockReads().length < 513,
    'the 513th dispersed GOT lookup must not issue another 64 KiB cache-miss read');
});
