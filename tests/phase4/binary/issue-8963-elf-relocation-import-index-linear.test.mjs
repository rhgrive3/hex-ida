import assert from 'node:assert/strict';
import { parseELF } from '../../../js/binary/elf.js';

// #8963 — [HIGH][ELF] relocation→import-site attachment must not rescan the
// whole import table per relocation.
//
// parseRelocations() bound each relocation's symbol by index, but then resolved
// its import with `image.imports.find(...)` for EVERY relocation — Θ(N²)
// predicate work behind a constant budget charge. A valid ET_REL with N unique
// undefined symbols and N matching relocations must attach sites in ~O(N).
// The fix must preserve the #5682 identity binding (a relocation attaches to the
// import of the exact (tableIndex, symbolIndex) it references, never a
// same-name import from another table, and never with last-write-wins).

const SHT_NULL = 0, SHT_PROGBITS = 1, SHT_SYMTAB = 2, SHT_STRTAB = 3, SHT_RELA = 4;
const ET_REL = 1, X86_64 = 62, R_X86_64_64 = 1;

function build(n) {
  // Dynamic layout so symtab/rela can scale past a fixed header gap.
  const strtabBytes = [0]; // leading NUL
  const nameOffset = [];
  for (let i = 0; i < n; i++) {
    nameOffset.push(strtabBytes.length);
    strtabBytes.push(...new TextEncoder().encode(`sym${i}\0`));
  }
  const shstrNames = ['', '.strtab', '.symtab', '.text', '.rela.text', '.shstrtab'];
  const shstrBytes = []; const shstrOff = [];
  for (const nm of shstrNames) { shstrOff.push(shstrBytes.length); shstrBytes.push(...new TextEncoder().encode(`${nm}\0`)); }

  const alignUp = (v, a) => (v % a === 0 ? v : v + (a - (v % a)));
  const strtab = 0x80, strtabSize = strtabBytes.length;
  const symtab = alignUp(strtab + strtabSize, 8), symEntry = 24, symtabSize = symEntry * (n + 1);
  const rela = alignUp(symtab + symtabSize, 8), relaEntry = 24, relaSize = relaEntry * n;
  const text = alignUp(rela + relaSize, 16), textSize = 16;
  const shstr = alignUp(text + textSize, 1);
  const shoff = alignUp(shstr + shstrBytes.length, 8);
  const total = shoff + 64 * 6;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);

  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  view.setUint16(16, ET_REL, true);
  view.setUint16(18, X86_64, true);
  view.setUint32(20, 1, true);
  view.setBigUint64(40, BigInt(shoff), true);
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, 0, true);
  view.setUint16(58, 64, true);
  view.setUint16(60, 6, true);
  view.setUint16(62, 5, true);

  bytes.set(strtabBytes, strtab);
  bytes.set(shstrBytes, shstr);
  bytes.fill(0x90, text, text + 8);

  const sv = new DataView(bytes.buffer, symtab, symtabSize);
  for (let i = 0; i < n; i++) {
    const p = symEntry * (i + 1);
    sv.setUint32(p, nameOffset[i], true); // sh_name -> 'symI'
    sv.setUint8(p + 4, (1 << 4) | 2);     // GLOBAL | FUNC
    sv.setUint16(p + 6, 0, true);         // shndx = SHN_UNDEF -> undefined -> import
  }
  for (let i = 0; i < n; i++) {
    const p = rela + i * relaEntry;
    view.setBigUint64(p, 0n, true);                                   // r_offset
    view.setBigUint64(p + 8, (BigInt(i + 1) << 32n) | BigInt(R_X86_64_64), true); // r_info: symIndex i+1
    view.setBigInt64(p + 16, 0n, true);                               // r_addend
  }

  const sec = (index, { type, flags = 0n, addr = 0n, offset = 0n, size = 0n, link = 0, info = 0, align = 1n, entsize = 0n }) => {
    const p = shoff + index * 64;
    view.setUint32(p, shstrOff[index], true);
    view.setUint32(p + 4, type, true);
    view.setBigUint64(p + 8, flags, true);
    view.setBigUint64(p + 16, addr, true);
    view.setBigUint64(p + 24, BigInt(offset), true);
    view.setBigUint64(p + 32, BigInt(size), true);
    view.setUint32(p + 40, link, true);
    view.setUint32(p + 44, info, true);
    view.setBigUint64(p + 48, align, true);
    view.setBigUint64(p + 56, entsize, true);
  };
  sec(0, { type: SHT_NULL });
  sec(1, { type: SHT_STRTAB, offset: strtab, size: strtabSize });
  sec(2, { type: SHT_SYMTAB, offset: symtab, size: symtabSize, link: 1, info: 1, align: 8n, entsize: 24n });
  sec(3, { type: SHT_PROGBITS, flags: 0x6n, offset: text, size: textSize, align: 16n });
  sec(4, { type: SHT_RELA, offset: rela, size: relaSize, link: 2, info: 3, align: 8n, entsize: 24n });
  sec(5, { type: SHT_STRTAB, offset: shstr, size: shstrBytes.length });
  return parseELF(bytes);
}

// Count only predicate evaluations performed over the import table, by
// instrumenting Array.prototype.find against arrays whose elements are import
// records (they carry a `sites` array + `symbolIndex`). The pre-fix per
// relocation `image.imports.find(...)` is Θ(N^2); the fix uses an O(1) index.
function parseAndCountImports(n) {
  const orig = Array.prototype.find;
  let checks = 0;
  Array.prototype.find = function (pred, ...rest) {
    const first = this[0];
    const isImports = this.length > 0 && first && typeof first === 'object'
      && Array.isArray(first.sites) && 'symbolIndex' in first && 'tableIndex' in first;
    if (isImports) return orig.call(this, (el, i, a) => { checks++; return pred(el, i, a); }, ...rest);
    return orig.call(this, pred, ...rest);
  };
  try { return { image: build(n), checks }; }
  finally { Array.prototype.find = orig; }
}

const N = 1200;
const { image, checks } = parseAndCountImports(N);

// Parsing still succeeds and every relocation attached its site.
assert.equal(image.metadata.elfMetadata.complete, true, 'valid ET_REL must parse complete');
assert.equal(image.imports.length, N, 'one distinct import record per unique undefined symbol');
assert.equal(image.relocations.length, N);
let siteTotal = 0;
for (const imp of image.imports) siteTotal += imp.sites.length;
assert.equal(siteTotal, N, 'every relocation attaches exactly one import site');
for (const imp of image.imports) {
  assert.equal(imp.sites.length, 1, 'each unique import owns its one relocation site');
  assert.equal(imp.sites[0].kind, 'relocation');
}

// The scan is no longer quadratic in the import table.
assert.ok(checks <= 30 * N, `import predicate checks ${checks} exceed the linear bound (N=${N})`);

// Linearity control: doubling the work must not quadruple the lookups.
const small = parseAndCountImports(400).checks;
assert.ok(checks <= small * 6 + 1000,
  `lookups grew super-linearly: N=${N} => ${checks} vs N=400 => ${small}`);

console.log('issue-8963 ELF relocation→import index linear-attachment regression: PASS');
