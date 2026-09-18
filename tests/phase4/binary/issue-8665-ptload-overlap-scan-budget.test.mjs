import assert from 'node:assert/strict';
import test from 'node:test';

import { parseELF } from '../../../js/binary/elf.js';

// Issue #8665: overlapping PT_LOAD provenance validation (added for #7610)
// scanned *every* previously accepted load for each new load, and every runtime
// SHF_ALLOC section re-scanned the whole load set. A structurally valid ELF of
// page-disjoint loads therefore cost Θ(N^2) prior-segment BigInt iterations
// before the shared ELFMetadataBudget/wall-clock/AbortSignal controls existed.
// A 1.7 MiB / 30k-load input exceeded an external 20s deadline (baseline here:
// 8k loads = ~33s). The repair indexes accepted loads by their page-rounded VM
// interval and bounds the topology scan, so disjoint inputs cost near-linear
// work while every genuine #7610 ambiguity still fails closed.

const PT_LOAD = 1;
const PF_R = 4;
const SHF_ALLOC = 0x2n;

function manyDisjointLoads(n, { withSections = false } = {}) {
  const ehsize = 64, phentsize = 56, shentsize = 64;
  const phoff = ehsize;
  const dataoff = ehsize + phentsize * n;
  const shstr = Buffer.from('a\0', 'latin1');
  const strtabFileOff = dataoff + n;
  const shoff = withSections ? strtabFileOff + shstr.length : 0;
  const secCount = withSections ? n + 1 : 0;
  const total = withSections ? shoff + shentsize * secCount : strtabFileOff + shstr.length;
  const b = Buffer.alloc(total);
  b.set([0x7f, 0x45, 0x4c, 0x46], 0);
  b.writeUInt8(2, 4);              // ELFCLASS64
  b.writeUInt8(1, 5);             // little endian
  b.writeUInt8(1, 6);             // EI_VERSION
  b.writeUInt16LE(2, 16);         // ET_EXEC
  b.writeUInt16LE(62, 18);        // EM_X86_64
  b.writeUInt32LE(1, 20);
  b.writeBigUInt64LE(0n, 24);     // e_entry
  b.writeBigUInt64LE(BigInt(phoff), 32);
  b.writeBigUInt64LE(BigInt(shoff), 40);
  b.writeUInt32LE(0, 48);
  b.writeUInt16LE(ehsize, 52);
  b.writeUInt16LE(phentsize, 54);
  b.writeUInt16LE(n, 56);         // e_phnum
  b.writeUInt16LE(shentsize, 58); // e_shentsize
  b.writeUInt16LE(secCount, 60);  // e_shnum
  b.writeUInt16LE(0, 62);         // e_shstrndx
  for (let i = 0; i < n; i++) {
    const off = dataoff + i, va = 0x100000 + i * 0x1000, po = phoff + i * phentsize;
    b.writeUInt32LE(PT_LOAD, po + 0);
    b.writeUInt32LE(PF_R, po + 4);
    b.writeBigUInt64LE(BigInt(off), po + 8);
    b.writeBigUInt64LE(BigInt(va), po + 16);
    b.writeBigUInt64LE(BigInt(va), po + 24);
    b.writeBigUInt64LE(1n, po + 32);
    b.writeBigUInt64LE(1n, po + 40);
    b.writeBigUInt64LE(1n, po + 48);     // p_align = 1 (matches the issue generator; page-disjoint via vaddr stride)
    b[off] = i & 0xff;
  }
  b.set(shstr, strtabFileOff);
  if (withSections) {
    for (let i = 0; i < n; i++) {
      const so = shoff + shentsize * (i + 1), va = 0x100000 + i * 0x1000, off = dataoff + i;
      b.writeUInt32LE(0, so + 0);         // .name = "a"
      b.writeUInt32LE(1, so + 4);         // SHT_PROGBITS
      b.writeBigUInt64LE(SHF_ALLOC, so + 8);
      b.writeBigUInt64LE(BigInt(va), so + 16);
      b.writeBigUInt64LE(BigInt(off), so + 24);
      b.writeBigUInt64LE(1n, so + 32);    // size
      b.writeBigUInt64LE(1n, so + 48);    // sh_addralign
    }
  }
  return b;
}

