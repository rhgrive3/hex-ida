import test from 'node:test';
import assert from 'node:assert/strict';

import { functionDiscoveryArtifact } from '../../../js/analysis/index.js';
import { parseELF } from '../../../js/binary/elf.js';

const EM_AARCH64 = 183;
const ET_DYN = 3;
const PT_LOAD = 1;
const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;
const R_AARCH64_ABS64 = 257;
const R_AARCH64_RELATIVE = 1027;

const TEXT = 0x400100n;
const DATA = 0x400180n;
const CODE_POINTER = TEXT + 0x30n;
const JUMP_TABLE_BODY = TEXT + 0x10n;
const DATA_POINTER = DATA + 0x20n;
const SYMBOL_FUNCTION = TEXT;

function buildFixture() {
  const bytes = new Uint8Array(0x700);
  const view = new DataView(bytes.buffer);
  const w16 = (offset, value) => view.setUint16(offset, value, true);
  const w32 = (offset, value) => view.setUint32(offset, value, true);
  const w64 = (offset, value) => view.setBigUint64(offset, BigInt(value), true);
  const wi64 = (offset, value) => view.setBigInt64(offset, BigInt(value), true);

  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  w16(16, ET_DYN);
  w16(18, EM_AARCH64);
  w32(20, 1);
  w64(24, 0n);
  w64(32, 0x40n);
  w64(40, 0x400n);
  w16(52, 64);
  w16(54, 56);
  w16(56, 1);
  w16(58, 64);
  w16(60, 7);
  w16(62, 6);

  const ph = 0x40;
  w32(ph, PT_LOAD);
  w32(ph + 4, 7); // PF_R | PF_W | PF_X; one compact synthetic load.
  w64(ph + 8, 0x100n);
  w64(ph + 16, TEXT);
  w64(ph + 24, TEXT);
  w64(ph + 32, 0xc0n);
  w64(ph + 40, 0xc0n);
  w64(ph + 48, 0x10n);

  // Four A64 NOPs at the symbol-backed function and additional mapped text.
  for (let offset = 0x100; offset < 0x140; offset += 4) {
    bytes.set([0x1f, 0x20, 0x03, 0xd5], offset);
  }

  const strtab = new TextEncoder().encode('\0func\0');
  bytes.set(strtab, 0x240);
  const sym = 0x260 + 24;
  w32(sym, 1);
  bytes[sym + 4] = 0x02; // STB_LOCAL | STT_FUNC
  w16(sym + 6, 1); // .text
  w64(sym + 8, SYMBOL_FUNCTION);
  w64(sym + 16, 0x20n);

  const relocations = [
    { site: DATA + 0x00n, type: R_AARCH64_RELATIVE, symbol: 0, addend: CODE_POINTER },
    { site: DATA + 0x08n, type: R_AARCH64_RELATIVE, symbol: 0, addend: DATA_POINTER },
    { site: DATA + 0x10n, type: R_AARCH64_RELATIVE, symbol: 0, addend: JUMP_TABLE_BODY },
    { site: DATA + 0x18n, type: R_AARCH64_ABS64, symbol: 1, addend: 0n },
  ];
  for (let index = 0; index < relocations.length; index += 1) {
    const p = 0x2a0 + index * 24;
    const relocation = relocations[index];
    w64(p, relocation.site);
    w64(p + 8, (BigInt(relocation.symbol) << 32n) | BigInt(relocation.type));
    wi64(p + 16, relocation.addend);
  }

  const names = ['', '.text', '.data', '.strtab', '.symtab', '.rela.data', '.shstrtab'];
  const nameOffsets = [];
  const shstr = [];
  for (const name of names) {
    nameOffsets.push(shstr.length);
    shstr.push(...new TextEncoder().encode(`${name}\0`));
  }
  bytes.set(shstr, 0x320);

  const section = (index, { name, type, flags = 0n, address = 0n, offset = 0n, size = 0n, link = 0, info = 0, align = 1n, entsize = 0n }) => {
    const p = 0x400 + index * 64;
    w32(p, nameOffsets[names.indexOf(name)]);
    w32(p + 4, type);
    w64(p + 8, flags);
    w64(p + 16, address);
    w64(p + 24, offset);
    w64(p + 32, size);
    w32(p + 40, link);
    w32(p + 44, info);
    w64(p + 48, align);
    w64(p + 56, entsize);
  };

  section(0, { name: '', type: 0 });
  section(1, { name: '.text', type: SHT_PROGBITS, flags: 0x6n, address: TEXT, offset: 0x100n, size: 0x40n, align: 4n });
  section(2, { name: '.data', type: SHT_PROGBITS, flags: 0x3n, address: DATA, offset: 0x180n, size: 0x40n, align: 8n });
  section(3, { name: '.strtab', type: SHT_STRTAB, offset: 0x240n, size: BigInt(strtab.length) });
  section(4, { name: '.symtab', type: SHT_SYMTAB, offset: 0x260n, size: 48n, link: 3, info: 2, align: 8n, entsize: 24n });
  section(5, { name: '.rela.data', type: SHT_RELA, offset: 0x2a0n, size: 96n, link: 4, info: 2, align: 8n, entsize: 24n });
  section(6, { name: '.shstrtab', type: SHT_STRTAB, offset: 0x320n, size: BigInt(shstr.length) });

  return bytes;
}

