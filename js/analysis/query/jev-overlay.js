// Jev query overlay integrating user renames, struct fields, manual segments,
// and safe-promoted types into Jev search & symbol answers (§7.3).
// Enforces 7 Fail-Closed gates and Authority Level precedence.
// Pure architecture-neutral core (INV-005: zero imports from js/targets/architecture/).

import {
  TYPE_CONFIDENCE,
  AUTHORITY_LEVEL,
  normalizeConfidence,
} from '../types/core/safe-type-promote.js';
import { MANUAL_SEG_KIND } from '../recovery/manual-segment-map.js';

export const JEV_DEFAULT_MIN_CONFIDENCE = 0.6;
export const JEV_HEXSIG_AUTHORITY_THRESHOLD = 820;

const FORBIDDEN_IDENTIFIERS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
]);

const C11_RESERVED_KEYWORDS = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do',
  'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if',
  'inline', 'int', 'long', 'register', 'restrict', 'return', 'short',
  'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union',
  'unsigned', 'void', 'volatile', 'while',
  '_Alignas', '_Alignof', '_Atomic', '_Bool', '_Complex', '_Generic',
  '_Imaginary', '_Noreturn', '_Static_assert', '_Thread_local',
]);

const STRICT_IDENT_SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * Canonicalize a VA (BigInt, non-negative finite safe integer, hex string including zero-padded
 * e.g. "0x00001000", or decimal string) into lowercase "0x<hex>" without leading zeros.
 * Non-finite or negative numbers return null. Non-numeric symbol names pass through trimmed.
 */
export function toVaKey(va) {
  if (va === null || va === undefined) return null;
  if (typeof va === 'bigint') {
    if (va < 0n) return null;
    return `0x${va.toString(16)}`;
  }
  if (typeof va === 'number') {
    if (!Number.isFinite(va) || !Number.isSafeInteger(va) || va < 0) return null;
    return `0x${BigInt(va).toString(16)}`;
  }
  if (typeof va === 'string') {
    const s = va.trim();
    if (!s) return null;
    if (/^-\s*(?:0x[0-9a-f]+|\d+)$/i.test(s)) return null;
    if (/^0x[0-9a-f]+$/i.test(s) || /^\d+$/.test(s)) {
      try {
        const big = BigInt(s);
        if (big < 0n) return null;
        return `0x${big.toString(16)}`;
      } catch {
        return null;
      }
    }
    return s;
  }
  return null;
}

