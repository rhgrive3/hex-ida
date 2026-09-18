/**
 * Same-address canonical symbol identity must be decided by published parser
 * metadata, not by the order the raw records happened to be emitted in.
 *
 * Regression for the AAELF64 case where a zero-sized local STT_NOTYPE mapping
 * marker (`$x`/`$d`) and the STT_FUNC it describes share one address: with
 * raw-order collapse the canonical display/function name flipped between `$x`
 * and the real function depending on whether the symbol table listed the marker
 * before or after the FUNC.
 *
 * The mapping marker itself is never removed: its record stays in
 * `image.symbols`, its code/data authority stays in
 * `metadata.aarch64MappingSymbols`, and its `$d` interval stays in
 * `image.dataInCode`. Only the naming projection is ranked.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseELF } from '../../../js/binary/elf.js';
import { describeBinaryImage } from '../../../js/platform/describe.js';
import { analysisFromBinaryImage } from '../../../js/platform/analysis-result.js';
import { SymbolIndex } from '../../../js/symbols.js';

const ET_REL = 1;
const EM_AARCH64 = 183;
const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHF_ALLOC = 0x2n;
const SHF_EXECINSTR = 0x4n;

// Local zero-sized STT_NOTYPE records: exactly the shape every ELF psABI mapping
// symbol (and the RISC-V record contract) requires.
const mappingRecord = (name, address, sectionIndex = 1) => ({
  name, address, kind: 'type-0', binding: 'local', size: 0n, defined: true, sectionIndex, source: 'symtab',
});

const funcRecord = (name, address, { size = 16n, binding = 'local', sectionIndex = 1 } = {}) => ({
  name, address, kind: 'function', binding, size, defined: true, sectionIndex, source: 'symtab',
});

function imageWith(overrides = {}) {
  return {
    format: 'elf',
    arch: 'arm64',
    symbols: [],
    exports: [],
    imports: [],
    functions: [],
    metadata: {},
    ...overrides,
  };
}

const canonicalNames = (symbols) => analysisFromBinaryImage(imageWith({ symbols })).names;
const indexNameAt = (result, address) => new SymbolIndex({ ...result, regions: [] }).nameAt(address);

test('mapping marker first and FUNC second resolve to the real function identity', () => {
  const address = 0x1000n;
  const result = analysisFromBinaryImage(imageWith({
    symbols: [mappingRecord('$x', address), funcRecord('real_function', address)],
  }));

  assert.deepEqual([...result.addrs], [address]);
  assert.deepEqual(result.names, ['real_function']);
  assert.deepEqual([...result.kinds], [0]);
  assert.equal(result.symbolCount, 1);
  assert.equal(indexNameAt(result, address), 'real_function');
});

test('FUNC first and mapping marker second resolve to the same identity', () => {
  const address = 0x1000n;
  const result = analysisFromBinaryImage(imageWith({
    symbols: [funcRecord('real_function', address), mappingRecord('$x', address)],
  }));

  assert.deepEqual([...result.addrs], [address]);
  assert.deepEqual(result.names, ['real_function']);
  assert.equal(indexNameAt(result, address), 'real_function');
});

test('the ranking never keys off the marker spelling', () => {
  const address = 0x1800n;
  // `$x`/`$d`/`$x.1` are the real AAELF64 spellings; the rest prove no string
  // pattern is special-cased. Every one of them is a local zero-sized STT_NOTYPE
  // record, so all of them must lose to the FUNC the same way.
  for (const markerName of ['$x', '$d', '$x.1', '.Ltmp0', 'weird_marker']) {
    assert.deepEqual(
      canonicalNames([mappingRecord(markerName, address), funcRecord('real_function', address)]),
      ['real_function'],
      `${markerName} must not become the canonical name when listed first`,
    );
    assert.deepEqual(
      canonicalNames([funcRecord('real_function', address), mappingRecord(markerName, address)]),
      ['real_function'],
      `${markerName} must not become the canonical name when listed second`,
    );
  }
});

test('raw symbol order is irrelevant: every permutation yields one canonical name', () => {
  const address = 0x1000n;
  const records = [
    mappingRecord('$x', address),
    funcRecord('real_function', address),
    funcRecord('alias_name', address, { binding: 'global' }),
    funcRecord('weak_alias', address, { binding: 'weak' }),
  ];

  const names = [];
  const transports = [];
  for (let rotation = 0; rotation < records.length; rotation++) {
    const permuted = [...records.slice(rotation), ...records.slice(0, rotation)];
    const result = analysisFromBinaryImage(imageWith({ symbols: permuted }));
    names.push(result.names.join(','));
    transports.push(JSON.stringify({
      addrs: [...result.addrs].map((entry) => entry.toString()),
      kinds: [...result.kinds],
      flags: [...result.flags],
      provenance: result.nameProvenance,
    }));
  }

  assert.equal(new Set(names).size, 1, `every rotation must agree, got ${JSON.stringify(names)}`);
  assert.equal(new Set(transports).size, 1, 'addresses, kinds, flags and provenance must be order independent too');
  // Published binding evidence outranks the local alias; the alphabetical
  // tie-break then decides between the two equally-bound aliases. No input order
  // is ever consulted.
  assert.deepEqual(names, ['alias_name', 'alias_name', 'alias_name', 'alias_name']);

  // Reversing the raw array — the exact permutation that used to flip the answer
  // between `$x` and the function name — must be a no-op.
  const forward = analysisFromBinaryImage(imageWith({ symbols: records }));
  const reversed = analysisFromBinaryImage(imageWith({ symbols: [...records].reverse() }));
  assert.deepEqual(forward.names, reversed.names);
  assert.deepEqual([...forward.kinds], [...reversed.kinds]);
  assert.deepEqual([...forward.flags], [...reversed.flags]);
  assert.deepEqual(forward.nameProvenance, reversed.nameProvenance);
});

test('an untyped marker loses to a typed data identity in either raw order', () => {
  const address = 0x2000n;
  const dataRecord = { name: 'global_data', address, kind: 'object', binding: 'global', size: 8n, defined: true, sectionIndex: 1, source: 'symtab' };
  assert.deepEqual(canonicalNames([mappingRecord('$x', address), dataRecord]), ['global_data']);
  assert.deepEqual(canonicalNames([dataRecord, mappingRecord('$x', address)]), ['global_data']);
});

test('a zero-sized marker loses to an untyped label that publishes a real size', () => {
  const address = 0x2400n;
  const sizedLabel = { ...mappingRecord('sized_label', address), size: 8n };
  assert.deepEqual(canonicalNames([mappingRecord('$x', address), sizedLabel]), ['sized_label']);
  assert.deepEqual(canonicalNames([sizedLabel, mappingRecord('$x', address)]), ['sized_label']);
});

test('a mapping marker remains the canonical name when it is the only candidate', () => {
  const address = 0x3000n;
  const image = imageWith({ symbols: [mappingRecord('$d', address)] });
  const result = analysisFromBinaryImage(image);

  assert.deepEqual(result.names, ['$d'], 'a lone mapping marker must not be dropped from the naming projection');
  assert.equal(result.symbolCount, 1);
  assert.equal(image.symbols.length, 1, 'the raw marker record must be preserved');
});

test('an ordinary ELF symbol keeps its name, kind, flag and provenance semantics', () => {
  const address = 0x4000n;
  const result = analysisFromBinaryImage(imageWith({
    symbols: [{ name: 'plain_symbol', address, kind: 'function', binding: 'global', size: 16n, defined: true, sectionIndex: 1, source: 'symtab' }],
  }));

  assert.deepEqual([...result.addrs], [address]);
  assert.deepEqual(result.names, ['plain_symbol']);
  assert.deepEqual([...result.kinds], [0]);
  assert.deepEqual([...result.flags], [0]);
  assert.equal(result.nameProvenance[0].source, 'symtab');
  assert.equal(result.nameProvenance[0].confidence, 0.99);
});

test('export and import priority still dominate the same-address symbol tier', () => {
  const address = 0x5000n;
  const symbol = { name: 'symbol_name', address, kind: 'function', binding: 'local', size: 16n, defined: true, exported: false, sectionIndex: 1, source: 'symtab' };

  const withImport = analysisFromBinaryImage(imageWith({
    symbols: [symbol],
    exports: [{ address, name: 'export_name', kind: 'function', source: 'dynsym' }],
    imports: [{ name: 'import_name', source: 'elf-dynsym', sites: [{ address, kind: 'bind' }] }],
  }));
  assert.deepEqual(withImport.names, ['import_name'], 'import priority (30) still wins the address');
  assert.deepEqual([...withImport.kinds], [2]);
  assert.deepEqual([...withImport.flags], [1], 'the lower-priority exported evidence still merges its export bit');
  assert.equal(withImport.nameProvenance[0].source, 'bind');

  const exportOnly = analysisFromBinaryImage(imageWith({
    symbols: [symbol],
    exports: [{ address, name: 'export_name', kind: 'function', source: 'dynsym' }],
  }));
  assert.deepEqual(exportOnly.names, ['export_name'], 'export priority (20) still beats the symbol tier (10)');
  assert.deepEqual([...exportOnly.kinds], [0]);
  assert.deepEqual([...exportOnly.flags], [1]);
  assert.equal(exportOnly.nameProvenance[0].source, 'dynsym');
});

test('function identity and published function starts survive the naming decision', () => {
  const address = 0x6000n;
  const result = analysisFromBinaryImage(imageWith({
    symbols: [mappingRecord('$x', address), funcRecord('real_function', address)],
    functions: [{ address, source: 'symbol', exactFunctionStart: true, confidence: 0.995 }],
    metadata: { functionDiscovery: { complete: true } },
  }));

  assert.deepEqual([...result.funcs], [address], 'the FUNC start must not be lost to the collapsed name');
  assert.deepEqual([...result.addrs], [address]);
  assert.deepEqual(result.names, ['real_function']);
  assert.equal(result.functionProvenance[0].source, 'symbol');
  assert.equal(result.functionProvenance[0].confidence, 0.995);
  assert.equal(result.functionProvenance[0].confirmed, true);
  assert.equal(result.functionStartsExact, true);
});

/* ------------------------------------------------------------------ *
 * End-to-end: a real AArch64 ELF fixture whose `.symtab` puts `$x` and
 * `foo` at the same synthetic address.
 * ------------------------------------------------------------------ */

