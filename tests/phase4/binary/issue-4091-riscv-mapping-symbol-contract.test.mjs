/**
 * #4091 — RISC-V mapping symbols carry an ELF psABI metadata contract
 * (STT_NOTYPE + STB_LOCAL + st_size == 0).  Name-only recognition let a global
 * function named `$d` become authoritative data/code evidence.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseELF } from '../../../js/binary/elf.js';
import { resolveRiscvIsaProfile } from '../../../js/binary/riscv-isa.js';

const EM_RISCV = 243;
const ET_REL = 1;
const ET_EXEC = 2;
const ET_DYN = 3;
const PT_LOAD = 1;
const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RISCV_ATTRIBUTES = 0x70000003;
const SHF_ALLOC = 0x2n;
const SHF_EXECINSTR = 0x4n;
const STB_LOCAL = 0;
const STB_GLOBAL = 1;
const STB_WEAK = 2;
const STT_NOTYPE = 0;
const STT_FUNC = 2;

function uleb(n) {
  const out = [];
  do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n);
  return out;
}

function ntbs(s) { return [...Buffer.from(s, 'utf8'), 0]; }

function attrPayload(arch) {
  const attrBytes = [...uleb(5), ...ntbs(arch)];
  const tagBytes = uleb(1);
  const subsub = [...tagBytes, ...u32le(tagBytes.length + 4 + attrBytes.length), ...attrBytes];
  const vendor = ntbs('riscv');
  return Uint8Array.from([0x41, ...u32le(4 + vendor.length + subsub.length), ...vendor, ...subsub]);
}

function u32le(n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }

function stringTable(names) {
  const bytes = new Uint8Array(names.reduce((sum, name) => sum + Buffer.byteLength(name, 'utf8') + 1, 1));
  bytes[0] = 0;
  const offsets = [];
  let cursor = 1;
  for (const name of names) {
    offsets.push(cursor);
    bytes.set(Buffer.from(name, 'utf8'), cursor);
    cursor += Buffer.byteLength(name, 'utf8') + 1;
  }
  return { bytes, offsets };
}

function symbolEntry({ name, bind = STB_LOCAL, type = STT_NOTYPE, size = 0n, value = 4n, shndx = 2 }) {
  return { name, info: (bind << 4) | type, other: 0, shndx, value, size };
}

function buildElf({ arch = 'rv64i2p1', symbols = [], type = ET_REL, textAddress = 0x401000n }) {
  const runtimeImage = type !== ET_REL;
  const attr = arch === null ? null : attrPayload(arch);
  const textContent = new Uint8Array(16);
  const strtab = stringTable(['', ...symbols.map((entry) => entry.name)]);

  let cursor = 64 + (runtimeImage ? 56 : 0);
  const attrOff = cursor; if (attr) cursor += attr.length;
  const textOff = cursor; cursor += textContent.length;
  const symOff = cursor; cursor += (symbols.length + 1) * 24;
  const strOff = cursor; cursor += strtab.bytes.length;
  const shstrOff = cursor;

  const sections = [{ name:'', type:0, flags:0n, addr:0n, off:0, size:0, link:0, info:0, entsize:0n, addralign:0n }];
  if (attr) sections.push({ name:'.riscv.attributes', type:SHT_RISCV_ATTRIBUTES, flags:0n, addr:0n, off:attrOff, size:attr.length, link:0, info:0, entsize:0n, addralign:1n });
  sections.push({ name:'.text', type:SHT_PROGBITS, flags:SHF_ALLOC | SHF_EXECINSTR, addr:runtimeImage ? textAddress : 0n, off:textOff, size:textContent.length, link:0, info:0, entsize:0n, addralign:4n });
  sections.push({ name:'.symtab', type:SHT_SYMTAB, flags:0n, addr:0n, off:symOff, size:(symbols.length + 1) * 24, link:0, info:1, entsize:24n, addralign:8n });
  sections.push({ name:'.strtab', type:SHT_STRTAB, flags:0n, addr:0n, off:strOff, size:strtab.bytes.length, link:0, info:0, entsize:0n, addralign:1n });
  const symtab = sections.findIndex((section) => section.name === '.symtab');
  sections[symtab].link = sections.findIndex((section) => section.name === '.strtab');
  sections[symtab].info = sections.findIndex((section) => section.name === '.text');

  const shstrtab = stringTable(['', ...sections.slice(1).map((section) => section.name), '.shstrtab']);
  cursor += shstrtab.bytes.length;
  const shOff = (cursor + 7) & ~7;
  sections.push({ name:'.shstrtab', type:SHT_STRTAB, flags:0n, addr:0n, off:shstrOff, size:shstrtab.bytes.length, link:0, info:0, entsize:0n, addralign:1n });

  const total = shOff + sections.length * 64;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  buf.set(attr || [], attrOff);
  buf.set(textContent, textOff);
  buf.set(strtab.bytes, strOff);
  buf.set(shstrtab.bytes, shstrOff);
  symbols.forEach((entry, i) => {
    const p = symOff + (i + 1) * 24;
    view.setUint32(p, strtab.offsets[i + 1], true);
    view.setUint8(p + 4, entry.info);
    view.setUint8(p + 5, entry.other);
    view.setUint16(p + 6, entry.shndx, true);
    view.setBigUint64(p + 8, entry.value, true);
    view.setBigUint64(p + 16, entry.size, true);
  });

  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  view.setUint16(16, type, true);
  view.setUint16(18, EM_RISCV, true);
  view.setUint32(20, 1, true);
  view.setBigUint64(24, 0n, true);
  view.setBigUint64(32, runtimeImage ? 64n : 0n, true);
  view.setBigUint64(40, BigInt(shOff), true);
  view.setUint16(52, 64, true);
  view.setUint16(54, runtimeImage ? 56 : 0, true);
  view.setUint16(56, runtimeImage ? 1 : 0, true);
  view.setUint16(58, 64, true);
  view.setUint16(60, sections.length, true);
  view.setUint16(62, sections.length - 1, true);
  if (runtimeImage) {
    const p = 64;
    view.setUint32(p, PT_LOAD, true);
    view.setUint32(p + 4, 5, true); // PF_R | PF_X
    view.setBigUint64(p + 8, BigInt(textOff), true);
    view.setBigUint64(p + 16, textAddress, true);
    view.setBigUint64(p + 24, textAddress, true);
    view.setBigUint64(p + 32, BigInt(textContent.length), true);
    view.setBigUint64(p + 40, BigInt(textContent.length), true);
    view.setBigUint64(p + 48, 1n, true);
  }
  sections.forEach((section, i) => {
    const p = shOff + i * 64;
    view.setUint32(p, shstrtab.offsets[i], true);
    view.setUint32(p + 4, section.type, true);
    view.setBigUint64(p + 8, section.flags, true);
    view.setBigUint64(p + 16, section.addr, true);
    view.setBigUint64(p + 24, BigInt(section.off), true);
    view.setBigUint64(p + 32, BigInt(section.size), true);
    view.setUint32(p + 40, section.link, true);
    view.setUint32(p + 44, section.info, true);
    view.setBigUint64(p + 48, section.addralign, true);
    view.setBigUint64(p + 56, section.entsize, true);
  });
  return buf;
}

function parsed(definition) {
  const image = parseELF(buildElf({ symbols:[definition] }));
  assert.equal(image.arch, 'riscv64');
  assert.ok(image.symbols.some((entry) => entry.name === definition.name));
  return image;
}

function profileAt(image, name) {
  const symbol = image.symbols.find((entry) => entry.name === name);
  assert.ok(symbol, `symbol ${name} must stay in the symbol table`);
  const covered = image.metadata.riscvIsa.sections.some((section) => symbol.address >= section.start && symbol.address < section.end);
  assert.equal(covered, true, 'the target must sit inside an executable section so the mapping layer is reached');
  return resolveRiscvIsaProfile(image.metadata.riscvIsa, symbol.address);
}

test('#4091: STB_LOCAL + STT_NOTYPE + size 0 `$d` is accepted as a data mapping', () => {
  const image = parsed(symbolEntry({ name:'$d' }));
  const mappings = image.metadata.riscvIsa.mappings;
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0].kind, 'data');
  const profile = profileAt(image, '$d');
  assert.equal(profile.code, false);
  assert.equal(profile.exact, true);
  assert.equal(profile.evidence, 'mapping-symbol-data');
});

test('#4091: STB_LOCAL + STT_NOTYPE + size 0 `$x` is accepted as an instruction mapping', () => {
  const image = parsed(symbolEntry({ name:'$x' }));
  assert.equal(image.metadata.riscvIsa.mappings.length, 1);
  assert.equal(image.metadata.riscvIsa.mappings[0].kind, 'instruction');
  const profile = profileAt(image, '$x');
  assert.equal(profile.code, true);
  assert.equal(profile.canonical, 'rv64i2p1');
  assert.equal(profile.exact, true);
});

test('#4091: conforming `$x<ISA>` mapping keeps its exact local ISA authority', () => {
  const image = parsed(symbolEntry({ name:'$xrv64i2p1_m2p0_c2p0' }));
  const mapping = image.metadata.riscvIsa.mappings[0];
  assert.equal(mapping?.isa?.canonical, 'rv64i2p1_m2p0_c2p0');
  const profile = profileAt(image, '$xrv64i2p1_m2p0_c2p0');
  assert.equal(profile.canonical, 'rv64i2p1_m2p0_c2p0');
  assert.equal(profile.evidence, 'mapping-symbol');
  assert.equal(profile.exact, true);
});

test('#4091: STB_GLOBAL `$d` is not mapping evidence', () => {
  const image = parsed(symbolEntry({ name:'$d', bind:STB_GLOBAL }));
  assert.equal(image.metadata.riscvIsa.mappings.length, 0);
  const profile = profileAt(image, '$d');
  assert.equal(profile.code, true, 'a violating symbol must not open an exact data region');
  assert.equal(profile.evidence, 'elf-attribute');
  const symbol = image.symbols.find((entry) => entry.name === '$d');
  assert.equal(symbol.binding, 'global');
  assert.equal(symbol.defined, true);
});

test('#4091: STB_WEAK `$d` is not mapping evidence', () => {
  const image = parsed(symbolEntry({ name:'$d', bind:STB_WEAK }));
  assert.equal(image.metadata.riscvIsa.mappings.length, 0);
  assert.equal(profileAt(image, '$d').code, true);
});

test('#4091: STT_FUNC `$d` is not mapping evidence', () => {
  const image = parsed(symbolEntry({ name:'$d', type:STT_FUNC }));
  assert.equal(image.metadata.riscvIsa.mappings.length, 0);
  assert.equal(profileAt(image, '$d').code, true);
});

test('#4091: non-zero st_size `$d` is not mapping evidence', () => {
  const image = parsed(symbolEntry({ name:'$d', size:4n }));
  assert.equal(image.metadata.riscvIsa.mappings.length, 0);
  assert.equal(profileAt(image, '$d').code, true);
});

test('#4091: a non-conforming `$x<ISA>` record cannot override the file-level ISA', () => {
  const name = '$xrv64i2p1_m2p0_c2p0';
  const image = parsed(symbolEntry({ name, bind:STB_GLOBAL, type:STT_FUNC, size:4n }));
  assert.equal(image.metadata.riscvIsa.mappings.length, 0);
  const profile = profileAt(image, name);
  assert.equal(profile.canonical, 'rv64i2p1');
  assert.equal(profile.instructionAlignment, 4);
  assert.equal(profile.evidence, 'elf-attribute');
});

test('#4091: a user function named `$d` keeps ordinary symbol/export/function truth', () => {
  const image = parsed(symbolEntry({ name:'$d', bind:STB_GLOBAL, type:STT_FUNC, size:4n }));
  const symbol = image.symbols.find((entry) => entry.name === '$d');
  assert.equal(symbol.kind, 'function');
  assert.equal(symbol.defined, true);
  assert.equal(image.metadata.riscvIsa.mappings.length, 0);
  assert.ok(image.functions.some((seed) => seed.address === symbol.address));
  assert.ok(image.exports.some((entry) => entry.name === '$d' && entry.address === symbol.address));
});

test('#4091: conforming mappings survive alongside contract-violating look-alikes', () => {
  const image = parseELF(buildElf({ symbols:[
    symbolEntry({ name:'$d', bind:STB_GLOBAL, type:STT_FUNC, size:8n }),
    symbolEntry({ name:'$d', value:8n }),
    symbolEntry({ name:'$x', value:12n }),
  ] }));
  const mappings = image.metadata.riscvIsa.mappings;
  const conforming = image.symbols.filter((entry) => entry.defined === true && entry.binding === 'local'
    && entry.kind === 'type-0' && entry.size === 0n);
  assert.deepEqual(mappings.map((mapping) => mapping.kind), ['data', 'instruction']);
  assert.deepEqual(mappings.map((mapping) => mapping.address), conforming.map((entry) => entry.address));
  assert.equal(conforming.length, 2);
});

for (const shndx of [0xfff1, 0xfff2]) {
  test(`#4091: reserved section index ${shndx} cannot supply ISA authority without executable sections`, () => {
    const name = '$xrv64i2p1_m2p0_c2p0';
    const bytes = buildElf({ arch:null, symbols:[symbolEntry({ name, shndx })] });
    const view = new DataView(bytes.buffer);
    const textHeader = Number(view.getBigUint64(40, true)) + 64;
    view.setBigUint64(textHeader + 8, SHF_ALLOC, true);
    const image = parseELF(bytes);
    const symbol = image.symbols.find((entry) => entry.name === name);
    assert.ok(symbol, 'ordinary absolute/common symbol metadata is preserved');
    assert.equal(symbol.sectionIndex, shndx);
    assert.equal(symbol.defined, true);
    assert.deepEqual(image.metadata.riscvIsa.sections, []);
    assert.deepEqual(image.metadata.riscvIsa.mappings, []);
    assert.equal(resolveRiscvIsaProfile(image.metadata.riscvIsa, 4n, { allowAssumed:false }), null);
  });
}

test('#4091: an unmapped ET_REL executable section cannot supply mapping or range authority', () => {
  const name = '$xrv64i2p1_m2p0_c2p0';
  const bytes = buildElf({ arch:null, symbols:[symbolEntry({ name, shndx:1 })] });
  const view = new DataView(bytes.buffer);
  const textHeader = Number(view.getBigUint64(40, true)) + 64;
  view.setBigUint64(textHeader + 32, BigInt(bytes.length), true);
  const image = parseELF(bytes);
  assert.equal(image.sections.find((section) => section.index === 1)?.source, 'unmapped-section');
  const symbol = image.symbols.find((entry) => entry.name === name);
  assert.ok(symbol);
  assert.deepEqual(image.metadata.riscvIsa.mappings, []);
  assert.deepEqual(image.metadata.riscvIsa.sections, []);
  assert.equal(resolveRiscvIsaProfile(image.metadata.riscvIsa, symbol.address, { allowAssumed:false }), null);
});

test('#4091: an excluded executable virtual range cannot reappear through raw section metadata', () => {
  const name = '$xrv64i2p1_m2p0_c2p0';
  const value = (1n << 64n) - 4n;
  const bytes = buildElf({ arch:null, symbols:[symbolEntry({ name, shndx:1, value })] });
  const view = new DataView(bytes.buffer);
  const textHeader = Number(view.getBigUint64(40, true)) + 64;
  view.setUint16(16, 2, true); // ET_EXEC
  view.setBigUint64(textHeader + 16, (1n << 64n) - 8n, true);
  const image = parseELF(bytes);
  assert.equal(image.sections.some((section) => section.index === 1), false);
  assert.ok(image.symbols.some((entry) => entry.name === name));
  assert.deepEqual(image.metadata.riscvIsa.mappings, []);
  assert.deepEqual(image.metadata.riscvIsa.sections, []);
  assert.equal(resolveRiscvIsaProfile(image.metadata.riscvIsa, value, { allowAssumed:false }), null);
});

test('#4091: a non-allocated executable ET_EXEC section has no canonical ISA mapping authority', () => {
  const name = '$xrv64i2p1_m2p0_c2p0';
  const bytes = buildElf({ arch:null, symbols:[symbolEntry({ name, shndx:1 })] });
  const view = new DataView(bytes.buffer);
  const textHeader = Number(view.getBigUint64(40, true)) + 64;
  view.setUint16(16, 2, true); // ET_EXEC
  view.setBigUint64(textHeader + 8, SHF_EXECINSTR, true);
  const image = parseELF(bytes);
  assert.equal(image.sections.find((section) => section.index === 1)?.source, 'section-header');
  assert.equal(image.sections.find((section) => section.index === 1)?.perms.read, false);
  assert.deepEqual(image.metadata.riscvIsa.mappings, []);
  assert.deepEqual(image.metadata.riscvIsa.sections, []);
  assert.equal(resolveRiscvIsaProfile(image.metadata.riscvIsa, 4n, { allowAssumed:false }), null);
});

for (const [type, label] of [[ET_EXEC, 'ET_EXEC'], [ET_DYN, 'ET_DYN']]) {
  test(`#4091: ${label} mapping symbols must stay inside their declared section`, () => {
    const sectionStart = 0x401000n;
    for (const value of [sectionStart - 4n, sectionStart + 16n]) {
      const image = parseELF(buildElf({ type, textAddress:sectionStart, symbols:[symbolEntry({ name:'$d', value })] }));
      const symbol = image.symbols.find((entry) => entry.name === '$d');
      assert.equal(symbol?.sectionIndex, 2);
      assert.equal(symbol?.address, value);
      assert.ok(image.metadata.riscvIsa.sections.some((section) => section.sectionIndex === 2
        && section.start === sectionStart && section.end === sectionStart + 16n));
      assert.equal(image.metadata.riscvIsa.mappings.length, 0, `out-of-section st_value ${value.toString(16)} must not grant mapping authority`);
    }

    const valid = parseELF(buildElf({ type, textAddress:sectionStart, symbols:[symbolEntry({ name:'$d', value:sectionStart })] }));
    assert.equal(valid.metadata.riscvIsa.mappings.length, 1);
    assert.equal(valid.metadata.riscvIsa.mappings[0].address, sectionStart);
  });
}
