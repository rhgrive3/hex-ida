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
const DT_SYMTAB = 6;
const DT_SYMENT = 11;
const DT_RELA = 7;
const DT_RELASZ = 8;
const DT_RELAENT = 9;

// GNU-hash fixture geometry: one bucket whose chain needs GNU_HASH_CHAIN_STEPS
// walk steps, so symoffset + steps = GNU_HASH_SYM_COUNT exact symbols.
const GNU_HASH_CHAIN_STEPS = 64;
const GNU_HASH_SYM_COUNT = GNU_HASH_CHAIN_STEPS + 1;

function buildDynamicElf({ entries = 64, withRelocationsAndSymbols = false, withGnuHash = false } = {}) {
  const strtab = new TextEncoder().encode('\0libc.so.6\0foo\0');
  // Layout: [0,64) ELF header, [64,64+2*56) phdrs, strtab at 0x100,
  // PT_DYNAMIC entries at 0x200, [opt] dynsym + relocations after.
  const strtabOffset = 0x100;
  const strtabVa = 0x1000;
  const dynamicOffset = 0x200;
  const dynamicVa = 0x2000;
  const dynamicEntries = [];
  dynamicEntries.push([...u64(DT_NEEDED), ...u64(1)]);
  dynamicEntries.push([...u64(DT_STRTAB), ...u64(strtabVa)]);
  dynamicEntries.push([...u64(DT_STRSZ), ...u64(strtab.length)]);
  // Optional dynsym (2 entries: null + undefined 'foo') and DT_JMPREL/DT_RELA
  // relocation tables referencing it, so the relocation/symbol/version
  // subdecoders have real work to be cancelled out of.
  const symtabOffset = dynamicOffset + entries * 16 + 16;
  const symtabVa = 0x1000 + (symtabOffset - 0x100); // linear PT_LOAD mapping
  const relaOffset = symtabOffset + 48;
  const relaVa = 0x1000 + (relaOffset - 0x100);
  if (withRelocationsAndSymbols) {
    dynamicEntries.push([...u64(DT_SYMTAB), ...u64(symtabVa)]);
    dynamicEntries.push([...u64(DT_SYMENT), ...u64(24)]);
    dynamicEntries.push([...u64(DT_RELA), ...u64(relaVa)]);
    dynamicEntries.push([...u64(DT_RELASZ), ...u64(24)]);
    dynamicEntries.push([...u64(DT_RELAENT), ...u64(24)]);
  }
  // A GNU hash table whose single chain needs many steps, so a cancellation
  // observed mid-walk can only be honored by a traversal that checks the
  // signal inside the loop (#5584 item: tag scan -> DT_GNU_HASH traversal).
  // DT_SYMTAB/DT_SYMENT are declared too: exact count evidence only grounds
  // symbolCountSource when the dynsym table itself exists.
  let gnuHashOffset = null;
  let gnuHashVa = null;
  let gnuHashBytes = null;
  let symtabBytes = null;
  if (withGnuHash) {
    symtabBytes = new Uint8Array(GNU_HASH_SYM_COUNT * 24);
    const symView = new DataView(symtabBytes.buffer);
    symView.setUint32(24, 11, true); // entry 1 st_name -> 'foo'
    symView.setUint8(28, (1 << 4) | 2); // global function
    dynamicEntries.push([...u64(DT_SYMTAB), ...u64(symtabVa)]);
    dynamicEntries.push([...u64(DT_SYMENT), ...u64(24)]);
    gnuHashOffset = symtabOffset + symtabBytes.length; // hash table follows the dynsym table
    gnuHashVa = 0x1000 + (gnuHashOffset - 0x100);
    const symOffset = 1;
    const chains = new Uint8Array(GNU_HASH_CHAIN_STEPS * 4);
    const chainView = new DataView(chains.buffer);
    for (let i = 0; i < GNU_HASH_CHAIN_STEPS; i += 1) {
      // Even values keep the walk going; only the final entry is odd.
      chainView.setUint32(i * 4, i === GNU_HASH_CHAIN_STEPS - 1 ? 1 : (i + 2) * 2, true);
    }
    gnuHashBytes = new Uint8Array([
      ...u32(1), ...u32(symOffset), ...u32(1), ...u32(0), // hdr: nbuckets, symoffset, bloom_size, bloom_shift
      ...new Uint8Array(8), // bloom filter (1 x 64-bit word, unused)
      ...u32(symOffset), // buckets[0] starts the chain at symOffset
      ...chains,
    ]);
    dynamicEntries.push([...u64(0x6ffffef5n), ...u64(gnuHashVa)]); // DT_GNU_HASH
  }
  for (let i = dynamicEntries.length; i < entries; i += 1) {
    // Non-NULL filler tags keep the scan busy; a plain unknown tag keeps this
    // fixture minimal.
    dynamicEntries.push([...u64(0x70000000n), ...u64(i)]);
  }
  dynamicEntries.push([...u64(DT_NULL), ...u64(0)]);
  const dynamicBytes = dynamicEntries.flat();

  const dynamicSize = dynamicBytes.length;
  const trailingBytes = (withRelocationsAndSymbols ? 48 + 24 : 0)
    + (withGnuHash ? symtabBytes.length + gnuHashBytes.length : 0);
  const loadFilesz = dynamicOffset + dynamicSize - 0x100 + trailingBytes; // strtab + dynamic [+ symtab + rela [+ dynsym + gnu hash]]
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
  if (withGnuHash) {
    bytes.set(symtabBytes, symtabOffset);
    bytes.set(gnuHashBytes, gnuHashOffset);
  }
  if (withRelocationsAndSymbols) {
    // Dynsym: entry 0 null, entry 1 = {name:'foo', STB_GLOBAL, SHN_UNDEF}.
    const symtabBytes = new Uint8Array(48);
    const symView = new DataView(symtabBytes.buffer);
    symView.setUint32(24, 11, true); // st_name -> 'foo'
    symView.setUint8(28, (1 << 4) | 2); // global function
    // st_shndx stays 0 (SHN_UNDEF) -> an import-eligible undefined symbol.
    bytes.set(symtabBytes, symtabOffset);
    // One R_X86_64_JUMP_SLOT-style RELA entry (type 7 on x86-64, sym 1).
    const rela = new Uint8Array(24);
    const relaView = new DataView(rela.buffer);
    relaView.setBigUint64(0, 0x2000n, true); // r_offset
    relaView.setBigUint64(8, (1n << 32n) | 7n, true); // sym 1, type 7
    bytes.set(rela, relaOffset);
  }
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

// A signal that flips after the scan has started must still stop the tag loop
// and every subdecoder the signal is wired into (#5584 items 2-4/7): the
// deterministic stub aborts on the Nth observation.
const signalAfter = (n) => {
  let observations = 0;
  return {
    get aborted() {
      observations += 1;
      return observations > n;
    },
  };
};

test('#5584: a signal flipping mid-tag-scan stops the scan as partial', () => {
  const image = parseELF(buildDynamicElf({ entries: 512 }), { signal: signalAfter(3) });
  assert.equal(image.metadata.programDynamicPartial, true, 'mid-flight cancellation is partial, not complete');
  const diagnostics = image.metadata.programDynamicDiagnostics ?? [];
  assert.ok(diagnostics.some((d) => d.includes('cancelled')), `expected a cancellation diagnostic, got ${JSON.stringify(diagnostics)}`);
  assert.equal(image.imports.length, 0, 'no import authority was minted after abort');
});

test('#5584: a signal flipping during relocation/symbol decode leaves no post-abort authority', () => {
  // The aborted budget methods stop relocation/symbol/version decode work and
  // mark it partial; with no budget take succeeding, no records may publish.
  const image = parseELF(buildDynamicElf({ entries: 64, withRelocationsAndSymbols: true }), { signal: signalAfter(20) });
  const diagnostics = image.metadata.programDynamicDiagnostics ?? [];
  const partial = image.metadata.programDynamicPartial === true || diagnostics.length > 0;
  assert.equal(partial, true, 'post-abort work is reflected as partial/diagnostic');
  assert.equal(image.imports.some((imp) => imp.sites.some((site) => site.kind === 'relocation')), false,
    'no relocation site may attach after abort');
  const relocationBudget = image.metadata.programDynamicRelocationBudget;
  assert.ok(relocationBudget == null || relocationBudget.stopped === true || relocationBudget.output === 0,
    'the relocation budget must record the abort or produce nothing');
});

test('#5584: the same image decodes its relocations and symbols without cancellation', () => {
  const controller = new AbortController();
  const image = parseELF(buildDynamicElf({ entries: 64, withRelocationsAndSymbols: true }), { signal: controller.signal });
  const diagnostics = image.metadata.programDynamicDiagnostics ?? [];
  assert.equal(diagnostics.some((d) => d.includes('abort') || d.includes('cancelled')), false,
    'a non-aborted parse produces no cancellation evidence');
  assert.equal(image.relocations.length, 1, 'the RELA entry is decoded normally');
  assert.equal(image.relocations[0].symbol, 'foo');
  assert.equal(image.imports.some((imp) => imp.name === 'foo'), true, 'the undefined dynsym symbol mints its import');
});

// The GNU-hash symbol-count traversal is budget-less large work after the tag
// scan: with 64 chain steps it must observe the caller's signal inside the
// walk, not after it (#5584 item: tag scan -> DT_GNU_HASH traversal). The
// stub flips after 20 observations: the tag scan consumes ~14, so the abort
// fires while the chain walk is still stepping.
test('#5584: a signal flipping mid-GNU-hash-traversal stops the count walk as partial', () => {
  const image = parseELF(buildDynamicElf({ entries: 12, withGnuHash: true }), { signal: signalAfter(20) });
  const diagnostics = image.metadata.programDynamicDiagnostics ?? [];
  assert.equal(image.metadata.programDynamicPartial, true, 'a cancelled traversal is partial, not silently complete');
  assert.ok(diagnostics.some((d) => d.includes('cancelled')), `expected a cancellation diagnostic, got ${JSON.stringify(diagnostics)}`);
  assert.notEqual(image.metadata.programDynamic?.symbolCountSource, 'gnu-hash',
    'a mid-walk abort must not leave exact GNU-hash count evidence behind');
  assert.equal(image.metadata.programDynamic?.symbolsExpected ?? 0, 0, 'no symbol decode was funded after the abort');
});

test('#5584: the same GNU-hash image yields exact count evidence without cancellation', () => {
  const controller = new AbortController();
  const image = parseELF(buildDynamicElf({ entries: 12, withGnuHash: true }), { signal: controller.signal });
  const diagnostics = image.metadata.programDynamicDiagnostics ?? [];
  assert.equal(image.metadata.programDynamic?.symbolCountSource, 'gnu-hash',
    'the control proves the traversal itself mints exact count evidence');
  assert.equal(image.metadata.programDynamic?.symbolsExpected, GNU_HASH_SYM_COUNT, 'symoffset + chain steps = symbol count');
  assert.equal(image.metadata.programDynamicPartial ?? false, false);
  assert.equal(diagnostics.some((d) => d.includes('cancelled')), false, 'no cancellation evidence without an abort');
});


