import assert from 'node:assert/strict';
import { parseELF } from '../js/binary/elf.js';
import { loaderProducer } from '../js/analysis/discovery/producers.js';

const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const u64 = (v) => [...u32(Number(BigInt(v) & 0xffffffffn)), ...u32(Number((BigInt(v) >> 32n) & 0xffffffffn))];

const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const DT_NULL = 0n;
const DT_INIT = 12n;
const DT_STRTAB = 5n;
const DT_STRSZ = 10n;
const DT_SYMTAB = 6n;
const DT_SYMENT = 11n;
const DT_SYMTABSZ = 39n;
const SHT_PROGBITS = 1;
const SHT_STRTAB = 3;
const SHT_DYNAMIC = 6;
const EM_X86_64 = 62;
const EM_ARM64 = 183;

const DYN_OFF = 0x400;
const DYN_VA = 0x3000;
const DYNSTR_OFF = 0x300;
const DYNSTR_VA = 0x2100;
const DYNSYM_OFF = 0x310;
const DYNSYM_VA = 0x2110;
const SHSTR_OFF = 0x600;
const SH_OFF = 0x640;

function buildElf64({
  machine = EM_X86_64,
  dynamic = [[DT_INIT, 0x1000n]],
  loadFilesz = 0x100n,
  loadMemsz = 0x200n,
  withSections = false,
  withPtDynamic = true,
  withDynsym = false,
} = {}) {
  const dynEntries = dynamic.map(([tag, value]) => [...u64(tag), ...u64(value)]);
  dynEntries.push([...u64(DT_NULL), ...u64(0)]);
  const dynBytes = dynEntries.flat();
  const dynSize = dynBytes.length;
  const dynstr = withDynsym ? new TextEncoder().encode('\0foo\0') : new Uint8Array([0]);
  const dynsym = new Uint8Array(48);
  if (withDynsym) {
    const symView = new DataView(dynsym.buffer);
    symView.setUint32(24 + 0, 1, true);
    symView.setUint8(24 + 4, (1 << 4) | 2);
    symView.setUint8(24 + 5, 0);
    symView.setUint16(24 + 6, 1, true);
    symView.setBigUint64(24 + 8, 0x1000n, true);
    symView.setBigUint64(24 + 16, 0n, true);
  }
  const shstr = new TextEncoder().encode('\0.text\0.dynamic\0.dynstr\0.shstrtab\0');
  // A loader-invoked .dynamic is itself SHF_ALLOC and backed by a PT_LOAD;
  // #8096 rejects a file-backed SHF_ALLOC section whose sh_addr/sh_offset is
  // not reproduced by any PT_LOAD, so the sectioned fixture must model that.
  const phnum = 2 + (withPtDynamic ? 1 : 0) + (withSections ? 1 : 0);
  const end = Math.max(DYN_OFF + dynSize, DYNSYM_OFF + dynsym.length, withSections ? SH_OFF + 5 * 64 : 0);
  const bytes = new Uint8Array(end);
  const view = new DataView(bytes.buffer);

  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  view.setUint16(16, 3, true);
  view.setUint16(18, machine, true);
  view.setUint32(20, 1, true);
  view.setBigUint64(24, 0n, true);
  view.setBigUint64(32, 64n, true);
  view.setBigUint64(40, withSections ? BigInt(SH_OFF) : 0n, true);
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, phnum, true);
  if (withSections) {
    view.setUint16(58, 64, true);
    view.setUint16(60, 5, true);
    view.setUint16(62, 4, true);
  }

  const phdr = (i, type, flags, off, va, filesz, memsz) => {
    const p = 64 + i * 56;
    view.setUint32(p, type, true);
    view.setUint32(p + 4, flags, true);
    view.setBigUint64(p + 8, BigInt(off), true);
    view.setBigUint64(p + 16, BigInt(va), true);
    view.setBigUint64(p + 24, BigInt(va), true);
    view.setBigUint64(p + 32, BigInt(filesz), true);
    view.setBigUint64(p + 40, BigInt(memsz), true);
    // Keep the fixture's file offset and virtual address congruent under the
    // PT_LOAD p_align contract consolidated from #4090.
    view.setBigUint64(p + 48, 0x100n, true);
  };
  phdr(0, PT_LOAD, 5, 0x100, 0x1000, loadFilesz, loadMemsz);
  phdr(1, PT_LOAD, 4, 0x200, 0x2000, 0x200n, 0x200n);
  let phIndex = 2;
  if (withPtDynamic) phdr(phIndex++, PT_DYNAMIC, 4, DYN_OFF, DYN_VA, BigInt(dynSize), BigInt(dynSize));
  if (withSections) phdr(phIndex++, PT_LOAD, 4, DYN_OFF, DYN_VA, BigInt(dynSize), BigInt(dynSize));

  bytes.set(dynBytes, DYN_OFF);
  bytes.set(dynstr, DYNSTR_OFF);
  bytes.set(dynsym, DYNSYM_OFF);
  if (withSections) {
    bytes.set(shstr, SHSTR_OFF);
    const shdr = (i, { type = 0, flags = 0n, addr = 0n, offset = 0n, size = 0n, link = 0, entsize = 0n } = {}) => {
      const p = SH_OFF + i * 64;
      view.setUint32(p, 0, true);
      view.setUint32(p + 4, type, true);
      view.setBigUint64(p + 8, flags, true);
      view.setBigUint64(p + 16, addr, true);
      view.setBigUint64(p + 24, offset, true);
      view.setBigUint64(p + 32, size, true);
      view.setUint32(p + 40, link, true);
      view.setBigUint64(p + 56, entsize, true);
    };
    shdr(0);
    shdr(1, { type: SHT_PROGBITS, flags: 0x6n, addr: 0x1000n, offset: 0x100n, size: 0x100n });
    shdr(2, { type: SHT_DYNAMIC, flags: 0x3n, addr: 0x3000n, offset: BigInt(DYN_OFF), size: BigInt(dynSize), link: 3, entsize: 16n });
    shdr(3, { type: SHT_STRTAB, flags: 0x2n, addr: BigInt(DYNSTR_VA), offset: BigInt(DYNSTR_OFF), size: BigInt(dynstr.length) });
    shdr(4, { type: SHT_STRTAB, addr: 0n, offset: BigInt(SHSTR_OFF), size: BigInt(shstr.length) });
  }
  return bytes;
}

