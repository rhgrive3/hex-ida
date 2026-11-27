/**
 * Architecture-independent Vtable and ARM64 ConstTable cross-reference linker.
 * Maps structural scanner outputs (vtables, constTables) back onto normalized
 * function ranges as non-destructive metadata hints.
 *
 * Dependency boundary: imports ONLY from `./arm64-insn-bits.js`.
 */
import {
  readU32LE,
  isCallOrRet,
  isUncondBranch,
  decodeAdrp,
  decodeAdr,
  decodeAddImm,
  decodeImmMem,
  decodeRegUsage,
} from './arm64-insn-bits.js';

const DEFAULT_MAX_INSNS = 4_000_000;
const ADRP_MAX_WINDOW = 8;

const CONST_KIND_TAG = Object.freeze({
  1: 'const_f32_ref',
  2: 'const_f64_ref',
  3: 'const_strided_id_ref',
});

function toBigIntOrNull(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? BigInt(value) : null;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    try {
      return BigInt(s);
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeName(name) {
  return typeof name === 'string' && name.length > 0 ? name : null;
}

function addRawFunctionCandidate(map, rawStart, rawEnd, rawSize, rawName) {
  const start = toBigIntOrNull(rawStart);
  if (start == null || start < 0n) return;

  let end = toBigIntOrNull(rawEnd);
  if (end == null || end <= start) {
    const size = toBigIntOrNull(rawSize);
    if (size != null && size > 0n) {
      end = start + size;
    } else {
      end = null;
    }
  }

  const name = normalizeName(rawName);
  const existing = map.get(start);
  if (!existing) {
    map.set(start, { start, end, name });
    return;
  }
  if (existing.end == null && end != null) {
    existing.end = end;
  }
  if (existing.name == null && name != null) {
    existing.name = name;
  }
}

function ingestArrayLikeFunctions(map, list) {
  if (!list || typeof list.length !== 'number') return;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item == null) continue;
    if (typeof item === 'bigint' || typeof item === 'number' || typeof item === 'string') {
      addRawFunctionCandidate(map, item, null, null, null);
      continue;
    }
    if (typeof item === 'object') {
      const start = item.start ?? item.va ?? item.addr ?? item.address;
      addRawFunctionCandidate(map, start, item.end, item.size, item.name);
    }
  }
}

function ingestSymbolIndex(map, sym) {
  if (!sym || typeof sym !== 'object') return;

  const hasFuncs = sym.funcs && typeof sym.funcs.length === 'number';
  const funcsLen = hasFuncs ? sym.funcs.length : 0;

  if (typeof sym.functionList === 'function') {
    try {
      const limit = Math.max(funcsLen, 500000);
      const list = sym.functionList(null, limit);
      if (Array.isArray(list)) ingestArrayLikeFunctions(map, list);
    } catch {
      // Ignore failing mock/custom functionList and fall back to funcs array.
    }
  } else if (Array.isArray(sym.functionList)) {
    ingestArrayLikeFunctions(map, sym.functionList);
  }

  if (hasFuncs) {
    const funcEnds = sym.funcEnds && typeof sym.funcEnds.length === 'number' && sym.funcEnds.length === funcsLen
      ? sym.funcEnds
      : null;
    const hasNameAt = typeof sym.nameAt === 'function';
    for (let i = 0; i < funcsLen; i++) {
      const start = toBigIntOrNull(sym.funcs[i]);
      if (start == null || start < 0n) continue;
      const end = funcEnds ? funcEnds[i] : null;
      let name = null;
      if (hasNameAt) {
        try {
          name = sym.nameAt(start);
        } catch {
          name = null;
        }
      }
      addRawFunctionCandidate(map, start, end, null, name);
    }
  }

  if (Array.isArray(sym.functions)) {
    ingestArrayLikeFunctions(map, sym.functions);
  } else if (typeof sym.functions === 'function') {
    try {
      const iter = sym.functions();
      if (iter && typeof iter[Symbol.iterator] === 'function') {
        for (const item of iter) {
          if (item == null) continue;
          if (typeof item === 'bigint' || typeof item === 'number' || typeof item === 'string') {
            addRawFunctionCandidate(map, item, null, null, null);
          } else if (typeof item === 'object') {
            const start = item.start ?? item.va ?? item.addr ?? item.address;
            addRawFunctionCandidate(map, start, item.end, item.size, item.name);
          }
        }
      }
    } catch {
      // Ignore failing iterator.
    }
  }
}

