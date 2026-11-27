// Monotonic confidence promotion engine & non-destructive struct member promotion (§4.2, §9.3).
// Enforces UNKNOWN < HEURISTIC < PROPAGATED < TIL_MATCH < USER_PINNED so lower-confidence
// auto-inference can never overwrite USER_PINNED edits.
// Pure architecture-neutral core (INV-005).

export const TYPE_CONFIDENCE = Object.freeze({
  UNKNOWN: 0,
  HEURISTIC: 1,
  PROPAGATED: 2,
  TIL_MATCH: 3,
  USER_PINNED: 4,
});

export const AUTHORITY_LEVEL = Object.freeze({
  BASE: 0,
  AUTO_TYPE: 1,
  JEV_OVERLAY: 2,
  HEX_SIG: 3,
  OBJC_SWIFT: 4,
  IMPORTED_HEADER: 5,
  USER_MANUAL: 6,
});

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const FORBIDDEN_TYPE_NAMES = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
]);

const CANONICAL_TYPE_SIZES = Object.freeze(
  Object.assign(Object.create(null), {
    bool: 1,
    _Bool: 1,
    char: 1,
    'signed char': 1,
    'unsigned char': 1,
    int8_t: 1,
    uint8_t: 1,
    i8: 1,
    u8: 1,
    short: 2,
    'unsigned short': 2,
    int16_t: 2,
    uint16_t: 2,
    i16: 2,
    u16: 2,
    _Float16: 2,
    f16: 2,
    int: 4,
    'unsigned int': 4,
    int32_t: 4,
    uint32_t: 4,
    i32: 4,
    u32: 4,
    float: 4,
    f32: 4,
    long: 8,
    'unsigned long': 8,
    'long long': 8,
    'unsigned long long': 8,
    int64_t: 8,
    uint64_t: 8,
    i64: 8,
    u64: 8,
    double: 8,
    f64: 8,
    size_t: 8,
    ssize_t: 8,
    uintptr_t: 8,
    intptr_t: 8,
    ptrdiff_t: 8,
    __int128: 16,
    'unsigned __int128': 16,
    i128: 16,
    u128: 16,
    v128_t: 16,
    v128: 16,
  })
);

function isForbiddenKey(key) {
  return FORBIDDEN_KEYS.has(String(key));
}

export function normalizeConfidence(level) {
  if (typeof level === 'number' && Number.isInteger(level)) {
    if (level >= TYPE_CONFIDENCE.UNKNOWN && level <= TYPE_CONFIDENCE.USER_PINNED) return level;
  }
  if (typeof level === 'string' && Object.hasOwn(TYPE_CONFIDENCE, level)) {
    return TYPE_CONFIDENCE[level];
  }
  return TYPE_CONFIDENCE.UNKNOWN;
}

/**
 * Monotonic promotion guard.
 * Lower-confidence inference NEVER overwrites higher-confidence entries,
 * and nothing below USER_PINNED can ever overwrite USER_PINNED.
 */
export function canPromoteType(currentConfidence, incomingConfidence, options = {}) {
  const cur = normalizeConfidence(currentConfidence);
  const inc = normalizeConfidence(incomingConfidence);

  if (cur === TYPE_CONFIDENCE.USER_PINNED) {
    return inc === TYPE_CONFIDENCE.USER_PINNED;
  }
  if (inc > cur) return true;
  if (inc === cur && options.allowSameLevelUpdate) return true;
  return false;
}

export function resolveCanonicalTypeSize(typeStr, options = {}) {
  const archPtrBytes = options.archPtrBytes ?? 8;
  const knownStructs = options.knownStructs || null;
  if (!typeStr || typeof typeStr !== 'string') return null;

  const trimmed = typeStr.trim().replace(/^const\s+/, '').trim();
  if (!trimmed || FORBIDDEN_TYPE_NAMES.has(trimmed)) return null;

  // Pointer type: e.g. `void *`, `const char *`, `Player *`
  if (trimmed.includes('*')) {
    const basePart = trimmed.replace(/\*/g, '').trim();
    if (!basePart || FORBIDDEN_TYPE_NAMES.has(basePart)) return null;
    return archPtrBytes;
  }

  // Fixed-size array: e.g. `uint32_t[4]`
  const arrMatch = /^(.+?)\s*\[\s*(\d+)\s*\]$/.exec(trimmed);
  if (arrMatch) {
    const elemSize = resolveCanonicalTypeSize(arrMatch[1], options);
    const count = Number(arrMatch[2]);
    if (elemSize && Number.isInteger(count) && count > 0) {
      return elemSize * count;
    }
    return null;
  }

  if (Object.hasOwn(CANONICAL_TYPE_SIZES, trimmed)) {
    return CANONICAL_TYPE_SIZES[trimmed];
  }

  // Known struct lookup (Map or plain object with Object.hasOwn)
  if (knownStructs) {
    const cleanName = trimmed.replace(/^struct\s+/, '').trim();
    if (!cleanName || FORBIDDEN_TYPE_NAMES.has(cleanName)) return null;
    let rec = null;
    if (knownStructs instanceof Map) {
      rec = knownStructs.get(cleanName);
    } else if (typeof knownStructs === 'object' && Object.hasOwn(knownStructs, cleanName)) {
      rec = knownStructs[cleanName];
    }
    if (rec && Number.isFinite(rec.byteSize) && rec.byteSize > 0) {
      return rec.byteSize;
    }
  }

  return null;
}