function byAddress(items, address) {
  return items.find((item) => BigInt(item.address ?? item.start) === address) ?? null;
}

test('Candidate C1 publishes AArch64 ELF relocation targets as corroborating evidence only', () => {
  const image = parseELF(buildFixture());

  assert.deepEqual(
    image.relocationTargets.map((item) => item.address).sort((a, b) => a < b ? -1 : a > b ? 1 : 0),
    [SYMBOL_FUNCTION, JUMP_TABLE_BODY, CODE_POINTER, DATA_POINTER].sort((a, b) => a < b ? -1 : a > b ? 1 : 0),
  );
  assert.ok(image.relocationTargets.every((item) => item.provenance === 'elf-relocation-target'));
  assert.ok(byAddress(image.relocationTargets, CODE_POINTER), 'code pointer relocation is published');
  assert.ok(byAddress(image.relocationTargets, DATA_POINTER), 'data pointer relocation is published');
  assert.ok(byAddress(image.relocationTargets, JUMP_TABLE_BODY), 'jump-table body relocation is published');
  assert.equal(byAddress(image.relocationTargets, SYMBOL_FUNCTION)?.symbol, 'func');

  // Loader publication is additive evidence only. It must not mutate the
  // authoritative function-seed set, even for mapped executable targets.
  assert.deepEqual(image.functions.map((entry) => entry.address), [SYMBOL_FUNCTION]);

  const discovery = functionDiscoveryArtifact({
    input: { image },
    architectureId: image.arch,
    binaryId: 'fixture:c1-relocation-targets',
    sourceHash: 'bytes:c1-relocation-targets',
    snapshotId: 'snapshot:c1-relocation-targets',
  });
  assert.equal(byAddress(discovery.candidates, CODE_POINTER)?.startState, 'heuristic');
  assert.equal(byAddress(discovery.candidates, DATA_POINTER)?.startState, 'heuristic');
  assert.equal(byAddress(discovery.candidates, JUMP_TABLE_BODY)?.startState, 'heuristic');

  const symbolCandidate = byAddress(discovery.candidates, SYMBOL_FUNCTION);
  assert.equal(symbolCandidate?.startState, 'exact', 'existing symbol/loader authority must remain stronger than relocation evidence');
  assert.ok(symbolCandidate?.startEvidence.some((item) => item.kind === 'loader-function-start'));
  assert.ok(symbolCandidate?.startEvidence.some((item) => item.kind === 'relocation-target'));

  const references = discovery.artifact.references.filter((item) => item.kind === 'relocation');
  assert.equal(references.length, 4, 'generic artifact receives all four loader-published relocation references');
  assert.equal(image.toJSON().relocationTargets.length, 4, 'publication survives BinaryImage serialization');
});
