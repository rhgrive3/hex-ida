/**
 * Stripped Mach-O Objective-C Method Resolver
 *
 * Recovers Objective-C classes, metaclasses, categories, superclasses, selectors,
 * and IMP function VAs from stripped Mach-O binaries (`__objc_classlist`, `__objc_catlist`),
 * supporting both modern relative small method lists (`0x80000000`) and 64-bit large
 * method lists under DYLD_CHAINED_PTR_64_OFFSET, arm64e (formats 1/7/9/10/12), PAC, and raw VAs.
 *
 * Zero external static imports (self-contained pure JS).
 */

const U32_MASK = 0xffffffffn;
const U36_MASK = 0xfffffffffn;
const U43_MASK = 0x7ffffffffffn;
const MAX_METHODS_PER_LIST = 16384;
const DEFAULT_MAX_CLASSES = 50000;

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

function normalizeSectionList(sections, bytesLen) {
  if (!Array.isArray(sections)) return [];
  const out = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (!s || typeof s !== 'object') continue;
    const va = toBigIntSafe(s.address ?? s.vaddr ?? s.addr ?? s.vmAddr ?? s.va);
    const foffRaw = s.fileOffset ?? s.offset ?? s.fileOff ?? s.foff;
    const foff = typeof foffRaw === 'bigint' ? Number(foffRaw) : Number(foffRaw);
    const sizeRaw = s.size ?? s.byteLength ?? s.fileSize ?? 0;
    const size = typeof sizeRaw === 'bigint' ? Number(sizeRaw) : Number(sizeRaw);
    const fsizeRaw = s.fileSize ?? s.size ?? s.byteLength ?? 0;
    const fsize = typeof fsizeRaw === 'bigint' ? Number(fsizeRaw) : Number(fsizeRaw);
    if (va == null || !Number.isFinite(foff) || foff < 0 || !Number.isFinite(size) || size <= 0) continue;
    const clampedFsize = Math.min(Math.max(0, Number.isFinite(fsize) ? fsize : size), Math.max(0, bytesLen - foff));
    if (clampedFsize <= 0) continue;
    out.push({
      name: String(s.name || s.sectname || ''),
      segment: String(s.segment || s.segname || ''),
      va,
      vaEnd: va + BigInt(size),
      foff,
      fsize: clampedFsize,
    });
  }
  out.sort((a, b) => (a.va < b.va ? -1 : a.va > b.va ? 1 : 0));
  return out;
}

function createImageReader(bytes, sections) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const secs = normalizeSectionList(sections, bytes.length);
  const n = secs.length;

  const findSection = (va) => {
    let lo = 0;
    let hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const s = secs[mid];
      if (va < s.va) hi = mid - 1;
      else if (va >= s.vaEnd) lo = mid + 1;
      else return s;
    }
    return null;
  };

  const vaToOffset = (va) => {
    if (va == null || va <= 0n) return -1;
    const s = findSection(va);
    if (!s) return -1;
    const delta = Number(va - s.va);
    if (delta < 0 || delta >= s.fsize) return -1;
    return s.foff + delta;
  };

  const readU32Off = (off) => (off >= 0 && off + 4 <= bytes.length ? dv.getUint32(off, true) : null);
  const readI32Off = (off) => (off >= 0 && off + 4 <= bytes.length ? dv.getInt32(off, true) : null);
  const readU64Off = (off) => (off >= 0 && off + 8 <= bytes.length ? dv.getBigUint64(off, true) : null);

  const readCStringAtVa = (va, maxLen = 256) => {
    const off = vaToOffset(va);
    if (off < 0) return null;
    const limit = Math.min(bytes.length, off + maxLen);
    let end = off;
    while (end < limit && bytes[end] !== 0) {
      const b = bytes[end];
      if (b < 0x20 || b > 0x7e) return null;
      end++;
    }
    if (end === off || end >= bytes.length || bytes[end] !== 0) return null;
    let out = '';
    for (let i = off; i < end; i++) out += String.fromCharCode(bytes[i]);
    return out;
  };

  return {
    secs,
    findSection,
    vaToOffset,
    readU32Off,
    readI32Off,
    readU64Off,
    readCStringAtVa,
  };
}