function stringTable(names) {
  const encoded = names.map((name) => Buffer.from(name, 'utf8'));
  const size = encoded.reduce((sum, value) => sum + value.length + 1, 1);
  const bytes = new Uint8Array(size);
  const offsets = [];
  let cursor = 1;
  for (const value of encoded) {
    offsets.push(cursor);
    bytes.set(value, cursor);
    cursor += value.length + 1;
  }
  return { bytes, offsets };
}

// ET_REL AArch64 ELF carrying a real `.symtab`. The *physical* symbol-table
// order is a parameter: entry i occupies symbol index i + 1, so passing the same
// entries in another order rewrites the table layout without changing any
// semantic content. `info` is the raw st_info byte (st_bind << 4 | st_type).
function buildSymtabElf(entries, { sectionSize = 16 } = {}) {
  const text = new Uint8Array(sectionSize);
  for (let offset = 0; offset + 4 <= sectionSize; offset += 4) text.set([0x1f, 0x20, 0x03, 0xd5], offset);
  const names = entries.map((entry) => entry.name);
  const strtab = stringTable(names);
  const shstr = stringTable(['.text', '.symtab', '.strtab', '.shstrtab']);
  const symbolCount = entries.length + 1; // + the reserved null symbol at index 0
  let cursor = 64;
  const textOff = cursor; cursor += text.length;
  const symOff = (cursor + 7) & ~7; cursor = symOff + symbolCount * 24;
  const strOff = cursor; cursor += strtab.bytes.length;
  const shstrOff = cursor; cursor += shstr.bytes.length;
  const shOff = (cursor + 7) & ~7;
  const sectionCount = 5;
  const bytes = new Uint8Array(shOff + sectionCount * 64);
  const view = new DataView(bytes.buffer);
  bytes.set(text, textOff);
  bytes.set(strtab.bytes, strOff);
  bytes.set(shstr.bytes, shstrOff);

  // `sh_info` is one greater than the last local symbol index.
  let lastLocalIndex = 0;
  for (let i = 0; i < entries.length; i++) if (((entries[i].info >> 4) & 0xf) === 0) lastLocalIndex = i + 1;
  for (let i = 0; i < entries.length; i++) {
    const p = symOff + (i + 1) * 24;
    const s = entries[i];
    view.setUint32(p, strtab.offsets[i], true);
    view.setUint8(p + 4, s.info);
    view.setUint8(p + 5, 0);
    view.setUint16(p + 6, 1, true);
    view.setBigUint64(p + 8, s.value, true);
    view.setBigUint64(p + 16, s.size, true);
  }

  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  view.setUint16(16, ET_REL, true);
  view.setUint16(18, EM_AARCH64, true);
  view.setUint32(20, 1, true);
  view.setBigUint64(24, 0n, true);
  view.setBigUint64(32, 0n, true);
  view.setBigUint64(40, BigInt(shOff), true);
  view.setUint16(52, 64, true);
  view.setUint16(54, 0, true);
  view.setUint16(56, 0, true);
  view.setUint16(58, 64, true);
  view.setUint16(60, sectionCount, true);
  view.setUint16(62, 4, true);

  const sections = [
    { name: 0, type: 0, flags: 0n, addr: 0n, off: 0, size: 0, link: 0, info: 0, align: 0n, entsize: 0n },
    { name: 0, type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: 0n, off: textOff, size: text.length, link: 0, info: 0, align: 4n, entsize: 0n },
    { name: 1, type: SHT_SYMTAB, flags: 0n, addr: 0n, off: symOff, size: symbolCount * 24, link: 3, info: lastLocalIndex + 1, align: 8n, entsize: 24n },
    { name: 2, type: SHT_STRTAB, flags: 0n, addr: 0n, off: strOff, size: strtab.bytes.length, link: 0, info: 0, align: 1n, entsize: 0n },
    { name: 3, type: SHT_STRTAB, flags: 0n, addr: 0n, off: shstrOff, size: shstr.bytes.length, link: 0, info: 0, align: 1n, entsize: 0n },
  ];
  for (let i = 0; i < sections.length; i++) {
    const p = shOff + i * 64;
    const s = sections[i];
    view.setUint32(p, i === 0 ? 0 : shstr.offsets[s.name], true);
    view.setUint32(p + 4, s.type, true);
    view.setBigUint64(p + 8, s.flags, true);
    view.setBigUint64(p + 16, s.addr, true);
    view.setBigUint64(p + 24, BigInt(s.off), true);
    view.setBigUint64(p + 32, BigInt(s.size), true);
    view.setUint32(p + 40, s.link, true);
    view.setUint32(p + 44, s.info, true);
    view.setBigUint64(p + 48, s.align, true);
    view.setBigUint64(p + 56, s.entsize, true);
  }
  return bytes;
}

