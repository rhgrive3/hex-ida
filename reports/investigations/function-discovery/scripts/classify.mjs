#!/usr/bin/env node
/**
 * function-discovery investigation / Phase 2 evidence classifier.
 *
 * For every IDA-present / Hex-absent row re-derived in Phase 1, gather
 * independent evidence from the ELF binary and from the published IDA
 * Hex-Rays reference artifact, then assign a root-cause cluster.
 *
 * Evidence is computed locally (self-contained ELF64 parser + AArch64 static
 * scan) so the result does not depend on optional host tooling.
 *
 * Read-only with respect to production code. Writes only into
 * reports/investigations/function-discovery/.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = '/mnt/workspace/hex-agent-e';
const REPORT_DIR = path.join(ROOT, 'reports/investigations/function-discovery');
const BENCH = path.join(ROOT, 'benchmarks/public/codefuse-arm64');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(BENCH, 'manifest.json'), 'utf8'));
const IDA_ONLY = JSON.parse(fs.readFileSync(path.join(REPORT_DIR, 'ida-only-functions.json'), 'utf8'));

const byId = new Map(MANIFEST.cases.map((c) => [c.id, c]));

/* ------------------------------------------------------------------ ELF64 */

const SHF_WRITE = 0x1;
const SHF_ALLOC = 0x2;
const SHF_EXEC = 0x4;
const SHT_NOBITS = 8;
const SHT_SYMTAB = 2;
const SHT_DYNSYM = 11;

function parseElf(buf) {
  if (buf.readUInt32BE(0) !== 0x7f454c46) throw new Error('not ELF');
  const is64 = buf[4] === 2;
  if (!is64) throw new Error('not ELF64');
  const little = buf[5] === 1;
  const rd64 = (o) => (little ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));
  const rd32 = (o) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const rd16 = (o) => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o));

  const eType = rd16(16);
  const eMachine = rd16(18);
  const eEntry = rd64(24);
  const eShoff = Number(rd64(40));
  const eShentsize = rd16(58);
  const eShnum = rd16(60);
  const eShstrndx = rd16(62);

  const sections = [];
  for (let i = 0; i < eShnum; i += 1) {
    const o = eShoff + i * eShentsize;
    sections.push({
      index: i,
      nameOff: rd32(o),
      type: rd32(o + 4),
      flags: Number(rd64(o + 8)),
      addr: Number(rd64(o + 16)),
      offset: Number(rd64(o + 24)),
      size: Number(rd64(o + 32)),
      link: rd32(o + 40),
      entsize: Number(rd64(o + 56)),
    });
  }
  const shstr = sections[eShstrndx];
  const strAt = (strSec, off) => {
    if (!strSec || off >= strSec.size) return '';
    let end = strSec.offset + off;
    const limit = strSec.offset + strSec.size;
    while (end < limit && buf[end] !== 0) end += 1;
    return buf.toString('utf8', strSec.offset + off, end);
  };
  for (const s of sections) s.name = strAt(shstr, s.nameOff);

  // symbol tables
  const symbols = [];
  for (const s of sections) {
    if (s.type !== SHT_SYMTAB && s.type !== SHT_DYNSYM) continue;
    const strSec = sections[s.link];
    const count = Math.floor(s.size / (s.entsize || 24));
    for (let i = 0; i < count; i += 1) {
      const o = s.offset + i * (s.entsize || 24);
      const stName = rd32(o);
      const info = buf[o + 4];
      const ndx = rd16(o + 6);
      const value = Number(rd64(o + 8));
      const size = Number(rd64(o + 16));
      const type = info & 0xf;
      const bind = info >> 4;
      symbols.push({
        table: s.name,
        name: strAt(strSec, stName),
        type,
        typeName: ['NOTYPE', 'OBJECT', 'FUNC', 'SECTION', 'FILE', 'COMMON', 'TLS'][type] ?? `T${type}`,
        bind,
        bindName: ['LOCAL', 'GLOBAL', 'WEAK'][bind] ?? `B${bind}`,
        ndx,
        value,
        size,
      });
    }
  }

  return { buf, little, eType, eMachine, eEntry, sections, symbols };
}

