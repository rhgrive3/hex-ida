/*
 * Modern Mach-O binaries can leave undefined nlist names empty and keep the
 * real import names only in LC_DYLD_CHAINED_FIXUPS.  The worker historically
 * relied on LC_DYSYMTAB, which made every __stub anonymous in such binaries.
 *
 * This module is deliberately independent from worker.js so the browser and
 * the Node accuracy harness use the exact same recovery path.
 */

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const LC_SEGMENT_64 = 0x19;
const LC_DYLD_CHAINED_FIXUPS = 0x80000034;
const S_SYMBOL_STUBS = 0x8;
const MAX_LOAD_COMMAND_BYTES = 4 * 1024 * 1024;
const MAX_FIXUP_BYTES = 16 * 1024 * 1024;
const MAX_CHAINED_IMPORTS = 250_000;
const MAX_STUB_BYTES = 8 * 1024 * 1024;
const MAX_STUBS = 80_000;
const MAX_SUPPLEMENTAL_READ_BYTES = 32 * 1024 * 1024;

const PTR_ARM64E = new Set([1, 7, 9, 10]);
const PTR_ARM64E_24 = 12;
const PTR_64 = new Set([2, 6]);

async function bytes(file, start, length) {
  const a = Number(start);
  const end = Math.min(file.size, a + Number(length));
  if (!(a >= 0) || end <= a) return new Uint8Array(0);
  return new Uint8Array(await file.slice(a, end).arrayBuffer());
}

function ascii(u8, off, len) {
  let end = off;
  const max = Math.min(u8.length, off + len);
  while (end < max && u8[end]) end++;
  let out = '';
  for (let i = off; i < end; i++) out += String.fromCharCode(u8[i]);
  return out;
}

function utf8z(u8, off) {
  if (!(off >= 0) || off >= u8.length) return null;
  let end = off;
  while (end < u8.length && u8[end]) end++;
  /* A chained-fixups import name is a NUL-terminated string.  A scan that
     reaches the payload end without a terminator is truncated/malformed
     input, not an implicitly terminated name (#5217): fail closed instead of
     minting a symbol from tail bytes. */
  if (end >= u8.length) return null;
  try { return new TextDecoder().decode(u8.subarray(off, end)); }
  catch {
    let out = '';
    for (let i = off; i < end; i++) out += String.fromCharCode(u8[i]);
    return out;
  }
}

function u32be(dv, off) { return dv.getUint32(off, false); }

function rangeWithin(start, size, parentStart, parentSize) {
  return size >= 0n && start >= parentStart && start - parentStart <= parentSize && size <= parentSize - (start - parentStart);
}

function stubSectionWithinSegment(segment, addr, size, fileoff) {
  return !!segment?.validFileRange
    && rangeWithin(addr, size, segment.vmaddr, segment.vmsize)
    && rangeWithin(fileoff, size, segment.fileoff, segment.filesize);
}

/** Return the bounded active architecture slice. */
async function sliceOffset(file, sliceIndex) {
  if (sliceIndex != null) {
    if (typeof sliceIndex !== 'number' || !Number.isSafeInteger(sliceIndex) || sliceIndex < 0) {
      return null;
    }
  }
  const head = await bytes(file, 0, 8);
  if (head.length < 4) return null;
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (dv.getUint32(0, true) === MH_MAGIC_64) {
    return sliceIndex == null || sliceIndex === 0 ? { base:0n, size:BigInt(file.size) } : null;
  }
  const be = dv.getUint32(0, false);
  if (be !== FAT_MAGIC && be !== FAT_MAGIC_64 || head.length < 8) return null;
  const n = u32be(dv, 4), idx = sliceIndex ?? 0;
  if (idx >= n || n > 64) return null;
  const wide = be === FAT_MAGIC_64, entry = wide ? 32 : 20;
  const table = await bytes(file, 0, 8 + n * entry);
  if (table.length < 8 + n * entry) return null;
  const tdv = new DataView(table.buffer, table.byteOffset, table.byteLength), p = 8 + idx * entry;
  const base = wide ? tdv.getBigUint64(p + 8, false) : BigInt(tdv.getUint32(p + 8, false));
  const size = wide ? tdv.getBigUint64(p + 16, false) : BigInt(tdv.getUint32(p + 12, false));
  const total = BigInt(file.size);
  if (size <= 0n || base > total || size > total - base) return null;
  return { base, size };
}

