/**
 * C++ Non-Virtual Constructor / Destructor Resolver via Direct Vtable Reference Scan
 *
 * Scans ARM64 machine code (`ADRP+ADD` / `ADR`) inside normalized function ranges for
 * direct references to known C++ vtable addresses recovered by `stripped-rtti-resolver.js`.
 *
 * Strict anti-fabrication policy:
 * - Never overwrites existing `cxxRtti.byFunction` entries.
 * - Assigns `primaryOwner` ONLY when all referenced vtable classes in a function either
 *   belong to a single class OR form a single inheritance chain (where the most-derived class
 *   initializes/tears down its base vptrs before/after setting its own vptr).
 * - Unrelated multi-class factories are marked `{ primaryOwner: null, isShared: true, sharedOwners }`.
 *
 * Zero external static imports (self-contained pure JS).
 */

function toBigIntSafe(v) {
  if (typeof v === 'bigint') return v >= 0n ? v : null;
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    try {
      const b = BigInt(s);
      return b >= 0n ? b : null;
    } catch {
      return null;
    }
  }
  return null;
}

function compareLex(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function findTextSection(image) {
  if (!image || !Array.isArray(image.sections) || !(image.bytes instanceof Uint8Array)) return null;
  for (let i = 0; i < image.sections.length; i++) {
    const s = image.sections[i];
    if (!s || typeof s !== 'object') continue;
    const name = String(s.name || s.sectname || '');
    const seg = String(s.segment || s.segname || '');
    if (name === '__text' || name === '.text' || (seg === '__TEXT' && name === '__text')) {
      const va = toBigIntSafe(s.address ?? s.vaddr ?? s.addr ?? s.vmAddr ?? s.va);
      const foffRaw = s.fileOffset ?? s.offset ?? s.fileOff ?? s.foff;
      const foff = typeof foffRaw === 'bigint' ? Number(foffRaw) : Number(foffRaw);
      const sizeRaw = s.size ?? s.byteLength ?? s.fileSize ?? 0;
      const size = typeof sizeRaw === 'bigint' ? Number(sizeRaw) : Number(sizeRaw);
      if (va != null && Number.isFinite(foff) && foff >= 0 && Number.isFinite(size) && size > 0) {
        const clamped = Math.min(size, Math.max(0, image.bytes.length - foff));
        if (clamped > 0) {
          return {
            bytes: image.bytes.subarray(foff, foff + clamped),
            textVa: va,
          };
        }
      }
    }
  }
  return null;
}

function normalizeRanges(functions, textVa, textEnd) {
  if (!Array.isArray(functions) || functions.length === 0) return [];
  const starts = [];
  const rawEnds = [];
  for (let i = 0; i < functions.length; i++) {
    const f = functions[i];
    let s = null;
    let e = null;
    if (typeof f === 'bigint') {
      s = f;
    } else if (f && typeof f === 'object') {
      s = toBigIntSafe(f.start ?? f.va ?? f.addr ?? f.address);
      e = toBigIntSafe(f.end);
      if (e == null && f.size != null) {
        const sz = toBigIntSafe(f.size);
        if (s != null && sz != null && sz > 0n) e = s + sz;
      }
    }
    if (s == null || s < textVa || s >= textEnd) continue;
    starts.push({ s, e });
  }
  if (starts.length === 0) return [];
  starts.sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));

  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const curS = starts[i].s;
    if (out.length > 0 && out[out.length - 1].start === curS) continue;
    let curE = starts[i].e;
    if (curE == null || curE <= curS) {
      let nextS = textEnd;
      for (let j = i + 1; j < starts.length; j++) {
        if (starts[j].s > curS) {
          nextS = starts[j].s;
          break;
        }
      }
      curE = nextS;
    }
    if (curE > textEnd) curE = textEnd;
    if (curE > curS) out.push({ start: curS, end: curE });
  }
  return out;
}