const secByName = (elf, n) => elf.sections.find((s) => s.name === n) ?? null;

function sectionOfAddr(elf, addr) {
  let best = null;
  for (const s of elf.sections) {
    if (s.type === SHT_NOBITS) {
      if (addr >= s.addr && addr < s.addr + s.size && s.size > 0) best = best ?? s;
      continue;
    }
    if (s.name === '' || s.index === 0) continue;
    if (addr >= s.addr && addr < s.addr + s.size) {
      if (!best || s.size < best.size) best = s;
    }
  }
  return best;
}

function bytesAt(elf, addr, len) {
  const s = sectionOfAddr(elf, addr);
  if (!s || s.type === SHT_NOBITS) return null;
  const off = s.offset + (addr - s.addr);
  if (off < 0 || off + len > elf.buf.length) return null;
  return elf.buf.subarray(off, off + len);
}

/* ------------------------------------------------------- AArch64 static scan */

function scanCodeTargets(elf) {
  const bl = new Set();
  const b = new Set();
  const adrpAdd = new Set();
  const adr = new Set();
  const exec = elf.sections.filter((s) => (s.flags & SHF_EXEC) && s.type !== SHT_NOBITS && s.size > 0);
  for (const s of exec) {
    const start = s.addr;
    const end = s.addr + s.size - (s.size % 4);
    let lastAdrpPage = null;
    for (let a = start; a + 4 <= end; a += 4) {
      const o = s.offset + (a - s.addr);
      const w = elf.buf.readUInt32LE(o);
      const op = (w >>> 26) & 0x3f;
      if (op === 0x25) {
        // BL
        let imm = w & 0x03ffffff;
        if (imm & 0x02000000) imm -= 0x04000000;
        bl.add(a + imm * 4);
        lastAdrpPage = null;
      } else if (op === 0x05) {
        // B
        let imm = w & 0x03ffffff;
        if (imm & 0x02000000) imm -= 0x04000000;
        b.add(a + imm * 4);
        lastAdrpPage = null;
      } else if ((w & 0x9f000000) === 0x90000000) {
        // ADRP
        let immlo = (w >>> 29) & 0x3;
        let immhi = (w >>> 5) & 0x7ffff;
        let imm = (immhi << 2) | immlo;
        if (imm & 0x100000) imm -= 0x200000;
        lastAdrpPage = (a & ~0xfff) + imm * 4096;
      } else if ((w & 0xff000000) === 0x10000000) {
        // ADR
        let immlo = (w >>> 29) & 0x3;
        let immhi = (w >>> 5) & 0x7ffff;
        let imm = (immhi << 2) | immlo;
        if (imm & 0x100000) imm -= 0x200000;
        adr.add(a + imm);
        lastAdrpPage = null;
      } else if (lastAdrpPage !== null && (w & 0xff800000) === 0x91000000) {
        // ADD (immediate) after ADRP -> address materialization
        const imm12 = (w >>> 10) & 0xfff;
        const sh = (w >>> 22) & 1;
        adrpAdd.add(lastAdrpPage + (sh ? imm12 << 12 : imm12));
      } else {
        lastAdrpPage = null;
      }
    }
  }
  return { bl, b, adrpAdd, adr };
}

/* ------------------------------------------------------------- .eh_frame_hdr */

