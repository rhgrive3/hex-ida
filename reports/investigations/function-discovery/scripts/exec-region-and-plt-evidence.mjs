#!/usr/bin/env node
/**
 * function-discovery investigation / review-response evidence.
 *
 * Two questions, answered from the 160 real binaries only:
 *
 *  Q1  What kinds of ELF executable region exist, and is "0 function starts"
 *      ever a legitimate state for one of them?
 *  Q2  Which loader/linker evidence identifies a region as a PLT (resolver
 *      stub + thunks) *structurally* — i.e. toolchain-independent evidence
 *      rather than a section-name/type check?
 *
 * Read-only. Writes only into reports/investigations/function-discovery/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const REPORT_DIR = path.join(ROOT, 'reports/investigations/function-discovery');
const BENCH = path.join(ROOT, 'benchmarks/public/codefuse-arm64');
const manifest = JSON.parse(fs.readFileSync(path.join(BENCH, 'manifest.json'), 'utf8'));

const SHF_ALLOC = 0x2;
const SHF_EXEC = 0x4;
const SHT_NOBITS = 8;
const SHT_SYMTAB = 2;
const SHT_DYNSYM = 11;
const SHT_DYNAMIC = 6;
const SHT_RELA = 4;

const DT = {
  2: 'PLTRELSZ', 3: 'PLTGOT', 7: 'RELA', 8: 'RELASZ', 9: 'RELAENT',
  12: 'INIT', 13: 'FINI', 20: 'PLTREL', 23: 'JMPREL', 25: 'INIT_ARRAY', 26: 'FINI_ARRAY',
};
const R_AARCH64_JUMP_SLOT = 1026;
const R_AARCH64_RELATIVE = 1027;

const PAGE = (w) => {
  const immlo = (w >>> 29) & 3;
  let immhi = (w >>> 5) & 0x7ffff;
  let imm = (immhi << 2) | immlo;
  if (imm & 0x100000) imm -= 0x200000;
  return imm * 4096;
};
// stp x16, x30, [sp, #-16]!  — the AAELF64 PLT resolver prologue word.
// NOTE: JS bitwise operators coerce to int32, so a masked word whose bit 31 is
// set compares as a *negative* int32 and never equals a positive 32-bit literal.
// Every masked comparison below therefore normalises with `>>> 0`.
const STP_X16_X30_PRE = (w) => w === 0xa9bf7bf0;
const IS_ADRP = (w) => ((w & 0x9f000000) >>> 0) === 0x90000000;
const IS_LDR_UNSIGNED = (w) => ((w & 0xffc00000) >>> 0) === 0xf9400000 || ((w & 0xffc00000) >>> 0) === 0xb9400000;
const IS_ADD_IMM = (w) => ((w & 0xff800000) >>> 0) === 0x91000000;
const IS_BR = (w) => ((w & 0xfffffc1f) >>> 0) === 0xd61f0000;

function parseElf(buf) {
  const little = buf[5] === 1;
  const rd64 = (o) => Number(buf.readBigUInt64LE(o));
  const rd32 = (o) => buf.readUInt32LE(o);
  const rd16 = (o) => buf.readUInt16LE(o);
  const eEntry = rd64(24);
  const eShoff = rd64(40);
  const eShentsize = rd16(58);
  const eShnum = rd16(60);
  const eShstrndx = rd16(62);
  const sections = [];
  for (let i = 0; i < eShnum; i += 1) {
    const o = eShoff + i * eShentsize;
    sections.push({
      index: i, nameOff: rd32(o), type: rd32(o + 4), flags: rd64(o + 8),
      addr: rd64(o + 16), offset: rd64(o + 24), size: rd64(o + 32),
      link: rd32(o + 40), entsize: rd64(o + 56),
    });
  }
  const shstr = sections[eShstrndx];
  const strAt = (sec, off) => {
    if (!sec || off >= sec.size) return '';
    let end = sec.offset + off;
    const limit = sec.offset + sec.size;
    while (end < limit && buf[end] !== 0) end += 1;
    return buf.toString('utf8', sec.offset + off, end);
  };
  for (const s of sections) s.name = strAt(shstr, s.nameOff);

  const symbols = [];
  for (const s of sections) {
    if (s.type !== SHT_SYMTAB && s.type !== SHT_DYNSYM) continue;
    const strSec = sections[s.link];
    const count = Math.floor(s.size / (s.entsize || 24));
    for (let i = 0; i < count; i += 1) {
      const o = s.offset + i * (s.entsize || 24);
      const info = buf[o + 4];
      symbols.push({
        table: s.name, name: strAt(strSec, rd32(o)), type: info & 0xf,
        binding: info >> 4, ndx: rd16(o + 6), value: rd64(o + 8), size: rd64(o + 16),
      });
    }
  }

  // PT_DYNAMIC / .dynamic
  const dyn = new Map();
  const dynSec = sections.find((s) => s.type === SHT_DYNAMIC);
  if (dynSec) {
    const count = Math.floor(dynSec.size / (dynSec.entsize || 16));
    for (let i = 0; i < count; i += 1) {
      const o = dynSec.offset + i * (dynSec.entsize || 16);
      const tag = Number(buf.readBigInt64LE(o));
      const val = Number(buf.readBigUInt64LE(o + 8));
      if (tag === 0) break;
      if (!dyn.has(tag)) dyn.set(tag, val);
    }
  }

  // .rela.plt entries
  const relaPlt = [];
  for (const s of sections) {
    if (s.type !== SHT_RELA) continue;
    const count = Math.floor(s.size / (s.entsize || 24));
    for (let i = 0; i < count; i += 1) {
      const o = s.offset + i * (s.entsize || 24);
      const rOffset = Number(buf.readBigUInt64LE(o));
      const type = Number(buf.readBigUInt64LE(o + 8) & 0xffffffffn);
      const addend = Number(buf.readBigInt64LE(o + 16));
      if (type === R_AARCH64_JUMP_SLOT) relaPlt.push({ section: s.name, rOffset, addend });
    }
  }
  return { buf, eEntry, sections, symbols, dyn, relaPlt };
}

const execSections = (elf) =>
  elf.sections.filter((s) => (s.flags & SHF_EXEC) && (s.flags & SHF_ALLOC) && s.type !== SHT_NOBITS && s.size > 0 && s.index !== 0);

const bytesAt = (elf, addr, len) => {
  for (const s of elf.sections) {
    if (s.type === SHT_NOBITS || s.index === 0 || s.size === 0) continue;
    if (addr >= s.addr && addr + len <= s.addr + s.size) return elf.buf.subarray(s.offset + (addr - s.addr), s.offset + (addr - s.addr) + len);
  }
  return null;
};

const rd = (w) => w & 0x1f, rn = (w) => (w >>> 5) & 0x1f, rt = (w) => w & 0x1f;

/*
 * Decode the shared AAELF64 "GOT materialisation" tail used by both the PLT
 * resolver and the PLT thunks: adrp x16 / ldr x17,[x16,#off] / add x16,x16,#imm
 * / br x17.  `adrpAt` is the file-relative word index of the adrp inside the
 * slot (1 for the resolver, 0 for a thunk).
 */