function isValidStrictSymbolName(name) {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > 128) return false;
  // Reject whitespace or operator characters
  if (/[\s*&\-\+<>;()[\]{},=!?/\\'"`~@#$%^|.]/.test(name)) return false;
  const segments = name.split('::');
  if (segments.length === 0) return false;
  for (const seg of segments) {
    if (!STRICT_IDENT_SEGMENT_RE.test(seg)) return false;
    if (FORBIDDEN_IDENTIFIERS.has(seg)) return false;
    if (C11_RESERVED_KEYWORDS.has(seg)) return false;
  }
  return true;
}

function normalizeVaKeyedMap(src) {
  const out = new Map();
  if (!src) return out;
  const entries = src instanceof Map ? src.entries() : Object.entries(src);
  for (const [k, v] of entries) {
    const norm = toVaKey(k);
    if (norm !== null && !FORBIDDEN_IDENTIFIERS.has(norm)) {
      out.set(norm, v);
    }
  }
  return out;
}

/**
 * Evaluate the 7 Fail-Closed gates (§7.3) for a Jev naming suggestion.
 */
export function evaluateJevNamingGates(suggestion, context = {}) {
  const minConfidence = context.minConfidence ?? JEV_DEFAULT_MIN_CONFIDENCE;

  // Gate 1: Strict non-empty identifier (no JS prototype keys, C11 keywords, whitespace, or operators)
  const proposedName = typeof suggestion?.name === 'string' ? suggestion.name.trim() : '';
  if (!isValidStrictSymbolName(proposedName)) {
    return { allowed: false, failedGate: 1, reason: 'invalid_symbol_name' };
  }

  // Gate 2: Never overwrite USER_PINNED / Authority Level 0 manual names
  const existingAuthority = Number(context.existingAuthority ?? AUTHORITY_LEVEL.BASE);
  const existingConfidence = normalizeConfidence(context.existingConfidence ?? TYPE_CONFIDENCE.UNKNOWN);
  if (
    existingAuthority >= AUTHORITY_LEVEL.USER_MANUAL ||
    existingConfidence === TYPE_CONFIDENCE.USER_PINNED ||
    Boolean(context.hasUserRename)
  ) {
    return { allowed: false, failedGate: 2, reason: 'user_pinned_protected' };
  }

  // Gate 3: Never overwrite verified ObjC/Swift or Imported Header symbols
  if (
    existingAuthority >= AUTHORITY_LEVEL.OBJC_SWIFT ||
    existingAuthority === AUTHORITY_LEVEL.IMPORTED_HEADER
  ) {
    return { allowed: false, failedGate: 3, reason: 'higher_authority_symbol' };
  }

  // Gate 4: Never overwrite high-confidence HEX-SIG auto-names (S >= 820)
  const hexSigScore = Number(context.hexSigScore ?? 0);
  if (hexSigScore >= JEV_HEXSIG_AUTHORITY_THRESHOLD || existingAuthority === AUTHORITY_LEVEL.HEX_SIG) {
    return { allowed: false, failedGate: 4, reason: 'hexsig_authority_protected' };
  }

  // Gate 5: Target VA must not lie inside a manual non-code segment
  if (context.manualSegment && context.manualSegment.kind !== MANUAL_SEG_KIND.CODE) {
    return { allowed: false, failedGate: 5, reason: 'manual_non_code_segment' };
  }

  // Gate 6: Minimum Jev confidence floor
  const jevConfidence = Number(suggestion?.confidence ?? 0);
  if (!Number.isFinite(jevConfidence) || jevConfidence < minConfidence) {
    return { allowed: false, failedGate: 6, reason: 'below_confidence_floor' };
  }

  // Gate 7: Provenance invariant check (must not request mutation of provenance entity keys)
  if (suggestion?.mutateProvenanceKeys) {
    return { allowed: false, failedGate: 7, reason: 'provenance_mutation_forbidden' };
  }

  return { allowed: true, failedGate: 0, reason: null, acceptedName: proposedName };
}

export class JevQueryOverlay {
  constructor(stores = {}) {
    /** @type {Map<string, string>} canonical vaKey or symName -> user rename */
    this.userRenames = normalizeVaKeyedMap(stores.userRenames);
    /** @type {Map<string|number, object>} structId -> recovered/manual struct layout */
    this.structLayouts =
      stores.structLayouts instanceof Map
        ? new Map(stores.structLayouts)
        : new Map(Object.entries(stores.structLayouts || {}));
    /** @type {object|null} ManualSegmentMap instance */
    this.manualSegmentMap = stores.manualSegmentMap || null;
    /** @type {object|null} SafeTypePromoter instance */
    this.safeTypePromoter = stores.safeTypePromoter || null;
    /** @type {object|null} GlobalTypeMap instance */
    this.globalTypeMap = stores.globalTypeMap || null;
    /** @type {Map<string, number>} canonical vaKey -> HEX-SIG score */
    this.hexSigScores = normalizeVaKeyedMap(stores.hexSigScores);
    this.minConfidence = stores.minConfidence ?? JEV_DEFAULT_MIN_CONFIDENCE;
  }

  setUserRename(vaOrSym, newName) {
    const key = toVaKey(vaOrSym);
    if (key === null) return false;
    if (!newName) this.userRenames.delete(key);
    else this.userRenames.set(key, String(newName));
    return true;
  }

  /**
   * Apply user renames, manual segment metadata, safe-promoted types, struct field context,
   * and 7-gate-filtered Jev naming onto a symbol answer record (non-destructive).
   */
  applyToSymbolAnswer(symbolRecord, jevSuggestion = null) {
    const base = { ...(symbolRecord || {}) };
    const vaKey = toVaKey(base.va);
    const hasValidVa = vaKey !== null && vaKey.startsWith('0x');

    const manualSeg =
      this.manualSegmentMap && hasValidVa
        ? this.manualSegmentMap.queryVa(vaKey)
        : null;

    const promotedEntry =
      this.safeTypePromoter && vaKey ? this.safeTypePromoter.get(vaKey) : null;
    const globalHit =
      this.globalTypeMap && hasValidVa
        ? this.globalTypeMap.queryAddress(vaKey)
        : null;

    const userRename =
      (vaKey && this.userRenames.get(vaKey)) ||
      (base.name && this.userRenames.get(toVaKey(base.name))) ||
      null;

    let displayName = base.name || (hasValidVa ? `sub_${vaKey.slice(2)}` : 'unknown');
    let nameAuthority = Math.max(
      Number(base.authority ?? AUTHORITY_LEVEL.BASE),
      Number(globalHit?.entry?.authority ?? AUTHORITY_LEVEL.BASE)
    );
    let nameSource = 'base';
    let jevGateResult = null;

    const existingConfidence = Math.max(
      normalizeConfidence(promotedEntry?.confidence ?? TYPE_CONFIDENCE.UNKNOWN),
      normalizeConfidence(globalHit?.entry?.confidence ?? TYPE_CONFIDENCE.UNKNOWN),
      normalizeConfidence(base.confidence ?? TYPE_CONFIDENCE.UNKNOWN)
    );

    if (userRename) {
      displayName = userRename;
      nameAuthority = AUTHORITY_LEVEL.USER_MANUAL;
      nameSource = 'user_rename';
    } else if (jevSuggestion) {
      const hexSigScore = vaKey ? this.hexSigScores.get(vaKey) ?? 0 : 0;
      jevGateResult = evaluateJevNamingGates(jevSuggestion, {
        minConfidence: this.minConfidence,
        existingAuthority: nameAuthority,
        existingConfidence,
        hasUserRename: false,
        hexSigScore,
        manualSegment: manualSeg,
      });
      if (jevGateResult.allowed) {
        displayName = jevGateResult.acceptedName;
        nameAuthority = AUTHORITY_LEVEL.JEV_OVERLAY;
        nameSource = 'jev_overlay';
      }
    }

    const structId = base.structId ?? globalHit?.entry?.structSeedId ?? null;
    const structLayout = structId !== null ? this.structLayouts.get(structId) || null : null;
    const structFields = structLayout
      ? (structLayout.members || [])
          .filter((m) => m.kind !== 'padding')
          .map((m) => ({ name: m.name, offset: m.offset, size: m.size, type: m.type || m.kind }))
      : [];

    const effectiveType =
      promotedEntry?.type ||
      globalHit?.entry?.typeName ||
      base.type ||
      null;

    return {
      ...base,
      displayName,
      nameAuthority,
      nameSource,
      effectiveType,
      effectiveConfidence: existingConfidence,
      manualSegment: manualSeg
        ? {
            kind: manualSeg.kind,
            startVa: manualSeg.startVa,
            byteLen: manualSeg.byteLen,
            flags: manualSeg.flags,
          }
        : null,
      structFields,
      jevGateResult,
      provenancePreserved: true,
    };
  }

  /**
   * Enrich a list of Jev search / symbol results with overlay metadata.
   */
  applyToSearchResults(results, options = {}) {
    const jevByVa = normalizeVaKeyedMap(options.jevSuggestions);
    return (results || []).map((item) => {
      const vaKey = toVaKey(item.va);
      const suggestion =
        item.jevSuggestion || (vaKey ? jevByVa.get(vaKey) : null) || null;
      return this.applyToSymbolAnswer(item, suggestion);
    });
  }

  /**
   * Build an overlay specification consumable by PostEmitOverlayEngine / projectTypedOverlay.
   */
  buildPostEmitOverlaySpec(symbolRecords, jevSuggestions = new Map()) {
    const normSuggestions = normalizeVaKeyedMap(jevSuggestions);
    const renames = new Map();
    const typeOverrides = new Map();
    const structFields = new Map();

    for (const rec of symbolRecords || []) {
      const vaKey = toVaKey(rec.va);
      const sug = vaKey ? normSuggestions.get(vaKey) : null;
      const enriched = this.applyToSymbolAnswer(rec, sug);
      if (rec.name && enriched.displayName && enriched.displayName !== rec.name) {
        renames.set(rec.name, enriched.displayName);
      }
      if (rec.varName && enriched.effectiveType) {
        typeOverrides.set(rec.varName, enriched.effectiveType);
      }
      if (rec.baseVar && enriched.structFields.length > 0) {
        for (const f of enriched.structFields) {
          structFields.set(`${rec.baseVar}:${f.offset}`, f.name);
        }
      }
    }

    return { renames, typeOverrides, structFields };
  }
}
