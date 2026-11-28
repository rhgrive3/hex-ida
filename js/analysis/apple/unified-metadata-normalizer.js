/**
 * Unified metadata normalizer for C++ RTTI, Objective-C, Swift 5, and SymbolIndex inputs.
 * Zero-dependency pure JS module producing canonical UnifiedClassRecord[] and
 * Map<bigint, UnifiedMethodRef> with strict BigInt addresses and partial-completeness reporting.
 */

const MAX_NAMESPACE_DEPTH = 32;
const MAX_SYMBOL_SCAN = 200000;
const HEX_VA_RE = /^0[xX][0-9a-fA-F]+$/;
const DEC_VA_RE = /^[0-9]+$/;
const OBJC_METHOD_RE = /^([+-])\[([^\s\]()]+)(?:\([^)]*\))?\s+([^\]]+)\]$/;
const STRIPPED_NAME_RE = /^(?:sub|FUN|func|fn|loc|unk)_[0-9a-fA-F]+$/;

const LANGUAGE_PRIORITY = Object.freeze({
  cpp: 4,
  objc: 3,
  swift: 2,
  symbol: 1,
});

function toBigIntVa(value) {
  if (typeof value === 'bigint') {
    return value >= 0n ? value : null;
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    if (!HEX_VA_RE.test(s) && !DEC_VA_RE.test(s)) return null;
    try {
      const parsed = BigInt(s);
      return parsed >= 0n ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Split a qualified name by delimiter at template/paren depth 0.
 * Caps output depth to avoid pathological inputs.
 * @param {string} name
 * @param {string} delim
 * @returns {string[]}
 */
function splitTopLevel(name, delim) {
  if (typeof name !== 'string' || !name) return [];
  const parts = [];
  const dlen = delim.length;
  let angleDepth = 0;
  let parenDepth = 0;
  let start = 0;

  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    if (ch === '<') {
      angleDepth++;
      continue;
    }
    if (ch === '>' && angleDepth > 0) {
      angleDepth--;
      continue;
    }
    if (ch === '(') {
      parenDepth++;
      continue;
    }
    if (ch === ')' && parenDepth > 0) {
      parenDepth--;
      continue;
    }
    if (angleDepth === 0 && parenDepth === 0 && name.startsWith(delim, i)) {
      const seg = name.slice(start, i).trim();
      if (seg) parts.push(seg);
      i += dlen - 1;
      start = i + 1;
      if (parts.length >= MAX_NAMESPACE_DEPTH - 1) break;
    }
  }
  const tail = name.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function compareStringsCodepoint(a, b) {
  return a < b ? -1 : (a > b ? 1 : 0);
}

function compareBigInt(a, b) {
  return a < b ? -1 : (a > b ? 1 : 0);
}

/**
 * Normalize a Map<bigint|string, T> or plain Record<string, T> into Map<bigint, T>.
 * @param {unknown} source
 * @returns {Map<bigint, unknown>}
 */
function normalizeFnMap(source) {
  const out = new Map();
  if (!source || typeof source !== 'object') return out;
  if (source instanceof Map) {
    for (const [k, v] of source.entries()) {
      const va = toBigIntVa(k);
      if (va != null && v != null) out.set(va, v);
    }
    return out;
  }
  const keys = Object.keys(source);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const va = toBigIntVa(k);
    const v = source[k];
    if (va != null && v != null) out.set(va, v);
  }
  return out;
}

function makeClassId(language, className) {
  return `${language}:${className}`;
}

function extractBaseClassNames(raw) {
  const out = [];
  const seen = new Set();
  const pushName = (n) => {
    const clean = normalizeNonEmptyString(n);
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  };
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      if (typeof item === 'string') pushName(item);
      else if (item && typeof item === 'object') pushName(item.className ?? item.name);
    }
  } else if (typeof raw === 'string') {
    pushName(raw);
  }
  return out;
}

function extractUniqueSortedStrings(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const set = new Set();
  for (let i = 0; i < arr.length; i++) {
    const s = normalizeNonEmptyString(arr[i]);
    if (s) set.add(s);
  }
  return Array.from(set).sort(compareStringsCodepoint);
}