function decodeObjcPointer(raw, { imageBase = 0n, pointerFormat = null, stripPac = true, reader = null } = {}) {
  if (raw == null || raw === 0n) return null;

  if (
    pointerFormat === 1
    || pointerFormat === 7
    || pointerFormat === 9
    || pointerFormat === 10
    || pointerFormat === 12
  ) {
    const auth = ((raw >> 63n) & 1n) !== 0n;
    const bind = ((raw >> 62n) & 1n) !== 0n;
    if (bind) return null;
    if (auth) {
      return imageBase + (raw & U32_MASK);
    }
    const target = raw & U43_MASK;
    if (target === 0n) return null;
    return (pointerFormat === 1 || pointerFormat === 10) ? target : imageBase + target;
  }

  // Mach-O DYLD_CHAINED_PTR_64_OFFSET bind bit (bit 63)
  if ((raw & (1n << 63n)) !== 0n) {
    if (stripPac && imageBase > 0n) {
      const stripped = raw & 0x0000ffffffffffffn;
      if (reader && reader.vaToOffset(stripped) >= 0) return stripped;
    }
    return null;
  }

  // Raw VA in known section or code
  if (raw >= imageBase && imageBase > 0n) {
    if (!reader || reader.vaToOffset(raw) >= 0) return raw;
  }

  // Chained offset rebase (low 36 bits relative to imageBase)
  if (imageBase > 0n) {
    const cand = imageBase + (raw & U36_MASK);
    if (cand > imageBase && (!reader || reader.vaToOffset(cand) >= 0)) return cand;
  }

  // PAC-stripped VA fallback
  if (stripPac) {
    const stripped = raw & 0x0000ffffffffffffn;
    if (stripped > 0n && (!reader || reader.vaToOffset(stripped) >= 0)) return stripped;
  }

  return null;
}

function isValidClassName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 256) return false;
  if (name === '__proto__' || name === 'constructor' || name === 'prototype') return false;
  return /^[A-Za-z_$.][A-Za-z0-9_$.:+<>-]*$/.test(name);
}

/**
 * Resolve Objective-C classes and method IMP VAs from a stripped Mach-O image.
 *
 * @param {object} opts
 * @returns {{
 *   classes: Array<{ className: string, superClass: string|null, methods: Array<{ imp: bigint, selector: string|null }>, classMethods: Array<{ imp: bigint, selector: string|null }> }>,
 *   methodsByIMP: Map<bigint, { imp: bigint, className: string, selector: string|null, classMethod: boolean }>,
 *   completeness: 'complete'|'partial',
 *   truncated: boolean,
 *   stats: { classListCount: number, catListCount: number, classesRecovered: number, methodsRecovered: number, elapsedMs: number }
 * }}
 */