// `$x` (code) at offset 0, `$d` (data) at offset 4, `$x.1` (code) at offset 8,
// and STT_FUNC `foo` covering the whole section — so `$x` and `foo` collide.
const AARCH64_MAPPING_ENTRIES = [
  { name: '$x', info: 0x00, value: 0n, size: 0n },  // local NOTYPE, zero size
  { name: '$d', info: 0x00, value: 4n, size: 0n },
  { name: '$x.1', info: 0x00, value: 8n, size: 0n },
  { name: 'foo', info: 0x12, value: 0n, size: 16n }, // global STT_FUNC
];
const buildAarch64MappingElf = (entries = AARCH64_MAPPING_ENTRIES) => buildSymtabElf(entries);

// Two global STT_FUNC definitions of one address with identical st_size: the
// parser publishes no evidence that distinguishes them at all.
const TIED_ALIAS_ENTRIES = [
  { name: 'alpha_alias', info: 0x12, value: 0n, size: 16n },
  { name: 'beta_alias', info: 0x12, value: 0n, size: 16n },
];

// Names in the order the parsed image lists them, with the physical symbol-table
// ordinal the ELF reader assigned each one.
const laidOutSymbols = (image) => image.symbols
  .filter((entry) => entry.name)
  .map((entry) => [entry.name, entry.index]);