function decodeEhEnc(buf, p, enc, datarelBase) {
  const kind = enc & 0x0f;
  const rel = enc & 0x70;
  let val;
  let size;
  switch (kind) {
    case 0x01:
      val = BigInt(buf.readUInt32LE(p));
      size = 4;
      break; // uleb128 unsupported here
    case 0x02:
      val = BigInt(buf.readUInt16LE(p));
      size = 2;
      break;
    case 0x03:
      val = BigInt(buf.readUInt32LE(p));
      size = 4;
      break;
    case 0x04:
      val = buf.readBigUInt64LE(p);
      size = 8;
      break;
    case 0x09:
      val = BigInt(buf.readInt32LE(p));
      size = 4;
      break;
    case 0x0a:
      val = BigInt(buf.readInt16LE(p));
      size = 2;
      break;
    case 0x0b:
      val = BigInt(buf.readInt32LE(p));
      size = 4;
      break;
    case 0x0c:
      val = buf.readBigInt64LE(p);
      size = 8;
      break;
    default:
      return null;
  }
  let abs = val;
  if (rel === 0x10) abs = BigInt(p) + val; // pcrel
  else if (rel === 0x30) abs = BigInt(datarelBase) + val; // datarel
  // 0x00 abs / 0x50 indirect (not dereferenced here)
  return { value: abs, size };
}

function parseEhFrameHdr(elf) {
  const hdr = secByName(elf, '.eh_frame_hdr');
  if (!hdr) return { available: false, reason: 'no .eh_frame_hdr' };
  try {
    const p0 = hdr.offset;
    const version = elf.buf[p0];
    const ehFramePtrEnc = elf.buf[p0 + 1];
    const fdeCountEnc = elf.buf[p0 + 2];
    const tableEnc = elf.buf[p0 + 3];
    let p = p0 + 4;
    const efp = decodeEhEnc(elf.buf, p, ehFramePtrEnc, hdr.addr);
    if (!efp) return { available: false, reason: 'bad eh_frame_ptr encoding' };
    p += efp.size;
    const cnt = decodeEhEnc(elf.buf, p, fdeCountEnc, hdr.addr);
    if (!cnt) return { available: false, reason: 'bad fde_count encoding' };
    p += cnt.size;
    const fdeCount = Number(cnt.value);
    const starts = [];
    for (let i = 0; i < fdeCount; i += 1) {
      const pc = decodeEhEnc(elf.buf, p, tableEnc, hdr.addr);
      if (!pc) break;
      p += pc.size;
      const fp = decodeEhEnc(elf.buf, p, tableEnc, hdr.addr);
      if (!fp) break;
      p += fp.size;
      starts.push(Number(pc.value));
    }
    starts.sort((a, b) => a - b);
    return { available: true, version, fdeCount, starts };
  } catch (e) {
    return { available: false, reason: `parse error: ${e.message}` };
  }
}

/* ---------------------------------------------- IDA reference (.c) oracle */

function parseReferenceC(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const fns = new Map();
  const re = /^\/\* Function: (.*) @ 0x([0-9A-Fa-f]+) \*\/$/;
  let cur = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = re.exec(lines[i]);
    if (m) {
      cur = { name: m[1].trim(), addr: parseInt(m[2], 16), line: i + 1, sig: '', body: [], warnings: [] };
      fns.set(cur.addr, cur);
      continue;
    }
    if (!cur) continue;
    if (cur.sig === '' && lines[i].trim() !== '' && !lines[i].trim().startsWith('//')) cur.sig = lines[i].trim();
    if (/positive sp value has been detected/.test(lines[i])) cur.warnings.push('positive_sp_value');
    if (/The function has no return instruction|is not reachable|unreachable/i.test(lines[i])) cur.warnings.push('reachability_warning');
    cur.body.push(lines[i]);
  }
  for (const f of fns.values()) {
    f.noreturn = /__noreturn|_Noreturn|noreturn/.test(f.sig);
    f.isAutoSub = /^sub_[0-9A-Fa-f]+$/.test(f.name);
    f.isInitProc = /\.init_proc|^init_proc$/.test(f.name);
    f.bodyText = f.body.join('\n');
    f.jumpoutOnly = /JUMPOUT\(/.test(f.bodyText) && f.body.filter((l) => l.trim()).length <= 6;
  }
  return { fns, headerCount: fns.size, text };
}