/**
 * Normalize C++ RTTI, Objective-C, Swift 5, and SymbolIndex metadata into a
 * unified class/method model.
 *
 * @param {object} [opts]
 * @param {object|null} [opts.cxxRtti=null]
 * @param {object|null} [opts.objcSwift=null]
 * @param {object|null} [opts.objcModel=null]
 * @param {object|null} [opts.swiftModel=null]
 * @param {object|null} [opts.symbols=null]
 * @returns {{
 *   classes: Array<{
 *     id: string,
 *     language: 'cpp'|'objc'|'swift'|'symbol',
 *     className: string,
 *     namespacePath: string[],
 *     shortName: string,
 *     baseClassNames: string[],
 *     methods: Array<{
 *       fnVa: bigint,
 *       classId: string,
 *       className: string,
 *       language: 'cpp'|'objc'|'swift'|'symbol',
 *       methodName: string|null,
 *       slotIndex: number|null,
 *       isShared: boolean,
 *       sharedOwners: string[],
 *     }>,
 *     confidence: 'high'|'medium',
 *   }>,
 *   methodsByFn: Map<bigint, {
 *     fnVa: bigint,
 *     classId: string,
 *     className: string,
 *     language: 'cpp'|'objc'|'swift'|'symbol',
 *     methodName: string|null,
 *     slotIndex: number|null,
 *     isShared: boolean,
 *     sharedOwners: string[],
 *   }>,
 *   completeness: 'complete'|'partial',
 *   partialReasons: string[],
 *   stats: {
 *     totalClasses: number,
 *     cppClasses: number,
 *     objcClasses: number,
 *     swiftClasses: number,
 *     totalMethods: number,
 *   },
 * }}
 */