test('AArch64 ELF: `$x` and STT_FUNC foo at one address keep mapping authority and publish foo as the name', () => {
  const image = parseELF(buildAarch64MappingElf());
  assert.equal(image.arch, 'arm64');
  const foo = image.symbols.find((entry) => entry.name === 'foo');
  const marker = image.symbols.find((entry) => entry.name === '$x');
  assert.ok(foo?.address != null && marker?.address != null);
  assert.equal(marker.address, foo.address, 'the fixture must collide the marker and the function');

  const mappingBefore = image.metadata.aarch64MappingSymbols;
  const dataInCodeBefore = image.dataInCode.map((entry) => ({ ...entry }));
  const symbolCountBefore = image.symbols.length;

  const result = analysisFromBinaryImage(image);
  const nameAt = (address) => new SymbolIndex({ ...result, regions: [] }).nameAt(address);

  // The marker shares foo's address; $d and $x.1 sit at distinct ones.
  assert.equal(nameAt(foo.address), 'foo', 'the real function name is the canonical identity');
  assert.equal(nameAt(foo.address + 4n), '$d');
  assert.equal(nameAt(foo.address + 8n), '$x.1');
  assert.deepEqual(result.names, ['foo', '$d', '$x.1']);

  // The marker was not deleted and the code/data authority is untouched.
  assert.equal(image.symbols.length, symbolCountBefore, 'no raw symbol record may be removed');
  assert.ok(image.symbols.some((entry) => entry.name === '$x'));
  assert.equal(image.metadata.aarch64MappingSymbols, mappingBefore, 'mapping metadata object is preserved by identity');
  assert.deepEqual(
    image.metadata.aarch64MappingSymbols.mappings.map((entry) => [entry.kind, entry.address - foo.address]),
    [['instruction', 0n], ['data', 4n], ['instruction', 8n]],
  );
  assert.deepEqual(image.dataInCode.map((entry) => ({ ...entry })), dataInCodeBefore);
  assert.equal(image.dataInCode.length, 1);
  assert.equal(image.dataInCode[0].address, foo.address + 4n);
  assert.equal(image.dataInCode[0].length, 4);
  assert.equal(image.isInstructionAllowed(foo.address), true);
  assert.equal(image.isInstructionAllowed(foo.address + 4n), false, '$d data exclusion semantics preserved');
  assert.equal(image.isInstructionAllowed(foo.address + 8n), true);

  const described = describeBinaryImage(image);
  assert.equal(described.productDescriptor.formatMetadata.aarch64MappingSymbols.evidence, 'mapping-symbol');
  const text = described.productDescriptor.regions.find((region) => region.exec && foo.address >= region.vmAddr && foo.address < region.vmAddr + region.size);
  assert.ok(text);
  assert.deepEqual(text.dataInCode.map((entry) => [entry.address - foo.address, entry.length, entry.kindName]), [
    [4n, 4, 'ELF_AARCH64_MAPPING_DATA'],
  ]);
});