function decodePltTail(words, adrpPc) {
  const w = words;
  if (!(IS_ADRP(w[0]) && rd(w[0]) === 16)) return null;
  if (!(IS_LDR_UNSIGNED(w[1]) && rn(w[1]) === 16 && rt(w[1]) === 17)) return null;
  if (!(IS_ADD_IMM(w[2]) && rd(w[2]) === 16 && rn(w[2]) === 16)) return null;
  if (!(IS_BR(w[3]) && rn(w[3]) === 17)) return null;
  const page = (adrpPc & ~0xfff) + PAGE(w[0]);
  const ldrOff = ((w[1] >>> 10) & 0xfff) * 8;
  const sh = (w[2] >>> 22) & 1;
  const addImm = sh ? ((w[2] >>> 10) & 0xfff) << 12 : (w[2] >>> 10) & 0xfff;
  return { page, ldrOffset: ldrOff, gotSlot: page + ldrOff, addTarget: page + addImm };
}

function wordsAt(elf, addr, count) {
  const b = bytesAt(elf, addr, count * 4);
  if (!b || b.length < count * 4) return null;
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(b.readUInt32LE(i * 4));
  return out;
}

/* AArch64 PLT resolver (slot 0): stp x16,x30,[sp,#-16]! then the shared tail. */
function decodePltResolver(elf, addr) {
  const w = wordsAt(elf, addr, 5);
  if (!w) return null;
  if (!STP_X16_X30_PRE(w[0])) return null;
  const tail = decodePltTail(w.slice(1), addr + 4);
  if (!tail) return null;
  return { ...tail, wordCount: 5 };
}