export function normalizeUnifiedMetadata(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const cxxRtti = o.cxxRtti && typeof o.cxxRtti === 'object' ? o.cxxRtti : null;
  const objcSwift = o.objcSwift && typeof o.objcSwift === 'object' ? o.objcSwift : null;
  const objcModel = o.objcModel && typeof o.objcModel === 'object' ? o.objcModel : null;
  const swiftModel = o.swiftModel && typeof o.swiftModel === 'object' ? o.swiftModel : null;
  const symbols = o.symbols && typeof o.symbols === 'object' ? o.symbols : null;

  const classMap = new Map(); // classId -> internal builder
  const methodsByFn = new Map(); // fnVa: bigint -> UnifiedMethodRef
  const partialReasonSet = new Set();

  const addPartialReason = (reason) => {
    const clean = normalizeNonEmptyString(reason);
    if (clean) partialReasonSet.add(clean);
  };

  const getOrCreateClass = ({
    language,
    className,
    namespacePath = null,
    shortName = null,
    baseClassNames = null,
    confidence = 'high',
  }) => {
    const cleanName = normalizeNonEmptyString(className);
    if (!cleanName) return null;
    const id = makeClassId(language, cleanName);
    let rec = classMap.get(id);
    if (!rec) {
      let nsPath;
      let resolvedShort;
      if (Array.isArray(namespacePath)) {
        nsPath = namespacePath.map(normalizeNonEmptyString).filter(Boolean).slice(0, MAX_NAMESPACE_DEPTH);
        const explicitShort = normalizeNonEmptyString(shortName);
        if (explicitShort) {
          resolvedShort = explicitShort;
        } else if (language === 'swift') {
          const parts = splitTopLevel(cleanName, '.');
          resolvedShort = parts[parts.length - 1] || cleanName;
        } else if (language === 'objc') {
          resolvedShort = cleanName;
        } else {
          const parts = splitTopLevel(cleanName, '::');
          resolvedShort = parts[parts.length - 1] || cleanName;
        }
      } else if (language === 'cpp') {
        const parts = splitTopLevel(cleanName, '::');
        nsPath = parts.length > 1 ? parts.slice(0, -1) : [];
        resolvedShort = normalizeNonEmptyString(shortName) ?? (parts[parts.length - 1] || cleanName);
      } else if (language === 'swift') {
        const parts = splitTopLevel(cleanName, '.');
        nsPath = parts.length > 1 ? parts.slice(0, -1) : [];
        resolvedShort = normalizeNonEmptyString(shortName) ?? (parts[parts.length - 1] || cleanName);
      } else if (language === 'objc') {
        nsPath = ['ObjC'];
        resolvedShort = normalizeNonEmptyString(shortName) ?? cleanName;
      } else {
        const parts = splitTopLevel(cleanName, '::');
        nsPath = parts.length > 1 ? parts.slice(0, -1) : [];
        resolvedShort = normalizeNonEmptyString(shortName) ?? (parts[parts.length - 1] || cleanName);
      }
      rec = {
        id,
        language,
        className: cleanName,
        namespacePath: nsPath,
        shortName: resolvedShort,
        baseSet: new Set(),
        methodsByAddr: new Map(),
        confidence: confidence === 'high' ? 'high' : 'medium',
      };
      classMap.set(id, rec);
    } else if (confidence === 'high' && rec.confidence !== 'high') {
      rec.confidence = 'high';
    }

    if (baseClassNames) {
      const bases = extractBaseClassNames(baseClassNames);
      for (let i = 0; i < bases.length; i++) {
        rec.baseSet.add(bases[i]);
      }
    }
    return rec;
  };

  const registerMethod = (classRec, {
    fnVa,
    methodName = null,
    slotIndex = null,
    isShared = false,
    sharedOwners = [],
    isPrimaryForGlobal = true,
  }) => {
    const va = toBigIntVa(fnVa);
    if (va == null || !classRec) return;

    const cleanMethodName = normalizeNonEmptyString(methodName);
    const normSlot = typeof slotIndex === 'number' && Number.isInteger(slotIndex) && slotIndex >= 0
      ? slotIndex
      : null;
    const normSharedOwners = extractUniqueSortedStrings(sharedOwners);
    const normIsShared = Boolean(isShared || normSharedOwners.length > 1);

    const ref = {
      fnVa: va,
      classId: classRec.id,
      className: classRec.className,
      language: classRec.language,
      methodName: cleanMethodName,
      slotIndex: normSlot,
      isShared: normIsShared,
      sharedOwners: normSharedOwners,
    };

    const existingClassMethod = classRec.methodsByAddr.get(va);
    if (!existingClassMethod) {
      classRec.methodsByAddr.set(va, ref);
    } else {
      if (existingClassMethod.methodName == null && ref.methodName != null) {
        existingClassMethod.methodName = ref.methodName;
      }
      if (existingClassMethod.slotIndex == null && ref.slotIndex != null) {
        existingClassMethod.slotIndex = ref.slotIndex;
      }
      if (ref.isShared && !existingClassMethod.isShared) {
        existingClassMethod.isShared = true;
      }
      if (ref.sharedOwners.length > 0) {
        existingClassMethod.sharedOwners = extractUniqueSortedStrings([
          ...existingClassMethod.sharedOwners,
          ...ref.sharedOwners,
        ]);
      }
    }

    if (!isPrimaryForGlobal) return;

    const existingGlobal = methodsByFn.get(va);
    if (!existingGlobal) {
      methodsByFn.set(va, { ...ref, sharedOwners: [...ref.sharedOwners] });
      return;
    }

    const prevPrio = LANGUAGE_PRIORITY[existingGlobal.language] || 0;
    const nextPrio = LANGUAGE_PRIORITY[ref.language] || 0;
    if (nextPrio > prevPrio) {
      methodsByFn.set(va, {
        ...ref,
        methodName: ref.methodName ?? existingGlobal.methodName,
        slotIndex: ref.slotIndex ?? existingGlobal.slotIndex,
        sharedOwners: extractUniqueSortedStrings([...ref.sharedOwners, ...existingGlobal.sharedOwners]),
      });
    } else if (nextPrio === prevPrio) {
      if (existingGlobal.methodName == null && ref.methodName != null) {
        existingGlobal.methodName = ref.methodName;
      }
      if (existingGlobal.slotIndex == null && ref.slotIndex != null) {
        existingGlobal.slotIndex = ref.slotIndex;
      }
      if (ref.isShared) existingGlobal.isShared = true;
      if (ref.sharedOwners.length > 0) {
        existingGlobal.sharedOwners = extractUniqueSortedStrings([
          ...existingGlobal.sharedOwners,
          ...ref.sharedOwners,
        ]);
      }
    } else {
      if (existingGlobal.methodName == null && ref.methodName != null) {
        existingGlobal.methodName = ref.methodName;
      }
    }
  };

  // -------------------------------------------------------------------------
  // 1. C++ RTTI (Contract 1 output)
  // -------------------------------------------------------------------------
  if (cxxRtti) {
    if (cxxRtti.truncated === true || cxxRtti.completeness === 'partial') {
      addPartialReason('cxx_rtti_partial');
    }

    const byFunctionMap = normalizeFnMap(cxxRtti.byFunction);
    const cxxClasses = Array.isArray(cxxRtti.classes) ? cxxRtti.classes : [];
    for (let i = 0; i < cxxClasses.length; i++) {
      const cls = cxxClasses[i];
      if (!cls || typeof cls !== 'object') continue;
      const className = normalizeNonEmptyString(cls.className);
      if (!className) continue;
      const rec = getOrCreateClass({
        language: 'cpp',
        className,
        namespacePath: Array.isArray(cls.namespacePath) ? cls.namespacePath : null,
        shortName: cls.shortClassName ?? cls.shortName ?? null,
        baseClassNames: cls.baseClassNames ?? null,
        confidence: 'high',
      });
      if (!rec) continue;

      const methods = Array.isArray(cls.methods) ? cls.methods : [];
      for (let j = 0; j < methods.length; j++) {
        const m = methods[j];
        if (!m || typeof m !== 'object') continue;
        const fnVa = toBigIntVa(m.fnVa ?? m.addr ?? m.address);
        if (fnVa == null) continue;
        const link = byFunctionMap.get(fnVa) || null;
        const isPrimary = link
          ? (link.primaryOwner === className || (link.primaryOwner == null && m.isPrimaryOwner !== false))
          : (m.isPrimaryOwner !== false);
        registerMethod(rec, {
          fnVa,
          methodName: m.methodName ?? m.name ?? null,
          slotIndex: m.slotIndex ?? link?.slotIndex ?? null,
          isShared: Boolean(link?.isShared),
          sharedOwners: link?.sharedOwners ?? [],
          isPrimaryForGlobal: isPrimary,
        });
      }
    }

    // Backfill any function present in cxxRtti.byFunction not yet indexed globally.
    for (const [fnVa, link] of byFunctionMap.entries()) {
      if (!link || typeof link !== 'object') continue;
      if (methodsByFn.has(fnVa)) continue;
      const primaryName = normalizeNonEmptyString(link.primaryOwner);
      const sharedOwners = extractUniqueSortedStrings(link.sharedOwners);
      const ownerName = primaryName || (sharedOwners.length > 0 ? sharedOwners[0] : null);
      if (!ownerName) continue;
      const rec = getOrCreateClass({
        language: 'cpp',
        className: ownerName,
        confidence: primaryName ? 'high' : 'medium',
      });
      if (!rec) continue;
      registerMethod(rec, {
        fnVa,
        methodName: null,
        slotIndex: link.slotIndex ?? null,
        isShared: Boolean(link.isShared || !primaryName),
        sharedOwners,
        isPrimaryForGlobal: true,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 2. Resolved Objective-C model (objcModel)
  // -------------------------------------------------------------------------
  let objcResolvedClasses = 0;
  let objcResolvedMethods = 0;
  if (objcModel) {
    if (objcModel.truncated === true || objcModel.completeness === 'partial') {
      addPartialReason('objc_model_partial');
    }

    const ingestObjcClass = (cls, fallbackName = null) => {
      if (!cls || typeof cls !== 'object') return;
      const className = normalizeNonEmptyString(cls.name ?? cls.className ?? fallbackName);
      if (!className) return;
      const rec = getOrCreateClass({
        language: 'objc',
        className,
        namespacePath: ['ObjC'],
        shortName: className,
        baseClassNames: cls.superName ?? cls.superClass ?? cls.baseClassNames ?? null,
        confidence: 'high',
      });
      if (!rec) return;
      objcResolvedClasses++;

      const ingestList = (list, isClassMethod) => {
        if (!Array.isArray(list)) return;
        for (let i = 0; i < list.length; i++) {
          const m = list[i];
          if (!m || typeof m !== 'object') continue;
          const fnVa = toBigIntVa(m.imp ?? m.fnVa ?? m.address ?? m.addr);
          if (fnVa == null) continue;
          const rawSel = normalizeNonEmptyString(m.selector ?? m.name ?? m.methodName);
          const prefix = isClassMethod || m.classMethod ? '+' : '-';
          const methodName = rawSel
            ? (rawSel.startsWith('+') || rawSel.startsWith('-') ? rawSel : `${prefix}${rawSel}`)
            : null;
          registerMethod(rec, {
            fnVa,
            methodName,
            slotIndex: null,
            isShared: false,
            sharedOwners: [],
            isPrimaryForGlobal: true,
          });
          objcResolvedMethods++;
        }
      };

      ingestList(cls.methods, false);
      ingestList(cls.classMethods, true);
    };

    const rawClasses = objcModel.classes;
    if (rawClasses instanceof Map) {
      for (const [key, cls] of rawClasses.entries()) {
        ingestObjcClass(cls, typeof key === 'string' ? key : null);
      }
    } else if (Array.isArray(rawClasses)) {
      for (let i = 0; i < rawClasses.length; i++) {
        ingestObjcClass(rawClasses[i]);
      }
    } else if (rawClasses && typeof rawClasses === 'object') {
      const keys = Object.keys(rawClasses);
      for (let i = 0; i < keys.length; i++) {
        ingestObjcClass(rawClasses[keys[i]], keys[i]);
      }
    }

    if (objcModel.methodsByIMP instanceof Map) {
      for (const [rawAddr, list] of objcModel.methodsByIMP.entries()) {
        const fnVa = toBigIntVa(rawAddr);
        if (fnVa == null) continue;
        const items = Array.isArray(list) ? list : [list];
        for (let i = 0; i < items.length; i++) {
          const m = items[i];
          if (!m || typeof m !== 'object') continue;
          const className = normalizeNonEmptyString(m.className);
          if (!className) continue;
          const rec = getOrCreateClass({
            language: 'objc',
            className,
            namespacePath: ['ObjC'],
            shortName: className,
            confidence: 'high',
          });
          if (!rec) continue;
          const rawSel = normalizeNonEmptyString(m.selector ?? m.name ?? m.methodName);
          const prefix = m.classMethod ? '+' : '-';
          const methodName = rawSel
            ? (rawSel.startsWith('+') || rawSel.startsWith('-') ? rawSel : `${prefix}${rawSel}`)
            : null;
          registerMethod(rec, {
            fnVa,
            methodName,
            slotIndex: null,
            isShared: items.length > 1,
            sharedOwners: items.map((x) => x?.className).filter(Boolean),
            isPrimaryForGlobal: i === 0,
          });
          objcResolvedMethods++;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. Resolved Swift model (swiftModel)
  // -------------------------------------------------------------------------
  let swiftResolvedTypes = 0;
  let swiftResolvedMethods = 0;
  if (swiftModel) {
    if (swiftModel.truncated === true || swiftModel.completeness === 'partial') {
      addPartialReason('swift_model_partial');
    }

    const ingestSwiftType = (t, fallbackName = null) => {
      if (!t || typeof t !== 'object') return;
      const className = normalizeNonEmptyString(t.fullName ?? t.className ?? t.name ?? fallbackName);
      if (!className) return;
      const rec = getOrCreateClass({
        language: 'swift',
        className,
        baseClassNames: t.superclassName ?? t.superName ?? t.baseClassNames ?? null,
        confidence: 'high',
      });
      if (!rec) return;
      swiftResolvedTypes++;

      const lists = [];
      if (Array.isArray(t.methods)) lists.push(t.methods);
      if (Array.isArray(t.vtable?.methods)) lists.push(t.vtable.methods);
      for (let li = 0; li < lists.length; li++) {
        const list = lists[li];
        for (let i = 0; i < list.length; i++) {
          const m = list[i];
          if (!m || typeof m !== 'object') continue;
          const fnVa = toBigIntVa(m.fnVa ?? m.imp ?? m.address ?? m.addr);
          if (fnVa == null) continue;
          registerMethod(rec, {
            fnVa,
            methodName: m.name ?? m.methodName ?? m.selector ?? null,
            slotIndex: typeof m.slot === 'number' ? m.slot : (typeof m.slotIndex === 'number' ? m.slotIndex : null),
            isShared: false,
            sharedOwners: [],
            isPrimaryForGlobal: true,
          });
          swiftResolvedMethods++;
        }
      }
    };

    const rawTypes = swiftModel.types ?? swiftModel.classes;
    if (rawTypes instanceof Map) {
      for (const [key, t] of rawTypes.entries()) {
        ingestSwiftType(t, typeof key === 'string' ? key : null);
      }
    } else if (Array.isArray(rawTypes)) {
      for (let i = 0; i < rawTypes.length; i++) {
        ingestSwiftType(rawTypes[i]);
      }
    } else if (rawTypes && typeof rawTypes === 'object') {
      const keys = Object.keys(rawTypes);
      for (let i = 0; i < keys.length; i++) {
        ingestSwiftType(rawTypes[keys[i]], keys[i]);
      }
    }

    const vtables = Array.isArray(swiftModel.vtables) ? swiftModel.vtables : [];
    for (let i = 0; i < vtables.length; i++) {
      const vt = vtables[i];
      if (!vt || typeof vt !== 'object') continue;
      const className = normalizeNonEmptyString(vt.typeName ?? vt.className ?? vt.name);
      if (!className) continue;
      const rec = getOrCreateClass({ language: 'swift', className, confidence: 'high' });
      if (!rec) continue;
      const entries = Array.isArray(vt.methods) ? vt.methods : (Array.isArray(vt.entries) ? vt.entries : []);
      for (let j = 0; j < entries.length; j++) {
        const m = entries[j];
        if (!m || typeof m !== 'object') continue;
        const fnVa = toBigIntVa(m.fnVa ?? m.imp ?? m.address ?? m.addr);
        if (fnVa == null) continue;
        registerMethod(rec, {
          fnVa,
          methodName: m.name ?? m.methodName ?? null,
          slotIndex: typeof m.slot === 'number' ? m.slot : (typeof m.slotIndex === 'number' ? m.slotIndex : j),
          isShared: false,
          sharedOwners: [],
          isPrimaryForGlobal: true,
        });
        swiftResolvedMethods++;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. Raw WASM ObjC / Swift 5 scanner output (objcSwift)
  // -------------------------------------------------------------------------
  if (objcSwift) {
    if (objcSwift.truncated === true || objcSwift.completeness === 'partial') {
      addPartialReason('objc_swift_truncated');
    }

    const objcBlock = objcSwift.objc && typeof objcSwift.objc === 'object' ? objcSwift.objc : null;
    const swiftBlock = objcSwift.swift5 && typeof objcSwift.swift5 === 'object' ? objcSwift.swift5 : null;

    const rawObjcClasses = Array.isArray(objcBlock?.classList)
      ? objcBlock.classList
      : (Array.isArray(objcSwift.objcClasslist) ? objcSwift.objcClasslist : []);
    const rawObjcCats = Array.isArray(objcBlock?.catList)
      ? objcBlock.catList
      : (Array.isArray(objcSwift.objcCatlist) ? objcSwift.objcCatlist : []);

    if ((rawObjcClasses.length > 0 || rawObjcCats.length > 0) && objcResolvedClasses === 0) {
      let hasUnresolvedRawObjc = false;
      const seenObjcVa = new Set();
      for (let i = 0; i < rawObjcClasses.length; i++) {
        const entry = rawObjcClasses[i];
        const va = toBigIntVa(
          typeof entry === 'object' && entry !== null
            ? (entry.targetVa ?? entry.va ?? entry.addr ?? entry.address ?? entry.ptr)
            : entry,
        );
        const explicitName = typeof entry === 'object' && entry !== null
          ? normalizeNonEmptyString(entry.className ?? entry.name)
          : null;
        if (!explicitName) {
          hasUnresolvedRawObjc = true;
          if (va == null || seenObjcVa.has(va)) continue;
          seenObjcVa.add(va);
          getOrCreateClass({
            language: 'objc',
            className: `ObjC_Class_0x${va.toString(16)}`,
            namespacePath: ['ObjC'],
            shortName: `ObjC_Class_0x${va.toString(16)}`,
            confidence: 'medium',
          });
        } else {
          const rec = getOrCreateClass({
            language: 'objc',
            className: explicitName,
            namespacePath: ['ObjC'],
            shortName: explicitName,
            confidence: 'medium',
          });
          if (rec && (!Array.isArray(entry.methods) || entry.methods.length === 0)) {
            hasUnresolvedRawObjc = true;
          }
        }
      }
      if (rawObjcCats.length > 0 && objcResolvedMethods === 0) {
        hasUnresolvedRawObjc = true;
      }
      if (hasUnresolvedRawObjc) {
        addPartialReason('objc_raw_pointers_unresolved');
      }
    }

    const rawSwiftTypes = Array.isArray(swiftBlock?.types)
      ? swiftBlock.types
      : (Array.isArray(objcSwift.swiftTypes) ? objcSwift.swiftTypes : []);
    const rawSwiftFieldMd = Array.isArray(swiftBlock?.fieldMd) ? swiftBlock.fieldMd : [];

    if ((rawSwiftTypes.length > 0 || rawSwiftFieldMd.length > 0) && swiftResolvedTypes === 0) {
      let hasUnresolvedRawSwift = false;
      const seenSwiftVa = new Set();
      for (let i = 0; i < rawSwiftTypes.length; i++) {
        const entry = rawSwiftTypes[i];
        const va = toBigIntVa(
          typeof entry === 'object' && entry !== null
            ? (entry.targetVa ?? entry.va ?? entry.addr ?? entry.address ?? entry.descriptorVa)
            : entry,
        );
        const explicitName = typeof entry === 'object' && entry !== null
          ? normalizeNonEmptyString(entry.fullName ?? entry.typeName ?? entry.name)
          : null;
        if (!explicitName) {
          hasUnresolvedRawSwift = true;
          if (va == null || seenSwiftVa.has(va)) continue;
          seenSwiftVa.add(va);
          getOrCreateClass({
            language: 'swift',
            className: `Swift_Type_0x${va.toString(16)}`,
            namespacePath: [],
            shortName: `Swift_Type_0x${va.toString(16)}`,
            confidence: 'medium',
          });
        } else {
          const rec = getOrCreateClass({
            language: 'swift',
            className: explicitName,
            confidence: 'medium',
          });
          if (rec && (!Array.isArray(entry.methods) || entry.methods.length === 0)) {
            hasUnresolvedRawSwift = true;
          }
        }
      }
      if (rawSwiftFieldMd.length > 0 && swiftResolvedMethods === 0) {
        hasUnresolvedRawSwift = true;
      }
      if (hasUnresolvedRawSwift) {
        addPartialReason('swift_raw_descriptors_unresolved');
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5. SymbolIndex fallback (lower priority than RTTI / ObjC / Swift models)
  // -------------------------------------------------------------------------
  if (symbols) {
    const ingestSymbol = (rawVa, rawName) => {
      const fnVa = toBigIntVa(rawVa);
      const name = normalizeNonEmptyString(rawName);
      if (fnVa == null || !name || STRIPPED_NAME_RE.test(name)) return;

      const objcMatch = OBJC_METHOD_RE.exec(name);
      if (objcMatch) {
        const sign = objcMatch[1];
        const className = objcMatch[2];
        const selector = objcMatch[3];
        const rec = getOrCreateClass({
          language: 'objc',
          className,
          namespacePath: ['ObjC'],
          shortName: className,
          confidence: 'medium',
        });
        if (rec) {
          registerMethod(rec, {
            fnVa,
            methodName: `${sign}${selector}`,
            slotIndex: null,
            isShared: false,
            sharedOwners: [],
            isPrimaryForGlobal: true,
          });
        }
        return;
      }

      if (name.includes('::')) {
        const opCallIdx = name.indexOf('operator()');
        const parenIdx = opCallIdx >= 0
          ? name.indexOf('(', opCallIdx + 10)
          : name.indexOf('(');
        const head = parenIdx > 0 ? name.slice(0, parenIdx).trim() : name;
        const parts = splitTopLevel(head, '::');
        if (parts.length >= 2) {
          const methodName = parts[parts.length - 1];
          const className = parts.slice(0, -1).join('::');
          const rec = getOrCreateClass({
            language: 'symbol',
            className,
            confidence: 'medium',
          });
          if (rec) {
            registerMethod(rec, {
              fnVa,
              methodName,
              slotIndex: null,
              isShared: false,
              sharedOwners: [],
              isPrimaryForGlobal: true,
            });
          }
        }
      }
    };

    let scanned = 0;
    if (Array.isArray(symbols)) {
      if (symbols.length > MAX_SYMBOL_SCAN) addPartialReason('symbols_truncated');
      for (let i = 0; i < symbols.length && scanned < MAX_SYMBOL_SCAN; i++) {
        const s = symbols[i];
        if (s && typeof s === 'object') {
          ingestSymbol(s.addr ?? s.address ?? s.va ?? s.start, s.name);
          scanned++;
        }
      }
    } else if (typeof symbols.functionList === 'function') {
      try {
        const list = symbols.functionList(null, MAX_SYMBOL_SCAN + 1) || [];
        if (list.length > MAX_SYMBOL_SCAN) addPartialReason('symbols_truncated');
        for (let i = 0; i < list.length && scanned < MAX_SYMBOL_SCAN; i++) {
          const s = list[i];
          if (s && typeof s === 'object') {
            ingestSymbol(s.addr ?? s.address ?? s.va ?? s.start, s.name);
            scanned++;
          }
        }
      } catch {
        addPartialReason('symbols_enumeration_failed');
      }
    } else if (symbols.funcs && typeof symbols.funcs.length === 'number' && typeof symbols.nameAt === 'function') {
      if (symbols.funcs.length > MAX_SYMBOL_SCAN) addPartialReason('symbols_truncated');
      const n = Math.min(symbols.funcs.length, MAX_SYMBOL_SCAN);
      for (let i = 0; i < n; i++) {
        const addr = symbols.funcs[i];
        try {
          ingestSymbol(addr, symbols.nameAt(addr));
        } catch {
          // ignore per-entry symbol lookup errors
        }
        scanned++;
      }
    } else if (Array.isArray(symbols.addrs) && Array.isArray(symbols.names)) {
      const totalPairs = Math.min(symbols.addrs.length, symbols.names.length);
      if (totalPairs > MAX_SYMBOL_SCAN) addPartialReason('symbols_truncated');
      const n = Math.min(totalPairs, MAX_SYMBOL_SCAN);
      for (let i = 0; i < n; i++) {
        ingestSymbol(symbols.addrs[i], symbols.names[i]);
        scanned++;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 6. Finalize deterministic output arrays and statistics
  // -------------------------------------------------------------------------
  const classes = [];
  let cppClasses = 0;
  let objcClasses = 0;
  let swiftClasses = 0;

  const sortedIds = Array.from(classMap.keys()).sort(compareStringsCodepoint);
  for (let i = 0; i < sortedIds.length; i++) {
    const rec = classMap.get(sortedIds[i]);
    const methods = Array.from(rec.methodsByAddr.values()).sort((a, b) => compareBigInt(a.fnVa, b.fnVa));
    const baseClassNames = Array.from(rec.baseSet).sort(compareStringsCodepoint);
    classes.push({
      id: rec.id,
      language: rec.language,
      className: rec.className,
      namespacePath: rec.namespacePath,
      shortName: rec.shortName,
      baseClassNames,
      methods,
      confidence: rec.confidence,
    });
    if (rec.language === 'cpp') cppClasses++;
    else if (rec.language === 'objc') objcClasses++;
    else if (rec.language === 'swift') swiftClasses++;
  }

  const partialReasons = Array.from(partialReasonSet).sort(compareStringsCodepoint);
  const completeness = partialReasons.length > 0 ? 'partial' : 'complete';

  return {
    classes,
    methodsByFn,
    completeness,
    partialReasons,
    stats: {
      totalClasses: classes.length,
      cppClasses,
      objcClasses,
      swiftClasses,
      totalMethods: methodsByFn.size,
    },
  };
}