/* --------------------------------------------------------- relocations */

const R_AARCH64_RELATIVE = 1027;
const R_AARCH64_GLOB_DAT = 1025;
const R_AARCH64_JUMP_SLOT = 1026;

function parseRelaTargets(elf) {
  const relative = new Set();
  const other = [];
  for (const s of elf.sections) {
    if (s.type !== 4 /* SHT_RELA */) continue;
    const count = Math.floor(s.size / (s.entsize || 24));
    for (let i = 0; i < count; i += 1) {
      const o = s.offset + i * (s.entsize || 24);
      const rOffset = Number(elf.buf.readBigUInt64LE(o));
      const rInfo = elf.buf.readBigUInt64LE(o + 8);
      const type = Number(rInfo & 0xffffffffn);
      const addend = Number(elf.buf.readBigInt64LE(o + 16));
      if (type === R_AARCH64_RELATIVE) relative.add(addend);
      else if (type === R_AARCH64_JUMP_SLOT || type === R_AARCH64_GLOB_DAT) {
        other.push({ section: s.name, rOffset, type, addend });
      }
    }
  }
  return { relative, other };
}

/* ------------------------------------------------------------------ classify */

const elfCache = new Map();
function elfFor(sha) {
  if (elfCache.has(sha)) return elfCache.get(sha);
  const p = path.join(BENCH, 'inputs', `${sha}.bin`);
  const elf = parseElf(fs.readFileSync(p));
  const scan = scanCodeTargets(elf);
  const eh = parseEhFrameHdr(elf);
  const plt = secByName(elf, '.plt');
  const init = secByName(elf, '.init');
  const fini = secByName(elf, '.fini');
  const text = secByName(elf, '.text');
  const rela = parseRelaTargets(elf);
  const relocRelativeTargets = rela.relative;
  const funcs = elf.symbols
    .filter((s) => s.type === 2 && s.size > 0 && s.ndx !== 0)
    .map((s) => ({ name: s.name, start: s.value, size: s.size, end: s.value + s.size, bind: s.bindName }))
    .sort((a, b) => a.start - b.start);
  const rec = {
    elf,
    scan,
    eh,
    plt,
    init,
    fini,
    text,
    funcs,
    symbolsAt: new Map(),
    hasFn: [],
    relocRelativeTargets,
    fdeSet: eh.available ? new Set(eh.starts) : null,
  };
  for (const s of elf.symbols) {
    if (!rec.symbolsAt.has(s.value)) rec.symbolsAt.set(s.value, []);
    rec.symbolsAt.get(s.value).push(s);
  }
  rec.hasFn = funcs;
  elfCache.set(sha, rec);
  return rec;
}

const refCache = new Map();
function refFor(caseId) {
  if (refCache.has(caseId)) return refCache.get(caseId);
  const meta = byId.get(caseId);
  const refPath = path.join(BENCH, meta.reference.path);
  const parsed = fs.existsSync(refPath) ? parseReferenceC(refPath) : { fns: new Map(), headerCount: 0, text: '' };
  refCache.set(caseId, parsed);
  return parsed;
}

function enclosingFunc(rec, addr) {
  let best = null;
  for (const f of rec.funcs) {
    if (addr >= f.start && addr < f.end) {
      if (!best || f.size < best.size) best = f;
    }
  }
  return best;
}

function prevWords(rec, addr, n) {
  const out = [];
  for (let k = 1; k <= n; k += 1) {
    const b = bytesAt(rec.elf, addr - 4 * k, 4);
    out.push(b && b.length === 4 ? b.readUInt32LE(0) : null);
  }
  return out;
}