/* AArch64 PLT thunk: the shared tail only. */
function decodePltThunk(elf, addr) {
  const w = wordsAt(elf, addr, 4);
  if (!w) return null;
  return decodePltTail(w, addr);
}

function findStructuralPltSection(elf, exec, relaPlt) {
  const nJmp = relaPlt.length;
  const dtPltgot = elf.dyn.get(3) ?? null;
  if (dtPltgot == null || nJmp === 0) return null;
  const expectedSize = 32 + 16 * nJmp;
  const jumpOffsets = new Set(relaPlt.map((r) => r.rOffset));
  const candidates = [];

  for (const section of exec) {
    if (section.size !== expectedSize) continue;
    const resolver = decodePltResolver(elf, section.addr);
    if (!resolver) continue;
    if (resolver.gotSlot !== dtPltgot + 16 || resolver.addTarget !== resolver.gotSlot) continue;
    if (jumpOffsets.has(resolver.gotSlot)) continue;

    let allThunksMatch = true;
    for (let k = 0; k < nJmp; k += 1) {
      const thunk = decodePltThunk(elf, section.addr + 32 + 16 * k);
      if (!thunk
        || thunk.gotSlot !== thunk.addTarget
        || thunk.gotSlot !== relaPlt[k].rOffset) {
        allThunksMatch = false;
        break;
      }
    }
    if (allThunksMatch) candidates.push(section);
  }

  return candidates.length === 1 ? candidates[0] : null;
}

const perBinary = [];
const execNameCounts = {};
const plt0Signatures = {};
let pltSlots0Plt = 0;
let pltThunksVerified = 0;
let pltThunksTotal = 0;
let pltSizeRelationHolds = 0;
let pltGetsDtPltgotHolds = 0;
let pltThunksOrdered = 0;
let resolverNotAJumpSlot = 0;
const q3UncoveredBySection = {};
const q3PerBinary = [];
let q3ExecBytes = 0;
let q3CoveredBytes = 0;
let q3SectionsWithUncoveredBytes = 0;
let binariesWithExtraExecSection = 0;
let execSectionsWithZeroFuncSymbols = 0;
let execSectionsTotal = 0;
let execSectionsWithFuncSymbols = 0;