async function parseImage(file, sliceIndex) {
  const slice = await sliceOffset(file, sliceIndex);
  if (slice == null) return null;
  const { base, size: sliceSize } = slice;
  const h = await bytes(file, base, 32);
  if (h.length < 32) return null;
  let dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
  if (dv.getUint32(0, true) !== MH_MAGIC_64) return null;
  const ncmds = dv.getUint32(16, true);
  const sizeofcmds = dv.getUint32(20, true);
  if (!ncmds || ncmds > 10000 || sizeofcmds > MAX_LOAD_COMMAND_BYTES || BigInt(32 + sizeofcmds) > sliceSize) return null;

  const raw = await bytes(file, base, 32 + sizeofcmds);
  if (raw.length < 32) return null;
  dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const segments = [];
  const stubs = [];
  let fixups = null;
  let p = 32;
  const end = Math.min(raw.length, 32 + sizeofcmds);

  for (let ci = 0; ci < ncmds && p + 8 <= end; ci++) {
    const cmd = dv.getUint32(p, true);
    const size = dv.getUint32(p + 4, true);
    if (size < 8 || p + size > end) break;
    if (cmd === LC_SEGMENT_64 && size >= 72) {
      const name = ascii(raw, p + 8, 16);
      const vmaddr = dv.getBigUint64(p + 24, true);
      const vmsize = dv.getBigUint64(p + 32, true);
      const fileoff = dv.getBigUint64(p + 40, true);
      const filesize = dv.getBigUint64(p + 48, true);
      const nsects = dv.getUint32(p + 64, true);
      const segIndex = segments.length;
      const validFileRange = fileoff <= sliceSize && filesize <= sliceSize - fileoff;
      segments.push({ name, vmaddr, vmsize, fileoff, filesize, validFileRange });
      let q = p + 72;
      for (let si = 0; si < nsects && q + 80 <= p + size; si++, q += 80) {
        const section = ascii(raw, q, 16);
        const addr = dv.getBigUint64(q + 32, true);
        const secSize = dv.getBigUint64(q + 40, true);
        const offset = BigInt(dv.getUint32(q + 48, true));
        const flags = dv.getUint32(q + 64, true);
        const reserved2 = dv.getUint32(q + 72, true);
        const stubSize = BigInt(reserved2);
        const segment = segments[segIndex];
        if ((flags & 0xff) === S_SYMBOL_STUBS && secSize > 0n &&
            reserved2 >= 8 && reserved2 % 4 === 0 &&
            stubSize <= secSize && secSize % stubSize === 0n &&
            stubSectionWithinSegment(segment, addr, secSize, offset)) {
          stubs.push({ section, addr, size: secSize, fileoff: offset, stubSize: reserved2, segIndex });
        }
      }
    } else if (cmd === LC_DYLD_CHAINED_FIXUPS && size >= 16) {
      fixups = { dataoff: BigInt(dv.getUint32(p + 8, true)), datasize: dv.getUint32(p + 12, true) };
    }
    p += size;
  }
  return { base, sliceSize, segments, stubs, fixups };
}