const sectionless = parseELF(buildElf64());
assert.equal(sectionless.functions.length, 1, 'valid DT_INIT must mint exactly one canonical function seed');
const seed = sectionless.functions[0];
assert.equal(seed.address, 0x1000n);
assert.equal(seed.source, 'dt-init');
assert.equal(seed.exactFunctionStart, true);
assert.match(seed.functionStartEvidence, /DT_INIT/);
assert.deepEqual(sectionless.metadata.dtInit, { address: 0x1000n, source: 'PT_DYNAMIC' });
assert.equal(sectionless.metadata.programDynamicPartial, undefined);
assert.equal(sectionless.warnings.length, 0, 'a valid DT_INIT must not produce warnings');
assert.equal(sectionless.metadata.elfMetadata.complete, true);

const sectioned = parseELF(buildElf64({ withSections: true, withPtDynamic: false }));
assert.equal(sectioned.functions.length, 1, 'section-backed DT_INIT must mint the same canonical seed');
assert.equal(sectioned.functions[0].address, 0x1000n);
assert.equal(sectioned.functions[0].source, 'dt-init');
assert.equal(sectioned.functions[0].exactFunctionStart, true);
assert.deepEqual(sectioned.metadata.dtInit, { address: 0x1000n, source: 'SHT_DYNAMIC' });
assert.equal(sectioned.metadata.elfMetadata.complete, true);
assert.equal(sectioned.warnings.length, 0, 'a valid section-backed DT_INIT must not produce warnings');