for (const c of manifest.cases) {
  const p = path.join(BENCH, 'inputs', `${c.binarySha256}.bin`);
  const elf = parseElf(fs.readFileSync(p));
  const exec = execSections(elf);
  const relaPlt = elf.relaPlt;
  const pltSec = findStructuralPltSection(elf, exec, relaPlt);
  const nJmp = relaPlt.length;

  const names = exec.map((s) => s.name);
  for (const n of names) execNameCounts[n] = (execNameCounts[n] ?? 0) + 1;
  const extra = names.filter((n) => !['.init', '.plt', '.text', '.fini'].includes(n));
  if (extra.length) binariesWithExtraExecSection += 1;

  const funcSymsIn = (s) =>
    elf.symbols.filter((y) => y.type === 2 && y.value >= s.addr && y.value < s.addr + s.size && y.ndx === s.index).length;

  const sectionInfo = exec.map((s) => ({
    name: s.name,
    addr: '0x' + s.addr.toString(16),
    size: '0x' + s.size.toString(16),
    flags: (s.flags & SHF_EXEC ? 'X' : '') + (s.flags & SHF_ALLOC ? 'A' : '') + (s.flags & 1 ? 'W' : ''),
    funcSymbolCount: funcSymsIn(s),
    isDtInit: elf.dyn.get(12) != null && elf.dyn.get(12) === s.addr,
    isDtFini: elf.dyn.get(13) != null && elf.dyn.get(13) === s.addr,
    isDtInitArrayTarget: elf.dyn.get(25) != null && elf.dyn.get(25) >= s.addr && elf.dyn.get(25) < s.addr + s.size,
    isPlt: !!pltSec && s.index === pltSec.index,
  }));
  for (const si of sectionInfo) {
    execSectionsTotal += 1;
    if (si.funcSymbolCount > 0) execSectionsWithFuncSymbols += 1;
    else execSectionsWithZeroFuncSymbols += 1;
  }

  // --- Q3: executable-byte coverage accounting --------------------------------
  // How many executable bytes carry NO STT_FUNC symbol extent at all? This is
  // the population a blanket "non-empty region with no start => incomplete" rule
  // would have to classify, so its size and location matter for the fix design.
  let execBytes = 0;
  let coveredBytes = 0;
  for (const s of exec) {
    const lo = s.addr;
    const hi = s.addr + s.size;
    execBytes += s.size;
    const iv = elf.symbols
      .filter((y) => y.type === 2 && y.size > 0 && y.value < hi && y.value + y.size > lo)
      .map((y) => [Math.max(lo, y.value), Math.min(hi, y.value + y.size)])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cursor = lo;
    let cov = 0;
    for (const [a, b] of iv) {
      if (b <= cursor) continue;
      const st = Math.max(a, cursor);
      if (b > st) cov += b - st;
      cursor = Math.max(cursor, b);
    }
    coveredBytes += cov;
    const uncovered = s.size - cov;
    if (uncovered > 0) {
      q3UncoveredBySection[s.name] = (q3UncoveredBySection[s.name] ?? 0) + uncovered;
      q3SectionsWithUncoveredBytes += 1;
    }
  }
  q3ExecBytes += execBytes;
  q3CoveredBytes += coveredBytes;
  q3PerBinary.push({
    caseId: c.id,
    executableBytes: execBytes,
    bytesCoveredByFuncSymbolExtent: coveredBytes,
    uncoveredExecutableBytes: execBytes - coveredBytes,
  });

  // --- PLT structural evidence -------------------------------------------------
  let pltModel = { available: !!pltSec };
  if (pltSec) {
    const resolver = decodePltResolver(elf, pltSec.addr);
    const dtPltgot = elf.dyn.get(3) ?? null;
    const dtJmprel = elf.dyn.get(23) ?? null;
    const dtPltrelsz = elf.dyn.get(2) ?? null;
    const dtPltrel = elf.dyn.get(20) ?? null;
    const sig = (() => {
      const b = bytesAt(elf, pltSec.addr, 20);
      return b ? b.toString('hex') : null;
    })();
    plt0Signatures[sig] = (plt0Signatures[sig] ?? 0) + 1;
    const resolverShape = !!resolver;
    if (resolverShape) pltSlots0Plt += 1;

    // AAELF64 PLT layout: a 32-byte resolver slot (5 instructions + padding)
    // followed by one 16-byte thunk per R_AARCH64_JUMP_SLOT entry.
    const expectedSize = 32 + 16 * nJmp;
    const sizeRelation = pltSec.size === expectedSize;
    if (sizeRelation) pltSizeRelationHolds += 1;

    const got0 = resolver ? resolver.gotSlot : null;
    const addT0 = resolver ? resolver.addTarget : null;
    // AAELF64 lazy-binding PLT0 materialises &GOT[2] (DT_PLTGOT + 16) and loads the
    // resolver pointer from that same slot; the adjacent GOT[1] (DT_PLTGOT + 8)
    // holds link_map, and GOT[0] holds _DYNAMIC. This names the *dynamic table*
    // region, not a section: no section name is consulted.
    const pltgotRelation = dtPltgot != null && got0 != null && got0 === dtPltgot + 16 && addT0 === got0;
    if (pltgotRelation) pltGetsDtPltgotHolds += 1;

    // verify each thunk's encoded GOT slot against a R_AARCH64_JUMP_SLOT r_offset
    const offsets = new Set(relaPlt.map((r) => r.rOffset));
    let matched = 0;
    let ordered = 0;
    for (let k = 0; k < nJmp; k += 1) {
      const thunk = decodePltThunk(elf, pltSec.addr + 32 + 16 * k);
      if (!thunk) continue;
      pltThunksTotal += 1;
      if (thunk.gotSlot === thunk.addTarget && offsets.has(thunk.gotSlot)) matched += 1;
      if (k < relaPlt.length && thunk.gotSlot === relaPlt[k].rOffset) ordered += 1;
    }
    pltThunksVerified += matched;
    pltThunksOrdered += ordered;

    // The resolver slot must NOT denote any import: that is the structural
    // distinction between a resolver stub and an import thunk.
    const resolverIsNotJumpSlot = got0 != null && !offsets.has(got0);
    if (resolverShape && resolverIsNotJumpSlot) resolverNotAJumpSlot += 1;
    pltModel = {
      available: true,
      sectionName: pltSec.name,
      size: '0x' + pltSec.size.toString(16),
      jumpSlotCount: nJmp,
      resolverSlotBytes: 32,
      thunkSlotBytes: 16,
      sizeEquals32Plus16TimesJumpSlots: sizeRelation,
      dtPltgot: dtPltgot == null ? null : '0x' + dtPltgot.toString(16),
      dtJmprel: dtJmprel == null ? null : '0x' + dtJmprel.toString(16),
      dtPltrelsz: dtPltrelsz == null ? null : dtPltrelsz,
      dtPltrel: dtPltrel == null ? null : dtPltrel,
      resolverShapeDetected: resolverShape,
      resolverGotSlot: got0 == null ? null : '0x' + got0.toString(16),
      resolverAddTarget: addT0 == null ? null : '0x' + addT0.toString(16),
      resolverMaterialisesDtPltgotPlus16: got0 == null || dtPltgot == null ? null : got0 === dtPltgot + 16,
      resolverMaterialisedSlotIsNotAJumpSlot: resolverShape ? resolverIsNotJumpSlot : null,
      resolverRelationHolds: pltgotRelation,
      thunksMatchingJumpSlotOffsets: `${matched}/${nJmp}`,
      thunksMatchingJumpSlotOffsetsInOrder: `${ordered}/${nJmp}`,
      resolverSignatureHex20Bytes: sig,
    };
  }

  perBinary.push({
    caseId: c.id,
    binarySha256: c.binarySha256,
    compiler: c.compiler,
    optimization: c.optimization,
    entrypoint: '0x' + elf.eEntry.toString(16),
    executableSections: sectionInfo,
    pltModel,
  });
}