function parseImportNames(raw) {
  if (raw.length < 28) return null;
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const version = dv.getUint32(0, true);
  const startsOffset = dv.getUint32(4, true);
  const importsOffset = dv.getUint32(8, true);
  const symbolsOffset = dv.getUint32(12, true);
  const count = dv.getUint32(16, true);
  const format = dv.getUint32(20, true);
  const symbolsFormat = dv.getUint32(24, true);
  if (version !== 0 || symbolsFormat !== 0 || count > MAX_CHAINED_IMPORTS || startsOffset >= raw.length ||
      importsOffset >= raw.length || symbolsOffset >= raw.length) return null;

  const stride = format === 1 ? 4 : format === 2 ? 8 : format === 3 ? 16 : 0;
  if (!stride || importsOffset + count * stride > raw.length) return null;
  const names = new Array(count);
  for (let i = 0; i < count; i++) {
    const p = importsOffset + i * stride;
    let nameOffset;
    if (format === 1 || format === 2) {
      const word = dv.getUint32(p, true);
      nameOffset = word >>> 9;
    } else {
      const word = dv.getBigUint64(p, true);
      nameOffset = Number((word >> 32n) & 0xffffffffn);
    }
    names[i] = utf8z(raw, symbolsOffset + nameOffset);
  }

  /* starts_in_image uses the Mach-O segment order.  Keep the pointer format
     plus the full dyld_chained_starts_in_segment structure here: a GOT slot
     only carries a chained fixup if it is reachable through page_start[]/next
     chain walks (#5388) — the pointer format alone proves nothing. */
  const formats = new Map();
  const starts = new Map();
  if (startsOffset + 4 <= raw.length) {
    const segCount = dv.getUint32(startsOffset, true);
    if (segCount <= 4096 && startsOffset + 4 + segCount * 4 <= raw.length) {
      for (let i = 0; i < segCount; i++) {
        const rel = dv.getUint32(startsOffset + 4 + i * 4, true);
        if (!rel) continue;
        const s = startsOffset + rel;
        if (s + 22 > raw.length) continue;
        const structSize = dv.getUint32(s, true);
        const pageSize = dv.getUint16(s + 4, true);
        const pointerFormat = dv.getUint16(s + 6, true);
        const pageCount = dv.getUint16(s + 20, true);
        if (structSize < 22 || s + structSize > raw.length) continue;
        if (22 + pageCount * 2 > structSize) continue;
        if (pageSize !== 0x1000 && pageSize !== 0x4000) continue;
        const trailing = structSize - 22 - pageCount * 2;
        if (trailing % 2 !== 0) continue; // multi-start pool must be uint16-aligned
        /* dyld resolves a DYLD_CHAINED_PTR_START_MULTI entry against the
           combined page_start[] array (MachOLayout.cpp indexes
           segInfo->page_start[overflowIndex]), so keep the trailing entries
           and the page_start[] entries in one array (#5388 review). */
        const pool = new Array(pageCount + trailing / 2);
        for (let pg = 0; pg < pageCount; pg++) pool[pg] = dv.getUint16(s + 22 + pg * 2, true);
        for (let oi = 0; oi < trailing / 2; oi++) pool[pageCount + oi] = dv.getUint16(s + 22 + pageCount * 2 + oi * 2, true);
        formats.set(i, pointerFormat);
        starts.set(i, { pointerFormat, pageSize, pageCount, pool });
      }
    }
  }
  return { names, formats, starts };
}

/* `next` field position/stride per pointer format, mirroring dyld's
   fixup-chains pointer layouts (cf. macho-dyld.js decodeChainedPointer). */
function chainNext(raw, format) {
  if (format === 2 || format === 6) return { next: Number((raw >> 51n) & 0xfffn), stride: 4 };
  if (format === 1 || format === 7 || format === 9 || format === 10 || format === 12) {
    return { next: Number((raw >> 51n) & 0x7ffn), stride: format === 7 || format === 10 ? 4 : 8 };
  }
  return null;
}

function sign21(v) { return (v & 0x100000) ? v - 0x200000 : v; }

function stubInterveningPreservesBase(w, baseReg) {
  if (w === 0xd503201f) return true; // NOP.
  if (((w & 0xffe0ffe0) >>> 0) === 0xaa0003e0) {
    return (w & 31) !== baseReg; // MOV Xd, Xm (ORR alias).
  }
  return false;
}

