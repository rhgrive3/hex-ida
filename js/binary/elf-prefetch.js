import { ByteView } from './reader.js';

const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;
const SHT_DYNAMIC = 6;
const SHT_NOTE = 7;
const SHT_REL = 9;
const SHT_DYNSYM = 11;
const SHT_GNU_HASH = 0x6ffffff6;
const SHT_GNU_verdef = 0x6ffffffd;
const SHT_GNU_verneed = 0x6ffffffe;
const SHT_GNU_versym = 0x6fffffff;

const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const PT_NOTE = 4;
const PT_GNU_EH_FRAME = 0x6474e550;

const DT_NULL = 0n;
const DT_PLTRELSZ = 2n;
const DT_HASH = 4n;
const DT_STRTAB = 5n;
const DT_SYMTAB = 6n;
const DT_RELA = 7n;
const DT_RELASZ = 8n;
const DT_STRSZ = 10n;
const DT_REL = 17n;
const DT_RELSZ = 18n;
const DT_JMPREL = 23n;
const DT_RELRSZ = 35n;
const DT_RELR = 36n;
const DT_VERSYM = 0x6ffffff0n;
const DT_GNU_HASH = 0x6ffffef5n;
const DT_VERDEF = 0x6ffffffcn;
const DT_VERNEED = 0x6ffffffen;

function toSafeNumber(val) {
  if (val == null) return null;
  const n = Number(val);
  return Number.isSafeInteger(n) ? n : null;
}