function conflictingPairLoad() {
  const ehsize = 64, phentsize = 56, phoff = ehsize;
  const buf = Buffer.alloc(0x4000);
  buf.set([0x7f, 0x45, 0x4c, 0x46], 0);
  buf.writeUInt8(2, 4); buf.writeUInt8(1, 5); buf.writeUInt8(1, 6);
  buf.writeUInt16LE(2, 16); buf.writeUInt16LE(62, 18); buf.writeUInt32LE(1, 20);
  buf.writeBigUInt64LE(0n, 24); buf.writeBigUInt64LE(BigInt(phoff), 32);
  buf.writeUInt16LE(ehsize, 52); buf.writeUInt16LE(phentsize, 54); buf.writeUInt16LE(2, 56);
  const ph = (i, off, va, foff) => {
    const p = phoff + i * phentsize;
    buf.writeUInt32LE(PT_LOAD, p + 0); buf.writeUInt32LE(PF_R, p + 4);
    buf.writeBigUInt64LE(BigInt(off), p + 8);
    buf.writeBigUInt64LE(BigInt(va), p + 16); buf.writeBigUInt64LE(BigInt(va), p + 24);
    buf.writeBigUInt64LE(0x1000n, p + 32); buf.writeBigUInt64LE(0x1000n, p + 40);
    buf.writeBigUInt64LE(0x1000n, p + 48);
    void foff;
  };
  // Two identical-VM loads with different file offsets are ambiguous (#7610).
  ph(0, 0x2000, 0x400000);
  ph(1, 0x3000, 0x400000);
  return buf;
}

test('#8665 disjoint PT_LOAD topology validation is near-linear, not quadratic', () => {
  const small = manyDisjointLoads(4000);
  const large = manyDisjointLoads(16000);

  const t0 = Date.now();
  const smallImg = parseELF(small);
  const smallMs = Date.now() - t0;
  const t1 = Date.now();
  const largeImg = parseELF(large);
  const largeMs = Date.now() - t1;

  // Correctness is unchanged: every load is accepted, nothing is marked partial.
  assert.equal(smallImg.segments.length, 4000);
  assert.equal(largeImg.segments.length, 16000);
  assert.equal(largeImg.warnings.length, 0);
  assert.equal(largeImg.metadata.elfMetadata.complete, true);

  // Quadratic work over 4× the loads (16× the pairs) blew the 20s external
  // deadline (baseline: 8k ≈ 33s). Require a hard ceiling and sub-quadratic
  // scaling so this class of blow-up cannot regress silently.
  assert.ok(largeMs < 6000, `16k disjoint loads parsed in ${largeMs}ms (expected <6000ms; quadratic would exceed the 20s audit deadline)`);
  assert.ok(largeMs < smallMs * 8 + 1500, `scaling looks super-linear: 4k=${smallMs}ms 16k=${largeMs}ms`);
});

test('#8665 SHF_ALLOC section span check over disjoint loads stays near-linear', () => {
  const n = 8000;
  const buf = manyDisjointLoads(n, { withSections: true });
  const t0 = Date.now();
  parseELF(buf);
  const dt = Date.now() - t0;
  // Each load has a matching alloc section: baseline cost was Θ(n^2) scans
  // (8k sections × 8k loads ≈ 64M) on top of the pairwise load scan. The
  // indexed bounds keep the whole pass bounded even at this size.
  assert.ok(dt < 6000, `8k loads+sections parsed in ${dt}ms (expected <6000ms)`);
});

test('#8665 preserves the #7610 byte-provenance fail-closed rejection', () => {
  assert.throws(() => parseELF(conflictingPairLoad()), (error) => {
    return error && error.code === 'ELF_PT_LOAD_VM_OVERLAP';
  });
});