/** Decode the GOT slot loaded by a conventional arm64 Mach-O stub. */
function stubSlot(code, off, pc, stubSize) {
  const dv = new DataView(code.buffer, code.byteOffset, code.byteLength);
  const words = Math.min(Math.floor(stubSize / 4), 5);
  let page = null;
  let baseReg = -1;
  for (let i = 0; i < words && off + i * 4 + 4 <= code.length; i++) {
    const w = dv.getUint32(off + i * 4, true);
    const at = pc + BigInt(i * 4);
    if (((w & 0x9f000000) >>> 0) === 0x90000000) {
      const imm = sign21((((w >>> 5) & 0x7ffff) << 2) | ((w >>> 29) & 3));
      page = (at & ~0xfffn) + BigInt(imm) * 0x1000n;
      baseReg = w & 31;
      continue;
    }
    if (page != null && ((w & 0xffc00000) >>> 0) === 0xf9400000) {
      const rn = (w >>> 5) & 31;
      if (rn === baseReg) {
        const imm12 = (w >>> 10) & 0xfff;
        return page + BigInt(imm12 * 8);
      }
      if ((w & 31) === baseReg) {
        page = null;
        baseReg = -1;
      }
      continue;
    }
    if (page != null && !stubInterveningPreservesBase(w, baseReg)) {
      page = null;
      baseReg = -1;
    }
  }
  return null;
}

function bindOrdinal(raw, pointerFormat) {
  if (PTR_64.has(pointerFormat)) {
    if (((raw >> 63n) & 1n) === 0n) return null;
    return Number(raw & 0xffffffn);
  }
  if (PTR_ARM64E.has(pointerFormat)) {
    if (((raw >> 62n) & 1n) === 0n) return null;
    return Number(raw & 0xffffn);
  }
  if (pointerFormat === PTR_ARM64E_24) {
    if (((raw >> 62n) & 1n) === 0n) return null;
    return Number(raw & 0xffffffn);
  }
  return null;
}

/** Decode `dyld_chained_starts_in_segment` fields for the owning segment. */
function segmentStarts(starts, segIndex, slot, seg) {
  const st = starts.get(segIndex);
  if (!st) return null;
  const delta = slot - seg.vmaddr;
  const page = Number(delta / BigInt(st.pageSize));
  if (page < 0 || page >= st.pageCount) return null;
  const start = st.pool[page];
  if (start === 0xffff) return null; // dyld: DYLD_CHAINED_PTR_START_NONE — the page holds no fixups
  const chainStarts = [];
  if (start & 0x8000) {
    let oi = start & 0x7fff;
    /* The trailing chain_starts[] area begins at combined pool index
       pageCount; a MULTI index that points back into the page_start[] domain
       self-references the page's own marker and proves nothing (#5388
       review). */
    if (oi < st.pageCount || oi >= st.pool.length) return null;
    let terminated = false;
    for (let guard = 0; guard < 4096 && oi < st.pool.length; guard++, oi++) {
      const x = st.pool[oi];
      chainStarts.push(x & 0x7fff);
      if (x & 0x8000) { terminated = true; break; }
    }
    if (!terminated) return null; // malformed multi-start list fails closed
  } else {
    chainStarts.push(start);
  }
  return { st, page, chainStarts };
}

function segmentFor(segments, addr) {
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (addr >= s.vmaddr && addr < s.vmaddr + s.vmsize) return { s, i };
  }
  return null;
}

function makeBlockReader(file) {
  const BLOCK = 64 * 1024;
  const cache = new Map();
  return async (off) => {
    const n = Number(off);
    if (!(n >= 0) || n + 8 > file.size) return null;
    const bi = Math.floor(n / BLOCK);
    let b = cache.get(bi);
    if (!b) {
      b = await bytes(file, bi * BLOCK, BLOCK);
      cache.set(bi, b);
      while (cache.size > 8) cache.delete(cache.keys().next().value);
    }
    const p = n - bi * BLOCK;
    if (p + 8 > b.length) {
      const exact = await bytes(file, n, 8);
      if (exact.length < 8) return null;
      return new DataView(exact.buffer, exact.byteOffset, 8).getBigUint64(0, true);
    }
    return new DataView(b.buffer, b.byteOffset + p, 8).getBigUint64(0, true);
  };
}