function vaToOffset(segments, va, size = 1) {
  if (va == null) return null;
  const addr = BigInt(va);
  const len = BigInt(size);
  for (const seg of segments) {
    if (seg.type !== PT_LOAD) continue;
    const start = seg.vaddr;
    const fileSize = seg.filesz;
    if (fileSize <= 0n || addr < start || addr + len > start + fileSize) continue;
    const delta = addr - start;
    const fileStart = seg.offset + delta;
    if (fileStart > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(fileStart);
  }
  return null;
}

async function readBoundedRange(source, offset, length, signal, maxChunk = null) {
  let limit = Number(source.maxReadLength);
  if (maxChunk != null && Number.isSafeInteger(maxChunk) && maxChunk > 0) {
    limit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, maxChunk) : maxChunk;
  }
  if (!Number.isSafeInteger(limit) || limit <= 0 || length <= limit) {
    return source.readExactly(offset, length, { signal });
  }
  const chunks = [];
  let done = 0;
  while (done < length) {
    const take = Math.min(limit, length - done);
    chunks.push(await source.readExactly(offset + BigInt(done), take, { signal }));
    done += take;
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}

export async function prefetchELFRanges(source, prefix, options = {}) {
  const signal = options.signal;
  const maxCachedBytes = options.maxCachedBytes ?? 64 * 1024 * 1024;
  const configuredPage = options.maxPageSize ?? options.pageSize;
  let maxReadLimit = Number(source.maxReadLength ?? 16 * 1024 * 1024);
  if (configuredPage != null && Number.isSafeInteger(configuredPage) && configuredPage > 0) {
    maxReadLimit = Math.min(maxReadLimit, configuredPage);
  }
  const readChunk = (off, len) => readBoundedRange(source, off, len, signal, maxReadLimit);

  if (source.size < 16n) return [];
  const headerPrefix = prefix.byteLength >= 64 ? prefix : await readChunk(0n, Math.min(64, Number(source.size)));
  if (headerPrefix.byteLength < 16 || headerPrefix[0] !== 0x7f || headerPrefix[1] !== 0x45 || headerPrefix[2] !== 0x4c || headerPrefix[3] !== 0x46) {
    return [];
  }
  const cls = headerPrefix[4];
  const data = headerPrefix[5];
  if ((cls !== 1 && cls !== 2) || (data !== 1 && data !== 2)) return [];
  const bits = cls === 2 ? 64 : 32;
  const littleEndian = data === 1;
  const minHeader = bits === 64 ? 64 : 52;
  if (source.size < BigInt(minHeader)) return [];
  const fullHeaderBytes = headerPrefix.byteLength >= minHeader ? headerPrefix.subarray(0, minHeader) : await readChunk(0n, minHeader);
  const hr = new ByteView(fullHeaderBytes, { littleEndian });

  let phoff, phentsize, phnum, shoff, shentsize, shnum, shstrndx;
  if (bits === 64) {
    phoff = hr.u64(32);
    shoff = hr.u64(40);
    phentsize = hr.u16(54);
    phnum = hr.u16(56);
    shentsize = hr.u16(58);
    shnum = hr.u16(60);
    shstrndx = hr.u16(62);
  } else {
    phoff = BigInt(hr.u32(28));
    shoff = BigInt(hr.u32(32));
    phentsize = hr.u16(42);
    phnum = hr.u16(44);
    shentsize = hr.u16(46);
    shnum = hr.u16(48);
    shstrndx = hr.u16(50);
  }

  const minProgram = bits === 64 ? 56 : 32;
  const minSection = bits === 64 ? 64 : 40;

  // Read Section 0 if PN_XNUM or extended section count
  let extendedSection0 = null;
  if (shoff !== 0n && shoff + BigInt(minSection) <= source.size && (phnum === 0xffff || shnum === 0 || shstrndx === 0xffff)) {
    const sec0Bytes = await readChunk(shoff, minSection);
    const r0 = new ByteView(sec0Bytes, { littleEndian });
    if (bits === 64) {
      extendedSection0 = {
        size: r0.u64(32),
        link: r0.u32(40),
        info: r0.u32(44),
      };
    } else {
      extendedSection0 = {
        size: BigInt(r0.u32(20)),
        link: r0.u32(24),
        info: r0.u32(28),
      };
    }
  }

  if (phnum === 0xffff && extendedSection0) {
    phnum = extendedSection0.info;
  }
  if (shnum === 0 && extendedSection0) {
    const s = Number(extendedSection0.size);
    if (Number.isSafeInteger(s) && s > 0 && s <= 100000) shnum = s;
  }
  if (shstrndx === 0xffff && extendedSection0) {
    shstrndx = extendedSection0.link;
  }

  const segments = [];
  let programHeaderBytes = null;
  const phTableSize = phnum * phentsize;
  if (phoff !== 0n && phentsize >= minProgram && phnum > 0 && phnum <= 100000 && phoff + BigInt(phTableSize) <= source.size) {
    programHeaderBytes = await readChunk(phoff, phTableSize);
    const pr = new ByteView(programHeaderBytes, { littleEndian });
    for (let i = 0; i < phnum; i++) {
      const p = i * phentsize;
      let ph;
      if (bits === 64) {
        ph = {
          type: pr.u32(p),
          flags: pr.u32(p + 4),
          offset: pr.u64(p + 8),
          vaddr: pr.u64(p + 16),
          filesz: pr.u64(p + 32),
          memsz: pr.u64(p + 40),
        };
      } else {
        ph = {
          type: pr.u32(p),
          offset: BigInt(pr.u32(p + 4)),
          vaddr: BigInt(pr.u32(p + 8)),
          filesz: BigInt(pr.u32(p + 16)),
          memsz: BigInt(pr.u32(p + 20)),
          flags: pr.u32(p + 24),
        };
      }
      segments.push(ph);
    }
  }

  const sections = [];
  let sectionHeaderBytes = null;
  const shTableSize = shnum * shentsize;
  if (shoff !== 0n && shentsize >= minSection && shnum > 0 && shnum <= 100000 && shoff + BigInt(shTableSize) <= source.size) {
    sectionHeaderBytes = await readChunk(shoff, shTableSize);
    const sr = new ByteView(sectionHeaderBytes, { littleEndian });
    for (let i = 0; i < shnum; i++) {
      const p = i * shentsize;
      let sec;
      if (bits === 64) {
        sec = {
          index: i,
          nameOffset: sr.u32(p),
          type: sr.u32(p + 4),
          flags: sr.u64(p + 8),
          addr: sr.u64(p + 16),
          offset: sr.u64(p + 24),
          size: sr.u64(p + 32),
          link: sr.u32(p + 40),
          info: sr.u32(p + 44),
          entsize: sr.u64(p + 56),
          name: '',
        };
      } else {
        sec = {
          index: i,
          nameOffset: sr.u32(p),
          type: sr.u32(p + 4),
          flags: BigInt(sr.u32(p + 8)),
          addr: BigInt(sr.u32(p + 12)),
          offset: BigInt(sr.u32(p + 16)),
          size: BigInt(sr.u32(p + 20)),
          link: sr.u32(p + 24),
          info: sr.u32(p + 28),
          entsize: BigInt(sr.u32(p + 36)),
          name: '',
        };
      }
      sections.push(sec);
    }
  }

  // Read .shstrtab
  let shstrtabBytes = null;
  let shstrSec = null;
  if (shstrndx > 0 && shstrndx < sections.length) {
    const s = sections[shstrndx];
    if (s.type === SHT_STRTAB && s.offset + s.size <= source.size) {
      shstrSec = s;
      const sizeNum = toSafeNumber(s.size);
      if (sizeNum != null && sizeNum > 0 && sizeNum <= 10 * 1024 * 1024) {
        shstrtabBytes = await readChunk(s.offset, sizeNum);
        const strBytes = shstrtabBytes;
        for (const sec of sections) {
          const off = sec.nameOffset;
          if (off < strBytes.length) {
            let end = off;
            while (end < strBytes.length && strBytes[end] !== 0) end++;
            let name = '';
            for (let k = off; k < end; k++) name += String.fromCharCode(strBytes[k]);
            sec.name = name;
          }
        }
      }
    }
  }

  // Parse PT_DYNAMIC if present
  let dynamicSegment = segments.find((s) => s.type === PT_DYNAMIC && s.filesz > 0n);
  let dynamicBytes = null;
  const tags = new Map();
  if (dynamicSegment && dynamicSegment.offset + dynamicSegment.filesz <= source.size) {
    const dynSize = toSafeNumber(dynamicSegment.filesz);
    if (dynSize != null && dynSize > 0 && dynSize <= 10 * 1024 * 1024) {
      dynamicBytes = await readChunk(dynamicSegment.offset, dynSize);
      const dr = new ByteView(dynamicBytes, { littleEndian });
      const entSize = bits === 64 ? 16 : 8;
      for (let p = 0; p + entSize <= dynSize; p += entSize) {
        const tag = bits === 64 ? dr.i64(p) : BigInt(dr.i32(p));
        const val = bits === 64 ? dr.u64(p + 8) : BigInt(dr.u32(p + 4));
        if (tag === DT_NULL) break;
        if (!tags.has(tag)) tags.set(tag, []);
        tags.get(tag).push(val);
      }
    }
  }

  const one = (tag) => tags.get(tag)?.[0] ?? null;

  // Collect candidate file ranges with priority
  // Priority order:
  // 1. ELF header, program headers, section headers, .shstrtab, PT_DYNAMIC
  // 2. Sections of types SHT_DYNSYM, SHT_DYNAMIC, SHT_STRTAB (linked), SHT_SYMTAB,
  //    SHT_RELA/SHT_REL, SHT_GNU_versym/verneed/verdef, SHT_GNU_HASH/HASH, SHT_NOTE,
  //    .eh_frame_hdr, .gnu_debuglink, .comment
  // 3. Dynamic tag ranges: DT_SYMTAB, DT_STRTAB+DT_STRSZ, DT_RELA+DT_RELASZ,
  //    DT_REL+DT_RELSZ, DT_JMPREL+DT_PLTRELSZ, DT_VERSYM/DT_VERNEED/DT_VERDEF,
  //    DT_GNU_HASH/DT_HASH, DT_RELR
  const candidateRanges = [];

  function addRange(offset, size, priority, desc) {
    const off = toSafeNumber(offset);
    const sz = toSafeNumber(size);
    if (off == null || sz == null || off < 0 || sz <= 0) return;
    if (BigInt(off) + BigInt(sz) > source.size) return;
    candidateRanges.push({ offset: BigInt(off), size: sz, priority, desc });
  }

  // Priority 1: Headers & tables
  addRange(0n, minHeader, 1, 'ELF-header');
  if (phoff !== 0n && phTableSize > 0) addRange(phoff, phTableSize, 1, 'program-headers');
  if (shoff !== 0n && shTableSize > 0) addRange(shoff, shTableSize, 1, 'section-headers');
  if (shstrSec) addRange(shstrSec.offset, shstrSec.size, 1, '.shstrtab');
  if (dynamicSegment) addRange(dynamicSegment.offset, dynamicSegment.filesz, 1, 'PT_DYNAMIC');

  // Priority 2: Section headers
  const candidateSecTypes = new Set([
    SHT_DYNSYM,
    SHT_DYNAMIC,
    SHT_SYMTAB,
    SHT_RELA,
    SHT_REL,
    SHT_GNU_HASH,
    SHT_GNU_verdef,
    SHT_GNU_verneed,
    SHT_GNU_versym,
    SHT_NOTE,
  ]);

  for (const s of sections) {
    let matched = candidateSecTypes.has(s.type);
    if (s.type === SHT_STRTAB) {
      // Linked from dynsym or symtab?
      const isLinked = sections.some((other) => (other.type === SHT_DYNSYM || other.type === SHT_SYMTAB || other.type === SHT_DYNAMIC) && other.link === s.index);
      if (isLinked) matched = true;
    }
    if (s.name === '.eh_frame_hdr' || s.name === '.gnu_debuglink' || s.name === '.comment') {
      matched = true;
    }
    if (matched) {
      addRange(s.offset, s.size, 2, `section-${s.name || s.index}`);
    }
  }

  // Priority 2/3: Dynamic tags
  // DT_GNU_HASH / DT_HASH
  const hashVa = one(DT_GNU_HASH) ?? one(DT_HASH);
  if (hashVa != null) {
    const hashOff = vaToOffset(segments, hashVa);
    if (hashOff != null) {
      if (one(DT_GNU_HASH) != null) {
        // Read header to get size or derive from chains
        const gnuHashSec = sections.find((s) => s.type === SHT_GNU_HASH);
        if (gnuHashSec) {
          addRange(gnuHashSec.offset, gnuHashSec.size, 2, 'DT_GNU_HASH-sec');
        } else {
          // Probe gnu_hash header
          try {
            const probe = await readChunk(BigInt(hashOff), 16);
            const pr = new ByteView(probe, { littleEndian });
            const nbuckets = pr.u32(0), symOffset = pr.u32(4), bloomSize = pr.u32(8);
            const word = bits === 64 ? 8 : 4;
            const headerAndBuckets = 16 + bloomSize * word + nbuckets * 4;
            addRange(hashOff, headerAndBuckets + 64 * 1024, 2, 'DT_GNU_HASH');
          } catch {
            // ignore
          }
        }
      } else {
        const hashSec = sections.find((s) => s.name === '.hash');
        if (hashSec) {
          addRange(hashSec.offset, hashSec.size, 2, 'DT_HASH-sec');
        } else {
          try {
            const probe = await readChunk(BigInt(hashOff), 8);
            const pr = new ByteView(probe, { littleEndian });
            const nbucket = pr.u32(0), nchain = pr.u32(4);
            const sz = 8 + (nbucket + nchain) * 4;
            addRange(hashOff, sz, 2, 'DT_HASH');
          } catch {
            // ignore
          }
        }
      }
    }
  }

  // DT_SYMTAB
  const symtabVa = one(DT_SYMTAB);
  if (symtabVa != null) {
    const symtabOff = vaToOffset(segments, symtabVa);
    if (symtabOff != null) {
      const dynsymSec = sections.find((s) => s.type === SHT_DYNSYM);
      if (dynsymSec) {
        addRange(dynsymSec.offset, dynsymSec.size, 2, 'DT_SYMTAB-sec');
      } else {
        // Try derive count from gnu_hash / hash
        let count = null;
        if (one(DT_GNU_HASH) != null) {
          const gnuHashOff = vaToOffset(segments, one(DT_GNU_HASH));
          if (gnuHashOff != null) {
            try {
              const probe = await readChunk(BigInt(gnuHashOff), 16);
              const pr = new ByteView(probe, { littleEndian });
              const nbuckets = pr.u32(0), symOffset = pr.u32(4), bloomSize = pr.u32(8);
              const word = bits === 64 ? 8 : 4;
              const bucketsOff = gnuHashOff + 16 + bloomSize * word;
              const chainsOff = bucketsOff + nbuckets * 4;
              // read buckets
              const bucketsBytes = await readChunk(BigInt(bucketsOff), nbuckets * 4);
              const br = new ByteView(bucketsBytes, { littleEndian });
              let max = null;
              for (let i = 0; i < nbuckets; i++) {
                const b = br.u32(i * 4);
                if (b > 0 && (max == null || b > max)) max = b;
              }
              if (max != null) {
                // read chain starting at max
                let idx = max;
                let cp = chainsOff + (idx - symOffset) * 4;
                while (cp + 4 <= Number(source.size)) {
                  const chainBytes = await readChunk(BigInt(cp), 4);
                  const cr = new ByteView(chainBytes, { littleEndian });
                  const chain = cr.u32(0);
                  if (chain & 1) break;
                  idx++; cp += 4;
                }
                count = idx + 1;
              }
            } catch {
              // ignore
            }
          }
        } else if (one(DT_HASH) != null) {
          const hashOff = vaToOffset(segments, one(DT_HASH));
          if (hashOff != null) {
            try {
              const probe = await readChunk(BigInt(hashOff), 8);
              const pr = new ByteView(probe, { littleEndian });
              count = pr.u32(4);
            } catch {
              // ignore
            }
          }
        }
        if (count != null) {
          const entSize = bits === 64 ? 24 : 16;
          addRange(symtabOff, count * entSize, 2, 'DT_SYMTAB-derived');
        }
      }
    }
  }

  // DT_STRTAB + DT_STRSZ
  const strtabVa = one(DT_STRTAB);
  const strsz = one(DT_STRSZ);
  if (strtabVa != null && strsz != null) {
    const strOff = vaToOffset(segments, strtabVa, strsz);
    if (strOff != null) {
      addRange(strOff, strsz, 2, 'DT_STRTAB');
    }
  }

  // DT_RELA + DT_RELASZ
  const relaVa = one(DT_RELA);
  const relasz = one(DT_RELASZ);
  if (relaVa != null && relasz != null) {
    const relaOff = vaToOffset(segments, relaVa, relasz);
    if (relaOff != null) addRange(relaOff, relasz, 2, 'DT_RELA');
  }

  // DT_REL + DT_RELSZ
  const relVa = one(DT_REL);
  const relsz = one(DT_RELSZ);
  if (relVa != null && relsz != null) {
    const relOff = vaToOffset(segments, relVa, relsz);
    if (relOff != null) addRange(relOff, relsz, 2, 'DT_REL');
  }

  // DT_JMPREL + DT_PLTRELSZ
  const jmprelVa = one(DT_JMPREL);
  const pltrelsz = one(DT_PLTRELSZ);
  if (jmprelVa != null && pltrelsz != null) {
    const jmprelOff = vaToOffset(segments, jmprelVa, pltrelsz);
    if (jmprelOff != null) addRange(jmprelOff, pltrelsz, 2, 'DT_JMPREL');
  }

  // DT_RELR + DT_RELRSZ
  const relrVa = one(DT_RELR);
  const relrsz = one(DT_RELRSZ);
  if (relrVa != null && relrsz != null) {
    const relrOff = vaToOffset(segments, relrVa, relrsz);
    if (relrOff != null) addRange(relrOff, relrsz, 2, 'DT_RELR');
  }

  // DT_VERSYM
  const versymVa = one(DT_VERSYM);
  if (versymVa != null) {
    const versymSec = sections.find((s) => s.type === SHT_GNU_versym);
    if (versymSec) {
      addRange(versymSec.offset, versymSec.size, 2, 'DT_VERSYM-sec');
    } else {
      const versymOff = vaToOffset(segments, versymVa);
      if (versymOff != null) {
        addRange(versymOff, 64 * 1024, 2, 'DT_VERSYM');
      }
    }
  }

  // DT_VERNEED
  const verneedVa = one(DT_VERNEED);
  if (verneedVa != null) {
    const verneedSec = sections.find((s) => s.type === SHT_GNU_verneed);
    if (verneedSec) {
      addRange(verneedSec.offset, verneedSec.size, 2, 'DT_VERNEED-sec');
    } else {
      const verneedOff = vaToOffset(segments, verneedVa);
      if (verneedOff != null) {
        addRange(verneedOff, 16 * 1024, 2, 'DT_VERNEED');
      }
    }
  }

  // DT_VERDEF
  const verdefVa = one(DT_VERDEF);
  if (verdefVa != null) {
    const verdefSec = sections.find((s) => s.type === SHT_GNU_verdef);
    if (verdefSec) {
      addRange(verdefSec.offset, verdefSec.size, 2, 'DT_VERDEF-sec');
    } else {
      const verdefOff = vaToOffset(segments, verdefVa);
      if (verdefOff != null) {
        addRange(verdefOff, 16 * 1024, 2, 'DT_VERDEF');
      }
    }
  }

  // Deduplicate and filter by budget
  candidateRanges.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.offset < b.offset) return -1;
    if (a.offset > b.offset) return 1;
    return a.size - b.size;
  });

  // Coalesce intervals
  // Any gap < 64 KiB should be merged!
  const GAP_MERGE_THRESHOLD = 64 * 1024;
  let admittedSpans = [];
  let currentBudgetUsed = 0;

  for (const item of candidateRanges) {
    const start = item.offset;
    const end = start + BigInt(item.size);

    // Compute added bytes if we admit this interval
    // Check overlap with existing admittedSpans
    let overlap = 0n;
    for (const span of admittedSpans) {
      if (span.start >= end) continue;
      if (span.end <= start) continue;
      const lo = span.start > start ? span.start : start;
      const hi = span.end < end ? span.end : end;
      if (hi > lo) overlap += hi - lo;
    }
    const additional = item.size - Number(overlap);
    if (additional <= 0) continue;
    if (currentBudgetUsed + additional > maxCachedBytes) {
      // Exceeds budget, stop
      break;
    }

    // Merge into admittedSpans
    currentBudgetUsed += additional;
    admittedSpans.push({ start, end });
    admittedSpans.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
    // Consolidate overlapping / touching
    const consolidated = [];
    for (const span of admittedSpans) {
      if (!consolidated.length) {
        consolidated.push({ start: span.start, end: span.end });
      } else {
        const last = consolidated[consolidated.length - 1];
        if (span.start <= last.end) {
          if (span.end > last.end) last.end = span.end;
        } else {
          consolidated.push({ start: span.start, end: span.end });
        }
      }
    }
    admittedSpans = consolidated;
  }

  // Now coalesce adjacent spans where gap < GAP_MERGE_THRESHOLD
  // BUT only if merging does not exceed remaining maxCachedBytes!
  if (admittedSpans.length > 1) {
    const coalesced = [admittedSpans[0]];
    for (let i = 1; i < admittedSpans.length; i++) {
      const prev = coalesced[coalesced.length - 1];
      const cur = admittedSpans[i];
      const gap = Number(cur.start - prev.end);
      if (gap >= 0 && gap < GAP_MERGE_THRESHOLD && currentBudgetUsed + gap <= maxCachedBytes) {
        currentBudgetUsed += gap;
        prev.end = cur.end;
      } else {
        coalesced.push({ start: cur.start, end: cur.end });
      }
    }
    admittedSpans = coalesced;
  }

  // Now execute reads respecting source.maxReadLength, maxPageSize, and return array of { offset, bytes }
  const maxReads = options.maxReads ?? 4096;
  const result = [];
  for (const span of admittedSpans) {
    let cursor = span.start;
    while (cursor < span.end) {
      if (result.length >= maxReads) break;
      const take = Number(span.end - cursor > BigInt(maxReadLimit) ? BigInt(maxReadLimit) : span.end - cursor);
      const bytes = await readChunk(cursor, take);
      result.push({ offset: cursor, bytes });
      cursor += BigInt(bytes.byteLength);
    }
    if (result.length >= maxReads) break;
  }

  return result;
}
