/**
 * Class-level C++ struct field layout aggregator.
 *
 * Aggregates `this + offset` member accesses across all virtual/member methods
 * belonging to each recovered C++ class (from `cxxRtti`), combining both
 * pre-extracted per-function access lists (`accessesByFunc`) and raw WASM/JS
 * RMW scanner hits (`rmw`, `x86Rmw`).
 *
 * Pure zero-dependency JS module (no static imports from other tracks).
 */

const DEFAULT_MAX_CLASSES = 20000;
const MAX_SAMPLE_FUNCTIONS = 8;
const MAX_REASONABLE_OFFSET = 0x10000000; // 256 MiB struct offset guard
const MAX_REASONABLE_WIDTH = 1024;
const HEX_OR_DEC_VA_RE = /^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/;

function toBigIntVa(value) {
  if (typeof value === 'bigint') {
    return value >= 0n ? value : null;
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s || !HEX_OR_DEC_VA_RE.test(s)) return null;
    try {
      const b = BigInt(s);
      return b >= 0n ? b : null;
    } catch {
      return null;
    }
  }
  return null;
}

function toValidOffset(value) {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(MAX_REASONABLE_OFFSET)) return null;
    return Number(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
    if (value < 0 || value > MAX_REASONABLE_OFFSET) return null;
    return value;
  }
  return null;
}

function toValidWidth(value) {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
  if (value <= 0 || value > MAX_REASONABLE_WIDTH) return null;
  return value;
}

function normalizeKind(kind) {
  if (typeof kind !== 'string') return 'read';
  const k = kind.trim().toLowerCase();
  if (k === 'write' || k === 'store') return 'write';
  if (k === 'rmw' || k === 'readwrite' || k === 'read_write') return 'rmw';
  return 'read';
}

function normalizeTypeHint(hint) {
  if (typeof hint !== 'string') return null;
  const s = hint.trim();
  return s.length > 0 ? s : null;
}

function compareBigIntAsc(a, b) {
  return a < b ? -1 : (a > b ? 1 : 0);
}

/**
 * Normalize diverse function list / SymbolIndex / ProgramIndex inputs into a
 * sorted, deduplicated array of `{ start: bigint, end: bigint | null }`.
 * When `end` is explicitly provided it is preserved; otherwise neighboring
 * function starts bound each interval (last entry remains open-ended if no
 * explicit end was supplied).
 */
