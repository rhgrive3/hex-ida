import assert from 'node:assert/strict';
import test from 'node:test';

import { parseELF } from '../js/binary/elf.js';
import { analysisFromBinaryImage } from '../js/platform/analysis-result.js';

const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;
const SHT_NULL = 0;
const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_SYMTAB_SHNDX = 18;
const ET_EXEC = 2;
const SHN_UNDEF = 0;
const SHN_XINDEX = 0xffff;

const setU16 = (b, o, v) => new DataView(b.buffer).setUint16(o, v, true);
const setU32 = (b, o, v) => new DataView(b.buffer).setUint32(o, v >>> 0, true);
const setU64 = (b, o, v) => new DataView(b.buffer).setBigUint64(o, BigInt(v), true);

// Builds a resident ELF64 whose single SHT_SYMTAB contains one null entry plus
// the supplied symbols. `xindex` selects how the SHT_SYMTAB_SHNDX companion is
// presented: 'valid' (well-formed, entries resolved per symbol), 'short'
// (present but undersized -> xindex-malformed), or 'absent' (no companion).
function buildElf(symbols, { xindex = 'valid' } = {}) {
  const sectionHeaderOffset = 0x200;
  const sectionHeaderSize = 64;
  const bytes = new Uint8Array(sectionHeaderOffset + sectionHeaderSize * 5);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);

  setU16(bytes, 16, ET_EXEC);
  setU16(bytes, 18, 62); // EM_X86_64
  setU32(bytes, 20, 1);
  setU64(bytes, 24, 0); // e_entry
  setU64(bytes, 32, 0x40); // e_phoff
  setU64(bytes, 40, sectionHeaderOffset); // e_shoff
  setU32(bytes, 48, 0); // e_flags
  setU16(bytes, 52, 64); // e_ehsize
  setU16(bytes, 54, 56); // e_phentsize
  setU16(bytes, 56, 1); // e_phnum
  setU16(bytes, 58, sectionHeaderSize); // e_shentsize
  setU16(bytes, 60, 5); // e_shnum
  setU16(bytes, 62, 0); // e_shstrndx

  setU32(bytes, 0x40, 1); // PT_LOAD
  setU32(bytes, 0x44, 5); // PF_R | PF_X
  setU64(bytes, 0x48, 0x80); // p_offset
  setU64(bytes, 0x50, 0x400000); // p_vaddr
  setU64(bytes, 0x58, 0x400000); // p_paddr
  setU64(bytes, 0x60, 4); // p_filesz
  setU64(bytes, 0x68, 4); // p_memsz
  setU64(bytes, 0x70, 0x1000); // p_align
  bytes.set([0, 0, 0, 0], 0x80);

  const section = (index, { type = 0, flags = 0, address = 0, offset = 0, size = 0, link = 0, info = 0, align = 1, entsize = 0 } = {}) => {
    const p = sectionHeaderOffset + index * sectionHeaderSize;
    setU32(bytes, p + 4, type);
    setU64(bytes, p + 8, flags);
    setU64(bytes, p + 16, address);
    setU64(bytes, p + 24, offset);
    setU64(bytes, p + 32, size);
    setU32(bytes, p + 40, link);
    setU32(bytes, p + 44, info);
    setU64(bytes, p + 48, align);
    setU64(bytes, p + 56, entsize);
  };

  section(1, { type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, address: 0x400000, offset: 0x80, size: 4, align: 4 });

  const strOffset = 0x90;
  const strBytes = [0];
  const nameOffset = {};
  for (const symbol of symbols) {
    if (symbol.name in nameOffset) continue;
    nameOffset[symbol.name] = strBytes.length;
    for (const ch of symbol.name) strBytes.push(ch.charCodeAt(0));
    strBytes.push(0);
  }
  bytes.set(strBytes, strOffset);
  section(2, { type: SHT_STRTAB, offset: strOffset, size: strBytes.length, align: 1 });

  const symOffset = 0x120;
  const symEnt = 24;
  symbols.forEach((symbol, idx) => {
    const p = symOffset + (idx + 1) * symEnt;
    setU32(bytes, p, nameOffset[symbol.name]);
    bytes[p + 4] = symbol.info ?? 0x11; // STB_GLOBAL | STT_OBJECT
    bytes[p + 5] = 0; // st_other (visibility default)
    setU16(bytes, p + 6, symbol.shndx);
    setU64(bytes, p + 8, symbol.value ?? 0);
    setU64(bytes, p + 16, symbol.size ?? 0);
  });
  const symCount = symbols.length + 1;
  const symSize = symCount * symEnt;
  section(3, { type: SHT_SYMTAB, offset: symOffset, size: symSize, link: 2, info: 1, align: 8, entsize: symEnt });

  const xindexOffset = symOffset + symSize;
  if (xindex === 'valid' || xindex === 'short') {
    setU32(bytes, xindexOffset, 0); // companion entry for the null symbol
    symbols.forEach((symbol, idx) => setU32(bytes, xindexOffset + (idx + 1) * 4, symbol.xidx ?? 0));
    const size = xindex === 'short' ? (symCount - 1) * 4 : symCount * 4;
    section(4, { type: SHT_SYMTAB_SHNDX, offset: xindexOffset, size, link: 3, align: 4, entsize: 4 });
  } else {
    section(4, { type: SHT_NULL });
  }
  return bytes;
}