const out = [];
for (const row of IDA_ONLY.idaOnlyFunctions) {
  const addr = parseInt(row.address, 16);
  const rec = elfFor(row.binarySha256);
  const ref = refFor(row.caseId);
  const sec = sectionOfAddr(rec.elf, addr);
  const exact = rec.symbolsAt.get(addr) ?? [];
  const exactFunc = exact.find((s) => s.type === 2);
  const exactSection = exact.find((s) => s.type === 3);
  const exactMapping = exact.find((s) => s.type === 0 && /^\$[xdc]$/.test(s.name));
  const enclosing = enclosingFunc(rec, addr);
  const refFn = ref.fns.get(addr) ?? null;
  const enclosingRefFn = enclosing ? ref.fns.get(enclosing.start) ?? null : null;

  // previous-instruction analysis (function start candidate => look at prior insn)
  const [w1] = prevWords(rec, addr, 1);
  let prevKind = null;
  let prevTarget = null;
  if (w1 !== null) {
    const op = (w1 >>> 26) & 0x3f;
    if (op === 0x25 || op === 0x05) {
      let imm = w1 & 0x03ffffff;
      if (imm & 0x02000000) imm -= 0x04000000;
      prevKind = op === 0x25 ? 'bl' : 'b';
      prevTarget = addr - 4 + imm * 4;
    }
  }
  const prevTargetRefFn = prevTarget !== null ? ref.fns.get(prevTarget) ?? null : null;

  const isPltStart = !!rec.plt && addr === rec.plt.addr;
  const isInitStart = !!rec.init && addr === rec.init.addr;
  const isFiniStart = !!rec.fini && addr === rec.fini.addr;
  const isEntry = addr === rec.elf.eEntry;
  const inText = !!rec.text && addr >= rec.text.addr && addr < rec.text.addr + rec.text.size;
  const inPlt = !!rec.plt && addr >= rec.plt.addr && addr < rec.plt.addr + rec.plt.size;

  // bytes present in an executable section?
  const codeBytes = (() => {
    if (!sec || !(sec.flags & SHF_EXEC)) return null;
    const b = bytesAt(rec.elf, addr, 4);
    return b && b.length === 4 ? b.toString('hex') : null;
  })();

  const fdeStartAtAddr = rec.fdeSet ? rec.fdeSet.has(addr) : null;
  let nearestFdeLE = null;
  if (rec.eh.available) {
    for (let i = rec.eh.starts.length - 1; i >= 0; i -= 1) {
      if (rec.eh.starts[i] <= addr) {
        nearestFdeLE = rec.eh.starts[i];
        break;
      }
    }
  }

  out.push({
    caseId: row.caseId,
    group: row.group,
    compiler: row.compiler,
    optimization: row.optimization,
    debug: row.debug,
    binarySha256: row.binarySha256,
    address: row.address,
    idaName: row.idaName,
    evidence: {
      section: sec ? sec.name : null,
      sectionFlags: sec ? { write: !!(sec.flags & SHF_WRITE), alloc: !!(sec.flags & SHF_ALLOC), exec: !!(sec.flags & SHF_EXEC) } : null,
      sectionStart: sec ? '0x' + sec.addr.toString(16) : null,
      sectionSize: sec ? '0x' + sec.size.toString(16) : null,
      addressEqualsSectionStart: !!sec && addr === sec.addr,
      exactSymbols: exact.map((s) => ({ table: s.table, name: s.name, type: s.typeName, bind: s.bindName, ndx: s.ndx, size: s.size })),
      hasExactFuncSymbol: !!exactFunc,
      hasExactSectionSymbol: !!exactSection,
      mappingSymbolAtAddress: exactMapping ? exactMapping.name : null,
      enclosingFuncSymbol: enclosing ? { name: enclosing.name, start: '0x' + enclosing.start.toString(16), size: enclosing.size, bind: enclosing.bind } : null,
      isEntryPoint: isEntry,
      inText,
      inPlt,
      isPltSectionStart: isPltStart,
      isInitSectionStart: isInitStart,
      isFiniSectionStart: isFiniStart,
      codeBytesAtAddress: codeBytes,
      prevInstructionKind: prevKind,
      prevInstructionTarget: prevTarget === null ? null : '0x' + prevTarget.toString(16),
      prevInstructionTargetIsNoreturnInIdaReference: prevTargetRefFn ? !!prevTargetRefFn.noreturn : null,
      prevInstructionTargetIsRedundantJumpToNoreturn: prevTargetRefFn ? /JUMPOUT|abort|exit|__stack_chk_fail/.test(prevTargetRefFn.bodyText) : null,
      blTargetOfAnyCall: rec.scan.bl.has(addr),
      bTargetOfAnyBranch: rec.scan.b.has(addr),
      branchTargetCount: (rec.scan.bl.has(addr) ? 1 : 0) + (rec.scan.b.has(addr) ? 1 : 0),
      adrpAddReferenced: rec.scan.adrpAdd.has(addr),
      adrReferenced: rec.scan.adr.has(addr),
      addressMaterializedInCode: rec.scan.adrpAdd.has(addr) || rec.scan.adr.has(addr),
      relocationRelativeTarget: rec.relocRelativeTargets.has(addr),
      relocationRelativeTargetCount: [...rec.relocRelativeTargets].filter((v) => v === addr).length,
      relativeRelocationTargetCountTotal: rec.relocRelativeTargets.size,
      ehFrameHdrAvailable: rec.eh.available,
      ehFrameFdeCount: rec.eh.available ? rec.eh.fdeCount : null,
      fdeStartAtAddress: fdeStartAtAddr,
      nearestFdeStartLE: nearestFdeLE === null ? null : '0x' + nearestFdeLE.toString(16),
    },
    idaReference: {
      hasFunctionHeaderAtAddress: !!refFn,
      name: refFn ? refFn.name : null,
      isAutoSubName: refFn ? refFn.isAutoSub : null,
      noreturnAnnotated: refFn ? !!refFn.noreturn : null,
      warnings: refFn ? refFn.warnings : [],
      jumpoutOnlyBody: refFn ? !!refFn.jumpoutOnly : null,
      enclosingFunctionName: enclosingRefFn ? enclosingRefFn.name : null,
      enclosingFunctionNoreturnAnnotated: enclosingRefFn ? !!enclosingRefFn.noreturn : null,
    },
  });
}