/**
 * Normalize diverse function list / index inputs into a sorted, deduplicated
 * array of `{ start: bigint, end: bigint, name: string | null }`.
 *
 * Supported inputs:
 * - `Array<{ start, end, name? }>` / `Array<{ va, size?, name? }>` / `Array<{ addr, size?, name? }>`
 * - `Array<bigint | number>` / `BigUint64Array`
 * - `SymbolIndex`-like object (`funcs` array/BigUint64Array, optional `functionList`)
 * - `ProgramIndex`-like object (`functionRange(va)` method, optional `symbols`)
 *
 * @param {unknown} functions
 * @param {bigint | number | null} [textHi=null]
 * @returns {Array<{ start: bigint, end: bigint, name: string | null }>}
 */
export function normalizeFunctions(functions, textHi = null) {
  if (!functions) return [];

  const byStart = new Map();
  let programRangeFn = null;

  if (Array.isArray(functions) || functions instanceof BigUint64Array) {
    ingestArrayLikeFunctions(byStart, functions);
  } else if (typeof functions === 'object') {
    if (typeof functions.functionRange === 'function') {
      programRangeFn = (va) => functions.functionRange(va);
      if (functions.symbols && typeof functions.symbols === 'object') {
        ingestSymbolIndex(byStart, functions.symbols);
      }
    }
    ingestSymbolIndex(byStart, functions);
  }

  if (byStart.size === 0) return [];

  const out = Array.from(byStart.values());
  out.sort((a, b) => (a.start < b.start ? -1 : (a.start > b.start ? 1 : 0)));

  if (programRangeFn) {
    for (let i = 0; i < out.length; i++) {
      const fn = out[i];
      if (fn.end != null && fn.end > fn.start && fn.name != null) continue;
      try {
        const range = programRangeFn(fn.start);
        if (range && typeof range === 'object') {
          if (fn.end == null || fn.end <= fn.start) {
            const rangeEnd = toBigIntOrNull(range.end);
            if (rangeEnd != null && rangeEnd > fn.start) {
              fn.end = rangeEnd;
            } else {
              const rangeSize = toBigIntOrNull(range.size);
              if (rangeSize != null && rangeSize > 0n) {
                fn.end = fn.start + rangeSize;
              }
            }
          }
          if (fn.name == null) {
            fn.name = normalizeName(range.name);
          }
        }
      } catch {
        // Ignore failing functionRange lookup and fall back to neighbor boundary.
      }
    }
  }

  const hi = toBigIntOrNull(textHi);
  for (let i = 0; i < out.length; i++) {
    const fn = out[i];
    if (fn.end == null || fn.end <= fn.start) {
      if (i + 1 < out.length) {
        fn.end = out[i + 1].start;
      } else if (hi != null && hi > fn.start) {
        fn.end = hi;
      } else {
        fn.end = fn.start + 4n;
      }
    }
  }

  return out;
}

function findContainingFunction(functions, va) {
  let lo = 0;
  let hi = functions.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const start = functions[mid].start;
    if (start <= va) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (candidate < 0) return null;
  const fn = functions[candidate];
  return va < fn.end ? fn : null;
}

function normalizeConstTables(constTables, dataVaBig) {
  const rawList = Array.isArray(constTables)
    ? constTables
    : (Array.isArray(constTables?.tables) ? constTables.tables : []);
  if (rawList.length === 0) return [];

  const normalized = [];
  for (let i = 0; i < rawList.length; i++) {
    const t = rawList[i];
    if (!t || typeof t !== 'object') continue;
    const byteLenBig = toBigIntOrNull(t.byteLen);
    if (byteLenBig == null || byteLenBig <= 0n) continue;

    let va = null;
    if (t.va != null) {
      va = toBigIntOrNull(t.va);
    } else if (dataVaBig != null && t.startOff != null) {
      const off = toBigIntOrNull(t.startOff);
      if (off != null) va = dataVaBig + off;
    }
    if (va == null) continue;

    normalized.push({
      va,
      endVa: va + byteLenBig,
      byteLen: Number(byteLenBig),
      kind: Number(t.kind ?? 0),
      elementCount: t.elementCount ?? null,
      elemSize: t.elemSize ?? null,
      stride: t.stride ?? null,
      startOff: t.startOff ?? null,
    });
  }

  normalized.sort((a, b) => {
    if (a.va < b.va) return -1;
    if (a.va > b.va) return 1;
    if (a.endVa > b.endVa) return -1;
    if (a.endVa < b.endVa) return 1;
    return 0;
  });

  // Track running max endVa so interval lookup remains accurate even if tables overlap.
  let maxEnd = 0n;
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i].endVa > maxEnd) maxEnd = normalized[i].endVa;
    normalized[i].prefixMaxEnd = maxEnd;
  }

  return normalized;
}