/**
 * Resolve non-virtual C++ constructors/destructors and direct vtable-referencing functions.
 *
 * @param {object} opts
 * @returns {{
 *   addedByFunction: Map<bigint, { fnVa: bigint, primaryOwner: string|null, primaryRttiVa: bigint|null, slotIndex: null, isShared: boolean, sharedOwners: string[], isVtableRef: true }>,
 *   stats: { scannedFunctions: number, resolvedUnique: number, resolvedShared: number, elapsedMs: number }
 * }}
 */
export function resolveVtableRefOwners(opts = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const empty = () => ({
    addedByFunction: new Map(),
    stats: {
      scannedFunctions: 0,
      resolvedUnique: 0,
      resolvedShared: 0,
      elapsedMs: 0,
    },
  });

  if (!opts || typeof opts !== 'object') return empty();
  const arch = String(opts.arch || 'arm64').toLowerCase();
  if (arch !== 'arm64' && arch !== 'arm64e' && arch !== 'aarch64') return empty();

  const cxxRtti = opts.cxxRtti && typeof opts.cxxRtti === 'object' ? opts.cxxRtti : null;
  if (!cxxRtti || !Array.isArray(cxxRtti.classes) || cxxRtti.classes.length === 0) return empty();

  let codeBytes = opts.codeBytes instanceof Uint8Array ? opts.codeBytes : null;
  let textVa = toBigIntSafe(opts.textVa ?? opts.textLo);
  if (!codeBytes || textVa == null) {
    const sec = findTextSection(opts.image);
    if (!sec) return empty();
    if (!codeBytes) codeBytes = sec.bytes;
    if (textVa == null) textVa = sec.textVa;
  }
  if (!codeBytes || codeBytes.length < 4 || textVa == null) return empty();

  const textEnd = textVa + BigInt(codeBytes.length);
  const ranges = normalizeRanges(opts.functions, textVa, textEnd);
  if (ranges.length === 0) return empty();

  // Safe integer fast-path guard (ARM64 VAs fit in 48-bit < MAX_SAFE_INTEGER)
  const useNumberFast = textEnd <= BigInt(Number.MAX_SAFE_INTEGER);
  if (!useNumberFast) return empty();

  // Build class registry & inheritance ancestor cache + vtable VA lookup map
  const classes = cxxRtti.classes;
  const classNameToId = new Map();
  const classRecords = new Array(classes.length);
  const vtableNumToClassIds = new Map();

  for (let i = 0; i < classes.length; i++) {
    const cls = classes[i];
    if (!cls || typeof cls !== 'object' || typeof cls.className !== 'string' || !cls.className) continue;
    classNameToId.set(cls.className, i);
    classRecords[i] = cls;
  }

  for (let i = 0; i < classes.length; i++) {
    const cls = classRecords[i];
    if (!cls) continue;
    const vts = Array.isArray(cls.vtableVas) ? cls.vtableVas : [];
    for (let j = 0; j < vts.length; j++) {
      const vt = vts[j];
      const vtVa = toBigIntSafe(vt?.va ?? vt);
      if (vtVa == null || vtVa > BigInt(Number.MAX_SAFE_INTEGER)) continue;
      const vtNum = Number(vtVa);
      // Clang/Itanium ARM64 sets vptr to vtable's first slot (`vt.va`) via ADRP+ADD.
      let bucket = vtableNumToClassIds.get(vtNum);
      if (!bucket) {
        vtableNumToClassIds.set(vtNum, i);
      } else if (typeof bucket === 'number') {
        if (bucket !== i) vtableNumToClassIds.set(vtNum, [bucket, i]);
      } else if (!bucket.includes(i)) {
        bucket.push(i);
      }
    }
  }

  if (vtableNumToClassIds.size === 0) return empty();

  // Precompute ancestor ID sets lazily per classId (to resolve Base + Derived -> Derived)
  const baseIdsByClass = new Array(classes.length);
  for (let i = 0; i < classes.length; i++) {
    const cls = classRecords[i];
    if (!cls || !Array.isArray(cls.baseClassNames) || cls.baseClassNames.length === 0) {
      baseIdsByClass[i] = null;
      continue;
    }
    const bIds = [];
    for (let j = 0; j < cls.baseClassNames.length; j++) {
      const bId = classNameToId.get(cls.baseClassNames[j]);
      if (bId !== undefined && bId !== i) bIds.push(bId);
    }
    baseIdsByClass[i] = bIds.length > 0 ? bIds : null;
  }

  const ancSetCache = new Array(classes.length);
  const getAncSet = (cid) => {
    const cached = ancSetCache[cid];
    if (cached !== undefined) return cached;
    const bases = baseIdsByClass[cid];
    if (!bases) {
      ancSetCache[cid] = null;
      return null;
    }
    const set = new Set();
    const stack = [...bases];
    while (stack.length > 0 && set.size < 128) {
      const cur = stack.pop();
      if (set.has(cur)) continue;
      set.add(cur);
      const nextBases = baseIdsByClass[cur];
      if (nextBases) {
        for (let k = 0; k < nextBases.length; k++) {
          if (!set.has(nextBases[k])) stack.push(nextBases[k]);
        }
      }
    }
    ancSetCache[cid] = set;
    return set;
  };

  const existingByFn = cxxRtti.byFunction instanceof Map ? cxxRtti.byFunction : null;
  const addedByFunction = new Map();
  const u32Aligned = (codeBytes.byteOffset & 3) === 0
    ? new Uint32Array(codeBytes.buffer, codeBytes.byteOffset, codeBytes.byteLength >>> 2)
    : null;
  const dv = u32Aligned ? null : new DataView(codeBytes.buffer, codeBytes.byteOffset, codeBytes.byteLength);
  const textVaNum = Number(textVa);
  const codeLen = codeBytes.length;

  // Scratch register page state (Float64Array holds exact 53-bit integer addresses, -1 = unset)
  const adrpPage = new Float64Array(32);
  let scannedFunctions = 0;
  let resolvedUnique = 0;
  let resolvedShared = 0;

  for (let r = 0; r < ranges.length; r++) {
    const fnVa = ranges[r].start;
    if (existingByFn && existingByFn.has(fnVa)) continue;

    const fStart = Number(fnVa - textVa);
    const fEnd = Math.min(codeLen, Number(ranges[r].end - textVa));
    if (fStart < 0 || fStart + 4 > fEnd) continue;

    scannedFunctions++;
    adrpPage.fill(-1);

    let firstCid = -1;
    let hitCids = null;

    const recordClassHit = (entry) => {
      if (typeof entry === 'number') {
        if (firstCid < 0) firstCid = entry;
        else if (entry !== firstCid) {
          if (!hitCids) hitCids = [firstCid, entry];
          else if (!hitCids.includes(entry)) hitCids.push(entry);
        }
      } else {
        for (let k = 0; k < entry.length; k++) recordClassHit(entry[k]);
      }
    };

    for (let o = fStart; o + 4 <= fEnd; o += 4) {
      const insn = u32Aligned ? u32Aligned[o >>> 2] : dv.getUint32(o, true);
      const pcVa = textVaNum + o;

      // ADRP Xd, #imm (bits [31,28..24] == 1001_0000 -> mask 0x9f000000 == 0x90000000)
      if (((insn & 0x9f000000) >>> 0) === 0x90000000) {
        const rd = insn & 31;
        if (rd < 31) {
          const immlo = (insn >>> 29) & 3;
          const immhi = (insn >>> 5) & 0x7ffff;
          let imm = (immhi << 2) | immlo;
          if (imm & 0x100000) imm -= 0x200000;
          const pageBase = (pcVa - (pcVa & 0xfff)) + imm * 4096;
          adrpPage[rd] = pageBase;
        }
        continue;
      }

      // ADD Xd, Xn, #imm12{, LSL #12} (bits [31..23] == 1001_0001_0 -> mask 0xff800000 == 0x91000000)
      if (((insn & 0xff800000) >>> 0) === 0x91000000) {
        const rd = insn & 31;
        const rn = (insn >>> 5) & 31;
        if (rn < 31 && adrpPage[rn] >= 0) {
          const sh = (insn >>> 22) & 1;
          const imm12 = ((insn >>> 10) & 0xfff) << (sh ? 12 : 0);
          const target = adrpPage[rn] + imm12;
          const hit = vtableNumToClassIds.get(target);
          if (hit !== undefined) recordClassHit(hit);
        }
        if (rd < 31) adrpPage[rd] = -1;
        continue;
      }

      // ADR Xd, #imm (bits [31,28..24] == 0001_0000 -> mask 0x9f000000 == 0x10000000)
      if (((insn & 0x9f000000) >>> 0) === 0x10000000) {
        const rd = insn & 31;
        if (rd < 31) {
          const immlo = (insn >>> 29) & 3;
          const immhi = (insn >>> 5) & 0x7ffff;
          let imm = (immhi << 2) | immlo;
          if (imm & 0x100000) imm -= 0x200000;
          const target = pcVa + imm;
          const hit = vtableNumToClassIds.get(target);
          if (hit !== undefined) recordClassHit(hit);
          adrpPage[rd] = -1;
        }
        continue;
      }

      // Invalidate destination register on BL / BLR / MOV / LDR / etc. when Rd < 31
      const op6 = (insn & 0xfc000000) >>> 0;
      if (op6 === 0x94000000 || op6 === 0x14000000) {
        // Branch: clear caller-saved page cache to prevent false pairing across calls
        adrpPage[0] = -1; adrpPage[1] = -1; adrpPage[2] = -1; adrpPage[3] = -1;
        adrpPage[8] = -1; adrpPage[9] = -1; adrpPage[10] = -1; adrpPage[11] = -1;
        adrpPage[12] = -1; adrpPage[13] = -1; adrpPage[14] = -1; adrpPage[15] = -1;
        adrpPage[16] = -1; adrpPage[17] = -1;
        continue;
      }
      // Clear rd for common GPR writes (LDR literal / LDR / MOV / ORR / etc.)
      if ((insn & 0x1f000000) === 0x18000000 || (insn & 0x3f000000) === 0x39000000 || (insn & 0x7f000000) === 0x52000000 || (insn & 0x7f000000) === 0x2a000000) {
        const rd = insn & 31;
        if (rd < 31) adrpPage[rd] = -1;
      }
    }

    if (firstCid < 0) continue;

    if (!hitCids) {
      const cls = classRecords[firstCid];
      resolvedUnique++;
      addedByFunction.set(fnVa, {
        fnVa,
        primaryOwner: cls.className,
        primaryRttiVa: cls.rttiVa ?? null,
        slotIndex: null,
        isShared: false,
        sharedOwners: [],
        isVtableRef: true,
      });
      continue;
    }

    // Multiple vtable classes referenced: check if one most-derived class inherits all others
    let bestDerived = -1;
    for (let a = 0; a < hitCids.length; a++) {
      const candId = hitCids[a];
      const anc = getAncSet(candId);
      if (!anc) continue;
      let coversAll = true;
      for (let b = 0; b < hitCids.length; b++) {
        if (a !== b && !anc.has(hitCids[b])) {
          coversAll = false;
          break;
        }
      }
      if (coversAll) {
        bestDerived = candId;
        break;
      }
    }

    if (bestDerived >= 0) {
      const cls = classRecords[bestDerived];
      resolvedUnique++;
      addedByFunction.set(fnVa, {
        fnVa,
        primaryOwner: cls.className,
        primaryRttiVa: cls.rttiVa ?? null,
        slotIndex: null,
        isShared: false,
        sharedOwners: [],
        isVtableRef: true,
      });
    } else {
      const names = [];
      for (let k = 0; k < hitCids.length; k++) names.push(classRecords[hitCids[k]].className);
      names.sort(compareLex);
      resolvedShared++;
      addedByFunction.set(fnVa, {
        fnVa,
        primaryOwner: null,
        primaryRttiVa: null,
        slotIndex: null,
        isShared: true,
        sharedOwners: names,
        isVtableRef: true,
      });
    }
  }

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    addedByFunction,
    stats: {
      scannedFunctions,
      resolvedUnique,
      resolvedShared,
      elapsedMs: Number((t1 - t0).toFixed(2)),
    },
  };
}
