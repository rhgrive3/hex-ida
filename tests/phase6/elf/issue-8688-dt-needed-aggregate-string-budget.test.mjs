import assert from 'node:assert/strict';
import test from 'node:test';

import { parseELF } from '../../../js/binary/elf.js';

// Issue #8688: parseProgramDynamic() decoded every DT_NEEDED / DT_SONAME name
// with only a per-string 1 MiB span cap, no aggregate decoded/output/heap
// budget and no string-offset cache. A valid ELF may hold thousands of
// DT_NEEDED entries, each referencing a distinct long suffix of DT_STRTAB, so
// a ~169 KiB input could retain hundreds of MiB of dependency-name strings on
// the ordinary parse path and deterministically abort a constrained V8 heap.
// The repair charges every decode against a shared aggregate budget and caches
// offsets; on exhaustion it fails closed to an explicit dynamic-strings
// partiality instead of growing without bound.

const PT_LOAD = 1, PT_DYNAMIC = 2, PF_R = 4;

function dynamicStringElf({ neededCount, strsz }) {
  const ehsize = 64, phentsize = 56;
  const dynoff = 0x200;
  const dynEntries = 2 + neededCount + 1; // STRTAB, STRSZ, NEEDED..., NULL
  const dynSize = dynEntries * 16;
  const strOff = dynoff + dynSize;
  const fileLen = strOff + strsz;
  const b = Buffer.alloc(fileLen);
  b.set([0x7f, 0x45, 0x4c, 0x46], 0);
  b.writeUInt8(2, 4); b.writeUInt8(1, 5); b.writeUInt8(1, 6);
  b.writeUInt16LE(3, 16); b.writeUInt16LE(62, 18); b.writeUInt32LE(1, 20); // ET_DYN, x86-64
  b.writeBigUInt64LE(0n, 24); b.writeBigUInt64LE(BigInt(ehsize), 32); b.writeBigUInt64LE(0n, 40);
  b.writeUInt32LE(0, 48); b.writeUInt16LE(ehsize, 52); b.writeUInt16LE(phentsize, 54); b.writeUInt16LE(2, 56);
  const p0 = ehsize;
  b.writeUInt32LE(PT_LOAD, p0 + 0); b.writeUInt32LE(PF_R, p0 + 4);
  b.writeBigUInt64LE(0n, p0 + 8); b.writeBigUInt64LE(0x400000n, p0 + 16); b.writeBigUInt64LE(0x400000n, p0 + 24);
  b.writeBigUInt64LE(BigInt(fileLen), p0 + 32); b.writeBigUInt64LE(BigInt(fileLen), p0 + 40); b.writeBigUInt64LE(1n, p0 + 48);
  const p1 = ehsize + phentsize;
  b.writeUInt32LE(PT_DYNAMIC, p1 + 0); b.writeUInt32LE(PF_R, p1 + 4);
  b.writeBigUInt64LE(BigInt(dynoff), p1 + 8); b.writeBigUInt64LE(0x400000n + BigInt(dynoff), p1 + 16); b.writeBigUInt64LE(0x400000n + BigInt(dynoff), p1 + 24);
  b.writeBigUInt64LE(BigInt(dynSize), p1 + 32); b.writeBigUInt64LE(BigInt(dynSize), p1 + 40); b.writeBigUInt64LE(1n, p1 + 48);
  // DT_STRTAB content: 00 'A'*(strsz-2) 00. DT_NEEDED i points to offset 1+i, a
  // distinct long NUL-terminated suffix.
  b[strOff] = 0x00;
  for (let i = 1; i < strsz - 1; i++) b[strOff + i] = 0x41;
  b[strOff + strsz - 1] = 0x00;
  let d = dynoff;
  const writeDyn = (tag, val) => { b.writeBigUInt64LE(BigInt(tag), d); b.writeBigUInt64LE(BigInt(val), d + 8); d += 16; };
  writeDyn(5, 0x400000 + strOff); // DT_STRTAB
  writeDyn(10, strsz);            // DT_STRSZ
  for (let i = 0; i < neededCount; i++) writeDyn(1, 1 + i); // DT_NEEDED
  writeDyn(0, 0);                 // DT_NULL
  return b;
}