const evidence = loaderProducer.produce({ image: sectionless });
assert.deepEqual(evidence.map((item) => item.start), ['4096'], 'canonical function discovery must surface the DT_INIT seed');
assert.ok(evidence[0].evidenceIds.includes('loader:source:dt-init:4096'));

const dedup = parseELF(buildElf64({
  dynamic: [
    [DT_INIT, 0x1000n],
    [DT_STRTAB, BigInt(DYNSTR_VA)],
    [DT_STRSZ, 5n],
    [DT_SYMTAB, BigInt(DYNSYM_VA)],
    [DT_SYMENT, 24n],
    [DT_SYMTABSZ, 48n],
  ],
  withDynsym: true,
}));
assert.equal(dedup.functions.length, 1, 'symbol evidence at the DT_INIT address must not duplicate the seed');
assert.equal(dedup.functions[0].address, 0x1000n);
assert.ok(dedup.functions[0].sources.includes('dt-init'));
assert.ok(dedup.functions[0].sources.includes('symbol'));
assert.equal(dedup.functions[0].name, 'foo');

const negativeVariants = [
  { label: 'sectionless PT_DYNAMIC', opts: {} },
  { label: 'section-backed SHT_DYNAMIC', opts: { withSections: true, withPtDynamic: false } },
];

const negativeCases = [
  { label: 'unmapped target', opts: { dynamic: [[DT_INIT, 0x90000n]] } },
  { label: 'mapped non-executable target', opts: { dynamic: [[DT_INIT, 0x2000n]] } },
  { label: 'first instruction unit crosses the file-backed boundary', opts: { machine: EM_ARM64, loadFilesz: 0x102n, loadMemsz: 0x202n, dynamic: [[DT_INIT, 0x1100n]] } },
  { label: 'arm64 misaligned target', opts: { machine: EM_ARM64, dynamic: [[DT_INIT, 0x1002n]] } },
];

for (const variant of negativeVariants) {
  for (const item of negativeCases) {
    const image = parseELF(buildElf64({ ...item.opts, ...variant.opts }));
    assert.equal(image.functions.length, 0, `${variant.label}: ${item.label} must not mint a function seed`);
    assert.equal(image.metadata.dtInit, undefined, `${variant.label}: ${item.label} must not publish initializer metadata`);
    if (variant.opts.withSections) {
      assert.equal(image.metadata.elfMetadata.complete, false, `${variant.label}: ${item.label} must lower completeness`);
      assert.ok(
        image.metadata.elfMetadata.reasons.some((reason) => reason.includes('dt-init')),
        `${variant.label}: ${item.label} must record a dt-init partial reason`,
      );
    } else {
      assert.equal(image.metadata.programDynamicPartial, true, `${variant.label}: ${item.label} must lower completeness`);
      assert.ok(
        image.metadata.programDynamicDiagnostics.some((message) => message.includes('DT_INIT')),
        `${variant.label}: ${item.label} must record a DT_INIT partial reason`,
      );
    }
    assert.ok(
      image.warnings.some((warning) => warning.includes('DT_INIT')),
      `${variant.label}: ${item.label} must surface a precise warning`,
    );
  }

  for (const [label, dynamic] of [
    ['DT_INIT=0', [[DT_INIT, 0n]]],
    ['absent DT_INIT', [[0x70000000n, 1n]]],
  ]) {
    const image = parseELF(buildElf64({ dynamic, ...variant.opts }));
    assert.equal(image.functions.length, 0, `${variant.label}: ${label} must not mint a function seed`);
    assert.equal(image.metadata.dtInit, undefined, `${variant.label}: ${label} must not publish initializer metadata`);
    if (variant.opts.withSections) {
      assert.equal(image.metadata.elfMetadata.complete, true, `${variant.label}: ${label} must stay complete`);
    } else {
      assert.equal(image.metadata.programDynamicPartial, undefined, `${variant.label}: ${label} must stay complete`);
    }
  }
}

console.log('issue #8113 ELF DT_INIT canonical function discovery: PASS');
