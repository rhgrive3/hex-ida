/**
 * Fast O(1) Symbol & Type Resolver over Tier-0 Core TIL + Tier-1 Mounted Packs + User Header.
 * Priority ordering: User Header > Pack B > Pack A > JS LRU Packs > Core TIL.
 * Spec: hex_ida_beyond_ida_design.md §3.2, §10.1
 * INV-005: ZERO imports from js/targets/architecture/.
 */

import {
  TIL_NS,
  TIL_PRIM_NAMES,
  SIG_FLAG,
  getCoreTilIr,
  formatHexTypeId,
} from './til-lite-data.js';
import { compileTil1, Til1View } from './til-binary-compiler.js';

export const LOOKUP_FLAG = Object.freeze({
  RAW_ONLY: 0x01,
  ALLOW_STRIP1: 0x02,
  ALLOW_STRIP_ALL: 0x04,
  DEFAULT: 0x06,
});

export const SLOT_MASK = Object.freeze({
  CORE: 0x01,
  PACK_A: 0x02,
  PACK_B: 0x04,
  USER_HEADER: 0x08,
  ALL: 0x0F,
});

export const SLOT_ID = Object.freeze({
  CORE: 0,
  PACK_A: 1,
  PACK_B: 2,
  USER_HEADER: 3,
});

// ---------------------------------------------------------------------------
// §3.2 Mangle-first symbol normalization
// ---------------------------------------------------------------------------
const IMPORT_THUNK_PREFIX_RE = /^(?:_*(?:imp_|__imp_|j_|plt_|\$stubs\$))+/;
const ELF_VERSION_SUFFIX_RE = /@@?[A-Za-z0-9_.\-]+$/;
const DARWIN_ABI_SUFFIX_RE = /\$(?:UNIX2003|INODE64|NOCANCEL|DARWIN_EXTSN(?:_SNPRINTF_CHECK)?|EXTSN|VARIANT\$[A-Za-z0-9_]+)$/;
const OBJC_MSGSEND_STUB_RE = /^_?objc_msgSend\$(.+)$/;
const OBJC_METHOD_SYNTAX_RE = /^([+\-])\[([A-Za-z0-9_]+)(?:\([^)]*\))?\s+([A-Za-z0-9_:]+)\]$/;

/**
 * Classifies and produces ordered lookup candidates for a symbol name.
 * Mangle-first branching runs BEFORE stripping leading underscores.
 */
export function normalizeSymbolForTil(rawName, lookupFlags = LOOKUP_FLAG.DEFAULT) {
  if (!rawName || typeof rawName !== 'string') {
    return { kind: 'empty', raw: '', candidates: [], selectorKey: null };
  }
  const trimmed = rawName.trim();
  if (!trimmed) {
    return { kind: 'empty', raw: '', candidates: [], selectorKey: null };
  }

  // 1. ObjC method syntax: +[NSString stringWithUTF8String:] / -[NSArray objectAtIndex:]
  const objcMethodMatch = OBJC_METHOD_SYNTAX_RE.exec(trimmed);
  if (objcMethodMatch) {
    const [, sign, cls, sel] = objcMethodMatch;
    return {
      kind: 'objc-method',
      raw: trimmed,
      selectorKey: `${sign}${cls}:${sel}`,
      fallbackSelectorKey: `*:${sel}`,
      candidates: [trimmed],
    };
  }

  // 2. ObjC msgSend stub: _objc_msgSend$UTF8String or objc_msgSend$objectAtIndex:
  const msgSendStub = OBJC_MSGSEND_STUB_RE.exec(trimmed);
  if (msgSendStub) {
    const sel = msgSendStub[1];
    return {
      kind: 'objc-stub',
      raw: trimmed,
      selectorKey: `*:${sel}`,
      fallbackSelectorKey: null,
      candidates: ['objc_msgSend'],
    };
  }

  // 3. Itanium C++ mangled symbols (_Z / __Z / ___Z) — branch BEFORE underscore stripping
  if (/^_{1,3}Z/.test(trimmed)) {
    const noVer = trimmed.replace(ELF_VERSION_SUFFIX_RE, '');
    const candidates = [noVer];
    // Darwin prefixes an extra '_' to Itanium C++ symbols: __Znwm -> _Znwm
    if (noVer.startsWith('__Z')) {
      candidates.push(noVer.slice(1));
    } else if (noVer.startsWith('___Z')) {
      candidates.push(noVer.slice(2));
    }
    return { kind: 'itanium-cxx', raw: trimmed, candidates: dedupe(candidates), selectorKey: null };
  }

  // 4. Swift mangled symbols ($s / _$s / $S / _$S / _T0)
  if (/^_?(?:\$[sS]|_T0)/.test(trimmed)) {
    const noVer = trimmed.replace(ELF_VERSION_SUFFIX_RE, '');
    const candidates = [noVer];
    if (noVer.startsWith('_$')) {
      candidates.push(noVer.slice(1));
    }
    return { kind: 'swift', raw: trimmed, candidates: dedupe(candidates), selectorKey: null };
  }

  // 5. Non-mangled C / POSIX / Darwin / IL2CPP symbols
  let clean = trimmed;
  clean = clean.replace(IMPORT_THUNK_PREFIX_RE, '');
  clean = clean.replace(ELF_VERSION_SUFFIX_RE, '');
  // Strip repeated Darwin ABI suffixes
  let prev;
  do {
    prev = clean;
    clean = clean.replace(DARWIN_ABI_SUFFIX_RE, '');
  } while (clean !== prev);

  const candidates = [];
  candidates.push(clean);

  const rawOnly = (lookupFlags & LOOKUP_FLAG.RAW_ONLY) !== 0 && (lookupFlags & (LOOKUP_FLAG.ALLOW_STRIP1 | LOOKUP_FLAG.ALLOW_STRIP_ALL)) === 0;
  if (!rawOnly) {
    if ((lookupFlags & LOOKUP_FLAG.ALLOW_STRIP1) !== 0 && clean.startsWith('_')) {
      candidates.push(clean.slice(1));
    }
    if ((lookupFlags & LOOKUP_FLAG.ALLOW_STRIP_ALL) !== 0 && clean.startsWith('_')) {
      const strippedAll = clean.replace(/^_+/, '');
      if (strippedAll) candidates.push(strippedAll);
    }
  }

  return { kind: 'c', raw: trimmed, candidates: dedupe(candidates), selectorKey: null };
}