const symbolNamed = (image, name) => {
  const symbol = image.symbols.find((entry) => entry.name === name);
  assert.ok(symbol, `fixture must contain symbol ${name}`);
  return symbol;
};

test('#5009 keeps unknown section-identity symbols out of the zero address (parseSymbols)', () => {
  const image = parseELF(buildElf([
    { name: 'definedNonzero', shndx: 1, value: 0x400000, size: 4 }, // normal defined, nonzero VA
    { name: 'definedZero', shndx: 1, value: 0, size: 4 },           // legitimately defined at VA 0
    { name: 'undef', shndx: SHN_UNDEF, value: 0 },                  // SHN_UNDEF
    { name: 'xindexResolved', shndx: SHN_XINDEX, value: 0x400020, xidx: 1 }, // XINDEX -> section 1
    { name: 'xindexOutOfRange', shndx: SHN_XINDEX, value: 0x400040, xidx: 999 }, // XINDEX -> invalid entry
    { name: 'reservedUnsupported', shndx: 0xff05, value: 0x400050 }, // unsupported reserved index
  ]));

  const nonzero = symbolNamed(image, 'definedNonzero');
  assert.equal(nonzero.defined, true, 'defined nonzero: identity known');
  assert.equal(nonzero.address, 0x400000n, 'defined nonzero: keeps real address');

  const zero = symbolNamed(image, 'definedZero');
  assert.equal(zero.defined, true, 'defined at zero: still defined');
  assert.equal(zero.address, 0n, 'defined at zero: address 0n preserved');

  const undef = symbolNamed(image, 'undef');
  assert.equal(undef.defined, false, 'SHN_UNDEF: defined false');

  const resolved = symbolNamed(image, 'xindexResolved');
  assert.equal(resolved.defined, true, 'SHN_XINDEX + valid companion resolves');
  assert.equal(resolved.address, 0x400020n, 'SHN_XINDEX + valid companion uses resolved address');

  const outOfRange = symbolNamed(image, 'xindexOutOfRange');
  assert.equal(outOfRange.defined, null, 'SHN_XINDEX + invalid companion stays unknown');
  assert.equal(outOfRange.address, null, 'unknown identity must NOT collapse to address 0');

  const reserved = symbolNamed(image, 'reservedUnsupported');
  assert.equal(reserved.defined, null, 'unsupported reserved index stays unknown');
  assert.equal(reserved.address, null, 'unsupported reserved index must NOT collapse to address 0');
});

test('#5009 an unresolvable SHN_XINDEX symbol is never promoted to zero-address analysis evidence', () => {
  const image = parseELF(buildElf([
    { name: 'anchor', shndx: 1, value: 0x401000, size: 4 },
    { name: 'mystery', shndx: SHN_XINDEX, value: 0x402000 },
  ], { xindex: 'absent' }));

  const mystery = symbolNamed(image, 'mystery');
  assert.equal(mystery.defined, null, 'mystery stays unknown when the companion table is absent');
  assert.equal(mystery.address, null, 'mystery keeps a null address');

  const analysis = analysisFromBinaryImage(image);
  assert.ok(!analysis.names.includes('mystery'), 'unknown symbol must not appear as analysis evidence');
  const zeroNames = analysis.names.filter((_, i) => analysis.addrs[i] === 0n);
  assert.ok(!zeroNames.includes('mystery'), 'unknown symbol must not register at address 0');
  assert.ok(analysis.names.includes('anchor'), 'genuinely defined symbol is still adopted');
});

test('#5009 analysisFromBinaryImage only adopts symbols with known-defined identity', () => {
  const base = { format: 'elf', exports: [], imports: [], functions: [], metadata: {} };
  const run = (symbols) => analysisFromBinaryImage({ ...base, symbols });

  const kept = run([
    { name: 'known', defined: true, address: 0x2000n, source: 'symtab' },
    { name: 'realZero', defined: true, address: 0n, source: 'symtab' },
  ]);
  assert.ok(kept.names.includes('known'), 'defined nonzero symbol adopted');
  assert.ok(kept.names.includes('realZero'), 'legitimately defined zero-address symbol adopted');

  const unknownAtZero = run([{ name: 'unknownAtZero', defined: null, address: 0n, source: 'symtab' }]);
  assert.ok(!unknownAtZero.names.includes('unknownAtZero'), 'defined:null must not become zero-address evidence');

  const undefinedSym = run([{ name: 'undefined', defined: false, address: 0n, source: 'symtab' }]);
  assert.ok(!undefinedSym.names.includes('undefined'), 'SHN_UNDEF must not become evidence');

  const unknownNull = run([{ name: 'unknownNullAddr', defined: null, address: null, source: 'symtab' }]);
  assert.ok(!unknownNull.names.includes('unknownNullAddr'), 'defined:null with null address never adopted');
});

console.log('issue-5009 ELF unknown-symbol address: ok');