/* ------------------------------------------------------------- clustering */

function classify(r) {
  const e = r.evidence;
  // 1. PLT resolver stub: address is exactly the start of .plt and carries only
  //    a section symbol + $x mapping symbol (no real symbol).
  if (e.isPltSectionStart) return 'ida_synthetic_plt_resolver_stub';

  // 2. Address inside a symbol-table function, immediately after a branch to a
  //    function the IDA reference itself annotates __noreturn.
  if (
    e.enclosingFuncSymbol &&
    (e.prevInstructionKind === 'bl' || e.prevInstructionKind === 'b') &&
    e.prevInstructionTargetIsNoreturnInIdaReference === true
  ) {
    return 'ida_noreturn_split_of_enclosing_function';
  }

  // 3. Address taken only through a relocation-driven code-pointer table
  //    (switch/jump table in .data.rel.ro), interior to an ELF FUNC symbol.
  if (
    e.enclosingFuncSymbol &&
    e.relocationRelativeTarget &&
    e.branchTargetCount === 0 &&
    !e.fdeStartAtAddress
  ) {
    return 'ida_address_taken_table_target_split';
  }

  // 4. Interior address with IDA's own "positive sp value" self-doubt warning.
  if (
    e.enclosingFuncSymbol &&
    r.idaReference.warnings.length > 0 &&
    e.branchTargetCount === 0
  ) {
    return 'ida_interior_split_with_ida_self_doubt_warning';
  }

  // 5. Real function start that the ELF symbol table knows.
  if (e.hasExactFuncSymbol) return 'ida_only_real_function_start';

  // 6. No enclosing function and no symbol: unreferenced code region.
  if (!e.enclosingFuncSymbol && !e.hasExactFuncSymbol) return 'ida_only_symbol_free_code_region';

  return 'unknown';
}