/**
 * Promote a single typed entry in a Map or plain object with monotonic confidence protection.
 */
export function promoteTypeEntry(store, key, incoming, options = {}) {
  const isMap = store instanceof Map;
  if (!isMap && isForbiddenKey(key)) {
    return {
      ok: false,
      promoted: false,
      reason: 'forbidden_key',
      current: null,
    };
  }
  const existing = isMap
    ? store.get(key)
    : store && typeof store === 'object' && Object.hasOwn(store, key)
      ? store[key]
      : undefined;
  const curConf = existing ? normalizeConfidence(existing.confidence) : TYPE_CONFIDENCE.UNKNOWN;
  const incConf = normalizeConfidence(incoming?.confidence);

  if (existing && !canPromoteType(curConf, incConf, options)) {
    return {
      ok: false,
      promoted: false,
      reason: curConf === TYPE_CONFIDENCE.USER_PINNED ? 'user_pinned_protected' : 'lower_confidence',
      current: existing,
    };
  }

  const next = {
    ...existing,
    ...incoming,
    confidence: incConf,
  };
  if (isMap) store.set(key, next);
  else store[key] = next;

  return {
    ok: true,
    promoted: true,
    previous: existing || null,
    current: next,
  };
}

/**
 * Non-destructive struct member promotion with overlap resolution (§9.3).
 * Default confidence is TYPE_CONFIDENCE.UNKNOWN (fail-closed) so unspecified auto-inference
 * can never overwrite USER_PINNED entries.
 * Resolution modes: 'reject' (default) | 'replace_overlapping' | 'split_container'.
 */