const doc = {
  schema: 'hex-function-discovery-investigation/exec-region-and-plt-evidence/v1',
  generatedAt: new Date().toISOString(),
  source: 'all 160 binaries in benchmarks/public/codefuse-arm64/inputs (read-only)',
  q1ExecutableRegionKinds: {
    binaries: manifest.cases.length,
    distinctExecutableSectionNames: execNameCounts,
    binariesWithExecutableSectionOutsideInitPltTextFini: binariesWithExtraExecSection,
    executableSectionsTotal: execSectionsTotal,
    executableSectionsContainingAtLeastOneFuncSymbol: execSectionsWithFuncSymbols,
    executableSectionsContainingZeroFuncSymbols: execSectionsWithZeroFuncSymbols,
    finding:
      'Executable regions are not all function-bearing. In these binaries the executable set is exactly {.init,.plt,.text,.fini} (plus .init_array/.fini_array/.rodata-style regions only where a toolchain marks them AX — see names histogram), and .init/.fini/.plt all contain executable bytes that carry no STT_FUNC symbol. Any rule of the form "non-empty executable region with no start => incomplete" therefore fires on legitimate, fully-modelled regions.',
  },
  q2PltEvidenceModel: {
    binariesWithPltRegion: perBinary.filter((b) => b.pltModel.available).length,
    resolverShapeAtSlot0: pltSlots0Plt,
    sizeEquals32Plus16TimesJumpSlots: pltSizeRelationHolds,
    resolverMaterialisesDtPltgotPlus16: pltGetsDtPltgotHolds,
    resolverSlotIsNotAJumpSlot: resolverNotAJumpSlot,
    thunksWhoseEncodedGotSlotEqualsAJumpSlotROffset: `${pltThunksVerified}/${pltThunksTotal}`,
    thunksWhoseEncodedGotSlotEqualsAJumpSlotROffsetInOrder: `${pltThunksOrdered}/${pltThunksTotal}`,
    distinctSlot0ByteSignatures: Object.keys(plt0Signatures).length,
    slot0SignatureHistogram: plt0Signatures,
    finding:
      'A PLT is identifiable from the ELF dynamic/linker structures alone, with no section name consulted: DT_JMPREL + the R_AARCH64_JUMP_SLOT entry count fixes the region size as 32+16*n bytes with a 32-byte slot 0; slot 0 decodes as the AAELF64 resolver stub (stp x16,x30,[sp,#-16]! + adrp x16 / ldr x17,[x16,#o] / add x16,x16,#o / br x17) and materialises &GOT[2] = DT_PLTGOT+16, a slot that is NOT any jump-slot r_offset; and every remaining slot k decodes as that same GOT-materialisation tail encoding exactly .rela.plt[k-1].r_offset, in order. This separates the resolver stub (slot 0) from the import thunks (slots 1..n) using dynamic-table evidence only.',
  },
  q3ExecutableByteCoverage: {
    binaries: q3PerBinary.length,
    executableBytes: q3ExecBytes,
    bytesCoveredByFuncSymbolExtent: q3CoveredBytes,
    uncoveredExecutableBytes: q3ExecBytes - q3CoveredBytes,
    uncoveredBySection: q3UncoveredBySection,
    executableSectionsWithUncoveredBytes: q3SectionsWithUncoveredBytes,
    finding:
      'Executable bytes are not fully described by STT_FUNC extents: outside .plt, .text/.init/.fini also carry uncovered bytes (padding, alignment and symbol-less helper code). A rule that treats every non-empty executable region without a start as an incomplete model therefore has a non-empty false-positive population even in a corpus whose linker always emits a PLT.',
    perBinary: q3PerBinary,
  },
  perBinary,
};

const tmp = path.join(REPORT_DIR, `.exec-region-and-plt-evidence.json.tmp-${process.pid}`);
fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
const re = JSON.parse(fs.readFileSync(tmp, 'utf8'));
if (re.perBinary.length !== manifest.cases.length) throw new Error('case count mismatch');
if (re.q2PltEvidenceModel.binariesWithPltRegion === 0) throw new Error('no PLT region found');
fs.renameSync(tmp, path.join(REPORT_DIR, 'exec-region-and-plt-evidence.json'));

console.log(JSON.stringify({
  q1: doc.q1ExecutableRegionKinds,
  q2: { ...doc.q2PltEvidenceModel, slot0SignatureHistogram: undefined },
  q3: { ...doc.q3ExecutableByteCoverage, perBinary: undefined },
}, null, 2));