test('#8688 many long DT_NEEDED suffixes are bounded, not heap-exhausting', () => {
  // The issue's shape: thousands of DT_NEEDED entries over a ~100 KiB string
  // table would naively decode ~Θ(neededCount × strsz) bytes and retain them
  // all. Assert the aggregate decode/retention budget truncates the work and
  // reports it explicitly rather than growing without bound.
  const buf = dynamicStringElf({ neededCount: 4500, strsz: 100_002 });
  const before = process.memoryUsage().heapUsed;
  const img = parseELF(buf);
  const grew = (process.memoryUsage().heapUsed - before) / (1024 * 1024);

  // Retained names are capped far below the naive 4500 × ~100 KB (hundreds of
  // MiB) and the parse stays well inside a constrained heap.
  assert.ok(img.libraries.length < 4500, `expected truncated library count, got ${img.libraries.length}`);
  assert.ok(grew < 64, `dynamic-string decode grew heap by ${grew.toFixed(1)} MiB (expected bounded)`);
  assert.equal(img.metadata.programDynamicPartial, true);
  assert.ok(img.warnings.some((w) => w.includes('dynamic strings:resource-budget')));
});

test('#8688 a small valid ELF keeps every DT_NEEDED name and its DT_SONAME', () => {
  const ehsize = 64, phentsize = 56, dynoff = 0x200, strOff = 0x300;
  const str = Buffer.from('\0libfoo.so\0libbar.so\0libbaz.so\0soname.so\0', 'latin1');
  const dynEntries = 2 + 3 + 1 + 1;
  const dynSize = dynEntries * 16;
  const fileLen = strOff + str.length;
  const b = Buffer.alloc(fileLen);
  b.set([0x7f, 0x45, 0x4c, 0x46], 0);
  b.writeUInt8(2, 4); b.writeUInt8(1, 5); b.writeUInt8(1, 6);
  b.writeUInt16LE(3, 16); b.writeUInt16LE(62, 18); b.writeUInt32LE(1, 20);
  b.writeBigUInt64LE(0n, 24); b.writeBigUInt64LE(BigInt(ehsize), 32); b.writeBigUInt64LE(0n, 40);
  b.writeUInt32LE(0, 48); b.writeUInt16LE(ehsize, 52); b.writeUInt16LE(phentsize, 54); b.writeUInt16LE(2, 56);
  const p0 = ehsize;
  b.writeUInt32LE(PT_LOAD, p0 + 0); b.writeUInt32LE(PF_R, p0 + 4);
  b.writeBigUInt64LE(0n, p0 + 8); b.writeBigUInt64LE(0x400000n, p0 + 16); b.writeBigUInt64LE(0x400000n, p0 + 24);
  b.writeBigUInt64LE(BigInt(fileLen), p0 + 32); b.writeBigUInt64LE(BigInt(fileLen), p0 + 40); b.writeBigUInt64LE(1n, p0 + 48);
  const p1 = ehsize + phentsize;
  b.writeUInt32LE(PT_DYNAMIC, p1 + 0); b.writeUInt32LE(PF_R, p1 + 4);
  b.writeBigUInt64LE(BigInt(dynoff), p1 + 8); b.writeBigUInt64LE(0x400000n + BigInt(dynoff), p1 + 16); b.writeBigUInt64LE(0x400000n + BigInt(dynoff), p1 + 24);
  b.writeBigUInt64LE(BigInt(dynSize), p1 + 32); b.writeBigUInt64LE(BigInt(dynSize), p1 + 40); b.writeBigUInt64LE(1n, p1 + 48);
  b.set(str, strOff);
  let d = dynoff;
  const w = (tag, val) => { b.writeBigUInt64LE(BigInt(tag), d); b.writeBigUInt64LE(BigInt(val), d + 8); d += 16; };
  w(5, 0x400000 + strOff); w(10, str.length);
  w(1, 1); w(1, 11); w(1, 21); // libfoo.so / libbar.so / libbaz.so
  w(14, 31);                    // DT_SONAME = soname.so
  w(0, 0);
  const img = parseELF(b);
  assert.deepEqual(img.libraries, ['libfoo.so', 'libbar.so', 'libbaz.so']);
  assert.equal(img.metadata.soname, 'soname.so');
  assert.notEqual(img.metadata.programDynamicPartial, true);
});