test('AArch64 ELF: permuting the raw symbol table cannot change the canonical identity', () => {
  const baseline = analysisFromBinaryImage(parseELF(buildAarch64MappingElf()));
  const foo = parseELF(buildAarch64MappingElf()).symbols.find((entry) => entry.name === 'foo');
  assert.equal(new SymbolIndex({ ...baseline, regions: [] }).nameAt(foo.address), 'foo');

  for (let rotation = 1; rotation < 4; rotation++) {
    const image = parseELF(buildAarch64MappingElf());
    image.symbols = [...image.symbols.slice(rotation), ...image.symbols.slice(0, rotation)];
    assert.equal(image.symbols.length, 4);
    const permuted = analysisFromBinaryImage(image);
    assert.deepEqual(permuted.names, baseline.names, `rotation ${rotation} must not change the canonical name`);
    assert.deepEqual([...permuted.addrs], [...baseline.addrs]);
    assert.deepEqual([...permuted.kinds], [...baseline.kinds]);
    assert.deepEqual([...permuted.flags], [...baseline.flags]);
    assert.deepEqual(permuted.nameProvenance, baseline.nameProvenance);
  }

  // The historical failure: listing the marker *first* must not be what decides.
  const markerFirst = parseELF(buildAarch64MappingElf());
  const markers = markerFirst.symbols.filter((entry) => entry.kind === 'type-0');
  const nonMarkers = markerFirst.symbols.filter((entry) => entry.kind !== 'type-0');
  markerFirst.symbols = [...markers, ...nonMarkers];
  const reordered = analysisFromBinaryImage(markerFirst);
  assert.equal(new SymbolIndex({ ...reordered, regions: [] }).nameAt(foo.address), 'foo');
});

/* ------------------------------------------------------------------ *
 * The parser's own record ordinals (`index`, `tableIndex`) are the physical
 * symbol-table position of a record. They stay identity keys for relocation
 * lookup; they must never pick a canonical name.
 * ------------------------------------------------------------------ */

