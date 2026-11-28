/**
 * High-speed batch Itanium ABI C++ RTTI and vtable slot resolver for stripped
 * binaries (Mach-O chained fixups / arm64e / PAC / absolute / relative32).
 *
 * Reuses only the public `demangleCxx` export from `../../rtti.js` with an
 * unbounded per-run local Map cache to avoid thrashing the 4096-entry global
 * cache on 10,000+ class binaries.
 */

import { demangleCxx } from '../../rtti.js';

const DEFAULT_MAX_CLASSES = 50000;
const DEFAULT_MAX_SLOTS_PER_VTABLE = 512;
const MAX_ZTS_LENGTH = 256;
const MAX_INHERITANCE_DEPTH = 64;
const MAX_NAMESPACE_DEPTH = 32;
const MAX_VMI_BASES = 32;
const PAC_MASK_48 = 0x0000ffffffffffffn;
const TARGET_MASK_36 = 0xfffffffffn;
const TARGET_MASK_43 = 0x7ffffffffffn;
const U32_MASK = 0xffffffffn;
const OFFSET_LIMIT = 0x100000n;
const MAX_SAFE_BASE = 0x1fff0000000000n;

const HEX_VA_RE = /^0[xX][0-9a-fA-F]+$/;
const asciiDecoder = new TextDecoder('ascii');
const DEC_VA_RE = /^[0-9]+$/;

function toBigIntOrNull(value) {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    if (!HEX_VA_RE.test(s) && !DEC_VA_RE.test(s)) return null;
    try {
      const b = BigInt(s);
      return b >= 0n ? b : null;
    } catch {
      return null;
    }
  }
  return null;
}

function toSafeNonNegInt(value) {
  if (typeof value === 'bigint') {
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) {
    return Math.floor(value);
  }
  return null;
}

function normalizePositiveInt(value, fallback, min = 1) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= min) {
    return Math.floor(value);
  }
  return fallback;
}

function compareLex(a, b) {
  return a < b ? -1 : (a > b ? 1 : 0);
}

function skipOperatorAngles(str, idx) {
  if (str.slice(idx, idx + 8) !== 'operator') return 0;
  if (idx > 0 && /[\w$]/.test(str[idx - 1])) return 0;
  let j = idx + 8;
  while (j < str.length && str[j] === ' ') j++;
  const rest = str.slice(j);
  const m = /^(?:->\*|->|<=>|<<=|>>=|<<|>>|<=|>=|<|>)/.exec(rest);
  return m ? (j + m[0].length - idx) : 0;
}

/**
 * Split a C++ qualified class name by top-level `::`, tracking `<>` template
 * bracket depth and capping depth at `maxDepth`.
 */
export function splitCppClassPath(name, maxDepth = MAX_NAMESPACE_DEPTH) {
  if (typeof name !== 'string') return [];
  const trimmed = name.trim();
  if (!trimmed) return [];

  const limit = normalizePositiveInt(maxDepth, MAX_NAMESPACE_DEPTH, 1);
  if (trimmed.indexOf('<') < 0 && trimmed.indexOf('operator') < 0) {
    const parts = trimmed.split('::').filter(Boolean);
    if (parts.length > limit) {
      const head = parts.slice(0, limit - 1);
      head.push(parts.slice(limit - 1).join('::'));
      return head;
    }
    return parts;
  }

  const segments = [];
  let depth = 0;
  let start = 0;
  let i = 0;

  while (i < trimmed.length) {
    const opSkip = skipOperatorAngles(trimmed, i);
    if (opSkip > 0) {
      i += opSkip;
      continue;
    }
    const ch = trimmed[i];
    if (ch === '<') {
      depth++;
      i++;
      continue;
    }
    if (ch === '>') {
      if (depth > 0) depth--;
      i++;
      continue;
    }
    if (depth === 0 && ch === ':' && i + 1 < trimmed.length && trimmed[i + 1] === ':') {
      const seg = trimmed.slice(start, i).trim();
      if (seg) segments.push(seg);
      i += 2;
      start = i;
      continue;
    }
    i++;
  }

  const tail = trimmed.slice(start).trim();
  if (tail) segments.push(tail);

  if (segments.length > limit) {
    const head = segments.slice(0, limit - 1);
    head.push(segments.slice(limit - 1).join('::'));
    return head;
  }
  return segments;
}

function fastDemangleSimpleZts(clean) {
  const len = clean.length;
  if (len < 2) return null;
  const c0 = clean.charCodeAt(0);
  if (c0 === 78 /* N */) {
    if (clean.charCodeAt(len - 1) !== 69 /* E */) return null;
    let i = 1;
    const end = len - 1;
    const parts = [];
    while (i < end) {
      const ch = clean.charCodeAt(i);
      if (ch < 49 || ch > 57) return null;
      let n = 0;
      while (i < end) {
        const d = clean.charCodeAt(i);
        if (d < 48 || d > 57) break;
        n = n * 10 + (d - 48);
        if (n > end - i) return null;
        i++;
      }
      if (n <= 0 || i + n > end) return null;
      parts.push(clean.slice(i, i + n));
      i += n;
    }
    return parts.length > 0 ? parts.join('::') : null;
  }
  if (c0 >= 49 && c0 <= 57) {
    let i = 0;
    let n = 0;
    while (i < len) {
      const d = clean.charCodeAt(i);
      if (d < 48 || d > 57) break;
      n = n * 10 + (d - 48);
      if (n > len) return null;
      i++;
    }
    if (n > 0 && i + n === len) {
      return clean.slice(i, i + n);
    }
  }
  return null;
}

function fallbackExtractItaniumZts(clean) {
  const len = clean.length;
  if (len === 0) return null;
  const c0 = clean.charCodeAt(0);
  const startsItanium = c0 === 78 /* N */
    || c0 === 90 /* Z */
    || (c0 >= 49 && c0 <= 57) /* 1-9 */
    || (clean.startsWith('St') && len > 2);
  if (!startsItanium) return null;

  const parts = [];
  let i = 0;
  if (c0 === 78 || c0 === 90) i = 1;
  else if (clean.startsWith('St')) {
    parts.push('std');
    i = 2;
  }

  let steps = 0;
  while (i < len && steps++ < 128 && parts.length < 12) {
    const ch = clean.charCodeAt(i);
    if (ch >= 49 && ch <= 57) {
      let n = 0;
      const numStart = i;
      while (i < len) {
        const d = clean.charCodeAt(i);
        if (d < 48 || d > 57) break;
        n = n * 10 + (d - 48);
        if (n > len) break;
        i++;
      }
      if (n > 0 && i + n <= len) {
        const word = clean.slice(i, i + n);
        i += n;
        if (word && !word.startsWith('__')) {
          parts.push(word);
        }
        continue;
      }
      i = numStart + 1;
      continue;
    }
    if (ch === 85 /* U */ && i + 1 < len && clean.charCodeAt(i + 1) === 108 /* l */) {
      parts.push('lambda');
      i += 2;
      continue;
    }
    i++;
  }

  if (parts.length === 0) return null;
  return parts.join('::');
}

