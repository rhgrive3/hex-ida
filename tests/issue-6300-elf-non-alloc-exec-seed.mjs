import assert from 'node:assert/strict';
import { parseELF } from '../js/binary/elf.js';
import { executableELFRange } from '../js/binary/elf-mapping.js';
import { makeElf64Fixture } from './universal-binary.mjs';

const ET_EXEC = 2;
const ET_DYN = 3;
const ET_REL = 1;

// Build a minimal ELF64 with one PT_LOAD and one section header, with caller
// controlled e_type, section flags/addr/size and a single STT_FUNC symbol.
function makeTypedElf64({ type, sectionFlags, sectionAddr, symbolValue, symbolSize }) {
  const shnum = 4; // null, .text, .strtab, .symtab
  const shoff = 0x300;
  const b = new Uint8Array(0x1100);
  const v = new DataView(b.buffer);
  const w16 = (o, x) => v.setUint16(o, x, true);
  const w32 = (o, x) => v.setUint32(o, x >>> 0, true);
  const w64 = (o, x) => v.setBigUint64(o, BigInt(x), true);

  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0], 0);
  w16(16, type); w16(18, 62); w32(20, 1);
  w64(24, 0n); w64(32, 64n); w64(40, shoff); // one PT_LOAD at e_phoff=64
  w32(48, 0); w16(52, 64); w16(54, 56); w16(56, 1);
  w16(58, 64); w16(60, shnum); w16(62, 0);

  // PT_LOAD: executable, 0x400000..0x401000, file-backed 0x100..0x1100
  w32(64, 1); w32(68, 5);
  w64(72, 0x100n); w64(80, 0x400000n); w64(88, 0x400000n);
  w64(96, 0x1000n); w64(104, 0x1000n); w64(112, 0x1000n);

  // symbol-backed bytes inside the PT_LOAD
  b.fill(0x90, 0x100, 0x110);

  const shstr = new TextEncoder().encode('\0.text\0.strtab\0.symtab\0');
  b.set(shstr, 0x200);
  const nameOff = { text: 1, strtab: 7, symtab: 15 };

  const symstr = new TextEncoder().encode('\0ghost\0');
  b.set(symstr, 0x280);

  const sh = (i, name, type, flags, addr, off, size, link = 0, info = 0, align = 1, entsize = 0) => {
    const p = shoff + i * 64;
    w32(p, name); w32(p + 4, type); w64(p + 8, flags); w64(p + 16, addr);
    w64(p + 24, off); w64(p + 32, size); w32(p + 40, link); w32(p + 44, info);
    w64(p + 48, align); w64(p + 56, entsize);
  };
  sh(0, 0, 0, 0n, 0n, 0n, 0n);
  sh(1, nameOff.text, 1, sectionFlags, sectionAddr, 0x100n, 0x10n);
  sh(2, nameOff.strtab, 3, 0n, 0n, 0x280n, BigInt(symstr.length), 0, 0, 1, 0);
  sh(3, nameOff.symtab, 2, 0n, 0n, 0x2c0n, 48n, 2, 1, 8, 24);

  // symtab: null entry + ghost STT_FUNC (st_shndx=1)
  w32(0x2c0, 0); b[0x2c4] = 0; b[0x2c5] = 0; w16(0x2c6, 0); w64(0x2c8, 0n); w64(0x2d0, 0n);
  w32(0x2d8, 1); b[0x2dc] = 0x12; b[0x2dd] = 0; w16(0x2de, 1);
  w64(0x2e0, symbolValue); w64(0x2e8, symbolSize);
  return b;
}

const GHOST_ADDR = 0x700000n;
const ALLOC_EXEC = 0x6n; // SHF_ALLOC | SHF_EXECINSTR
const EXEC_ONLY = 0x4n; // SHF_EXECINSTR without SHF_ALLOC

// #6300 case 1/2: allocated executable section inside the executable PT_LOAD
// keeps the exact 0.995 seed for ET_EXEC and ET_DYN.
for (const type of [ET_EXEC, ET_DYN]) {
  const image = parseELF(makeTypedElf64({ type, sectionFlags: ALLOC_EXEC, sectionAddr: 0x400000n, symbolValue: 0x400000n, symbolSize: 4n }));
  const seed = image.functions.find((f) => f.address === 0x400000n && f.name === 'ghost');
  assert.ok(seed, `ET_${type === ET_EXEC ? 'EXEC' : 'DYN'}: allocated in-load STT_FUNC keeps its exact seed`);
  assert.equal(seed.exactFunctionStart, true);
  assert.equal(seed.confidence, 0.995);
  assert.match(seed.functionStartEvidence, /STT_FUNC/);
  assert.ok(!image.warnings.some((w) => w.includes('ghost')));
}

// #6300 case 3/4: SHF_EXECINSTR without SHF_ALLOC is not runtime memory.
for (const type of [ET_EXEC, ET_DYN]) {
  const image = parseELF(makeTypedElf64({ type, sectionFlags: EXEC_ONLY, sectionAddr: 0x400000n, symbolValue: 0x400000n, symbolSize: 4n }));
  assert.ok(!image.functions.some((f) => f.address === 0x400000n && f.source === 'symbol'),
    `ET_${type === ET_EXEC ? 'EXEC' : 'DYN'}: non-alloc executable section must not seed an exact function`);
  assert.ok(image.warnings.some((w) => w.includes('ghost') && w.includes('canonical executable extent')),
    `ET_${type === ET_EXEC ? 'EXEC' : 'DYN'}: rejected symbol keeps explicit provenance warning`);
}