function normalizeFunctionRanges(functions, textHiBig = null) {
  if (!functions) return [];
  const byStart = new Map();

  const addCandidate = (rawStart, rawEnd, rawSize) => {
    const start = toBigIntVa(rawStart);
    if (start == null) return;
    let end = toBigIntVa(rawEnd);
    if (end == null || end <= start) {
      const size = toBigIntVa(rawSize);
      if (size != null && size > 0n) {
        end = start + size;
      } else {
        end = null;
      }
    }
    const existing = byStart.get(start);
    if (!existing) {
      byStart.set(start, { start, end });
    } else if (existing.end == null && end != null) {
      existing.end = end;
    }
  };

  const ingestArrayLike = (list) => {
    if (!list || typeof list.length !== 'number') return;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (item == null) continue;
      if (typeof item === 'bigint' || typeof item === 'number' || typeof item === 'string') {
        addCandidate(item, null, null);
      } else if (typeof item === 'object') {
        const start = item.start ?? item.va ?? item.addr ?? item.address;
        addCandidate(start, item.end, item.size);
      }
    }
  };

  const ingestSymbolLike = (sym) => {
    if (!sym || typeof sym !== 'object') return;
    const hasFuncs = sym.funcs && typeof sym.funcs.length === 'number';
    if (hasFuncs) {
      const len = sym.funcs.length;
      const funcEnds = sym.funcEnds && typeof sym.funcEnds.length === 'number' && sym.funcEnds.length === len
        ? sym.funcEnds
        : null;
      for (let i = 0; i < len; i++) {
        addCandidate(sym.funcs[i], funcEnds ? funcEnds[i] : null, null);
      }
    }
    if (typeof sym.functionList === 'function') {
      try {
        const list = sym.functionList(null, Math.max(hasFuncs ? sym.funcs.length : 0, 500000));
        if (Array.isArray(list)) ingestArrayLike(list);
      } catch {
        // Ignore failing custom functionList.
      }
    } else if (Array.isArray(sym.functionList)) {
      ingestArrayLike(sym.functionList);
    }
    if (Array.isArray(sym.functions)) {
      ingestArrayLike(sym.functions);
    } else if (typeof sym.functions === 'function') {
      try {
        const iter = sym.functions();
        if (iter && typeof iter[Symbol.iterator] === 'function') {
          for (const item of iter) {
            if (item == null) continue;
            if (typeof item === 'bigint' || typeof item === 'number' || typeof item === 'string') {
              addCandidate(item, null, null);
            } else if (typeof item === 'object') {
              const start = item.start ?? item.va ?? item.addr ?? item.address;
              addCandidate(start, item.end, item.size);
            }
          }
        }
      } catch {
        // Ignore failing iterator.
      }
    }
  };

  if (Array.isArray(functions) || functions instanceof BigUint64Array) {
    ingestArrayLike(functions);
  } else if (typeof functions === 'object') {
    if (typeof functions.functionRange === 'function' && functions.symbols && typeof functions.symbols === 'object') {
      ingestSymbolLike(functions.symbols);
    }
    ingestSymbolLike(functions);
  }

  if (byStart.size === 0) return [];

  const sorted = Array.from(byStart.values());
  sorted.sort((a, b) => compareBigIntAsc(a.start, b.start));

  const programRangeFn = typeof functions === 'object' && typeof functions.functionRange === 'function'
    ? (va) => functions.functionRange(va)
    : null;

  if (programRangeFn) {
    for (let i = 0; i < sorted.length; i++) {
      const fn = sorted[i];
      if (fn.end != null && fn.end > fn.start) continue;
      try {
        const range = programRangeFn(fn.start);
        if (range && typeof range === 'object') {
          const end = toBigIntVa(range.end);
          if (end != null && end > fn.start) {
            fn.end = end;
          } else {
            const size = toBigIntVa(range.size);
            if (size != null && size > 0n) fn.end = fn.start + size;
          }
        }
      } catch {
        // Ignore failing functionRange lookup.
      }
    }
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    const fn = sorted[i];
    if (fn.end == null || fn.end <= fn.start) {
      fn.end = sorted[i + 1].start;
    }
  }
  if (sorted.length > 0) {
    const last = sorted[sorted.length - 1];
    if (last.end == null || last.end <= last.start) {
      last.end = (textHiBig != null && textHiBig > last.start) ? textHiBig : (last.start + 0x10000n);
    }
  }

  return sorted;
}

function findContainingFunctionVa(sortedRanges, va) {
  if (!sortedRanges.length) return null;
  let lo = 0;
  let hi = sortedRanges.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedRanges[mid].start <= va) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (candidate < 0) return null;
  const fn = sortedRanges[candidate];
  if (fn.end != null && va >= fn.end) return null;
  return fn.start;
}

function normalizeAccessesByFunc(accessesByFunc) {
  const out = new Map();
  if (!accessesByFunc) return out;

  const pushEntries = (rawKey, rawList) => {
    const fnVa = toBigIntVa(rawKey);
    if (fnVa == null || !Array.isArray(rawList) || rawList.length === 0) return;
    let bucket = out.get(fnVa);
    for (let i = 0; i < rawList.length; i++) {
      const rec = rawList[i];
      if (!rec || typeof rec !== 'object') continue;
      const offset = toValidOffset(rec.offset ?? rec.disp);
      if (offset == null) continue;
      const width = toValidWidth(rec.width);
      const kind = normalizeKind(rec.kind);
      const typeHint = normalizeTypeHint(rec.typeHint);
      if (!bucket) {
        bucket = [];
        out.set(fnVa, bucket);
      }
      bucket.push({ offset, width, kind, typeHint });
    }
  };

  if (accessesByFunc instanceof Map) {
    for (const [k, v] of accessesByFunc.entries()) {
      pushEntries(k, v);
    }
  } else if (typeof accessesByFunc === 'object') {
    for (const [k, v] of Object.entries(accessesByFunc)) {
      pushEntries(k, v);
    }
  }
  return out;
}