function dedupe(arr) {
  const out = [];
  const seen = new Set();
  for (const s of arr) {
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

// Lazy-compiled singleton Core TIL1 buffer so startup is instant and deterministic
let cachedCoreTilView = null;
export function getDefaultCoreTilView() {
  if (!cachedCoreTilView) {
    const coreBytes = compileTil1(getCoreTilIr());
    cachedCoreTilView = new Til1View(coreBytes, {
      tidBase: TIL_NS.CORE_MIN,
      tidCap: 4032,
      packId: 'core-til-lite',
    });
  }
  return cachedCoreTilView;
}

// ---------------------------------------------------------------------------
// TilLiteResolver: Priority-Ordered O(1) Resolver
// Priority: User Header (Slot 3) > Pack B (Slot 2) > Pack A (Slot 1) > JS LRU Packs > Core TIL (Slot 0)
// ---------------------------------------------------------------------------
export class TilLiteResolver {
  constructor({ coreTilView = null } = {}) {
    this.coreView = coreTilView || getDefaultCoreTilView();
    this.packA = null; // Slot 1: { packId, view, meta }
    this.packB = null; // Slot 2: { packId, view, meta }
    this.userHeader = null; // Slot 3: { packId, view, deferredTable, meta }
    this.jsLruPacks = []; // Overflow packs (packs 3..8), newest first
    this.pinnedTypes = new Map(); // Dangling-ID protection (§10.1)
  }

  mountCore(tilBufferOrView) {
    this.coreView = tilBufferOrView instanceof Til1View
      ? tilBufferOrView
      : new Til1View(tilBufferOrView, { tidBase: TIL_NS.CORE_MIN, packId: 'core-til-lite' });
    this._pinViewTypes(this.coreView);
  }

  mountPack(slot, tilBufferOrView, meta = {}) {
    const packId = meta.packId || `pack-slot-${slot}`;
    const tidBase = meta.tidBase ?? (slot === SLOT_ID.PACK_B ? TIL_NS.PACK_MIN + 2560 : TIL_NS.PACK_MIN);
    const view = tilBufferOrView instanceof Til1View
      ? tilBufferOrView
      : new Til1View(tilBufferOrView, { tidBase, tidCap: meta.tidCap ?? 2560, packId });
    this._pinViewTypes(view);

    const entry = { packId, view, meta };
    if (slot === SLOT_ID.PACK_A || slot === 'A') {
      this.packA = entry;
    } else if (slot === SLOT_ID.PACK_B || slot === 'B') {
      this.packB = entry;
    } else if (slot === SLOT_ID.USER_HEADER || slot === 'USER') {
      this.userHeader = { ...entry, deferredTable: meta.deferredTable || null };
    } else {
      // JS LRU overflow pack
      this.jsLruPacks = [entry, ...this.jsLruPacks.filter((p) => p.packId !== packId)].slice(0, 6);
    }
    return entry;
  }

  unmountPack(slotOrPackId) {
    if (slotOrPackId === SLOT_ID.PACK_A || slotOrPackId === 'A') {
      this.packA = null;
      return true;
    }
    if (slotOrPackId === SLOT_ID.PACK_B || slotOrPackId === 'B') {
      this.packB = null;
      return true;
    }
    if (slotOrPackId === SLOT_ID.USER_HEADER || slotOrPackId === 'USER') {
      this.userHeader = null;
      return true;
    }
    const before = this.jsLruPacks.length;
    this.jsLruPacks = this.jsLruPacks.filter((p) => p.packId !== slotOrPackId);
    return this.jsLruPacks.length !== before;
  }

  purgePacks() {
    this.packA = null;
    this.packB = null;
    this.jsLruPacks = [];
  }

  setUserHeader(tilBufferOrView, deferredTable = null, meta = {}) {
    const view = tilBufferOrView
      ? (tilBufferOrView instanceof Til1View
        ? tilBufferOrView
        : new Til1View(tilBufferOrView, { tidBase: TIL_NS.LOCAL_MIN, tidCap: 8192, packId: meta.packId || 'user-header' }))
      : null;
    if (view) this._pinViewTypes(view);
    this.userHeader = {
      packId: meta.packId || 'user-header',
      view,
      deferredTable,
      meta,
    };
  }

  _pinViewTypes(view) {
    if (!view || !view.typesByTid) return;
    for (const [tid, desc] of view.typesByTid.entries()) {
      if (!this.pinnedTypes.has(tid)) {
        this.pinnedTypes.set(tid, desc);
      }
    }
  }

  _orderedSources(slotMask = SLOT_MASK.ALL) {
    const sources = [];
    // Strictly: User Header > Pack B > Pack A > JS LRU Packs > Core TIL
    if ((slotMask & SLOT_MASK.USER_HEADER) && this.userHeader) {
      sources.push({ slotId: SLOT_ID.USER_HEADER, source: 'user-header', ...this.userHeader });
    }
    if ((slotMask & SLOT_MASK.PACK_B) && this.packB) {
      sources.push({ slotId: SLOT_ID.PACK_B, source: 'pack-b', ...this.packB });
    }
    if ((slotMask & SLOT_MASK.PACK_A) && this.packA) {
      sources.push({ slotId: SLOT_ID.PACK_A, source: 'pack-a', ...this.packA });
    }
    if (slotMask & (SLOT_MASK.PACK_A | SLOT_MASK.PACK_B)) {
      for (const p of this.jsLruPacks) {
        sources.push({ slotId: 4, source: 'js-lru', ...p });
      }
    }
    if ((slotMask & SLOT_MASK.CORE) && this.coreView) {
      sources.push({ slotId: SLOT_ID.CORE, source: 'core-til', packId: this.coreView.packId || 'core-til-lite', view: this.coreView });
    }
    return sources;
  }

  /**
   * Resolves a symbol across all mounted tiers in strict priority order.
   */
  resolveSymbol(rawName, { slotMask = SLOT_MASK.ALL, lookupFlags = LOOKUP_FLAG.DEFAULT } = {}) {
    const norm = normalizeSymbolForTil(rawName, lookupFlags);
    if (norm.kind === 'empty') return null;

    // If ObjC method or msgSend stub, try selector index first
    if (norm.selectorKey) {
      const selHit = this.resolveSelector(norm.selectorKey, null, { slotMask });
      if (selHit) return selHit;
      if (norm.fallbackSelectorKey) {
        const fbHit = this.resolveSelector(norm.fallbackSelectorKey, null, { slotMask });
        if (fbHit) return fbHit;
      }
    }

    const sources = this._orderedSources(slotMask);
    for (const src of sources) {
      if (src.view) {
        for (const cand of norm.candidates) {
          const hit = src.view.lookupSymbol(cand);
          if (hit) {
            return {
              ...hit,
              matchedName: cand,
              matchedSlotId: src.slotId,
              source: src.source,
              packId: src.packId,
            };
          }
        }
      }
      if (src.deferredTable && typeof src.deferredTable.lookupFunction === 'function') {
        for (const cand of norm.candidates) {
          const hit = src.deferredTable.lookupFunction(cand);
          if (hit) {
            return {
              ...hit,
              matchedName: cand,
              matchedSlotId: src.slotId,
              source: 'user-header-deferred',
              packId: src.packId,
            };
          }
        }
      }
    }
    return null;
  }

  /**
   * Resolves an Objective-C selector (e.g. "+NSString:stringWithUTF8String:" or (cls, sel)).
   */
  resolveSelector(clsOrKey, sel = null, { isClassMethod = false, slotMask = SLOT_MASK.ALL } = {}) {
    const keys = [];
    if (sel) {
      const sign = isClassMethod ? '+' : '-';
      if (clsOrKey) keys.push(`${sign}${clsOrKey}:${sel}`);
      keys.push(`*:${sel}`);
    } else if (typeof clsOrKey === 'string') {
      keys.push(clsOrKey);
      const colonIdx = clsOrKey.indexOf(':');
      if (colonIdx > 0 && !clsOrKey.startsWith('*:')) {
        keys.push(`*:${clsOrKey.slice(colonIdx + 1)}`);
      }
    }
    if (keys.length === 0) return null;

    const sources = this._orderedSources(slotMask);
    for (const src of sources) {
      if (!src.view) continue;
      for (const key of keys) {
        const hit = src.view.lookupSelector(key);
        if (hit) {
          return {
            ...hit,
            matchedName: key,
            matchedSlotId: src.slotId,
            source: src.source,
            packId: src.packId,
          };
        }
      }
    }
    // Bare selector fallback (e.g. "alloc", "init" from __objc_methname without class prefix)
    const rawBare = sel || (typeof clsOrKey === 'string'
      ? (clsOrKey.includes(':') && !clsOrKey.endsWith(':')
        ? clsOrKey.slice(clsOrKey.indexOf(':') + 1)
        : (clsOrKey.startsWith('*:') ? clsOrKey.slice(2) : clsOrKey))
      : null);
    if (rawBare) {
      for (const src of sources) {
        if (!src.view || typeof src.view.lookupBareSelector !== 'function') continue;
        const hit = src.view.lookupBareSelector(rawBare);
        if (hit) {
          return {
            ...hit,
            matchedName: hit.name || rawBare,
            matchedSlotId: src.slotId,
            source: src.source,
            packId: src.packId,
          };
        }
      }
    }
    return null;
  }

  /**
   * Resolves a type by numeric TilTypeId or by string name in priority order.
   */
  resolveType(tidOrName, { slotMask = SLOT_MASK.ALL } = {}) {
    if (typeof tidOrName === 'number') {
      const tid = tidOrName & 0xFFFF;
      if (TIL_PRIM_NAMES[tid]) {
        return { tid, name: TIL_PRIM_NAMES[tid], kind: 0, source: 'primitive' };
      }
      for (const src of this._orderedSources(slotMask)) {
        if (src.view) {
          const hit = src.view.getTypeByTid(tid);
          if (hit) return { ...hit, source: src.source, packId: src.packId };
        }
      }
      const pinned = this.pinnedTypes.get(tid);
      if (pinned) return { ...pinned, source: 'pinned' };
      return null;
    }

    if (typeof tidOrName === 'string') {
      for (const src of this._orderedSources(slotMask)) {
        if (src.view) {
          const hit = src.view.getTypeByName(tidOrName);
          if (hit) return { ...hit, source: src.source, packId: src.packId };
        }
        if (src.deferredTable && typeof src.deferredTable.lookupType === 'function') {
          const hit = src.deferredTable.lookupType(tidOrName);
          if (hit) return { ...hit, source: 'user-header-deferred', packId: src.packId };
        }
      }
    }
    return null;
  }

  /**
   * Bridge adapter for call-prototypes.js (§3.2):
   * 0..8 args map to register args, 9..12 args spill to stackArgs.
   */
  resolveKnownCallSignature(rawName, opts = {}) {
    const sig = this.resolveSymbol(rawName, opts);
    if (!sig) return null;
    const regArgs = sig.paramHexTypes.slice(0, 8);
    const stackArgs = sig.paramHexTypes.length > 8 ? sig.paramHexTypes.slice(8) : [];
    const lookupName = (tid) => {
      const t = this.resolveType(tid);
      return t ? t.name : null;
    };
    return {
      name: sig.matchedName,
      arity: sig.arity,
      isVariadic: (sig.flags & SIG_FLAG.VARIADIC) !== 0,
      isNoReturn: (sig.flags & SIG_FLAG.NORETURN) !== 0,
      isAlloc: (sig.flags & SIG_FLAG.ALLOC) !== 0,
      isFree: (sig.flags & SIG_FLAG.FREE) !== 0,
      formatFamily: sig.formatFamily,
      fmtArgIdx: sig.fmtArgIdx,
      callConv: sig.callConv,
      retHexType: sig.retHexType,
      retTypeStr: formatHexTypeId(sig.retHexType, lookupName),
      regArgs,
      stackArgs,
      paramHexTypes: sig.paramHexTypes,
      paramTypeStrs: sig.paramHexTypes.map((p) => formatHexTypeId(p, lookupName)),
      source: sig.source,
      packId: sig.packId,
      matchedSlotId: sig.matchedSlotId,
    };
  }
}