// #6300 case 5: allocated+executable section whose address is outside every
// executable PT_LOAD is not runtime memory either.
for (const type of [ET_EXEC, ET_DYN]) {
  const image = parseELF(makeTypedElf64({ type, sectionFlags: ALLOC_EXEC, sectionAddr: GHOST_ADDR, symbolValue: GHOST_ADDR, symbolSize: 4n }));
  assert.ok(!image.functions.some((f) => f.address === GHOST_ADDR && f.source === 'symbol'),
    `ET_${type === ET_EXEC ? 'EXEC' : 'DYN'}: section outside all executable PT_LOADs must not seed an exact function`);
  assert.ok(image.warnings.some((w) => w.includes('ghost')));
}

// #6300 case 6: symbol start inside the PT_LOAD but extent past the segment
// end is not an exact extent.
for (const type of [ET_EXEC, ET_DYN]) {
  const image = parseELF(makeTypedElf64({ type, sectionFlags: ALLOC_EXEC, sectionAddr: 0x400000n, symbolValue: 0x400ffcn, symbolSize: 0x10n }));
  assert.ok(!image.functions.some((f) => f.address === 0x400ffcn && f.source === 'symbol'),
    `ET_${type === ET_EXEC ? 'EXEC' : 'DYN'}: extent past the canonical executable mapping must not seed an exact function`);
  assert.ok(image.warnings.some((w) => w.includes('ghost')));
}

// #6300 case 7: STT_GNU_IFUNC resolvers get the same runtime mapping check.
{
  const ifunc = makeTypedElf64({ type: ET_EXEC, sectionFlags: EXEC_ONLY, sectionAddr: 0x400000n, symbolValue: 0x400000n, symbolSize: 4n });
  const v = new DataView(ifunc.buffer);
  v.setUint8(0x2dc, 0x1a); // STB_GLOBAL | STT_GNU_IFUNC
  const image = parseELF(ifunc);
  assert.ok(!image.functions.some((f) => f.source === 'ifunc-resolver'),
    'STT_GNU_IFUNC resolver in a non-alloc executable section must not seed an exact resolver');
  assert.ok(image.warnings.some((w) => w.includes('STT_GNU_IFUNC resolver')));
}

// #6300 case 8: ET_REL synthetic section-relative behavior is preserved.
{
  const rel = makeTypedElf64({ type: ET_REL, sectionFlags: EXEC_ONLY, sectionAddr: 0x400000n, symbolValue: 0n, symbolSize: 4n });
  const image = parseELF(rel);
  const fn = image.symbols.find((s) => s.name === 'ghost');
  assert.ok(fn);
  assert.equal(fn.addressDomain, 'section-relative-synthetic');
  assert.ok(image.functions.some((f) => f.address !== 0n && f.exactFunctionStart),
    'ET_REL keeps its synthetic section-relative exact seed contract');
}

// #6300 helper contract: relocatable images keep section-only validation.
{
  const relImage = { metadata: { type: ET_REL }, sections: [{ index: 1, address: 0x100000000n, size: 4n, perms: { read: false, write: false, execute: true } }], segments: [] };
  assert.ok(executableELFRange(relImage, 0x100000000n, 4n, 1));
  const execImage = { metadata: { type: ET_EXEC }, sections: [{ index: 1, address: 0x400000n, size: 4n, perms: { read: true, write: false, execute: true } }], segments: [{ address: 0x400000n, size: 0x1000n, perms: { read: true, write: false, execute: true } }] };
  assert.ok(executableELFRange(execImage, 0x400000n, 4n, 1));
  const unmapped = { metadata: { type: ET_EXEC }, sections: [{ index: 1, address: 0x700000n, size: 4n, perms: { read: true, write: false, execute: true } }], segments: [{ address: 0x400000n, size: 0x1000n, perms: { read: true, write: false, execute: true } }] };
  assert.equal(executableELFRange(unmapped, 0x700000n, 4n, 1), null);
  const sectionless = { metadata: { type: ET_EXEC }, sections: [], segments: [{ address: 0x400000n, size: 0x1000n, perms: { read: true, write: false, execute: true } }] };
  assert.ok(executableELFRange(sectionless, 0x400000n, 4n, null), 'sectionless PT_DYNAMIC fallback still resolves through executable segments');
}

// #6300 case 9: existing section-provenance exact seeds without program
// headers keep working (makeElf64Fixture is ET_DYN with no PT_LOAD; its
// .text section is SHF_ALLOC|SHF_EXECINSTR, the pre-#6300 canonical path).
{
  const baseline = parseELF(makeElf64Fixture());
  const seed = baseline.functions.find((f) => f.address === 0x401000n && f.name === 'myfunc');
  assert.ok(seed, 'existing section-provenance STT_FUNC seed is preserved');
  assert.equal(seed.exactFunctionStart, true);
}

console.log('issue #6300 non-alloc executable section function-seed regressions: PASS');