function ingestRmwHits(targetByFunc, rmwSource, textVaBig, sortedRanges) {
  if (!rmwSource) return;
  const hits = Array.isArray(rmwSource)
    ? rmwSource
    : (Array.isArray(rmwSource.hits) ? rmwSource.hits : null);
  if (!hits || hits.length === 0) return;

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    if (!hit || typeof hit !== 'object') continue;

    const offset = toValidOffset(hit.disp ?? hit.offset);
    if (offset == null) continue;

    let fnVa = toBigIntVa(hit.funcVa ?? hit.fnVa);
    if (fnVa == null) {
      const loadOff = toBigIntVa(hit.loadOff);
      if (loadOff == null || sortedRanges.length === 0) continue;
      const hitVa = textVaBig + loadOff;
      fnVa = findContainingFunctionVa(sortedRanges, hitVa);
      if (fnVa == null) continue;
    }

    const width = toValidWidth(hit.width);
    const typeHint = hit.isFloat === true
      ? 'float'
      : normalizeTypeHint(hit.typeHint);

    let bucket = targetByFunc.get(fnVa);
    if (!bucket) {
      bucket = [];
      targetByFunc.set(fnVa, bucket);
    }
    bucket.push({
      offset,
      width,
      kind: 'rmw',
      typeHint,
    });
  }
}

function extractClassMethods(cxxRtti) {
  const classToMethods = new Map();
  if (!cxxRtti || typeof cxxRtti !== 'object') return classToMethods;

  const addMethod = (className, rawFnVa) => {
    if (typeof className !== 'string') return;
    const cleanName = className.trim();
    if (!cleanName) return;
    const fnVa = toBigIntVa(rawFnVa);
    if (fnVa == null) return;
    let set = classToMethods.get(cleanName);
    if (!set) {
      set = new Set();
      classToMethods.set(cleanName, set);
    }
    set.add(fnVa);
  };

  if (Array.isArray(cxxRtti.classes)) {
    for (let i = 0; i < cxxRtti.classes.length; i++) {
      const cls = cxxRtti.classes[i];
      if (!cls || typeof cls !== 'object' || typeof cls.className !== 'string') continue;
      const cleanName = cls.className.trim();
      if (!cleanName) continue;
      if (!classToMethods.has(cleanName)) {
        classToMethods.set(cleanName, new Set());
      }
      if (Array.isArray(cls.methods)) {
        const byFnMap = cxxRtti.byFunction instanceof Map ? cxxRtti.byFunction : null;
        for (let j = 0; j < cls.methods.length; j++) {
          const m = cls.methods[j];
          if (!m || typeof m !== 'object') continue;
          if (m.isPrimaryOwner === false) continue;
          const fnVa = toBigIntVa(m.fnVa ?? m.va ?? m.addr);
          if (fnVa == null) continue;
          if (byFnMap) {
            const link = byFnMap.get(fnVa);
            if (link && link.primaryOwner !== cleanName) continue;
          }
          addMethod(cleanName, fnVa);
        }
      }
    }
  }

  const byFn = cxxRtti.byFunction;
  if (byFn instanceof Map) {
    for (const [k, link] of byFn.entries()) {
      if (!link || typeof link !== 'object') continue;
      const fnVa = toBigIntVa(link.fnVa ?? k);
      if (fnVa == null) continue;
      if (typeof link.primaryOwner === 'string' && link.primaryOwner.trim()) {
        addMethod(link.primaryOwner, fnVa);
      }
    }
  } else if (byFn && typeof byFn === 'object') {
    for (const [k, link] of Object.entries(byFn)) {
      if (!link || typeof link !== 'object') continue;
      const fnVa = toBigIntVa(link.fnVa ?? k);
      if (fnVa == null) continue;
      if (typeof link.primaryOwner === 'string' && link.primaryOwner.trim()) {
        addMethod(link.primaryOwner, fnVa);
      }
    }
  }

  return classToMethods;
}

function pickBestWidth(widthCounts) {
  let bestWidth = null;
  let bestCount = -1;
  for (const [w, count] of widthCounts.entries()) {
    if (count > bestCount || (count === bestCount && (bestWidth == null || w > bestWidth))) {
      bestWidth = w;
      bestCount = count;
    }
  }
  return bestWidth;
}

function pickBestTypeHint(hintCounts) {
  let bestHint = null;
  let bestCount = -1;
  for (const [hint, count] of hintCounts.entries()) {
    if (count > bestCount || (count === bestCount && (bestHint == null || hint < bestHint))) {
      bestHint = hint;
      bestCount = count;
    }
  }
  return bestHint;
}

/**
 * Aggregate per-method `this + offset` field accesses into per-class struct
 * layout candidates.
 *
 * @param {object} [opts]
 * @returns {{
 *   layouts: Map<string, {
 *     className: string,
 *     methodCount: number,
 *     fields: Array<{
 *       offset: number,
 *       width: number | null,
 *       reads: number,
 *       writes: number,
 *       typeHint: string | null,
 *       confidence: 'high' | 'medium' | 'low',
 *       sampleFunctions: bigint[],
 *     }>,
 *   }>,
 *   completeness: 'complete' | 'partial',
 *   truncated: boolean,
 *   stats: {
 *     classesProcessed: number,
 *     classesWithFields: number,
 *     totalFields: number,
 *   },
 * }}
 */