for (const r of out) {
  r.cluster = classify(r);
  r.confidence = (() => {
    switch (r.cluster) {
      case 'ida_synthetic_plt_resolver_stub':
        return 'confirmed';
      case 'ida_noreturn_split_of_enclosing_function':
        return r.idaReference.warnings.length > 0 ? 'confirmed' : 'probable';
      case 'ida_address_taken_table_target_split':
        return 'probable';
      case 'ida_interior_split_with_ida_self_doubt_warning':
        return 'probable';
      case 'ida_only_real_function_start':
      case 'ida_only_symbol_free_code_region':
        return 'probable';
      default:
        return 'unknown';
    }
  })();
}

/* ------------------------------------------------------------------ output */

const clusterAgg = {};
for (const r of out) {
  const c = (clusterAgg[r.cluster] ??= {
    cluster: r.cluster,
    count: 0,
    confidence: r.confidence,
    cases: new Set(),
    addresses: new Set(),
    sections: {},
    compilers: {},
    optimizations: {},
    debug: {},
    examples: [],
  });
  c.count += 1;
  c.cases.add(r.caseId);
  c.addresses.add(r.address);
  c.sections[r.evidence.section] = (c.sections[r.evidence.section] ?? 0) + 1;
  c.compilers[r.compiler] = (c.compilers[r.compiler] ?? 0) + 1;
  c.optimizations[r.optimization] = (c.optimizations[r.optimization] ?? 0) + 1;
  c.debug[String(r.debug)] = (c.debug[String(r.debug)] ?? 0) + 1;
  if (c.examples.length < 5) c.examples.push({ caseId: r.caseId, address: r.address, idaName: r.idaName });
}

const clusters = {};
for (const [k, v] of Object.entries(clusterAgg)) {
  clusters[k] = {
    cluster: v.cluster,
    count: v.count,
    confidence: v.confidence,
    affectedCaseCount: v.cases.size,
    affectedCases: [...v.cases].sort(),
    distinctAddressCount: v.addresses.size,
    representativeAddresses: [...v.addresses].sort().slice(0, 12),
    sectionHistogram: v.sections,
    compilerHistogram: v.compilers,
    optimizationHistogram: v.optimizations,
    debugHistogram: v.debug,
    examples: v.examples,
  };
}

const doc = {
  schema: 'hex-function-discovery-investigation/classification/v1',
  generatedAt: new Date().toISOString(),
  baseSha: IDA_ONLY.baseSha,
  checkoutSha: IDA_ONLY.checkoutSha,
  inputs: {
    idaOnlyFunctionsSha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(REPORT_DIR, 'ida-only-functions.json')))
      .digest('hex'),
    manifestSha256: IDA_ONLY.evidence.manifestSha256,
  },
  totals: {
    classified: out.length,
    clusters: Object.keys(clusters).length,
    unknown: out.filter((r) => r.cluster === 'unknown').length,
    confirmed: out.filter((r) => r.confidence === 'confirmed').length,
    probable: out.filter((r) => r.confidence === 'probable').length,
  },
  clusters,
  rows: out,
};

const tmp = path.join(REPORT_DIR, `.classification.json.tmp-${process.pid}`);
fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
JSON.parse(fs.readFileSync(tmp, 'utf8'));
if (doc.rows.length !== IDA_ONLY.idaOnlyFunctions.length) throw new Error('row count mismatch');
fs.renameSync(tmp, path.join(REPORT_DIR, 'classification.json'));

console.log(JSON.stringify({ totals: doc.totals, clusters: Object.fromEntries(Object.entries(clusters).map(([k, v]) => [k, { count: v.count, cases: v.affectedCaseCount, addrs: v.distinctAddressCount, conf: v.confidence, sections: v.sectionHistogram }])) }, null, 2));
