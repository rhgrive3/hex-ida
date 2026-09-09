import assert from 'node:assert/strict';
import test from 'node:test';
import { parseELF } from '../../../js/binary/elf.js';

// Issue #7610: Linux maps conflicting PT_LOAD claims last-wins, so a first-wins
// canonical mapping publishes bytes the OS does not execute. Any PT_LOAD overlap
// whose byte provenance depends on program-header order must fail closed
// (typed ELF_PT_LOAD_VM_OVERLAP) instead of silently resolving the winner.

const PT_LOAD = 1;
const PF_X = 1, PF_W = 2, PF_R = 4;

function elf(loads) {
  const ehsize = 64, phentsize = 56, phoff = ehsize;
  const buf = new Uint8Array(0x4000);
  const dv = new DataView(buf.buffer);
  buf.set([0x7f, 0x45, 0x4c, 0x46], 0);
  dv.setUint8(4, 2);            // ELF64
  dv.setUint8(5, 1);            // little endian
  dv.setUint8(6, 1);            // EI_VERSION
  dv.setUint16(14, 2, true);    // ET_EXEC
  dv.setUint16(16, 62, true);   // EM_X86_64
  dv.setUint32(20, 1, true);    // e_version
  dv.setBigUint64(24, 0x400000n, true); // e_entry
  dv.setBigUint64(32, BigInt(phoff), true);
  dv.setUint16(52, ehsize, true);
  dv.setUint16(54, phentsize, true);
  dv.setUint16(56, loads.length, true);
  let p = phoff;
  for (const L of loads) {
    dv.setUint32(p + 0, PT_LOAD, true);
    dv.setUint32(p + 4, L.flags, true);
    dv.setBigUint64(p + 8, BigInt(L.offset), true);
    dv.setBigUint64(p + 16, BigInt(L.vaddr ?? 0x400000), true);
    dv.setBigUint64(p + 24, BigInt(L.vaddr ?? 0x400000), true);
    dv.setBigUint64(p + 32, BigInt(L.filesz ?? 0x1000), true);
    dv.setBigUint64(p + 40, BigInt(L.memsz ?? 0x1000), true);
    dv.setBigUint64(p + 48, 0x1000n, true);
    p += phentsize;
  }
  const put = (off, edi) => buf.set([0xb8, 0x3c, 0x00, 0x00, 0x00, 0xbf, edi, 0x00, 0x00, 0x00, 0x0f, 0x05], off);
  put(0x1000, 11);
  put(0x2000, 22);
  return buf;
}

const parse = (loads) => {
  try {
    return { image: parseELF(elf(loads)), error: null };
  } catch (error) {
    return { image: null, error };
  }
};

test('#7610 conflicting PT_LOAD file mappings over one VA range fail closed', () => {
  // Issue's decisive fixture: two PT_LOADs map VA 0x400000 to file 0x1000
  // (exit 11) and file 0x2000 (exit 22). Linux executes the later mapping.
  const { image, error } = parse([{ offset: 0x1000, flags: PF_R | PF_X }, { offset: 0x2000, flags: PF_R | PF_X }]);
  assert.equal(image, null, 'first-wins bytes must not be published as canonical');
  assert.equal(error?.code, 'ELF_PT_LOAD_VM_OVERLAP');
  assert.match(error.message, /different file mapping/);
});

test('#7610 program-header order must not decide the winner (reverse control)', () => {
  const { image, error } = parse([{ offset: 0x2000, flags: PF_R | PF_X }, { offset: 0x1000, flags: PF_R | PF_X }]);
  assert.equal(image, null);
  assert.equal(error?.code, 'ELF_PT_LOAD_VM_OVERLAP');
});

test('#7610 file-backed over zero-fill overlap is order-dependent and fails closed', () => {
  // LOAD0 zero-fill BSS; LOAD1 maps bytes into that range — Linux would let
  // LOAD1 win, first-wins publishes LOAD0's zeros.
  const { image, error } = parse([
    { offset: 0x1000, flags: PF_R | PF_W, filesz: 0, memsz: 0x800, vaddr: 0x400000 },
    { offset: 0x2000, flags: PF_R | PF_X, filesz: 0x800, memsz: 0x800, vaddr: 0x400400 },
  ]);
  assert.equal(image, null);
  assert.equal(error?.code, 'ELF_PT_LOAD_VM_OVERLAP');
  assert.match(error.message, /ambiguous file\/zero ownership/);
});

test('#7610 congruent duplicate PT_LOAD claims stay accepted', () => {
  const { image, error } = parse([{ offset: 0x1000, flags: PF_R | PF_X }, { offset: 0x1000, flags: PF_R | PF_X }]);
  assert.equal(error, null);
  const loads = image.segments.filter((s) => s.name?.startsWith('LOAD'));
  assert.equal(loads.length, 2);
  assert.equal(image.addressToOffset(0x400000n), 0x1000n);
});

test('#7610 non-overlapping PT_LOADs are not regressed', () => {
  const { image, error } = parse([
    { offset: 0x1000, flags: PF_R | PF_X, vaddr: 0x400000 },
    { offset: 0x2000, flags: PF_R | PF_W, vaddr: 0x401000 },
  ]);
  assert.equal(error, null);
  assert.equal(image.addressToOffset(0x400000n), 0x1000n);
  assert.equal(image.addressToOffset(0x401000n), 0x2000n);
});

test('#7610 loader-congruent partial-page aliases fail closed in either header order', () => {
  const first = { offset: 0x1000, flags: PF_R | PF_X, vaddr: 0x400000, filesz: 0x800, memsz: 0x800 };
  const second = { offset: 0x2800, flags: PF_R | PF_X, vaddr: 0x400800, filesz: 0x800, memsz: 0x800 };
  for (const loads of [[first, second], [second, first]]) {
    const { image, error } = parse(loads);
    assert.equal(image, null, 'same mapped page with different file-page provenance must not publish canonical bytes');
    assert.equal(error?.code, 'ELF_PT_LOAD_VM_OVERLAP');
    assert.match(error.message, /mapped page.*different file mapping/);
  }
});

test('#7610 page-disjoint adjacent PT_LOADs keep one canonical mapping authority', async () => {
  const { image, error } = parse([
    { offset: 0x1000, flags: PF_R | PF_X, vaddr: 0x400000, filesz: 0x1000, memsz: 0x1000 },
    { offset: 0x2000, flags: PF_R | PF_X, vaddr: 0x401000, filesz: 0x1000, memsz: 0x1000 },
  ]);
  assert.equal(error, null);
  assert.equal(image.addressToOffset(0x401000n), 0x2000n);
  const mapping = image.resolveVirtualMapping(0x401000n);
  assert.equal(mapping?.kind, 'file');
  assert.equal(mapping?.offset, 0x2000n);
  const expected = [0xb8, 0x3c, 0x00, 0x00, 0x00, 0xbf, 22, 0x00, 0x00, 0x00, 0x0f, 0x05];
  assert.deepEqual([...image.readVirtual(0x401000n, expected.length)], expected);
  assert.deepEqual([...await image.readVirtualAsync(0x401000n, expected.length)], expected);
  assert.equal(image.offsetToAddress(0x2000n), 0x401000n);
});