function buildSectionReader({ image = null, sections = null, dataBytes = null, dataVa = null }) {
  const entries = [];
  const sectionVaByName = new Map();
  const dvCache = new WeakMap();

  const getDataView = (u8) => {
    let dv = dvCache.get(u8);
    if (!dv) {
      dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      dvCache.set(u8, dv);
    }
    return dv;
  };

  const addEntry = (name, seg, va, bytes, fileOffset, fileSize) => {
    if (va == null || !(bytes instanceof Uint8Array)) return;
    if (fileOffset == null || fileOffset < 0 || fileOffset >= bytes.length) return;
    const avail = bytes.length - fileOffset;
    const effectiveSize = fileSize != null ? Math.min(fileSize, avail) : avail;
    if (effectiveSize <= 0) return;

    const vaEnd = va + BigInt(effectiveSize);
    const dv = getDataView(bytes);
    entries.push({
      name: name || '',
      seg: seg || '',
      va,
      vaEnd,
      vaNum: va <= MAX_SAFE_BASE ? Number(va) : -1,
      vaEndNum: vaEnd <= MAX_SAFE_BASE ? Number(vaEnd) : -1,
      bytes,
      dv,
      fileOffset,
      fileSize: effectiveSize,
    });

    if (name && !sectionVaByName.has(name)) sectionVaByName.set(name, va);
    if (seg && name) {
      const qualified = `${seg}.${name}`;
      if (!sectionVaByName.has(qualified)) sectionVaByName.set(qualified, va);
      const commaQualified = `${seg},${name}`;
      if (!sectionVaByName.has(commaQualified)) sectionVaByName.set(commaQualified, va);
    }
  };

  if (image && typeof image === 'object' && image.bytes instanceof Uint8Array && Array.isArray(image.sections)) {
    const imgBytes = image.bytes;
    for (let i = 0; i < image.sections.length; i++) {
      const s = image.sections[i];
      if (!s || typeof s !== 'object') continue;
      const va = toBigIntOrNull(s.address ?? s.vaddr ?? s.addr ?? s.vmAddr ?? s.va);
      const foff = toSafeNonNegInt(s.fileOffset ?? s.offset ?? s.fileOff ?? s.foff);
      const rawSize = toSafeNonNegInt(s.size ?? s.byteLength);
      const fsize = s.fileSize != null ? toSafeNonNegInt(s.fileSize) : rawSize;
      const seg = typeof (s.segment ?? s.segname) === 'string' ? (s.segment ?? s.segname) : '';
      const name = typeof s.name === 'string' ? s.name : '';
      addEntry(name, seg, va, imgBytes, foff, fsize);
    }
  }

  if (Array.isArray(sections)) {
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      if (!s || typeof s !== 'object' || !(s.bytes instanceof Uint8Array)) continue;
      const va = toBigIntOrNull(s.address ?? s.vaddr ?? s.addr ?? s.vmAddr ?? s.va);
      const fsize = s.fileSize != null
        ? toSafeNonNegInt(s.fileSize)
        : toSafeNonNegInt(s.size ?? s.byteLength ?? s.bytes.length);
      const seg = typeof (s.segment ?? s.segname) === 'string' ? (s.segment ?? s.segname) : '';
      const name = typeof s.name === 'string' ? s.name : '';
      addEntry(name, seg, va, s.bytes, 0, fsize);
    }
  }

  if (entries.length === 0 && dataBytes instanceof Uint8Array && dataBytes.length > 0) {
    const va = toBigIntOrNull(dataVa);
    if (va != null) {
      addEntry('data', '', va, dataBytes, 0, dataBytes.length);
    }
  }

  entries.sort((a, b) => (a.va < b.va ? -1 : (a.va > b.va ? 1 : 0)));

  const findSection = (va) => {
    if (va == null || va < 0n || entries.length === 0) return null;
    let lo = 0;
    let hi = entries.length - 1;
    let cand = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (entries[mid].va <= va) {
        cand = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (cand < 0) return null;
    const sec = entries[cand];
    return va < sec.vaEnd ? sec : null;
  };

  const readCStringAscii = (va, maxLen = MAX_ZTS_LENGTH) => {
    const sec = findSection(va);
    if (!sec) return null;
    const delta = Number(va - sec.va);
    if (delta < 0 || delta >= sec.fileSize) return null;
    const start = sec.fileOffset + delta;
    const maxAvail = Math.min(maxLen + 1, sec.fileSize - delta);
    const bytes = sec.bytes;
    let len = 0;
    let foundNul = false;
    for (let i = 0; i < maxAvail; i++) {
      const b = bytes[start + i];
      if (b === 0) {
        foundNul = true;
        break;
      }
      if (b < 0x20 || b > 0x7e) return null;
      len++;
    }
    if (!foundNul || len === 0 || len > maxLen) return null;
    if (len <= 96) {
      let s = '';
      const end = start + len;
      for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
      return s;
    }
    return asciiDecoder.decode(bytes.subarray(start, start + len));
  };

  const findSectionNum = (vaNum) => {
    if (vaNum < 0 || entries.length === 0) return null;
    let lo = 0;
    let hi = entries.length - 1;
    let cand = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const eVa = entries[mid].vaNum;
      if (eVa >= 0 && eVa <= vaNum) {
        cand = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (cand < 0) return null;
    const sec = entries[cand];
    return vaNum < sec.vaEndNum ? sec : null;
  };

  const hasVa = (va) => findSection(va) !== null;

  return {
    entries,
    sectionVaByName,
    findSection,
    findSectionNum,
    hasVa,
    readCStringAscii,
  };
}

/**
 * Decode a raw pointer word (vtable slot or typeinfo field) per Contract 1.
 * Self-contained implementation (does not import private helpers from js/rtti.js).
 */
export function decodeStrippedPointer(raw, slotVa, opts = {}) {
  if (raw == null) return { va: null, isBind: false, ordinal: null };
  if (raw === 0n) return { va: 0n, isBind: false, ordinal: null };

  const ptrSize = opts.ptrSize === 4 ? 4 : 8;
  const encoding = opts.encoding || 'absolute';
  const pointerFormat = opts.pointerFormat ?? null;
  const imageBase = opts.imageBase ?? 0n;
  const stripPac = opts.stripPac !== false;
  const isKnownVa = typeof opts.isKnownVa === 'function' ? opts.isKnownVa : null;

  if (encoding === 'relative32') {
    const disp = BigInt.asIntN(32, raw & U32_MASK);
    if (disp === 0n || slotVa == null) return { va: null, isBind: false, ordinal: null };
    const va = slotVa + disp;
    return va >= 0n
      ? { va, isBind: false, ordinal: null }
      : { va: null, isBind: false, ordinal: null };
  }

  if (ptrSize === 4) {
    return { va: raw & U32_MASK, isBind: false, ordinal: null };
  }

  // arm64e chained pointer formats: 1, 7, 9, 10, 12
  if (
    pointerFormat === 1
    || pointerFormat === 7
    || pointerFormat === 9
    || pointerFormat === 10
    || pointerFormat === 12
  ) {
    const auth = ((raw >> 63n) & 1n) !== 0n;
    const bind = ((raw >> 62n) & 1n) !== 0n;
    if (bind) {
      const ordinalMask = pointerFormat === 12 ? 0xffffffn : 0xffffn;
      return {
        va: null,
        isBind: true,
        ordinal: Number(raw & ordinalMask),
        authenticated: auth,
      };
    }
    if (auth) {
      return {
        va: imageBase + (raw & U32_MASK),
        isBind: false,
        ordinal: null,
        authenticated: true,
      };
    }
    const target = raw & TARGET_MASK_43;
    const high8 = (raw >> 43n) & 0xffn;
    const isVmOffset = pointerFormat === 7 || pointerFormat === 9 || pointerFormat === 12;
    const baseAddr = isVmOffset ? (imageBase + target) : target;
    return {
      va: BigInt.asUintN(64, baseAddr | (high8 << 56n)),
      isBind: false,
      ordinal: null,
      authenticated: false,
    };
  }

  // DYLD_CHAINED_PTR_64_OFFSET (format 6) or chained_offset vtable encoding
  if (encoding === 'chained_offset' || pointerFormat === 6) {
    const bind = ((raw >> 63n) & 1n) !== 0n;
    if (bind) {
      return {
        va: null,
        isBind: true,
        ordinal: Number(raw & 0xffffffn),
      };
    }
    const target = raw & TARGET_MASK_36;
    if (target === 0n) return { va: null, isBind: false, ordinal: null };
    const high8 = (raw >> 36n) & 0xffn;
    const va = high8 !== 0n && !stripPac
      ? BigInt.asUintN(64, (imageBase + target) | (high8 << 56n))
      : BigInt.asUintN(64, imageBase + target);
    return { va, isBind: false, ordinal: null };
  }

  // DYLD_CHAINED_PTR_64 (format 2)
  if (pointerFormat === 2) {
    const bind = ((raw >> 63n) & 1n) !== 0n;
    if (bind) {
      return {
        va: null,
        isBind: true,
        ordinal: Number(raw & 0xffffffn),
      };
    }
    const target = raw & TARGET_MASK_36;
    if (target === 0n) return { va: null, isBind: false, ordinal: null };
    const high8 = (raw >> 36n) & 0xffn;
    const va = high8 !== 0n && !stripPac
      ? BigInt.asUintN(64, target | (high8 << 56n))
      : target;
    return { va, isBind: false, ordinal: null };
  }

  // Absolute encoding (with optional PAC strip + Mach-O chained offset fallback)
  const cand = stripPac ? (raw & PAC_MASK_48) : raw;
  if (!isKnownVa || isKnownVa(cand)) {
    return { va: cand, isBind: false, ordinal: null };
  }

  if (imageBase > 0n) {
    if ((raw >> 63n) !== 0n) {
      return {
        va: null,
        isBind: true,
        ordinal: Number(raw & 0xffffffn),
      };
    }
    const target = raw & TARGET_MASK_36;
    if (target !== 0n) {
      const chainedVa = imageBase + target;
      if (isKnownVa(chainedVa)) {
        return { va: chainedVa, isBind: false, ordinal: null };
      }
    }
  }

  return { va: null, isBind: false, ordinal: null };
}

function demangleZtsName(rawZts, localCache) {
  if (typeof rawZts !== 'string' || !rawZts) return null;
  const cached = localCache.get(rawZts);
  if (cached !== undefined) return cached;

  const clean = rawZts.startsWith('*') ? rawZts.slice(1) : rawZts;
  if (!clean) {
    localCache.set(rawZts, null);
    return null;
  }

  let result = fastDemangleSimpleZts(clean);

  if (!result) {
    const likelyUnsupported = clean.includes('IF') || clean.includes('IZN') || clean.includes('$_') || clean.includes('Ul');
    if (!likelyUnsupported) {
      const demangled = (clean.startsWith('_Z') || clean.startsWith('__Z'))
        ? demangleCxx(clean)
        : demangleCxx(`_Z${clean}`);
      if (typeof demangled === 'string' && demangled.length > 0) {
        result = demangled;
      }
    }
  }

  if (!result) {
    result = fallbackExtractItaniumZts(clean);
  }
  if (!result && /^[A-Za-z_][A-Za-z0-9_:<>, ]*$/.test(clean)) {
    result = clean;
  }

  localCache.set(rawZts, result);
  return result;
}

function classifyTypeinfoSymbol(symName) {
  if (typeof symName !== 'string' || !symName) return null;
  if (symName.includes('__vmi_class_type_info')) return 'vmi';
  if (symName.includes('__si_class_type_info')) return 'si';
  if (symName.includes('__class_type_info')) return 'base';
  return null;
}

/**
 * Resolve stripped C++ Itanium ABI RTTI, inheritance graph, all vtable slots,
 * and `primaryOwner` / `sharedOwners` links for all virtual methods.
 *
 * @param {object} [opts]
 * @returns {object}
 */
function scanChained64VtableSlots(
  dv,
  baseOff,
  maxByteEnd,
  vtableVaNum,
  clsTiId,
  offsetToTop,
  minSlotCount,
  maxSlotsPerVtable,
  textLoOffNum,
  textHiOffNum,
  knownVtableHeadersNum,
  knownRttiVasNum,
  state,
) {
  let slotCount = state.slotCount;
  let totalSlots = state.totalSlots;
  const slotFnOff = state.slotFnOff;
  const slotIdxArr = state.slotIdxArr;
  const slotVtVaNum = state.slotVtVaNum;
  const slotTiIdArr = state.slotTiIdArr;
  const slotOffArr = state.slotOffArr;
  const slotNext = state.slotNext;
  let htKey = state.htKey;
  let htHead = state.htHead;
  let htMask = state.htMask;
  let htCount = state.htCount;
  let htLimit = state.htLimit;

  for (let s = 0; s < maxSlotsPerVtable; s++) {
    const bytePos = baseOff + (s * 8);
    if (bytePos + 8 > maxByteEnd) break;
    if (s >= minSlotCount) {
      const slotVaNum = vtableVaNum + (s * 8);
      if (knownVtableHeadersNum.has(slotVaNum) || knownRttiVasNum.has(slotVaNum)) break;
    }
    const lo = dv.getUint32(bytePos, true);
    const hi = dv.getUint32(bytePos + 4, true);
    if (lo === 0 && hi === 0) {
      if (s >= minSlotCount) break;
      continue;
    }
    if ((hi & 0x80000000) !== 0) {
      const pos = slotCount++;
      slotFnOff[pos] = -1;
      slotIdxArr[pos] = s;
      slotVtVaNum[pos] = vtableVaNum;
      slotTiIdArr[pos] = clsTiId;
      slotOffArr[pos] = offsetToTop;
      slotNext[pos] = -1;
      totalSlots++;
      continue;
    }
    if ((hi & 0xfff) !== 0) {
      if (s >= minSlotCount) break;
      continue;
    }
    const targetOff = lo;
    if (targetOff < textLoOffNum || targetOff >= textHiOffNum) {
      if (s >= minSlotCount) break;
      continue;
    }
    const pos = slotCount++;
    slotFnOff[pos] = targetOff;
    slotIdxArr[pos] = s;
    slotVtVaNum[pos] = vtableVaNum;
    slotTiIdArr[pos] = clsTiId;
    slotOffArr[pos] = offsetToTop;
    if (htCount >= htLimit) {
      state.htCount = htCount;
      state.rehash();
      htKey = state.htKey;
      htHead = state.htHead;
      htMask = state.htMask;
      htLimit = state.htLimit;
    }
    let hIdx = ((targetOff >>> 2) * 2654435761) & htMask;
    while (true) {
      const k = htKey[hIdx];
      if (k === 0) {
        htKey[hIdx] = targetOff;
        htHead[hIdx] = pos;
        slotNext[pos] = -1;
        htCount++;
        break;
      }
      if (k === targetOff) {
        slotNext[pos] = htHead[hIdx];
        htHead[hIdx] = pos;
        break;
      }
      hIdx = (hIdx + 1) & htMask;
    }
    totalSlots++;
  }

  state.slotCount = slotCount;
  state.totalSlots = totalSlots;
  state.htCount = htCount;
}

export function resolveStrippedCxxRtti(opts = {}) {
  const t0 = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

  const o = opts && typeof opts === 'object' ? opts : {};
  const vtableList = Array.isArray(o.vtables)
    ? o.vtables
    : (Array.isArray(o.vtables?.vtables) ? o.vtables.vtables : []);

  const maxClasses = normalizePositiveInt(o.maxClasses, DEFAULT_MAX_CLASSES, 1);
  const maxSlotsPerVtable = normalizePositiveInt(o.maxSlotsPerVtable, DEFAULT_MAX_SLOTS_PER_VTABLE, 1);
  const ptrSize = o.ptrSize === 4 ? 4 : 8;
  const ptrBig = BigInt(ptrSize);
  const pointerFormat = o.pointerFormat ?? null;
  const stripPac = o.stripPac !== false;
  const resolveBindSymbol = typeof o.resolveBindSymbol === 'function' ? o.resolveBindSymbol : null;
  const symbols = o.symbols && typeof o.symbols === 'object' ? o.symbols : null;

  const imageBase = toBigIntOrNull(o.imageBase ?? o.image?.imageBase) ?? 0n;
  const textLo = toBigIntOrNull(o.textLo) ?? 0n;
  const textHi = toBigIntOrNull(o.textHi) ?? 0n;
  const hasTextRange = textHi > textLo;

  const reader = buildSectionReader({
    image: o.image ?? null,
    sections: o.sections ?? null,
    dataBytes: o.dataBytes ?? null,
    dataVa: o.dataVa ?? null,
  });

  if (vtableList.length === 0 || reader.entries.length === 0) {
    const t1 = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
    return {
      classes: [],
      byFunction: new Map(),
      byRttiVa: new Map(),
      completeness: 'complete',
      truncated: false,
      stats: {
        vtablesInput: vtableList.length,
        namedVtables: 0,
        uniqueClasses: 0,
        totalSlots: 0,
        linkedFunctions: 0,
        sharedFunctions: 0,
        elapsedMs: Math.max(0, Number((t1 - t0).toFixed(2))),
      },
    };
  }

  const isCodeVa = (va) => {
    if (va == null || va <= 0n) return false;
    if (hasTextRange) return va >= textLo && va < textHi;
    return reader.hasVa(va);
  };

  const isKnownVa = (va) => reader.hasVa(va) || (hasTextRange && va >= textLo && va < textHi);

  const decodeOptsBase = {
    ptrSize,
    encoding: 'absolute',
    pointerFormat,
    imageBase,
    stripPac,
    isKnownVa,
  };
  const decodePtr = (raw, slotVa, encoding) => {
    decodeOptsBase.encoding = encoding;
    decodeOptsBase.pointerFormat = encoding === 'absolute' ? null : pointerFormat;
    return decodeStrippedPointer(raw, slotVa, decodeOptsBase);
  };

  const resolveVtableVa = (v) => {
    const direct = toBigIntOrNull(v.va);
    if (direct != null) return direct;
    const off = toSafeNonNegInt(v.vtableOff);
    if (off == null) return null;
    if (typeof v.section === 'string' && reader.sectionVaByName.has(v.section)) {
      return reader.sectionVaByName.get(v.section) + BigInt(off);
    }
    const fallbackDataVa = toBigIntOrNull(o.dataVa);
    if (fallbackDataVa != null) return fallbackDataVa + BigInt(off);
    return null;
  };

  const canUseFastChained64 = ptrSize === 8
    && (pointerFormat == null || pointerFormat === 6)
    && hasTextRange
    && imageBase > 0n
    && imageBase <= MAX_SAFE_BASE
    && textLo > imageBase
    && textHi <= MAX_SAFE_BASE
    && (textHi - imageBase) <= 0x3fffffffn;

  const knownRttiVas = new Set();
  const knownVtableHeaders = new Set();
  const knownRttiVasNum = canUseFastChained64 ? new Set() : null;
  const knownVtableHeadersNum = canUseFastChained64 ? new Set() : null;
  if (canUseFastChained64) {
    for (let i = 0; i < vtableList.length; i++) {
      const v = vtableList[i];
      if (!v || typeof v !== 'object') continue;
      const rva = v.rttiVa;
      if (typeof rva === 'bigint' && rva > 0n && rva <= MAX_SAFE_BASE) {
        knownRttiVasNum.add(Number(rva));
      } else {
        const rb = toBigIntOrNull(rva);
        if (rb != null && rb > 0n) {
          knownRttiVas.add(rb);
          if (rb <= MAX_SAFE_BASE) knownRttiVasNum.add(Number(rb));
        }
      }
      if (v.hasRtti) {
        const vva = typeof v.va === 'bigint' ? v.va : resolveVtableVa(v);
        if (vva != null && vva >= 16n) {
          if (vva <= MAX_SAFE_BASE) {
            knownVtableHeadersNum.add(Number(vva) - 16);
          } else {
            knownVtableHeaders.add(vva - 16n);
          }
        }
      }
    }
  } else {
    for (let i = 0; i < vtableList.length; i++) {
      const v = vtableList[i];
      if (!v || typeof v !== 'object') continue;
      const rva = toBigIntOrNull(v.rttiVa);
      if (rva != null && rva > 0n) knownRttiVas.add(rva);
      if (v.hasRtti) {
        const vva = resolveVtableVa(v);
        if (vva != null && vva >= 2n * ptrBig) {
          knownVtableHeaders.add(vva - (2n * ptrBig));
        }
      }
    }
  }

  const localDemangleCache = new Map();
  const typeinfoHeaderCache = new Map();
  const typeinfoHeaderCacheNum = canUseFastChained64 ? new Map() : null;
  const parsedTypeinfo = new Map();
  const parsedTypeinfoNum = canUseFastChained64 ? new Map() : null;
  const tiById = [];

  const readCStringAsciiNum = (vaNum, maxLen = MAX_ZTS_LENGTH) => {
    const sec = reader.findSectionNum(vaNum);
    if (!sec) return null;
    const delta = vaNum - sec.vaNum;
    if (delta < 0 || delta >= sec.fileSize) return null;
    const start = sec.fileOffset + delta;
    const maxAvail = Math.min(maxLen + 1, sec.fileSize - delta);
    const bytes = sec.bytes;
    let len = 0;
    let foundNul = false;
    for (let i = 0; i < maxAvail; i++) {
      const b = bytes[start + i];
      if (b === 0) {
        foundNul = true;
        break;
      }
      if (b < 0x20 || b > 0x7e) return null;
      len++;
    }
    if (!foundNul || len === 0 || len > maxLen) return null;
    if (len <= 96) {
      let s = '';
      const end = start + len;
      for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
      return s;
    }
    return asciiDecoder.decode(bytes.subarray(start, start + len));
  };

  const canFastChainedHeader = ptrSize === 8
    && (pointerFormat == null || pointerFormat === 6)
    && imageBase > 0n
    && imageBase <= MAX_SAFE_BASE;
  const headerImageBaseNum = canFastChainedHeader ? Number(imageBase) : 0;

  const readTypeinfoHeaderNum = (rttiVaNum) => {
    const cached = typeinfoHeaderCacheNum.get(rttiVaNum);
    if (cached !== undefined) return cached;
    const sec = reader.findSectionNum(rttiVaNum);
    if (!sec) {
      typeinfoHeaderCacheNum.set(rttiVaNum, null);
      return null;
    }
    const delta = rttiVaNum - sec.vaNum;
    if (delta + 16 > sec.fileSize) {
      typeinfoHeaderCacheNum.set(rttiVaNum, null);
      return null;
    }
    const off = sec.fileOffset + delta + 8;
    const lo = sec.dv.getUint32(off, true);
    const hi = sec.dv.getUint32(off + 4, true);
    if ((lo === 0 && hi === 0) || (hi & 0x80000000) !== 0) {
      typeinfoHeaderCacheNum.set(rttiVaNum, null);
      return null;
    }
    const targetOff = ((hi & 0xf) * 4294967296) + lo;
    if (targetOff === 0) {
      typeinfoHeaderCacheNum.set(rttiVaNum, null);
      return null;
    }
    const rawZts = readCStringAsciiNum(headerImageBaseNum + targetOff, MAX_ZTS_LENGTH);
    if (!rawZts) {
      typeinfoHeaderCacheNum.set(rttiVaNum, null);
      return null;
    }
    const className = demangleZtsName(rawZts, localDemangleCache);
    if (!className) {
      typeinfoHeaderCacheNum.set(rttiVaNum, null);
      return null;
    }
    const header = { rawZts, className };
    typeinfoHeaderCacheNum.set(rttiVaNum, header);
    return header;
  };

  const readTypeinfoHeader = (rttiVa, encoding) => {
    if (rttiVa == null || rttiVa <= 0n) return null;
    if (typeinfoHeaderCacheNum !== null && encoding === 'chained_offset' && rttiVa <= MAX_SAFE_BASE) {
      return readTypeinfoHeaderNum(Number(rttiVa));
    }
    const cachedHeader = typeinfoHeaderCache.get(rttiVa);
    if (cachedHeader !== undefined) return cachedHeader;

    const sec = reader.findSection(rttiVa);
    if (!sec) {
      typeinfoHeaderCache.set(rttiVa, null);
      return null;
    }
    const delta = Number(rttiVa - sec.va);
    if (delta + (2 * ptrSize) > sec.fileSize) {
      typeinfoHeaderCache.set(rttiVa, null);
      return null;
    }

    const namePtrVa = rttiVa + ptrBig;
    const namePtrRaw = ptrSize === 4
      ? BigInt(sec.dv.getUint32(sec.fileOffset + delta + 4, true))
      : sec.dv.getBigUint64(sec.fileOffset + delta + 8, true);
    if (namePtrRaw === 0n) {
      typeinfoHeaderCache.set(rttiVa, null);
      return null;
    }

    const namePtr = decodePtr(namePtrRaw, namePtrVa, encoding);
    if (!namePtr.va || namePtr.isBind || namePtr.va === 0n) {
      typeinfoHeaderCache.set(rttiVa, null);
      return null;
    }

    const rawZts = reader.readCStringAscii(namePtr.va, MAX_ZTS_LENGTH);
    if (!rawZts) {
      typeinfoHeaderCache.set(rttiVa, null);
      return null;
    }

    const className = demangleZtsName(rawZts, localDemangleCache);
    if (!className) {
      typeinfoHeaderCache.set(rttiVa, null);
      return null;
    }

    const header = { rawZts, className };
    typeinfoHeaderCache.set(rttiVa, header);
    return header;
  };

  const readWordAt = (sec, baseDelta, offBytes) => {
    if (!sec || baseDelta < 0 || baseDelta + offBytes + ptrSize > sec.fileSize) return null;
    return ptrSize === 4
      ? BigInt(sec.dv.getUint32(sec.fileOffset + baseDelta + offBytes, true))
      : sec.dv.getBigUint64(sec.fileOffset + baseDelta + offBytes, true);
  };
  const readSignedWordAt = (sec, baseDelta, offBytes) => {
    if (!sec || baseDelta < 0 || baseDelta + offBytes + ptrSize > sec.fileSize) return null;
    return ptrSize === 4
      ? BigInt(sec.dv.getInt32(sec.fileOffset + baseDelta + offBytes, true))
      : sec.dv.getBigInt64(sec.fileOffset + baseDelta + offBytes, true);
  };

  const activeVisited = new Set();
  const activeVisitedNum = canUseFastChained64 ? new Set() : null;

  const resolveTypeinfoFastNum = (rttiVaNum, rttiVaOrNull, depth = 0) => {
    const cached = parsedTypeinfoNum.get(rttiVaNum);
    if (cached !== undefined) return cached;
    if (depth > MAX_INHERITANCE_DEPTH || activeVisitedNum.has(rttiVaNum)) return null;

    const header = readTypeinfoHeaderNum(rttiVaNum);
    if (!header) {
      parsedTypeinfoNum.set(rttiVaNum, null);
      return null;
    }

    const rttiVa = rttiVaOrNull !== null ? rttiVaOrNull : BigInt(rttiVaNum);
    const sec = reader.findSectionNum(rttiVaNum);
    const baseDelta = sec ? (rttiVaNum - sec.vaNum) : -1;

    let kind = null;
    if (resolveBindSymbol || symbols) {
      const vptrRaw = readWordAt(sec, baseDelta, 0);
      if (vptrRaw != null && vptrRaw !== 0n) {
        const vptrDec = decodePtr(vptrRaw, rttiVa, 'chained_offset');
        let symName = null;
        if (vptrDec.isBind && resolveBindSymbol && vptrDec.ordinal != null) {
          try { symName = resolveBindSymbol(vptrDec.ordinal); } catch { symName = null; }
        } else if (!vptrDec.isBind && vptrDec.va && symbols && typeof symbols.nameAt === 'function') {
          try { symName = symbols.nameAt(vptrDec.va); } catch { symName = null; }
        }
        kind = classifyTypeinfoSymbol(symName);
      }
    }

    const baseRttiVas = [];
    const baseRttiNums = [];
    let parsedSi = false;
    if (kind !== 'vmi' && kind !== 'base' && sec && baseDelta >= 0 && baseDelta + 24 <= sec.fileSize) {
      const off = sec.fileOffset + baseDelta + 16;
      const lo = sec.dv.getUint32(off, true);
      const hi = sec.dv.getUint32(off + 4, true);
      if ((lo !== 0 || hi !== 0) && (hi & 0x80000000) === 0) {
        const targetOff = ((hi & 0xf) * 4294967296) + lo;
        if (targetOff !== 0) {
          const baseVaNum = headerImageBaseNum + targetOff;
          if (baseVaNum !== rttiVaNum && (knownRttiVasNum.has(baseVaNum) || readTypeinfoHeaderNum(baseVaNum) !== null)) {
            baseRttiNums.push(baseVaNum);
            baseRttiVas.push(BigInt(baseVaNum));
            parsedSi = true;
          }
        }
      }
    }

    if (!parsedSi && kind !== 'si' && kind !== 'base' && sec && baseDelta >= 0 && baseDelta + 24 <= sec.fileSize) {
      const dv = sec.dv;
      const fOff = sec.fileOffset + baseDelta + 16;
      const flags = dv.getUint32(fOff, true);
      const baseCount = dv.getUint32(fOff + 4, true);
      if ((flags & ~0x3) === 0 && baseCount >= 1 && baseCount <= MAX_VMI_BASES && baseDelta + 24 + (baseCount * 16) <= sec.fileSize) {
        const foundNums = [];
        let ok = true;
        for (let i = 0; i < baseCount; i++) {
          const eOff = fOff + 8 + (i * 16);
          const lo = dv.getUint32(eOff, true);
          const hi = dv.getUint32(eOff + 4, true);
          if ((lo === 0 && hi === 0) || (hi & 0x80000000) !== 0) { ok = false; break; }
          const targetOff = ((hi & 0xf) * 4294967296) + lo;
          if (targetOff === 0) { ok = false; break; }
          const bVaNum = headerImageBaseNum + targetOff;
          if (bVaNum === rttiVaNum) { ok = false; break; }
          if (!knownRttiVasNum.has(bVaNum) && readTypeinfoHeaderNum(bVaNum) === null) { ok = false; break; }
          const offFlagsLo = dv.getUint32(eOff + 8, true);
          if ((offFlagsLo & 0xff) > 0x03) { ok = false; break; }
          const offFlagsRaw = dv.getBigInt64(eOff + 8, true);
          const offset = offFlagsRaw >> 8n;
          if (offset < -OFFSET_LIMIT || offset > OFFSET_LIMIT) { ok = false; break; }
          foundNums.push(bVaNum);
        }
        if (ok) {
          for (let i = 0; i < foundNums.length; i++) {
            baseRttiNums.push(foundNums[i]);
            baseRttiVas.push(BigInt(foundNums[i]));
          }
        }
      }
    }

    const segs = splitCppClassPath(header.className, MAX_NAMESPACE_DEPTH);
    const shortClassName = segs.length > 0 ? segs[segs.length - 1] : header.className;
    const namespacePath = segs.length > 1 ? segs.slice(0, -1) : [];

    const record = {
      _id: tiById.length,
      rttiVa,
      className: header.className,
      mangledName: header.rawZts,
      namespacePath,
      shortClassName,
      baseRttiVas,
      baseIds: [],
      baseClassNames: [],
    };
    tiById.push(record);
    parsedTypeinfoNum.set(rttiVaNum, record);

    if (baseRttiNums.length > 0) {
      activeVisitedNum.add(rttiVaNum);
      try {
        for (let i = 0; i < baseRttiNums.length; i++) {
          const baseRec = resolveTypeinfoFastNum(baseRttiNums[i], baseRttiVas[i], depth + 1);
          if (baseRec && baseRec.className) {
            record.baseIds.push(baseRec._id);
            record.baseClassNames.push(baseRec.className);
          }
        }
      } finally {
        activeVisitedNum.delete(rttiVaNum);
      }
    }
    return record;
  };

  const resolveTypeinfo = (rttiVa, encoding, depth = 0) => {
    if (rttiVa == null || rttiVa <= 0n) return null;
    if (parsedTypeinfoNum !== null && encoding === 'chained_offset' && rttiVa <= MAX_SAFE_BASE) {
      return resolveTypeinfoFastNum(Number(rttiVa), rttiVa, depth);
    }
    const cachedTi = parsedTypeinfo.get(rttiVa);
    if (cachedTi !== undefined) return cachedTi;
    if (depth > MAX_INHERITANCE_DEPTH || activeVisited.has(rttiVa)) return null;

    const header = readTypeinfoHeader(rttiVa, encoding);
    if (!header) {
      parsedTypeinfo.set(rttiVa, null);
      return null;
    }

    activeVisited.add(rttiVa);
    try {
      const fastChained = canFastChainedHeader && encoding === 'chained_offset' && rttiVa <= MAX_SAFE_BASE;
      const rttiVaNum = fastChained ? Number(rttiVa) : -1;
      const sec = fastChained ? reader.findSectionNum(rttiVaNum) : reader.findSection(rttiVa);
      const baseDelta = sec ? (fastChained ? (rttiVaNum - sec.vaNum) : Number(rttiVa - sec.va)) : -1;

      let kind = null;
      if (resolveBindSymbol || symbols) {
        const vptrRaw = readWordAt(sec, baseDelta, 0);
        if (vptrRaw != null && vptrRaw !== 0n) {
          const vptrDec = decodePtr(vptrRaw, rttiVa, encoding);
          let symName = null;
          if (vptrDec.isBind && resolveBindSymbol && vptrDec.ordinal != null) {
            try { symName = resolveBindSymbol(vptrDec.ordinal); } catch { symName = null; }
          } else if (!vptrDec.isBind && vptrDec.va && symbols && typeof symbols.nameAt === 'function') {
            try { symName = symbols.nameAt(vptrDec.va); } catch { symName = null; }
          }
          kind = classifyTypeinfoSymbol(symName);
        }
      }

      const baseRttiVas = [];
      const field2Off = 2 * ptrSize;

      const parseSiBase = () => {
        if (fastChained) {
          if (!sec || baseDelta < 0 || baseDelta + 24 > sec.fileSize) return false;
          const off = sec.fileOffset + baseDelta + 16;
          const lo = sec.dv.getUint32(off, true);
          const hi = sec.dv.getUint32(off + 4, true);
          if ((lo === 0 && hi === 0) || (hi & 0x80000000) !== 0) return false;
          const targetOff = ((hi & 0xf) * 4294967296) + lo;
          if (targetOff === 0) return false;
          const baseVaNum = headerImageBaseNum + targetOff;
          if (baseVaNum === rttiVaNum) return false;
          const isKnown = knownRttiVasNum !== null && knownRttiVasNum.has(baseVaNum);
          const baseVa = BigInt(baseVaNum);
          if (!isKnown && !knownRttiVas.has(baseVa) && !readTypeinfoHeader(baseVa, encoding)) return false;
          baseRttiVas.push(baseVa);
          return true;
        }
        const baseRaw = readWordAt(sec, baseDelta, field2Off);
        if (baseRaw == null || baseRaw === 0n) return false;
        const baseDec = decodePtr(baseRaw, rttiVa + BigInt(field2Off), encoding);
        if (!baseDec.va || baseDec.isBind || baseDec.va === rttiVa) return false;
        if (!knownRttiVas.has(baseDec.va) && !readTypeinfoHeader(baseDec.va, encoding)) return false;
        baseRttiVas.push(baseDec.va);
        return true;
      };

      const parseVmiBases = () => {
        if (!sec || baseDelta < 0 || baseDelta + field2Off + 8 > sec.fileSize) return false;
        const dv = sec.dv;
        const fOff = sec.fileOffset + baseDelta + field2Off;
        const flags = dv.getUint32(fOff, true);
        const baseCount = dv.getUint32(fOff + 4, true);
        if ((flags & ~0x3) !== 0) return false;
        if (baseCount < 1 || baseCount > MAX_VMI_BASES) return false;

        const found = [];
        const stride = 2 * ptrSize;
        const tableOff = field2Off + 8;
        for (let i = 0; i < baseCount; i++) {
          const entryOff = tableOff + (i * stride);
          const bTypeRaw = readWordAt(sec, baseDelta, entryOff);
          const offFlagsRaw = readSignedWordAt(sec, baseDelta, entryOff + ptrSize);
          if (bTypeRaw == null || offFlagsRaw == null) return false;
          const bType = decodePtr(bTypeRaw, rttiVa + BigInt(entryOff), encoding);
          if (!bType.va || bType.isBind || bType.va === rttiVa) return false;
          if (!knownRttiVas.has(bType.va) && !readTypeinfoHeader(bType.va, encoding)) return false;
          const lowByte = offFlagsRaw & 0xffn;
          if (lowByte > 0x03n) return false;
          const offset = offFlagsRaw >> 8n;
          if (offset < -OFFSET_LIMIT || offset > OFFSET_LIMIT) return false;
          found.push(bType.va);
        }
        for (let i = 0; i < found.length; i++) baseRttiVas.push(found[i]);
        return true;
      };

      if (kind === 'si') {
        parseSiBase();
      } else if (kind === 'vmi') {
        parseVmiBases();
      } else if (kind !== 'base') {
        if (!parseSiBase()) {
          parseVmiBases();
        }
      }

      const segs = splitCppClassPath(header.className, MAX_NAMESPACE_DEPTH);
      const shortClassName = segs.length > 0 ? segs[segs.length - 1] : header.className;
      const namespacePath = segs.length > 1 ? segs.slice(0, -1) : [];

      const record = {
        _id: tiById.length,
        rttiVa,
        className: header.className,
        mangledName: header.rawZts,
        namespacePath,
        shortClassName,
        baseRttiVas,
        baseIds: [],
        baseClassNames: [],
      };
      tiById.push(record);
      parsedTypeinfo.set(rttiVa, record);

      for (let i = 0; i < baseRttiVas.length; i++) {
        const baseRec = resolveTypeinfo(baseRttiVas[i], encoding, depth + 1);
        if (baseRec && baseRec.className) {
          record.baseIds.push(baseRec._id);
          record.baseClassNames.push(baseRec.className);
        }
      }

      return record;
    } finally {
      activeVisited.delete(rttiVa);
    }
  };

  let truncated = false;
  let namedVtables = 0;
  let totalSlots = 0;

  const byRttiVa = new Map();
  const fnCandidates = new Map();

  let slotFnOff = null;
  let slotIdxArr = null;
  let slotVtVaNum = null;
  let slotTiIdArr = null;
  let slotOffArr = null;
  let byFunctionRef = null;

  class FastClassRecord {
    constructor(ti) {
      this._tiId = ti._id;
      this.className = ti.className;
      this.mangledName = ti.mangledName;
      this.namespacePath = ti.namespacePath;
      this.shortClassName = ti.shortClassName;
      this.rttiVa = ti.rttiVa;
      this.vtableVas = [];
      this.baseRttiVas = ti.baseRttiVas;
      this.baseClassNames = ti.baseClassNames;
      this.methodCount = 0;
      this._slotRanges = null;
      this._eagerMethods = null;
      this._methodsCache = null;
    }
    get methods() {
      if (this._methodsCache !== null) return this._methodsCache;
      const out = this._eagerMethods ? this._eagerMethods.slice() : [];
      const ranges = this._slotRanges;
      if (ranges) {
        const clsRttiVa = this.rttiVa;
        for (let r = 0; r < ranges.length; r += 2) {
          const rStart = ranges[r];
          const rEnd = ranges[r + 1];
          for (let p = rStart; p < rEnd; p++) {
            const fOff = slotFnOff[p];
            const vtVa = BigInt(slotVtVaNum[p]);
            if (fOff < 0) {
              out.push({
                fnVa: null,
                slotIndex: slotIdxArr[p],
                vtableVa: vtVa,
                isPrimaryOwner: false,
                isPureVirtualBind: true,
              });
            } else {
              const fnVa = imageBase + BigInt(fOff);
              const link = byFunctionRef ? byFunctionRef.get(fnVa) : null;
              out.push({
                fnVa,
                slotIndex: slotIdxArr[p],
                vtableVa: vtVa,
                isPrimaryOwner: Boolean(link && link.primaryRttiVa === clsRttiVa),
              });
            }
          }
        }
      }
      this._methodsCache = out;
      return out;
    }
    pushEagerMethod(m) {
      if (this._eagerMethods === null) this._eagerMethods = [];
      this._eagerMethods.push(m);
      this.methodCount++;
    }
  }

  const clsByTiId = [];
  const getOrCreateClassRecord = (ti) => {
    let cls = clsByTiId[ti._id];
    if (cls !== undefined) return cls;
    if (byRttiVa.size >= maxClasses) {
      truncated = true;
      return null;
    }
    cls = new FastClassRecord(ti);
    clsByTiId[ti._id] = cls;
    byRttiVa.set(ti.rttiVa, cls);
    return cls;
  };

  const textLoOffNum = canUseFastChained64 ? Number(textLo - imageBase) : 0;
  const textHiOffNum = canUseFastChained64 ? Number(textHi - imageBase) : 0;
  const imageBaseNum = canUseFastChained64 ? Number(imageBase) : 0;

  // Flat TypedArray slot storage for fast chained_offset path (zero per-slot JS objects).
  let slotCap = canUseFastChained64 ? Math.max(4096, Math.min(524288, vtableList.length * 32)) : 0;
  slotFnOff = canUseFastChained64 ? new Int32Array(slotCap) : null;
  slotIdxArr = canUseFastChained64 ? new Int32Array(slotCap) : null;
  slotVtVaNum = canUseFastChained64 ? new Float64Array(slotCap) : null;
  slotTiIdArr = canUseFastChained64 ? new Int32Array(slotCap) : null;
  slotOffArr = canUseFastChained64 ? new Int32Array(slotCap) : null;
  let slotCount = 0;

  const growSlotBuffers = (needed) => {
    let nextCap = slotCap;
    while (nextCap < needed) nextCap *= 2;
    const growF64 = (old) => { const a = new Float64Array(nextCap); a.set(old); return a; };
    const growI32 = (old) => { const a = new Int32Array(nextCap); a.set(old); return a; };
    slotFnOff = growI32(slotFnOff);
    slotIdxArr = growI32(slotIdxArr);
    slotVtVaNum = growF64(slotVtVaNum);
    slotTiIdArr = growI32(slotTiIdArr);
    slotOffArr = growI32(slotOffArr);
    slotCap = nextCap;
  };

  // Flat linked-list per unique fnVaNum: headSlot[fnId], nextSlot[slotPos] (zero Array allocs per slot!).
  let slotNext = canUseFastChained64 ? new Int32Array(slotCap) : null;
  const growSlotNext = () => {
    const a = new Int32Array(slotCap);
    a.set(slotNext);
    slotNext = a;
  };
  // Open-addressing Int32Array hash table: targetOff (SMI > 0) -> head slotPos (zero GC, ~3ms for 400k slots).
  let htSize = canUseFastChained64 ? 131072 : 0;
  let htMask = htSize - 1;
  let htKey = canUseFastChained64 ? new Int32Array(htSize) : null;
  let htHead = canUseFastChained64 ? new Int32Array(htSize) : null;
  let htCount = 0;
  let htLimit = (htSize * 3) >>> 2;

  const fastState = canUseFastChained64 ? {
    slotCount: 0,
    totalSlots: 0,
    slotFnOff,
    slotIdxArr,
    slotVtVaNum,
    slotTiIdArr,
    slotOffArr,
    slotNext,
    htKey,
    htHead,
    htMask,
    htCount: 0,
    htLimit,
    rehash() {
      const oldKey = htKey;
      const oldHead = htHead;
      const oldSize = htSize;
      htSize *= 2;
      htMask = htSize - 1;
      htLimit = (htSize * 3) >>> 2;
      htKey = new Int32Array(htSize);
      htHead = new Int32Array(htSize);
      for (let i = 0; i < oldSize; i++) {
        const k = oldKey[i];
        if (k === 0) continue;
        let idx = ((k >>> 2) * 2654435761) & htMask;
        while (htKey[idx] !== 0) idx = (idx + 1) & htMask;
        htKey[idx] = k;
        htHead[idx] = oldHead[i];
      }
      this.htKey = htKey;
      this.htHead = htHead;
      this.htMask = htMask;
      this.htLimit = htLimit;
    },
  } : null;

  for (let i = 0; i < vtableList.length; i++) {
    const v = vtableList[i];
    if (!v || typeof v !== 'object') continue;
    if (!v.hasRtti) continue;
    const rawRtti = v.rttiVa;
    const rttiVa = (typeof rawRtti === 'bigint' && rawRtti > 0n) ? rawRtti : toBigIntOrNull(rawRtti);
    if (rttiVa == null || rttiVa === 0n) continue;

    const encoding = v.encoding || (pointerFormat === 6 ? 'chained_offset' : 'absolute');
    const ti = (parsedTypeinfoNum !== null && encoding === 'chained_offset' && rttiVa <= MAX_SAFE_BASE)
      ? resolveTypeinfoFastNum(Number(rttiVa), rttiVa, 0)
      : resolveTypeinfo(rttiVa, encoding);
    if (!ti) continue;

    const cls = getOrCreateClassRecord(ti);
    if (!cls) continue;

    namedVtables++;
    const vtableVa = (typeof v.va === 'bigint' && v.va >= 0n) ? v.va : resolveVtableVa(v);
    const offsetToTop = typeof v.offsetToTop === 'number' && Number.isFinite(v.offsetToTop)
      ? v.offsetToTop
      : 0;

    if (vtableVa != null) {
      cls.vtableVas.push({ va: vtableVa, offsetToTop });
    }

    const rawEntryCount = toSafeNonNegInt(v.entryCount) ?? 0;
    if (rawEntryCount > maxSlotsPerVtable) truncated = true;
    const minSlotCount = Math.min(rawEntryCount, maxSlotsPerVtable);
    const slotStride = encoding === 'relative32' ? 4 : ptrSize;

    if (vtableVa != null && minSlotCount > 0) {
      const vtSec = (canUseFastChained64 && vtableVa <= MAX_SAFE_BASE)
        ? reader.findSectionNum(Number(vtableVa))
        : reader.findSection(vtableVa);
      if (!vtSec) continue;
      const vtDelta = (canUseFastChained64 && vtSec.vaNum >= 0 && vtableVa <= MAX_SAFE_BASE)
        ? (Number(vtableVa) - vtSec.vaNum)
        : Number(vtableVa - vtSec.va);
      const dv = vtSec.dv;
      const baseOff = vtSec.fileOffset + vtDelta;
      const maxByteEnd = vtSec.fileOffset + vtSec.fileSize;

      if (canUseFastChained64 && encoding === 'chained_offset' && vtableVa <= MAX_SAFE_BASE) {
        const rangeStart = fastState.slotCount;
        const maxPossible = rangeStart + maxSlotsPerVtable;
        if (maxPossible > slotCap) {
          growSlotBuffers(maxPossible);
          growSlotNext();
          fastState.slotFnOff = slotFnOff;
          fastState.slotIdxArr = slotIdxArr;
          fastState.slotVtVaNum = slotVtVaNum;
          fastState.slotTiIdArr = slotTiIdArr;
          fastState.slotOffArr = slotOffArr;
          fastState.slotNext = slotNext;
        }
        fastState.totalSlots = totalSlots;
        scanChained64VtableSlots(
          dv,
          baseOff,
          maxByteEnd,
          Number(vtableVa),
          cls._tiId,
          offsetToTop,
          minSlotCount,
          maxSlotsPerVtable,
          textLoOffNum,
          textHiOffNum,
          knownVtableHeadersNum,
          knownRttiVasNum,
          fastState,
        );
        slotCount = fastState.slotCount;
        totalSlots = fastState.totalSlots;
        htCount = fastState.htCount;
        const added = slotCount - rangeStart;
        if (added > 0) {
          if (!cls._slotRanges) cls._slotRanges = [];
          cls._slotRanges.push(rangeStart, slotCount);
          cls.methodCount = (cls.methodCount || 0) + added;
        }
      } else {
        const slotStrideBig = BigInt(slotStride);
        for (let s = 0; s < maxSlotsPerVtable; s++) {
          const bytePos = baseOff + (s * slotStride);
          if (bytePos + slotStride > maxByteEnd) break;
          const slotVa = vtableVa + (BigInt(s) * slotStrideBig);

          if (s >= minSlotCount) {
            if (
              knownVtableHeaders.has(slotVa)
              || knownRttiVas.has(slotVa)
              || (slotVa <= MAX_SAFE_BASE && (
                knownVtableHeadersNum?.has(Number(slotVa))
                || knownRttiVasNum?.has(Number(slotVa))
              ))
            ) break;
          }

          const raw = slotStride === 4
            ? BigInt(dv.getUint32(bytePos, true))
            : dv.getBigUint64(bytePos, true);

          if (raw === 0n) {
            if (s >= minSlotCount) break;
            continue;
          }

          const dec = decodePtr(raw, slotVa, encoding);
          if (dec.isBind) {
            totalSlots++;
            cls.pushEagerMethod({
              fnVa: null,
              slotIndex: s,
              vtableVa,
              isPrimaryOwner: false,
              isPureVirtualBind: true,
            });
            continue;
          }

          if (!dec.va || !isCodeVa(dec.va)) {
            if (s >= minSlotCount) break;
            continue;
          }

          totalSlots++;
          cls.pushEagerMethod({
            fnVa: dec.va,
            slotIndex: s,
            vtableVa,
            isPrimaryOwner: false,
          });

          let list = fnCandidates.get(dec.va);
          if (!list) {
            list = [];
            fnCandidates.set(dec.va, list);
          }
          list.push({
            _tiId: cls._tiId,
            className: cls.className,
            rttiVa: cls.rttiVa,
            vtableVa,
            slotIndex: s,
            offsetToTop,
          });
        }
      }
    }
  }

  // Dense integer-indexed ancestor lists + Int32Array stamp tables (zero Map/Set allocations per function).
  const numTi = tiById.length;
  const EMPTY_ANC_ARR = Object.freeze([]);
  const ancCacheById = new Array(numTi);
  const ancVisitStamp = new Int32Array(numTi);
  let ancStampSeq = 0;

  const getAncestorIds = (tiId) => {
    const cached = ancCacheById[tiId];
    if (cached !== undefined) return cached;
    const ti0 = tiById[tiId];
    if (!ti0 || ti0.baseIds.length === 0) {
      ancCacheById[tiId] = EMPTY_ANC_ARR;
      return EMPTY_ANC_ARR;
    }
    ancStampSeq++;
    const mark = ancStampSeq;
    ancVisitStamp[tiId] = mark;
    const out = [];
    const stack = [tiId];
    const depths = [0];
    while (stack.length > 0) {
      const curId = stack.pop();
      const curDepth = depths.pop();
      if (curDepth >= MAX_INHERITANCE_DEPTH) continue;
      const bases = tiById[curId].baseIds;
      for (let i = 0; i < bases.length; i++) {
        const bId = bases[i];
        if (ancVisitStamp[bId] === mark) continue;
        ancVisitStamp[bId] = mark;
        out.push(bId);
        const bCached = ancCacheById[bId];
        if (bCached !== undefined) {
          for (let j = 0; j < bCached.length; j++) {
            const aId = bCached[j];
            if (ancVisitStamp[aId] !== mark) {
              ancVisitStamp[aId] = mark;
              out.push(aId);
            }
          }
        } else {
          stack.push(bId);
          depths.push(curDepth + 1);
        }
      }
    }
    ancCacheById[tiId] = out;
    return out;
  };

  // Reused O(1) stamp & best-owner scratch buffers.
  const poolStamp = new Int32Array(numTi);
  const poolBestSlot = new Int32Array(numTi);
  const poolBestObj = new Array(numTi);
  let poolStampSeq = 0;
  const uniqueOwnersScratch = [];

  const EMPTY_SHARED_OWNERS = Object.freeze([]);
  let sharedFunctions = 0;

  // Materialize allOwners lazily from the flat linked list for fast chained_offset path.
  const materializeOwnersFromHead = (headPos) => {
    const out = [];
    for (let p = headPos; p >= 0; p = slotNext[p]) {
      const ti = tiById[slotTiIdArr[p]];
      out.push({
        className: ti.className,
        rttiVa: ti.rttiVa,
        vtableVa: BigInt(slotVtVaNum[p]),
        slotIndex: slotIdxArr[p],
        offsetToTop: slotOffArr[p],
      });
    }
    out.reverse();
    return out;
  };

  class FastFuncLink {
    #headPos;
    #allOwnersCache = null;
    constructor(fnVa, primaryOwner, primaryRttiVa, slotIndex, isShared, sharedOwners, headPos) {
      this.fnVa = fnVa;
      this.primaryOwner = primaryOwner;
      this.primaryRttiVa = primaryRttiVa;
      this.slotIndex = slotIndex;
      this.isShared = isShared;
      this.sharedOwners = sharedOwners;
      this.#headPos = headPos;
    }
    get allOwners() {
      if (this.#allOwnersCache === null) {
        this.#allOwnersCache = materializeOwnersFromHead(this.#headPos);
      }
      return this.#allOwnersCache;
    }
  }

  // Parallel TypedArrays storing resolved primary owner TiId & slotIndex for O(1) zero-GC Map lookup.
  const htPrimaryTi = htCount > 0 ? new Int32Array(htSize) : null;
  const htPrimarySlot = htCount > 0 ? new Int32Array(htSize) : null;
  const sharedByHIdx = htCount > 0 ? new Map() : null;

  // 1) Resolve fast chained_offset functions directly into TypedArrays (zero 50k BigInt/FastFuncLink allocs!).
  if (htCount > 0) {
    for (let hIdx = 0; hIdx < htSize; hIdx++) {
      const fnOff = htKey[hIdx];
      if (fnOff === 0) continue;
      const headPos = htHead[hIdx];
      const nextPos = slotNext[headPos];
      if (nextPos < 0) {
        htPrimaryTi[hIdx] = slotTiIdArr[headPos];
        htPrimarySlot[hIdx] = slotIdxArr[headPos];
        continue;
      }

      let hasPrimaryVtable = false;
      for (let p = headPos; p >= 0; p = slotNext[p]) {
        if (slotOffArr[p] === 0) {
          hasPrimaryVtable = true;
          break;
        }
      }

      poolStampSeq++;
      const mark = poolStampSeq;
      uniqueOwnersScratch.length = 0;
      for (let p = headPos; p >= 0; p = slotNext[p]) {
        if (hasPrimaryVtable && slotOffArr[p] !== 0) continue;
        const id = slotTiIdArr[p];
        const sIdx = slotIdxArr[p];
        if (poolStamp[id] !== mark) {
          poolStamp[id] = mark;
          poolBestSlot[id] = sIdx;
          uniqueOwnersScratch.push(id);
        } else if (sIdx < poolBestSlot[id]) {
          poolBestSlot[id] = sIdx;
        }
      }

      const uLen = uniqueOwnersScratch.length;
      if (uLen === 1) {
        const onlyId = uniqueOwnersScratch[0];
        htPrimaryTi[hIdx] = onlyId;
        htPrimarySlot[hIdx] = poolBestSlot[onlyId];
        continue;
      }

      let minimalId = -1;
      let minimalCount = 0;
      for (let i = 0; i < uLen; i++) {
        const candId = uniqueOwnersScratch[i];
        const anc = getAncestorIds(candId);
        let hasAncestorInPool = false;
        for (let j = 0; j < anc.length; j++) {
          if (poolStamp[anc[j]] === mark) {
            hasAncestorInPool = true;
            break;
          }
        }
        if (!hasAncestorInPool) {
          minimalId = candId;
          minimalCount++;
          if (minimalCount > 1) break;
        }
      }

      let dominatorId = -1;
      if (minimalCount === 1) {
        let dominatesAll = true;
        for (let i = 0; i < uLen; i++) {
          const otherId = uniqueOwnersScratch[i];
          if (otherId === minimalId) continue;
          const anc = getAncestorIds(otherId);
          let found = false;
          for (let j = 0; j < anc.length; j++) {
            if (anc[j] === minimalId) {
              found = true;
              break;
            }
          }
          if (!found) {
            dominatesAll = false;
            break;
          }
        }
        if (dominatesAll) dominatorId = minimalId;
      }

      if (dominatorId >= 0) {
        htPrimaryTi[hIdx] = dominatorId;
        htPrimarySlot[hIdx] = poolBestSlot[dominatorId];
      } else {
        const sharedSet = new Set();
        for (let i = 0; i < uLen; i++) sharedSet.add(tiById[uniqueOwnersScratch[i]].className);
        const sharedOwners = Array.from(sharedSet).sort(compareLex);
        sharedFunctions++;
        htPrimaryTi[hIdx] = -1;
        htPrimarySlot[hIdx] = poolBestSlot[uniqueOwnersScratch[0]];
        sharedByHIdx.set(hIdx, sharedOwners);
      }
    }
  }

  // Tombstone value -1 in htKey distinguishes deleted/migrated slots from empty slot 0.
  const probeFastIdx = (key) => {
    if (htCount === 0 || typeof key !== 'bigint') return -1;
    if (key < textLo || key >= textHi) return -1;
    // Zero-allocation exact floating-point offset (textHi <= MAX_SAFE_BASE guarantees 53-bit exactness).
    const off = Number(key) - imageBaseNum;
    if (off <= 0) return -1;
    let hIdx = ((off >>> 2) * 2654435761) & htMask;
    while (true) {
      const k = htKey[hIdx];
      if (k === off) return hIdx;
      if (k === 0) return -1;
      hIdx = (hIdx + 1) & htMask;
    }
  };

  // Merge any fnVa present in BOTH fast (chained_offset) and slow (absolute/relative32) paths into fnCandidates.
  if (htCount > 0 && fnCandidates.size > 0) {
    for (const [fnVa, slowOwners] of fnCandidates.entries()) {
      const hIdx = probeFastIdx(fnVa);
      if (hIdx < 0) continue;
      if (htPrimaryTi[hIdx] < 0) sharedFunctions = Math.max(0, sharedFunctions - 1);
      for (let p = htHead[hIdx]; p >= 0; p = slotNext[p]) {
        const ti = tiById[slotTiIdArr[p]];
        slowOwners.push({
          _tiId: slotTiIdArr[p],
          className: ti.className,
          rttiVa: ti.rttiVa,
          vtableVa: BigInt(slotVtVaNum[p]),
          slotIndex: slotIdxArr[p],
          offsetToTop: slotOffArr[p],
        });
      }
      htKey[hIdx] = -1;
      htCount--;
    }
  }

  const buildLinkAt = (hIdx, fnVa) => {
    const tiId = htPrimaryTi[hIdx];
    const sIdx = htPrimarySlot[hIdx];
    const headPos = htHead[hIdx];
    if (tiId >= 0) {
      const ti = tiById[tiId];
      return new FastFuncLink(fnVa, ti.className, ti.rttiVa, sIdx, false, EMPTY_SHARED_OWNERS, headPos);
    }
    const sharedOwners = sharedByHIdx.get(hIdx) || EMPTY_SHARED_OWNERS;
    return new FastFuncLink(fnVa, null, null, sIdx, true, sharedOwners, headPos);
  };

  class LazyRttiFunctionMap extends Map {
    get size() {
      return super.size + htCount;
    }
    has(key) {
      if (super.has(key)) return true;
      return probeFastIdx(key) >= 0;
    }
    get(key) {
      const v = super.get(key);
      if (v !== undefined) return v;
      const hIdx = probeFastIdx(key);
      if (hIdx < 0) return undefined;
      return buildLinkAt(hIdx, key);
    }
    set(key, value) {
      const hIdx = probeFastIdx(key);
      if (hIdx >= 0) {
        htKey[hIdx] = -1;
        htCount--;
      }
      return super.set(key, value);
    }
    delete(key) {
      const deletedSuper = super.delete(key);
      const hIdx = probeFastIdx(key);
      if (hIdx >= 0) {
        htKey[hIdx] = -1;
        htCount--;
        return true;
      }
      return deletedSuper;
    }
    clear() {
      super.clear();
      if (htCount > 0 && htKey) {
        htKey.fill(0);
        htCount = 0;
      }
    }
    *keys() {
      yield* super.keys();
      if (htCount > 0) {
        for (let i = 0; i < htSize; i++) {
          const fnOff = htKey[i];
          if (fnOff > 0) yield imageBase + BigInt(fnOff);
        }
      }
    }
    *values() {
      yield* super.values();
      if (htCount > 0) {
        for (let i = 0; i < htSize; i++) {
          const fnOff = htKey[i];
          if (fnOff > 0) yield buildLinkAt(i, imageBase + BigInt(fnOff));
        }
      }
    }
    *entries() {
      yield* super.entries();
      if (htCount > 0) {
        for (let i = 0; i < htSize; i++) {
          const fnOff = htKey[i];
          if (fnOff > 0) {
            const va = imageBase + BigInt(fnOff);
            yield [va, buildLinkAt(i, va)];
          }
        }
      }
    }
    [Symbol.iterator]() {
      return this.entries();
    }
    _forEachPrimary(cb) {
      for (const [va, link] of super.entries()) {
        cb(va, link.primaryOwner, Boolean(link.isShared), link.sharedOwners);
      }
      if (htCount > 0) {
        for (let i = 0; i < htSize; i++) {
          const fnOff = htKey[i];
          if (fnOff <= 0) continue;
          const tiId = htPrimaryTi[i];
          const va = imageBase + BigInt(fnOff);
          if (tiId >= 0) {
            cb(va, tiById[tiId].className, false, EMPTY_SHARED_OWNERS);
          } else {
            cb(va, null, true, sharedByHIdx.get(i) || EMPTY_SHARED_OWNERS);
          }
        }
      }
    }
    forEach(cb, thisArg) {
      super.forEach(cb, thisArg);
      if (htCount > 0) {
        for (let i = 0; i < htSize; i++) {
          const fnOff = htKey[i];
          if (fnOff > 0) {
            const va = imageBase + BigInt(fnOff);
            cb.call(thisArg, buildLinkAt(i, va), va, this);
          }
        }
      }
    }
  }

  const byFunction = htCount > 0 ? new LazyRttiFunctionMap() : new Map();
  byFunctionRef = byFunction;

  // 2) Resolve slow-path (non-chained_offset) functions.
  for (const [fnVa, rawOwners] of fnCandidates.entries()) {
    if (rawOwners.length === 1) {
      const only = rawOwners[0];
      byFunction.set(fnVa, {
        fnVa,
        primaryOwner: only.className,
        primaryRttiVa: only.rttiVa,
        slotIndex: only.slotIndex,
        isShared: false,
        sharedOwners: EMPTY_SHARED_OWNERS,
        allOwners: rawOwners,
      });
      continue;
    }

    let hasPrimaryVtable = false;
    for (let i = 0; i < rawOwners.length; i++) {
      if (rawOwners[i].offsetToTop === 0) {
        hasPrimaryVtable = true;
        break;
      }
    }

    poolStampSeq++;
    const mark = poolStampSeq;
    uniqueOwnersScratch.length = 0;
    for (let i = 0; i < rawOwners.length; i++) {
      const item = rawOwners[i];
      if (hasPrimaryVtable && item.offsetToTop !== 0) continue;
      const id = item._tiId;
      if (poolStamp[id] !== mark) {
        poolStamp[id] = mark;
        poolBestObj[id] = item;
        uniqueOwnersScratch.push(id);
      } else if (item.slotIndex < poolBestObj[id].slotIndex) {
        poolBestObj[id] = item;
      }
    }

    const uLen = uniqueOwnersScratch.length;
    if (uLen === 1) {
      const only = poolBestObj[uniqueOwnersScratch[0]];
      byFunction.set(fnVa, {
        fnVa,
        primaryOwner: only.className,
        primaryRttiVa: only.rttiVa,
        slotIndex: only.slotIndex,
        isShared: false,
        sharedOwners: EMPTY_SHARED_OWNERS,
        allOwners: rawOwners,
      });
      continue;
    }

    let minimalId = -1;
    let minimalCount = 0;
    for (let i = 0; i < uLen; i++) {
      const candId = uniqueOwnersScratch[i];
      const anc = getAncestorIds(candId);
      let hasAncestorInPool = false;
      for (let j = 0; j < anc.length; j++) {
        if (poolStamp[anc[j]] === mark) {
          hasAncestorInPool = true;
          break;
        }
      }
      if (!hasAncestorInPool) {
        minimalId = candId;
        minimalCount++;
        if (minimalCount > 1) break;
      }
    }

    let uniqueDominator = null;
    if (minimalCount === 1) {
      let dominatesAll = true;
      for (let i = 0; i < uLen; i++) {
        const otherId = uniqueOwnersScratch[i];
        if (otherId === minimalId) continue;
        const anc = getAncestorIds(otherId);
        let found = false;
        for (let j = 0; j < anc.length; j++) {
          if (anc[j] === minimalId) {
            found = true;
            break;
          }
        }
        if (!found) {
          dominatesAll = false;
          break;
        }
      }
      if (dominatesAll) uniqueDominator = poolBestObj[minimalId];
    }

    if (uniqueDominator) {
      byFunction.set(fnVa, {
        fnVa,
        primaryOwner: uniqueDominator.className,
        primaryRttiVa: uniqueDominator.rttiVa,
        slotIndex: uniqueDominator.slotIndex,
        isShared: false,
        sharedOwners: EMPTY_SHARED_OWNERS,
        allOwners: rawOwners,
      });
    } else {
      const sharedSet = new Set();
      for (let i = 0; i < uLen; i++) sharedSet.add(poolBestObj[uniqueOwnersScratch[i]].className);
      const sharedOwners = Array.from(sharedSet).sort(compareLex);
      sharedFunctions++;
      byFunction.set(fnVa, {
        fnVa,
        primaryOwner: null,
        primaryRttiVa: null,
        slotIndex: poolBestObj[uniqueOwnersScratch[0]].slotIndex,
        isShared: true,
        sharedOwners,
        allOwners: rawOwners,
      });
    }
  }

  const classes = Array.from(byRttiVa.values());
  if (fnCandidates.size > 0) {
    for (let i = 0; i < classes.length; i++) {
      const cls = classes[i];
      const eager = cls._eagerMethods;
      if (!eager || eager.length === 0) continue;
      for (let j = 0; j < eager.length; j++) {
        const m = eager[j];
        if (m.fnVa == null) continue;
        const link = byFunction.get(m.fnVa);
        if (link && link.primaryRttiVa === cls.rttiVa) {
          m.isPrimaryOwner = true;
        }
      }
    }
  }

  const t1 = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

  return {
    classes,
    byFunction,
    byRttiVa,
    completeness: truncated ? 'partial' : 'complete',
    truncated,
    stats: {
      vtablesInput: vtableList.length,
      namedVtables,
      uniqueClasses: classes.length,
      totalSlots,
      linkedFunctions: byFunction.size,
      sharedFunctions,
      elapsedMs: Math.max(0, Number((t1 - t0).toFixed(2))),
    },
  };
}