export function promoteStructMemberSafe(notesStructs, structKey, memberSpec, options = {}) {
  const {
    resolution = 'reject',
    archPtrBytes = 8,
    knownStructs = null,
    allowOverwritePinned = false,
  } = options;

  const isMap = notesStructs instanceof Map;
  if (!isMap && isForbiddenKey(structKey)) {
    return { ok: false, reason: 'forbidden_key' };
  }
  if (!memberSpec || typeof memberSpec !== 'object') {
    return { ok: false, reason: 'invalid_member_spec' };
  }
  if (memberSpec.type && FORBIDDEN_TYPE_NAMES.has(String(memberSpec.type).trim())) {
    return { ok: false, reason: 'forbidden_type_name' };
  }
  if (memberSpec.name && isForbiddenKey(String(memberSpec.name).trim())) {
    return { ok: false, reason: 'forbidden_member_name' };
  }

  const existingStruct = isMap
    ? notesStructs.get(structKey)
    : notesStructs && typeof notesStructs === 'object' && Object.hasOwn(notesStructs, structKey)
      ? notesStructs[structKey]
      : undefined;

  const currentMembers = Array.isArray(existingStruct?.members)
    ? existingStruct.members.map((m) => ({ ...m }))
    : [];

  const offset = Number(memberSpec.offset);
  if (!Number.isInteger(offset) || offset < 0) {
    return { ok: false, reason: 'invalid_offset' };
  }

  // Fail-closed default: UNKNOWN (explicitly pass USER_PINNED for user edits)
  const incomingConf = normalizeConfidence(memberSpec.confidence ?? TYPE_CONFIDENCE.UNKNOWN);
  const existingAtExact = currentMembers.find((m) => m.offset === offset);

  // Width resolution order (§9.3):
  // (1) explicitByteSize > (2) resolveCanonicalTypeSize > (3) existing m.size > (4) archPtrBytes + warning
  let warning = null;
  let size = null;
  if (Number.isInteger(memberSpec.explicitByteSize) && memberSpec.explicitByteSize > 0) {
    size = memberSpec.explicitByteSize;
  } else if (Number.isInteger(memberSpec.size) && memberSpec.size > 0) {
    size = memberSpec.size;
  } else {
    const resolved = resolveCanonicalTypeSize(memberSpec.type, { archPtrBytes, knownStructs });
    if (resolved !== null) {
      size = resolved;
    } else if (existingAtExact && existingAtExact.size > 0) {
      size = existingAtExact.size;
    } else {
      size = archPtrBytes;
      warning = 'fallback_arch_ptr_bytes';
    }
  }

  const newStart = offset;
  const newEnd = offset + size;

  const conflicts = currentMembers.filter((m) => {
    const mStart = m.offset;
    const mEnd = m.offset + m.size;
    return mStart < newEnd && mEnd > newStart;
  });

  // Check USER_PINNED protection on any conflicting member
  for (const c of conflicts) {
    const cConf = normalizeConfidence(c.confidence);
    if (cConf === TYPE_CONFIDENCE.USER_PINNED && incomingConf < TYPE_CONFIDENCE.USER_PINNED) {
      return {
        ok: false,
        reason: 'user_pinned_protected',
        conflicts,
      };
    }
    if (
      cConf === TYPE_CONFIDENCE.USER_PINNED &&
      !(c.offset === newStart && c.size === size) &&
      !allowOverwritePinned &&
      resolution !== 'reject'
    ) {
      return {
        ok: false,
        reason: 'user_pinned_conflict',
        conflicts,
      };
    }
  }

  const newMember = {
    name: memberSpec.name || existingAtExact?.name || `field_${offset.toString(16)}`,
    type: memberSpec.type || existingAtExact?.type || `uint${Math.min(64, size * 8)}_t`,
    offset,
    size,
    confidence: incomingConf,
    authority:
      incomingConf === TYPE_CONFIDENCE.USER_PINNED
        ? AUTHORITY_LEVEL.USER_MANUAL
        : memberSpec.authority ?? AUTHORITY_LEVEL.AUTO_TYPE,
  };

  let nextMembers;
  if (conflicts.length === 0) {
    nextMembers = [...currentMembers, newMember];
  } else if (
    conflicts.length === 1 &&
    conflicts[0].offset === newStart &&
    conflicts[0].size === size
  ) {
    if (!canPromoteType(conflicts[0].confidence, incomingConf, { allowSameLevelUpdate: false })) {
      return { ok: false, reason: 'lower_confidence', conflicts };
    }
    nextMembers = currentMembers.map((m) => (m === conflicts[0] ? newMember : m));
  } else if (resolution === 'reject') {
    return {
      ok: false,
      reason: 'member_overlap',
      conflicts,
    };
  } else if (resolution === 'replace_overlapping') {
    const conflictSet = new Set(conflicts);
    nextMembers = currentMembers.filter((m) => !conflictSet.has(m));
    nextMembers.push(newMember);
  } else if (resolution === 'split_container') {
    if (
      conflicts.length !== 1 ||
      conflicts[0].offset > newStart ||
      conflicts[0].offset + conflicts[0].size < newEnd
    ) {
      return {
        ok: false,
        reason: 'cannot_split_non_enclosing',
        conflicts,
      };
    }
    const container = conflicts[0];
    const cStart = container.offset;
    const cEnd = container.offset + container.size;
    nextMembers = currentMembers.filter((m) => m !== container);
    if (newStart > cStart) {
      const leadSize = newStart - cStart;
      nextMembers.push({
        name: `${container.name}_lo`,
        type:
          leadSize === 1 || leadSize === 2 || leadSize === 4 || leadSize === 8
            ? `uint${leadSize * 8}_t`
            : `uint8_t[${leadSize}]`,
        offset: cStart,
        size: leadSize,
        confidence: normalizeConfidence(container.confidence),
        authority: container.authority ?? AUTHORITY_LEVEL.AUTO_TYPE,
      });
    }
    nextMembers.push(newMember);
    if (cEnd > newEnd) {
      const tailSize = cEnd - newEnd;
      nextMembers.push({
        name: `${container.name}_hi`,
        type:
          tailSize === 1 || tailSize === 2 || tailSize === 4 || tailSize === 8
            ? `uint${tailSize * 8}_t`
            : `uint8_t[${tailSize}]`,
        offset: newEnd,
        size: tailSize,
        confidence: normalizeConfidence(container.confidence),
        authority: container.authority ?? AUTHORITY_LEVEL.AUTO_TYPE,
      });
    }
  } else {
    return { ok: false, reason: 'invalid_resolution_mode', conflicts };
  }

  nextMembers.sort((a, b) => a.offset - b.offset);
  const byteSize = nextMembers.reduce((max, m) => Math.max(max, m.offset + m.size), 0);
  const nextStruct = {
    ...(existingStruct || { name: String(structKey) }),
    members: nextMembers,
    byteSize,
  };

  if (isMap) notesStructs.set(structKey, nextStruct);
  else if (notesStructs && typeof notesStructs === 'object') notesStructs[structKey] = nextStruct;

  return {
    ok: true,
    struct: nextStruct,
    member: newMember,
    warning,
    replacedCount: conflicts.length,
  };
}

export class SafeTypePromoter {
  constructor() {
    this.entries = new Map();
  }

  promote(key, incoming, options = {}) {
    return promoteTypeEntry(this.entries, key, incoming, options);
  }

  get(key) {
    return this.entries.get(key) || null;
  }

  isPinned(key) {
    const e = this.entries.get(key);
    return Boolean(e && e.confidence === TYPE_CONFIDENCE.USER_PINNED);
  }
}