export function aggregateClassFields(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const maxClasses = (typeof o.maxClasses === 'number' && Number.isFinite(o.maxClasses) && o.maxClasses >= 0)
    ? Math.floor(o.maxClasses)
    : DEFAULT_MAX_CLASSES;

  const layouts = new Map();
  let truncated = false;
  let completeness = (
    o.cxxRtti?.truncated === true
    || o.cxxRtti?.completeness === 'partial'
    || o.rmw?.truncated === true
    || o.x86Rmw?.truncated === true
  )
    ? 'partial'
    : 'complete';

  const classToMethods = extractClassMethods(o.cxxRtti);
  if (classToMethods.size === 0 || maxClasses === 0) {
    if (classToMethods.size > maxClasses) {
      truncated = true;
      completeness = 'partial';
    }
    return {
      layouts,
      completeness,
      truncated,
      stats: {
        classesProcessed: 0,
        classesWithFields: 0,
        totalFields: 0,
      },
    };
  }

  const accessesByFunc = normalizeAccessesByFunc(o.accessesByFunc);
  const textVaBig = toBigIntVa(o.textVa) ?? 0n;
  const hasRmw = Boolean(o.rmw || o.x86Rmw);
  const textHiBig = toBigIntVa(o.textHi);
  const sortedRanges = hasRmw ? normalizeFunctionRanges(o.functions, textHiBig) : [];

  if (o.rmw) ingestRmwHits(accessesByFunc, o.rmw, textVaBig, sortedRanges);
  if (o.x86Rmw) ingestRmwHits(accessesByFunc, o.x86Rmw, textVaBig, sortedRanges);

  let classesProcessed = 0;
  let classesWithFields = 0;
  let totalFields = 0;

  for (const [className, methodSet] of classToMethods.entries()) {
    if (classesProcessed >= maxClasses) {
      truncated = true;
      completeness = 'partial';
      break;
    }
    classesProcessed += 1;

    if (methodSet.size === 0) continue;

    const fieldBuckets = new Map();

    for (const fnVa of methodSet) {
      const records = accessesByFunc.get(fnVa);
      if (!records || records.length === 0) continue;

      for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        let bucket = fieldBuckets.get(rec.offset);
        if (!bucket) {
          bucket = {
            offset: rec.offset,
            reads: 0,
            writes: 0,
            totalAccesses: 0,
            widthCounts: new Map(),
            typeHintCounts: new Map(),
            funcSet: new Set(),
          };
          fieldBuckets.set(rec.offset, bucket);
        }

        if (rec.kind === 'read') {
          bucket.reads += 1;
        } else if (rec.kind === 'write') {
          bucket.writes += 1;
        } else {
          bucket.reads += 1;
          bucket.writes += 1;
        }
        bucket.totalAccesses += 1;
        bucket.funcSet.add(fnVa);

        if (rec.width != null) {
          bucket.widthCounts.set(rec.width, (bucket.widthCounts.get(rec.width) || 0) + 1);
        }
        if (rec.typeHint != null) {
          bucket.typeHintCounts.set(rec.typeHint, (bucket.typeHintCounts.get(rec.typeHint) || 0) + 1);
        }
      }
    }

    if (fieldBuckets.size === 0) continue;

    const fields = [];
    for (const bucket of fieldBuckets.values()) {
      const sampleFunctions = Array.from(bucket.funcSet)
        .sort(compareBigIntAsc)
        .slice(0, MAX_SAMPLE_FUNCTIONS);

      let confidence = 'low';
      if (bucket.funcSet.size >= 2) {
        confidence = 'high';
      } else if (bucket.totalAccesses >= 2) {
        confidence = 'medium';
      }

      fields.push({
        offset: bucket.offset,
        width: pickBestWidth(bucket.widthCounts),
        reads: bucket.reads,
        writes: bucket.writes,
        typeHint: pickBestTypeHint(bucket.typeHintCounts),
        confidence,
        sampleFunctions,
      });
    }

    fields.sort((a, b) => a.offset - b.offset);

    layouts.set(className, {
      className,
      methodCount: methodSet.size,
      fields,
    });
    classesWithFields += 1;
    totalFields += fields.length;
  }

  return {
    layouts,
    completeness,
    truncated,
    stats: {
      classesProcessed,
      classesWithFields,
      totalFields,
    },
  };
}