/**
 * Walk one fixup chain and collect its member slot VM addresses.  The whole
 * chain is validated before any membership claim: returns the member set on a
 * cleanly terminated chain, or null when the chain is malformed (out-of-page
 * next, non-positive step, unreadable or non-file-backed fixup, iteration
 * guard) — a malformed chain proves membership for nothing (#5388).
 */
async function chainMembers(st, page, chainStart, seg, read64, base) {
  const pageSize = BigInt(st.pageSize);
  const pageStart = seg.vmaddr + BigInt(page) * pageSize;
  const pageVmEnd = pageStart + pageSize < seg.vmaddr + BigInt(seg.vmsize)
    ? pageStart + pageSize
    : seg.vmaddr + BigInt(seg.vmsize);
  if (chainStart < 0 || BigInt(chainStart) + 8n > pageVmEnd - pageStart) return null;
  let address = pageStart + BigInt(chainStart);
  const members = new Set();
  for (let guard = 0; guard < 100000; guard++) {
    const fileOff = base + seg.fileoff + (address - seg.vmaddr);
    if (fileOff + 8n > base + seg.fileoff + seg.filesize) return null;
    const ptr = await read64(fileOff);
    if (ptr == null) return null;
    members.add(address);
    const d = chainNext(ptr, st.pointerFormat);
    if (d == null) return null;
    if (d.next === 0) return members;
    const step = BigInt(d.next) * BigInt(d.stride);
    if (step <= 0n) return null;
    const next = address + step;
    if (next + 8n > pageVmEnd) return null; // chain leaves its page
    address = next;
  }
  return null;
}

/**
 * Recover external symbol names for __stubs from LC_DYLD_CHAINED_FIXUPS.
 * Returns entries in the same shape worker.js uses: {addr,name,kind}.
 */
export async function chainedImportSymbols(file, sliceIndex = 0) {
  if (!file || typeof file.slice !== 'function') return [];
  const image = await parseImage(file, sliceIndex);
  if (!image || !image.fixups || !image.stubs.length) return [];
  if (image.fixups.datasize > MAX_FIXUP_BYTES) return [];
  const fixupSize = BigInt(image.fixups.datasize);
  if (image.fixups.dataoff > image.sliceSize || fixupSize > image.sliceSize - image.fixups.dataoff) return [];
  const raw = await bytes(file, image.base + image.fixups.dataoff, image.fixups.datasize);
  const imports = parseImportNames(raw);
  if (!imports || !imports.names.length) return [];

  const read64 = makeBlockReader(file);
  /* Page-scoped membership memo: many stubs converge on the same GOT page,
     so cache per (segment, page, chainStart) — a validated member Set (chain
     walked clean) or null (malformed chain). Malformed stays scoped to its
     own chainStart, never collapsed into a page-wide invalid flag (#5388
     review). */
  const chainMembersCache = new Map();
  const out = [];
  let supplementalReadBytes = raw.length;
  let decodedStubs = 0;
  for (const sec of image.stubs) {
    if (sec.size > BigInt(MAX_STUB_BYTES) || sec.fileoff > image.sliceSize || sec.size > image.sliceSize - sec.fileoff) continue;
    const sectionBytes = Number(sec.size);
    if (supplementalReadBytes + sectionBytes > MAX_SUPPLEMENTAL_READ_BYTES) break;
    const code = await bytes(file, image.base + sec.fileoff, sectionBytes);
    supplementalReadBytes += code.length;
    const count = Math.min(Math.floor(Number(sec.size) / sec.stubSize), MAX_STUBS - decodedStubs);
    for (let i = 0; i < count; i++) {
      decodedStubs++;
      const stubAddr = sec.addr + BigInt(i * sec.stubSize);
      const slot = stubSlot(code, i * sec.stubSize, stubAddr, sec.stubSize);
      if (slot == null) continue;
      const hit = segmentFor(image.segments, slot);
      if (!hit || hit.s.validFileRange === false) continue;
      const delta = slot - hit.s.vmaddr;
      if (delta < 0n || delta + 8n > hit.s.filesize) continue;
      const format = imports.formats.get(hit.i);
      if (format == null) continue;
      /* A GOT slot carries a chained fixup only when the segment's starts
         structure declares fixups on its page AND the slot lies on one of
         that page's chains (#5388).  START_NONE pages, off-chain slots and
         malformed chains must never launder raw bytes into an import name. */
      const segStarts = segmentStarts(imports.starts, hit.i, slot, hit.s);
      if (segStarts == null) continue;
      let member = false;
      for (const chainStart of segStarts.chainStarts) {
        const cacheKey = `${hit.i}:${segStarts.page}:${chainStart}`;
        let members = chainMembersCache.get(cacheKey);
        if (members === undefined) {
          members = await chainMembers(segStarts.st, segStarts.page, chainStart, hit.s, read64, image.base);
          chainMembersCache.set(cacheKey, members);
        }
        /* A malformed chain proves no membership for its own start only; a
           later independent multi-start chain may still cover the slot. */
        if (members !== null && members.has(slot)) { member = true; break; }
      }
      if (!member) continue;
      const fileOff = image.base + hit.s.fileoff + (slot - hit.s.vmaddr);
      const ptr = await read64(fileOff);
      if (ptr == null) continue;
      const ordinal = bindOrdinal(ptr, format);
      if (ordinal == null || ordinal < 0 || ordinal >= imports.names.length) continue;
      const name = imports.names[ordinal];
      if (!name) continue;
      out.push({ addr: stubAddr, name, kind: 1 });
      /* The GOT name is useful for indirect-call explanations too. */
      out.push({ addr: slot, name, kind: 2 });
    }
  }
  return out;
}