test('parser record ordinals are never consulted as naming evidence', () => {
  const address = 0x7000n;
  const withLayout = (name, index, tableIndex) => ({ ...funcRecord(name, address, { binding: 'global' }), index, tableIndex });

  // Same slot in different tables: the table that owns the slot is not evidence.
  assert.deepEqual(
    canonicalNames([withLayout('alpha_alias', 1, 2), withLayout('beta_alias', 1, 3)]),
    ['alpha_alias'],
  );
  // The alphabetically later alias holds the earlier physical slot. Layout must
  // not win; the record's own content must.
  assert.deepEqual(
    canonicalNames([withLayout('beta_alias', 1, 2), withLayout('alpha_alias', 2, 2)]),
    ['alpha_alias'],
  );
  assert.deepEqual(
    canonicalNames([withLayout('alpha_alias', 9, 9), withLayout('beta_alias', 1, 1)]),
    ['alpha_alias'],
  );
});

/* ------------------------------------------------------------------ *
 * Fully tied aliases: same address, same declared kind, same extent, same
 * linkage. Nothing but the physical symbol-table layout used to separate them.
 * ------------------------------------------------------------------ */

test('AArch64 ELF: fully tied global aliases keep one canonical name under every physical table layout', () => {
  const baseline = parseELF(buildSymtabElf(TIED_ALIAS_ENTRIES));
  const swapped = parseELF(buildSymtabElf([TIED_ALIAS_ENTRIES[1], TIED_ALIAS_ENTRIES[0]]));

  // `index` is the entry's own slot in `.symtab`, so the two fixtures really do
  // express the same content in two different physical orders.
  assert.deepEqual(laidOutSymbols(baseline), [['alpha_alias', 1], ['beta_alias', 2]]);
  assert.deepEqual(laidOutSymbols(swapped), [['beta_alias', 1], ['alpha_alias', 2]]);

  const alpha = baseline.symbols.find((entry) => entry.name === 'alpha_alias');
  const beta = baseline.symbols.find((entry) => entry.name === 'beta_alias');
  assert.ok(alpha?.address != null && beta?.address != null);
  assert.equal(alpha.address, beta.address, 'the fixture must collide the two definitions');
  assert.equal(alpha.kind, beta.kind);
  assert.equal(alpha.binding, beta.binding);
  assert.equal(alpha.size, beta.size);

  const first = analysisFromBinaryImage(baseline);
  const second = analysisFromBinaryImage(swapped);
  assert.deepEqual(first.names, ['alpha_alias'], 'the tied aliases resolve to one deterministic name');
  assert.deepEqual(second.names, first.names, 'swapping the physical table order must not change it');
  assert.deepEqual([...second.addrs], [...first.addrs]);
  assert.deepEqual([...second.kinds], [...first.kinds]);
  assert.deepEqual([...second.flags], [...first.flags]);
  assert.deepEqual(second.nameProvenance, first.nameProvenance);
});

test('AArch64 ELF: a three-way tied alias set agrees under every rotation and the reversed table', () => {
  const entries = [
    { name: 'alpha_alias', info: 0x12, value: 0n, size: 16n },
    { name: 'beta_alias', info: 0x12, value: 0n, size: 16n },
    { name: 'gamma_alias', info: 0x12, value: 0n, size: 16n },
  ];
  const layouts = [];
  for (let rotation = 0; rotation < entries.length; rotation++) {
    layouts.push([...entries.slice(rotation), ...entries.slice(0, rotation)]);
  }
  layouts.push([...entries].reverse());

  const names = new Set();
  const ordinals = new Set();
  for (const layout of layouts) {
    const image = parseELF(buildSymtabElf(layout));
    names.add(analysisFromBinaryImage(image).names.join(','));
    ordinals.add(JSON.stringify(laidOutSymbols(image)));
  }

  assert.equal(names.size, 1, `every layout must agree, got ${JSON.stringify([...names])}`);
  assert.deepEqual([...names], ['alpha_alias'], 'the consensus must be a deterministic name, not just a stable one');
  assert.ok(ordinals.size > 1, 'the layouts must genuinely differ in physical symbol order');
});