function findContainingConstTable(tables, targetVa) {
  let lo = 0;
  let hi = tables.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (tables[mid].va <= targetVa) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (candidate < 0) return null;
  if (targetVa < tables[candidate].endVa) return tables[candidate];
  if (targetVa >= tables[candidate].prefixMaxEnd) return null;
  for (let i = candidate - 1; i >= 0; i--) {
    if (targetVa < tables[i].endVa) return tables[i];
    if (targetVa >= tables[i].prefixMaxEnd) break;
  }
  return null;
}

/**
 * Link Vtable and ConstTable scan results back to normalized functions as
 * non-destructive structural hints.
 *
 * @param {object} [opts]
 * @returns {{
 *   byFunction: Record<string, {
 *     start: bigint,
 *     end: bigint,
 *     name: string | null,
 *     vtableRefs: Array<object>,
 *     constTableRefs: Array<object>,
 *     tags: Array<string>,
 *   }>,
 *   stats: {
 *     functionsInput: number,
 *     functionsLinked: number,
 *     vtableLinks: number,
 *     constTableLinks: number,
 *     scannedInsns: number,
 *   },
 *   skippedCodeScan: boolean,
 * }}
 */
export function linkWasmStructuralHints(opts = {}) {
  const {
    codeBytes = null,
    textVa = null,
    functions = null,
    vtables = null,
    constTables = null,
    dataVa = null,
    arch = 'arm64',
    maxInsns = DEFAULT_MAX_INSNS,
  } = opts || {};

  const textVaBig = toBigIntOrNull(textVa);
  const dataVaBig = toBigIntOrNull(dataVa);
  const hasCodeBytes = codeBytes instanceof Uint8Array;
  const derivedTextHi = textVaBig != null && hasCodeBytes && codeBytes.length > 0
    ? textVaBig + BigInt(codeBytes.length)
    : null;

  const normalizedFunctions = normalizeFunctions(functions, derivedTextHi);
  const byFunction = {};
  const constDedupeByFn = new Map();

  let functionsLinked = 0;
  let vtableLinks = 0;
  let constTableLinks = 0;
  let scannedInsns = 0;

  const getOrCreateFnEntry = (fn) => {
    const key = `0x${fn.start.toString(16)}`;
    let entry = byFunction[key];
    if (!entry) {
      entry = {
        start: fn.start,
        end: fn.end,
        name: fn.name,
        vtableRefs: [],
        constTableRefs: [],
        tags: [],
      };
      byFunction[key] = entry;
      functionsLinked++;
    }
    return { key, entry };
  };

  const addTag = (entry, tag) => {
    if (tag && !entry.tags.includes(tag)) {
      entry.tags.push(tag);
    }
  };

  // 1. Architecture-independent Vtable linking (runs on non-ARM64 as well).
  const vtableList = Array.isArray(vtables)
    ? vtables
    : (Array.isArray(vtables?.vtables) ? vtables.vtables : []);

  if (normalizedFunctions.length > 0 && vtableList.length > 0) {
    for (let i = 0; i < vtableList.length; i++) {
      const v = vtableList[i];
      if (!v || typeof v !== 'object') continue;
      const firstFnVa = toBigIntOrNull(v.firstFnVa);
      if (firstFnVa == null) continue;
      const fn = findContainingFunction(normalizedFunctions, firstFnVa);
      if (!fn) continue;

      const { entry } = getOrCreateFnEntry(fn);
      entry.vtableRefs.push({
        vtableOff: v.vtableOff,
        vtableVa: v.va ?? null,
        entryCount: v.entryCount,
        hasRtti: Boolean(v.hasRtti),
        encoding: v.encoding || 'absolute',
        section: v.section || null,
      });
      addTag(entry, 'vtable_member');
      vtableLinks++;
    }
  }

  // 2. ConstTable VA normalization.
  const normConstTables = normalizeConstTables(constTables, dataVaBig);

  // 3. ARM64 constant reference scan (explicitly skipped on non-ARM64).
  const archNorm = typeof arch === 'string' ? arch.trim().toLowerCase() : '';
  const isArm64 = archNorm === 'arm64' || archNorm === 'aarch64' || archNorm === 'arm64e' || archNorm === 'arm64_32';
  const canScanCode = isArm64 && hasCodeBytes && textVaBig != null && normConstTables.length > 0;
  const skippedCodeScan = !canScanCode;

  if (canScanCode) {
    const safeMaxInsns = (typeof maxInsns === 'number' && Number.isFinite(maxInsns) && maxInsns >= 0)
      ? Math.floor(maxInsns)
      : DEFAULT_MAX_INSNS;
    const totalInsns = Math.min(codeBytes.length >>> 2, safeMaxInsns);
    const regPages = new Map();

    for (let insnIdx = 0; insnIdx < totalInsns; insnIdx++) {
      const off = insnIdx * 4;
      const w = readU32LE(codeBytes, off);
      const insnVa = textVaBig + BigInt(off);

      if (isCallOrRet(w) || isUncondBranch(w)) {
        regPages.clear();
        continue;
      }

      const adrp = decodeAdrp(w);
      if (adrp) {
        if (adrp.rd !== 31) {
          const pageVa = (insnVa & ~0xFFFn) + BigInt(adrp.pageDelta);
          regPages.set(adrp.rd, { pageVa, insnIdx });
        }
        continue;
      }

      let targetVa = null;
      const add = decodeAddImm(w);
      if (add) {
        // 64-bit ADD Xd, Xn, #imm only (sf === 1, rd !== 31).
        if (((w >>> 31) & 1) === 1 && add.rd !== 31) {
          const entry = regPages.get(add.rn);
          if (entry && (insnIdx - entry.insnIdx) <= ADRP_MAX_WINDOW) {
            targetVa = entry.pageVa + BigInt(add.imm);
          }
        }
      } else {
        const mem = decodeImmMem(w);
        if (mem) {
          if (!mem.isStore && mem.disp >= 0) {
            const entry = regPages.get(mem.rn);
            if (entry && (insnIdx - entry.insnIdx) <= ADRP_MAX_WINDOW) {
              targetVa = entry.pageVa + BigInt(mem.disp);
            }
          }
        } else {
          const adr = decodeAdr(w);
          if (adr && adr.rd !== 31) {
            targetVa = insnVa + BigInt(adr.delta);
          }
        }
      }

      if (targetVa != null && normalizedFunctions.length > 0) {
        const tbl = findContainingConstTable(normConstTables, targetVa);
        if (tbl) {
          const fn = findContainingFunction(normalizedFunctions, insnVa);
          if (fn) {
            const { key, entry } = getOrCreateFnEntry(fn);
            let seen = constDedupeByFn.get(key);
            if (!seen) {
              seen = new Set();
              constDedupeByFn.set(key, seen);
            }
            const refKey = `${tbl.va.toString(16)}:${tbl.kind}`;
            if (!seen.has(refKey)) {
              seen.add(refKey);
              entry.constTableRefs.push({
                tableVa: tbl.va,
                byteLen: tbl.byteLen,
                kind: tbl.kind,
                elementCount: tbl.elementCount,
                elemSize: tbl.elemSize,
                stride: tbl.stride,
                insnVa,
              });
              const tag = CONST_KIND_TAG[tbl.kind] || null;
              if (tag) addTag(entry, tag);
              constTableLinks++;
            }
          }
        }
      }

      if (regPages.size > 0) {
        const ru = decodeRegUsage(w);
        const gpWrite = ru.gpWrite >>> 0;
        if (gpWrite !== 0) {
          for (const reg of regPages.keys()) {
            if (((gpWrite >>> reg) & 1) !== 0) {
              regPages.delete(reg);
            }
          }
        }
      }
    }

    scannedInsns = totalInsns;
  }

  return {
    byFunction,
    stats: {
      functionsInput: normalizedFunctions.length,
      functionsLinked,
      vtableLinks,
      constTableLinks,
      scannedInsns,
    },
    skippedCodeScan,
  };
}