/** Merge recovered names without replacing names that the normal symbol path got right. */
export async function augmentAnalysisResultWithChainedImports(file, sliceIndex, result) {
  if (!result || !result.addrs) return result;
  let extra;
  try { extra = await chainedImportSymbols(file, sliceIndex); }
  catch { return result; }
  if (!extra.length) return result;

  const oldNames = Array.isArray(result.names)
    ? result.names.map((name) => String(name ?? ''))
    : (typeof result.names === 'string' && result.names.length ? result.names.split('\n') : []);
  const entries = [];
  const occupied = new Set();
  const existing = new Map();
  for (let i = 0; i < result.addrs.length; i++) {
    const addr = result.addrs[i];
    const name = oldNames[i] || '';
    entries.push({ addr, name, kind: result.kinds ? result.kinds[i] : 0,
      flag: result.flags ? result.flags[i] : 0 });
    existing.set(addr.toString(), entries.length - 1);
    if (name) occupied.add(addr.toString());
  }
  for (const e of extra) {
    const key = e.addr.toString();
    if (occupied.has(key)) continue;
    const at = existing.get(key);
    if (at != null && !entries[at].name) {
      entries[at].name = e.name;
      if (!entries[at].kind) entries[at].kind = e.kind;
      occupied.add(key);
      continue;
    }
    occupied.add(key);
    existing.set(key, entries.length);
    entries.push({ addr: e.addr, name: e.name, kind: e.kind, flag: 0 });
  }
  entries.sort((a, b) => a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : a.kind - b.kind);

  const addrs = new BigUint64Array(entries.length);
  const kinds = new Uint8Array(entries.length);
  const flags = new Uint8Array(entries.length);
  const names = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    addrs[i] = entries[i].addr;
    kinds[i] = entries[i].kind;
    flags[i] = entries[i].flag || 0;
    names[i] = entries[i].name;
  }
  return Object.assign({}, result, { addrs, kinds, flags, names });
}

export const __chainedInternalsForTests = Object.freeze({ rangeWithin, stubSectionWithinSegment });