test('AArch64 ELF: rebuilding .symtab with foo before the marker keeps mapping authority and the same identity', () => {
  const reorderedEntries = [
    AARCH64_MAPPING_ENTRIES[3], AARCH64_MAPPING_ENTRIES[0],
    AARCH64_MAPPING_ENTRIES[1], AARCH64_MAPPING_ENTRIES[2],
  ];
  const baseline = parseELF(buildAarch64MappingElf());
  const reordered = parseELF(buildAarch64MappingElf(reorderedEntries));

  assert.deepEqual(laidOutSymbols(baseline), [['$x', 1], ['foo', 4], ['$d', 2], ['$x.1', 3]]);
  assert.deepEqual(laidOutSymbols(reordered), [['foo', 1], ['$x', 2], ['$d', 3], ['$x.1', 4]]);

  const foo = baseline.symbols.find((entry) => entry.name === 'foo');
  assert.ok(foo?.address != null);
  const first = analysisFromBinaryImage(baseline);
  const second = analysisFromBinaryImage(reordered);

  assert.deepEqual(second.names, first.names);
  assert.deepEqual(second.names, ['foo', '$d', '$x.1']);
  assert.equal(new SymbolIndex({ ...second, regions: [] }).nameAt(foo.address), 'foo');
  assert.deepEqual([...second.kinds], [...first.kinds]);
  assert.deepEqual([...second.flags], [...first.flags]);
  assert.deepEqual(second.nameProvenance, first.nameProvenance);

  // The marker keeps its record and its code/data authority in both layouts.
  for (const image of [baseline, reordered]) {
    assert.ok(image.symbols.some((entry) => entry.name === '$x'));
    assert.equal(image.dataInCode.length, 1);
    assert.equal(image.isInstructionAllowed(foo.address + 4n), false);
  }
});

/* ------------------------------------------------------------------ *
 * Binding evidence. STB_GLOBAL, STB_WEAK and STB_GNU_UNIQUE are all definitions
 * the link kept, so they share one naming tier; STB_LOCAL and OS/processor
 * specific `bind-N` are file-scoped, matching the reader's own linkage notion.
 * ------------------------------------------------------------------ */

test('declared non-local bindings share one naming tier: global, weak and gnu-unique are not ordered', () => {
  const address = 0x8000n;
  for (const binding of ['global', 'weak', 'gnu-unique']) {
    const linkVisible = funcRecord('link_visible', address, { binding });
    const fileScoped = funcRecord('file_scoped', address);
    assert.deepEqual(canonicalNames([fileScoped, linkVisible]), ['link_visible'], `${binding} must outrank a local definition`);
    assert.deepEqual(canonicalNames([linkVisible, fileScoped]), ['link_visible'], `${binding} must outrank a local definition in either order`);
  }

  // The binding bit is not naming evidence between two definitions: every pairing
  // resolves to the same name in either order.
  for (const [first, second] of [['global', 'weak'], ['global', 'gnu-unique'], ['weak', 'gnu-unique']]) {
    assert.deepEqual(
      canonicalNames([funcRecord('alpha_alias', address, { binding: first }), funcRecord('beta_alias', address, { binding: second })]),
      ['alpha_alias'],
      `${first} vs ${second} must not be decided by binding`,
    );
    assert.deepEqual(
      canonicalNames([funcRecord('beta_alias', address, { binding: second }), funcRecord('alpha_alias', address, { binding: first })]),
      ['alpha_alias'],
      `${second} vs ${first} must not be decided by binding`,
    );
  }
});

test('an OS/processor-specific binding stays file-scoped, matching the reader externallyVisible notion', () => {
  const address = 0x8800n;
  const vendorBound = funcRecord('vendor_bound', address, { binding: 'bind-7' });
  const fileScoped = funcRecord('file_scoped', address);

  assert.deepEqual(canonicalNames([vendorBound, funcRecord('link_visible', address, { binding: 'global' })]), ['link_visible']);
  assert.deepEqual(canonicalNames([funcRecord('link_visible', address, { binding: 'global' }), vendorBound]), ['link_visible']);
  // No published linkage for `bind-N`: it stays at the file-scoped tier, so the
  // spelling is the only remaining evidence and it decides the same way twice.
  assert.deepEqual(canonicalNames([vendorBound, fileScoped]), ['file_scoped']);
  assert.deepEqual(canonicalNames([fileScoped, vendorBound]), ['file_scoped']);
});

console.log('same-address symbol semantic ranking regression: PASS');
