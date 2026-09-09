import assert from 'node:assert/strict';
import test from 'node:test';

import { parseELF } from '../../../js/binary/elf.js';

// parseELF(..., { signal }) advertises cancellation for section-backed
// metadata, but the PT_DYNAMIC path started its own budgets and scanned tags
// without consulting the caller's signal (#5584). An aborted caller must not
// fund new PT_DYNAMIC decode work: the parse stops fail-closed with partial
// dynamic metadata and never reports complete.

const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const u64 = (v) => [...u32(Number(BigInt(v) & 0xffffffffn)), ...u32(Number((BigInt(v) >> 32n) & 0xffffffffn))];

const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const DT_NULL = 0;
const DT_NEEDED = 1;
const DT_STRTAB = 5;
const DT_STRSZ = 10;

function buildDynamicElf({ entries = 64 } = {}) {
  const strtab = new TextEncoder().encode('\0libc.so.6\0');
  // Layout: [0,64) ELF header, [64,64+2*56) phdrs, strtab at 0x100,
  // PT_DYNAMIC entries at 0x200.
  const strtabOffset = 0x100;
  const strtabVa = 0x1000;
  const dynamicOffset = 0x200;
  const dynamicVa = 0x2000;
  const dynamicEntries = [];
  dynamicEntries.push([...u64(DT_NEEDED), ...u64(1)]);
  dynamicEntries.push([...u64(DT_STRTAB), ...u64(strtabVa)]);
  dynamicEntries.push([...u64(DT_STRSZ), ...u64(strtab.length)]);
  for (let i = dynamicEntries.length; i < entries; i += 1) {
    // Non-NULL filler tags keep the scan busy; tag 0x6ffffff0-ish is fine but
    // a plain unknown tag keeps this fixture minimal.
    dynamicEntries.push([...u64(0x70000000n), ...u64(i)]);
  }
  dynamicEntries.push([...u64(DT_NULL), ...u64(0)]);
  const dynamicBytes = dynamicEntries.flat();

  const dynamicSize = dynamicBytes.length;
  const loadFilesz = dynamicOffset + dynamicSize - 0x100; // strtab + dynamic
  const total = 0x100 + loadFilesz;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);

  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  view.setUint16(16, 3, true); // ET_DYN
  view.setUint16(18, 62, true); // x86-64
  view.setUint32(20, 1, true);
  view.setBigUint64(32, 64n, true); // e_phoff
  view.setUint16(52, 64, true); // e_ehsize
  view.setUint16(54, 56, true); // e_phentsize
  view.setUint16(56, 2, true); // e_phnum

  const phdr = (i, type, off, va, filesz) => {
    const p = 64 + i * 56;
    view.setUint32(p, type, true);
    view.setUint32(p + 4, 5, true); // PF_R|PF_X
    view.setBigUint64(p + 8, BigInt(off), true);
    view.setBigUint64(p + 16, BigInt(va), true);
    view.setBigUint64(p + 24, BigInt(va), true);
    view.setBigUint64(p + 32, BigInt(filesz), true);
    view.setBigUint64(p + 40, BigInt(filesz), true);
    view.setBigUint64(p + 48, 0x1000n, true);
  };
  phdr(0, PT_LOAD, 0x100, 0x1000, loadFilesz);
  phdr(1, PT_DYNAMIC, dynamicOffset, dynamicVa, dynamicSize);

  bytes.set(strtab, strtabOffset);
  bytes.set(dynamicBytes, dynamicOffset);
  return bytes;
}

test('#5584: an aborted signal stops the PT_DYNAMIC path before it starts', () => {
  const controller = new AbortController();
  controller.abort();
  const image = parseELF(buildDynamicElf(), { signal: controller.signal });
  assert.equal(image.metadata.programDynamicPartial, true, 'cancelled PT_DYNAMIC work is partial, not silently complete');
  assert.ok(image.metadata.programDynamicDiagnostics.some((d) => d.includes('cancelled')));
  assert.equal(image.metadata.programDynamicSymbols?.length ?? 0, 0, 'no dynamic symbols were decoded after abort');
  assert.equal(image.imports.length, 0, 'no imports were minted after abort');
  assert.equal(image.libraries.includes('libc.so.6'), false, 'DT_NEEDED decode did not run after abort');
});

test('#5584: a non-aborted signal parses the same image normally', () => {
  const controller = new AbortController();
  const image = parseELF(buildDynamicElf(), { signal: controller.signal });
  assert.equal(image.metadata.programDynamicPartial ?? false, false);
  assert.equal(image.libraries.includes('libc.so.6'), true);
  assert.equal(image.imports.length, 0, 'this fixture declares no undefined symbols');
});