export function resolveStrippedObjcMethods(opts = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const empty = () => ({
    classes: [],
    methodsByIMP: new Map(),
    completeness: 'complete',
    truncated: false,
    stats: {
      classListCount: 0,
      catListCount: 0,
      classesRecovered: 0,
      methodsRecovered: 0,
      elapsedMs: 0,
    },
  });

  if (!opts || typeof opts !== 'object') return empty();
  const image = opts.image && typeof opts.image === 'object' ? opts.image : null;
  const rawBytes = image?.bytes ?? opts.bytes ?? null;
  if (!(rawBytes instanceof Uint8Array) || rawBytes.length < 16) return empty();

  const sections = Array.isArray(image?.sections) ? image.sections : (Array.isArray(opts.sections) ? opts.sections : []);
  if (sections.length === 0) return empty();

  const ptrSize = opts.ptrSize === 4 ? 4 : 8;
  if (ptrSize !== 8) return empty();

  const imageBase = toBigIntSafe(opts.imageBase ?? image?.imageBase ?? 0n) ?? 0n;
  const textLo = toBigIntSafe(opts.textLo) ?? 0n;
  const textHi = toBigIntSafe(opts.textHi) ?? 0n;
  const pointerFormat = opts.pointerFormat ?? null;
  const stripPac = opts.stripPac !== false;
  const maxClasses = Number.isInteger(opts.maxClasses) && opts.maxClasses > 0 ? opts.maxClasses : DEFAULT_MAX_CLASSES;

  const reader = createImageReader(rawBytes, sections);
  const ptrOpts = { imageBase, pointerFormat, stripPac, reader };

  let classListSec = null;
  let catListSec = null;
  let textSec = null;
  for (let i = 0; i < reader.secs.length; i++) {
    const s = reader.secs[i];
    if (s.name === '__objc_classlist') classListSec = s;
    else if (s.name === '__objc_catlist') catListSec = s;
    else if (s.segment === '__TEXT' && s.name === '__text') textSec = s;
  }

  if (!classListSec && !catListSec) return empty();

  const codeLo = textHi > textLo ? textLo : (textSec ? textSec.va : 0n);
  const codeHi = textHi > textLo ? textHi : (textSec ? textSec.vaEnd : 0n);
  if (codeHi <= codeLo) return empty();

  const isCodeVa = (va) => va != null && va >= codeLo && va < codeHi;

  const resolveSelectorFromPtrOrText = (va) => {
    if (va == null || va <= 0n) return null;
    // In arm64 relative small method lists, name_rel points either to a selref pointer or directly to a cstring.
    const direct = reader.readCStringAtVa(va, 256);
    if (direct && /^[\x21-\x7e]+$/.test(direct)) return direct;
    const off = reader.vaToOffset(va);
    if (off < 0) return null;
    const rawPtr = reader.readU64Off(off);
    if (rawPtr == null) return null;
    const targetVa = decodeObjcPointer(rawPtr, ptrOpts);
    if (targetVa == null) return null;
    return reader.readCStringAtVa(targetVa, 256);
  };

  const readMethodList = (mlistVa) => {
    if (mlistVa == null || mlistVa <= 0n) return [];
    const mlistOff = reader.vaToOffset(mlistVa);
    if (mlistOff < 0 || mlistOff + 8 > rawBytes.length) return [];
    const entsizeAndFlags = reader.readU32Off(mlistOff);
    const count = reader.readU32Off(mlistOff + 4);
    if (entsizeAndFlags == null || count == null || count === 0) return [];
    const isRelative = (entsizeAndFlags & 0x80000000) !== 0;
    const entsize = entsizeAndFlags & 0xffff;
    const safeCount = Math.min(count, MAX_METHODS_PER_LIST);
    const methods = [];

    if (isRelative) {
      if (entsize < 12) return [];
      for (let i = 0; i < safeCount; i++) {
        const entryOff = mlistOff + 8 + i * entsize;
        if (entryOff + 12 > rawBytes.length) break;
        const nameRel = reader.readI32Off(entryOff);
        const impRel = reader.readI32Off(entryOff + 8);
        if (nameRel == null || impRel == null || impRel === 0) continue;
        const entryVa = mlistVa + 8n + BigInt(i * entsize);
        const impVa = entryVa + 8n + BigInt(impRel);
        if (!isCodeVa(impVa)) continue;
        const selVa = entryVa + BigInt(nameRel);
        const selector = resolveSelectorFromPtrOrText(selVa);
        methods.push({ imp: impVa, selector });
      }
      return methods;
    }

    if (entsize < 24) return [];
    for (let i = 0; i < safeCount; i++) {
      const entryOff = mlistOff + 8 + i * entsize;
      if (entryOff + 24 > rawBytes.length) break;
      const rawName = reader.readU64Off(entryOff);
      const rawImp = reader.readU64Off(entryOff + 16);
      if (rawName == null || rawImp == null) continue;
      let impVa = decodeObjcPointer(rawImp, { imageBase, pointerFormat, stripPac, reader: null });
      if (impVa == null && rawImp >= codeLo && rawImp < codeHi) impVa = rawImp;
      if (!isCodeVa(impVa)) continue;
      const nameVa = decodeObjcPointer(rawName, ptrOpts);
      const selector = nameVa ? reader.readCStringAtVa(nameVa, 256) : null;
      methods.push({ imp: impVa, selector });
    }
    return methods;
  };

  const classMap = new Map(); // className -> record
  const classVaToName = new Map(); // classVa -> className
  const methodsByIMP = new Map();
  let truncated = false;

  const getOrCreateClass = (className, superClass = null) => {
    let rec = classMap.get(className);
    if (!rec) {
      if (classMap.size >= maxClasses) {
        truncated = true;
        return null;
      }
      rec = {
        className,
        superClass,
        methods: [],
        classMethods: [],
        _seenImps: new Set(),
      };
      classMap.set(className, rec);
    } else if (!rec.superClass && superClass) {
      rec.superClass = superClass;
    }
    return rec;
  };

  const addMethodsToClass = (rec, list, isClassMethod) => {
    if (!rec || list.length === 0) return;
    const targetArr = isClassMethod ? rec.classMethods : rec.methods;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!rec._seenImps.has(m.imp)) {
        rec._seenImps.add(m.imp);
        targetArr.push(m);
      }
      if (!methodsByIMP.has(m.imp)) {
        methodsByIMP.set(m.imp, {
          imp: m.imp,
          className: rec.className,
          selector: m.selector,
          classMethod: isClassMethod,
        });
      }
    }
  };

  const readClassNameFromClassVa = (clsVa) => {
    if (clsVa == null) return null;
    const cached = classVaToName.get(clsVa);
    if (cached !== undefined) return cached;
    const clsOff = reader.vaToOffset(clsVa);
    if (clsOff < 0 || clsOff + 40 > rawBytes.length) return null;
    const rawRo = reader.readU64Off(clsOff + 32);
    if (rawRo == null) return null;
    const roVa = decodeObjcPointer(rawRo & ~3n, ptrOpts);
    if (roVa == null) return null;
    const roOff = reader.vaToOffset(roVa);
    if (roOff < 0 || roOff + 40 > rawBytes.length) return null;
    const rawName = reader.readU64Off(roOff + 24);
    const nameVa = decodeObjcPointer(rawName, ptrOpts);
    const className = nameVa ? reader.readCStringAtVa(nameVa, 256) : null;
    if (!isValidClassName(className)) return null;
    classVaToName.set(clsVa, className);
    return className;
  };

  // 1. Parse __objc_classlist
  let classListCount = 0;
  if (classListSec) {
    classListCount = Math.floor(classListSec.fsize / 8);
    for (let i = 0; i < classListCount; i++) {
      const rawPtr = reader.readU64Off(classListSec.foff + i * 8);
      if (rawPtr == null) continue;
      const clsVa = decodeObjcPointer(rawPtr, ptrOpts);
      if (clsVa == null) continue;
      const clsOff = reader.vaToOffset(clsVa);
      if (clsOff < 0 || clsOff + 40 > rawBytes.length) continue;

      const rawMeta = reader.readU64Off(clsOff);
      const rawSuper = reader.readU64Off(clsOff + 8);
      const rawRo = reader.readU64Off(clsOff + 32);
      if (rawRo == null) continue;
      const roVa = decodeObjcPointer(rawRo & ~3n, ptrOpts);
      if (roVa == null) continue;
      const roOff = reader.vaToOffset(roVa);
      if (roOff < 0 || roOff + 40 > rawBytes.length) continue;

      const nameVa = decodeObjcPointer(reader.readU64Off(roOff + 24), ptrOpts);
      const className = nameVa ? reader.readCStringAtVa(nameVa, 256) : null;
      if (!isValidClassName(className)) continue;
      classVaToName.set(clsVa, className);

      const superVa = decodeObjcPointer(rawSuper, ptrOpts);
      const superClass = superVa ? readClassNameFromClassVa(superVa) : null;
      const rec = getOrCreateClass(className, superClass);
      if (!rec) break;

      const mlistVa = decodeObjcPointer(reader.readU64Off(roOff + 32), ptrOpts);
      if (mlistVa) {
        addMethodsToClass(rec, readMethodList(mlistVa), false);
      }

      // MetaClass -> class methods (+[Class selector])
      const metaVa = decodeObjcPointer(rawMeta, ptrOpts);
      if (metaVa != null) {
        const metaOff = reader.vaToOffset(metaVa);
        if (metaOff >= 0 && metaOff + 40 <= rawBytes.length) {
          const rawMetaRo = reader.readU64Off(metaOff + 32);
          if (rawMetaRo != null) {
            const metaRoVa = decodeObjcPointer(rawMetaRo & ~3n, ptrOpts);
            const metaRoOff = metaRoVa != null ? reader.vaToOffset(metaRoVa) : -1;
            if (metaRoOff >= 0 && metaRoOff + 40 <= rawBytes.length) {
              const metaMlistVa = decodeObjcPointer(reader.readU64Off(metaRoOff + 32), ptrOpts);
              if (metaMlistVa) {
                addMethodsToClass(rec, readMethodList(metaMlistVa), true);
              }
            }
          }
        }
      }
    }
  }

  // 2. Parse __objc_catlist (categories on local classes)
  let catListCount = 0;
  if (catListSec) {
    catListCount = Math.floor(catListSec.fsize / 8);
    for (let i = 0; i < catListCount; i++) {
      const rawPtr = reader.readU64Off(catListSec.foff + i * 8);
      if (rawPtr == null) continue;
      const catVa = decodeObjcPointer(rawPtr, ptrOpts);
      if (catVa == null) continue;
      const catOff = reader.vaToOffset(catVa);
      if (catOff < 0 || catOff + 32 > rawBytes.length) continue;

      const clsVa = decodeObjcPointer(reader.readU64Off(catOff + 8), ptrOpts);
      if (clsVa == null) continue;
      const className = readClassNameFromClassVa(clsVa);
      if (!className) continue;

      const rec = getOrCreateClass(className, null);
      if (!rec) break;

      const instMlistVa = decodeObjcPointer(reader.readU64Off(catOff + 16), ptrOpts);
      if (instMlistVa) addMethodsToClass(rec, readMethodList(instMlistVa), false);

      const clsMlistVa = decodeObjcPointer(reader.readU64Off(catOff + 24), ptrOpts);
      if (clsMlistVa) addMethodsToClass(rec, readMethodList(clsMlistVa), true);
    }
  }

  const classes = [];
  for (const rec of classMap.values()) {
    classes.push({
      className: rec.className,
      superClass: rec.superClass,
      methods: rec.methods,
      classMethods: rec.classMethods,
    });
  }

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    classes,
    methodsByIMP,
    completeness: truncated ? 'partial' : 'complete',
    truncated,
    stats: {
      classListCount,
      catListCount,
      classesRecovered: classes.length,
      methodsRecovered: methodsByIMP.size,
      elapsedMs: Number((t1 - t0).toFixed(2)),
    },
  };
}
