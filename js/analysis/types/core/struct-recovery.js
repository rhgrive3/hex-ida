// JS-parity struct / bitfield / union field recovery from FieldObservation evidence (§4.1, §4.2).
// Pure architecture-neutral core (INV-005: zero imports from js/targets/architecture/).

export const OBS_BASE_KIND = Object.freeze({
  PARAM_PTR: 0,
  THIS_PTR: 1,
  HEAP_ALLOC: 2,
  GLOBAL: 3,
  SRET: 4,
  STACK_SLOT: 5,
});

export const OBS_TYPE_HINT = Object.freeze({
  UNK: 0,
  INT: 1,
  UINT: 2,
  FLOAT: 3,
  DOUBLE: 4,
  PTR: 5,
  SIMD: 6,
});

export const OBS_FLAGS = Object.freeze({
  ACCESS_MASK: 0x03,
  ACCESS_READ: 0x00,
  ACCESS_WRITE: 0x01,
  ACCESS_RMW: 0x02,
  ACCESS_ADDR: 0x03,
  IS_NEUTRAL_COPY: 1 << 2,
  HAS_BITFIELD: 1 << 3,
  HAS_STRIDE: 1 << 4,
  SIGNED_EV: 1 << 5,
  UNSIGNED_EV: 1 << 6,
});

export const DEFAULT_XREF_CAP_TIER_C = 350000;

function isFloatHint(hint) {
  return hint === OBS_TYPE_HINT.FLOAT || hint === OBS_TYPE_HINT.DOUBLE;
}

function isIntOrPtrHint(hint) {
  return hint === OBS_TYPE_HINT.INT || hint === OBS_TYPE_HINT.UINT || hint === OBS_TYPE_HINT.PTR;
}

function hintClass(hint) {
  if (isFloatHint(hint)) return 'fp';
  if (hint === OBS_TYPE_HINT.PTR) return 'ptr';
  if (hint === OBS_TYPE_HINT.SIMD) return 'simd';
  if (hint === OBS_TYPE_HINT.INT || hint === OBS_TYPE_HINT.UINT) return 'int';
  return 'unk';
}

function observationWeight(obs) {
  const flags = Number(obs.obsFlags ?? obs.obs_flags ?? 0);
  if (flags & OBS_FLAGS.IS_NEUTRAL_COPY) return 0;
  const hint = Number(obs.typeHint ?? obs.type_hint ?? OBS_TYPE_HINT.UNK);
  if (isFloatHint(hint) || isIntOrPtrHint(hint) || hint === OBS_TYPE_HINT.SIMD) return 3;
  return 1;
}

function alignUp(value, align) {
  if (align <= 1) return value;
  const rem = value % align;
  return rem === 0 ? value : value + (align - rem);
}

function formatScalarType(typeClass, width, signedVotes, unsignedVotes, archPtrBytes = 8) {
  if (typeClass === 'fp') {
    if (width === 2) return '_Float16';
    if (width === 4) return 'float';
    if (width === 8) return 'double';
    return `uint8_t[${width}]`;
  }
  if (typeClass === 'ptr') {
    return width === archPtrBytes ? 'void *' : `uintptr_t`;
  }
  if (typeClass === 'simd') {
    return width === 16 ? 'v128_t' : `uint8_t[${width}]`;
  }
  const isSigned = signedVotes > unsignedVotes;
  const prefix = isSigned ? 'int' : 'uint';
  if (width === 1 || width === 2 || width === 4 || width === 8) {
    return `${prefix}${width * 8}_t`;
  }
  if (width === 16) return isSigned ? '__int128' : 'unsigned __int128';
  return `uint8_t[${width}]`;
}

function normalizeObservation(raw, offsetToTop = 0) {
  const rawOffset = Number(raw.offset ?? 0);
  const rebasedOffset = rawOffset - offsetToTop;
  const width = Number(raw.accessWidth ?? raw.access_width ?? 0);
  const baseKind = Number(raw.baseKind ?? raw.base_kind ?? OBS_BASE_KIND.PARAM_PTR);
  const typeHint = Number(raw.typeHint ?? raw.type_hint ?? OBS_TYPE_HINT.UNK);
  const obsFlags = Number(raw.obsFlags ?? raw.obs_flags ?? 0);
  const bfLsb = Number(raw.bfLsb ?? raw.bf_lsb ?? 0);
  const bfWidth = Number(raw.bfWidth ?? raw.bf_width ?? 0);
  const strideBytes = Number(raw.strideBytes ?? raw.stride_bytes ?? 0);
  const funcVa = raw.funcVa ?? raw.func_va ?? 0n;
  const insnVa = raw.insnVa ?? raw.insn_va ?? 0n;
  const structSeedId = Number(raw.structSeedId ?? raw.struct_seed_id ?? 0);
  const nameHint = raw.nameHint ?? raw.name ?? null;
  const polymorphic = Boolean(raw.polymorphic);
  return {
    funcVa,
    insnVa,
    structSeedId,
    rawOffset,
    offset: rebasedOffset,
    accessWidth: width,
    baseKind,
    typeHint,
    obsFlags,
    bfLsb,
    bfWidth,
    strideBytes,
    nameHint,
    polymorphic,
  };
}

function resolveBitfields(obsList, containerWidth) {
  const bfObs = obsList.filter(
    (o) => ((o.obsFlags & OBS_FLAGS.HAS_BITFIELD) !== 0 || o.bfWidth > 0) && o.bfWidth > 0
  );
  if (bfObs.length === 0) return null;

  const byRange = new Map();
  for (const o of bfObs) {
    const lsb = o.bfLsb;
    const width = o.bfWidth;
    if (lsb < 0 || width <= 0 || lsb + width > containerWidth * 8) {
      // Fail-Closed to scalar container on invalid bitfield bounds
      return null;
    }
    const key = `${lsb}:${width}`;
    const existing = byRange.get(key) || {
      lsb,
      width,
      signedVotes: 0,
      unsignedVotes: 0,
      evidenceCount: 0,
      name: null,
    };
    existing.evidenceCount += 1;
    if (o.obsFlags & OBS_FLAGS.SIGNED_EV || o.typeHint === OBS_TYPE_HINT.INT) existing.signedVotes += 1;
    if (o.obsFlags & OBS_FLAGS.UNSIGNED_EV || o.typeHint === OBS_TYPE_HINT.UINT) existing.unsignedVotes += 1;
    if (!existing.name && o.nameHint) existing.name = o.nameHint;
    byRange.set(key, existing);
  }

  const sorted = [...byRange.values()].sort((a, b) => a.lsb - b.lsb || a.width - b.width);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (prev.lsb + prev.width > curr.lsb) {
      // Intersecting bitfields -> Fail-Closed to normal integer (§4.2)
      return null;
    }
  }

  return sorted.map((bf) => ({
    name: bf.name || `bf_${bf.lsb}_${bf.width}`,
    lsb: bf.lsb,
    width: bf.width,
    signed: bf.signedVotes > bf.unsignedVotes,
    evidenceCount: bf.evidenceCount,
  }));
}

function summarizeBucket(offset, width, obsList, archPtrBytes) {
  const classWeights = new Map();
  let signedVotes = 0;
  let unsignedVotes = 0;
  let totalWeight = 0;
  let nonNeutralCount = 0;
  let maxStride = 0;
  const funcs = new Set();
  let nameHint = null;

  for (const o of obsList) {
    funcs.add(String(o.funcVa));
    if (!nameHint && o.nameHint) nameHint = o.nameHint;
    if ((o.obsFlags & OBS_FLAGS.HAS_STRIDE) || o.strideBytes > 0) {
      if (o.strideBytes > maxStride) maxStride = o.strideBytes;
    }
    const w = observationWeight(o);
    if (w > 0) {
      nonNeutralCount += 1;
      totalWeight += w;
      const cls = hintClass(o.typeHint);
      classWeights.set(cls, (classWeights.get(cls) || 0) + w);
    }
    if ((o.obsFlags & OBS_FLAGS.SIGNED_EV) || o.typeHint === OBS_TYPE_HINT.INT) signedVotes += 1;
    if ((o.obsFlags & OBS_FLAGS.UNSIGNED_EV) || o.typeHint === OBS_TYPE_HINT.UINT) unsignedVotes += 1;
  }

  // Deterministic conflict resolution (§4.2):
  // Sort classes by weight descending, then fixed precedence ptr > fp > simd > int > unk
  const classOrder = { ptr: 4, fp: 3, simd: 2, int: 1, unk: 0 };
  const ranked = [...classWeights.entries()]
    .filter(([cls]) => cls !== 'unk')
    .sort((a, b) => b[1] - a[1] || (classOrder[b[0]] || 0) - (classOrder[a[0]] || 0));

  const primaryClass = ranked.length > 0 ? ranked[0][0] : 'int';
  const primaryWeight = ranked.length > 0 ? ranked[0][1] : 0;
  const secondaryClass = ranked.length > 1 ? ranked[1][0] : null;
  const secondaryWeight = ranked.length > 1 ? ranked[1][1] : 0;

  // Union condition at same offset/width: both >= 2 and minority >= 25% of top-two total (§4.2)
  const isSameSlotUnion =
    secondaryClass !== null &&
    primaryWeight >= 2 &&
    secondaryWeight >= 2 &&
    secondaryWeight / (primaryWeight + secondaryWeight) >= 0.25;

  const bitfields = !isSameSlotUnion ? resolveBitfields(obsList, width) : null;
  const typeName = formatScalarType(primaryClass, width, signedVotes, unsignedVotes, archPtrBytes);

  // Confidence scoring (0..1 and 0..255)
  const distinctFuncs = funcs.size;
  const conflictPenalty = isSameSlotUnion ? 0.15 : secondaryWeight > 0 ? 0.08 : 0;
  const baseScore =
    0.35 +
    Math.min(0.35, nonNeutralCount * 0.09) +
    Math.min(0.25, Math.max(0, distinctFuncs - 1) * 0.1) +
    (primaryClass !== 'unk' && totalWeight > 0 ? 0.1 : 0) -
    conflictPenalty;
  const confidence = Math.max(0.1, Math.min(0.99, Number(baseScore.toFixed(4))));
  const confidenceU8 = Math.round(confidence * 255);

  if (isSameSlotUnion) {
    const variants = ranked
      .filter(([, w]) => w >= 2 && w / (primaryWeight + secondaryWeight) >= 0.25)
      .map(([cls, w], idx) => ({
        name: `as_${cls}_${idx}`,
        type: formatScalarType(cls, width, signedVotes, unsignedVotes, archPtrBytes),
        typeClass: cls,
        offset: 0,
        size: width,
        weight: w,
      }));
    return {
      kind: 'union',
      name: nameHint || `u_${offset.toString(16)}`,
      offset,
      size: width,
      alignment: Math.min(width, archPtrBytes),
      variants,
      bitfields: null,
      strideBytes: maxStride,
      evidenceCount: obsList.length,
      nonNeutralCount,
      distinctFuncs,
      confidence,
      confidenceU8,
    };
  }

  return {
    kind: bitfields ? 'bitfield_group' : 'field',
    name: nameHint || `field_${offset.toString(16)}`,
    type: typeName,
    typeClass: primaryClass,
    offset,
    size: width,
    alignment: Math.min(width, archPtrBytes),
    signed: signedVotes > unsignedVotes,
    signedVotes,
    unsignedVotes,
    bitfields,
    strideBytes: maxStride,
    evidenceCount: obsList.length,
    nonNeutralCount,
    distinctFuncs,
    confidence,
    confidenceU8,
  };
}

/**
 * Recover a struct/bitfield/union layout from FieldObservation evidence (§4.1, §4.2).
 */
export function recoverStructLayout(observations, options = {}) {
  const {
    structId = 0,
    structName = `struct_${structId}`,
    offsetToTop = 0,
    archPtrBytes = 8,
    isolateStackSlots = true,
    includePadding = true,
    packed = false,
  } = options;

  const normalized = [];
  let rejectedNegative = 0;
  let isolatedStack = 0;
  let polymorphicBlocked = 0;

  for (const raw of observations || []) {
    const obs = normalizeObservation(raw, offsetToTop);
    if (obs.accessWidth <= 0) continue;
    if (isolateStackSlots && obs.baseKind === OBS_BASE_KIND.STACK_SLOT) {
      isolatedStack += 1;
      continue;
    }
    if (obs.polymorphic) {
      polymorphicBlocked += 1;
      continue;
    }
    if (obs.offset < 0) {
      rejectedNegative += 1;
      continue;
    }
    normalized.push(obs);
  }

  // Group exact (offset, accessWidth) observations first
  const bucketMap = new Map();
  for (const obs of normalized) {
    const key = `${obs.offset}:${obs.accessWidth}`;
    let list = bucketMap.get(key);
    if (!list) {
      list = [];
      bucketMap.set(key, list);
    }
    list.push(obs);
  }

  const candidates = [];
  for (const [key, list] of bucketMap.entries()) {
    const [offStr, widthStr] = key.split(':');
    candidates.push(summarizeBucket(Number(offStr), Number(widthStr), list, archPtrBytes));
  }

  // Sort deterministically by offset asc, then size desc
  candidates.sort((a, b) => a.offset - b.offset || b.size - a.size);

  // Coalesce overlapping ranges into union clusters
  const resolved = [];
  let i = 0;
  while (i < candidates.length) {
    let clusterEnd = candidates[i].offset + candidates[i].size;
    const cluster = [candidates[i]];
    let j = i + 1;
    while (j < candidates.length && candidates[j].offset < clusterEnd) {
      cluster.push(candidates[j]);
      const candEnd = candidates[j].offset + candidates[j].size;
      if (candEnd > clusterEnd) clusterEnd = candEnd;
      j += 1;
    }

    if (cluster.length === 1) {
      resolved.push(cluster[0]);
    } else {
      const clusterStart = cluster[0].offset;
      const clusterSize = clusterEnd - clusterStart;
      // Check if smaller fields cleanly partition a larger neutral-only copy
      const largest = cluster[0];
      const subFields = cluster.slice(1);
      const subsNonOverlapping = subFields.every(
        (f, idx) => idx === 0 || subFields[idx - 1].offset + subFields[idx - 1].size <= f.offset
      );
      if (
        largest.offset === clusterStart &&
        largest.size === clusterSize &&
        largest.nonNeutralCount === 0 &&
        subsNonOverlapping
      ) {
        // Largest was only a neutral copy (e.g. memcpy/LDP); prefer concrete subfields
        resolved.push(...subFields);
      } else {
        // Build overlapping union group
        const variants = [];
        for (const member of cluster) {
          if (member.kind === 'union' && Array.isArray(member.variants)) {
            for (const v of member.variants) {
              variants.push({
                ...v,
                offset: member.offset - clusterStart + (v.offset || 0),
              });
            }
          } else {
            variants.push({
              name: member.name,
              type: member.type,
              typeClass: member.typeClass,
              offset: member.offset - clusterStart,
              size: member.size,
              bitfields: member.bitfields || null,
              evidenceCount: member.evidenceCount,
            });
          }
        }
        const totalEvidence = cluster.reduce((s, m) => s + m.evidenceCount, 0);
        const avgConf =
          cluster.reduce((s, m) => s + m.confidence, 0) / cluster.length;
        const unionConf = Math.max(0.1, Number((avgConf * 0.9).toFixed(4)));
        resolved.push({
          kind: 'union',
          name: `union_${clusterStart.toString(16)}`,
          offset: clusterStart,
          size: clusterSize,
          alignment: Math.min(
            archPtrBytes,
            cluster.reduce((m, c) => Math.max(m, c.alignment || 1), 1)
          ),
          variants,
          bitfields: null,
          evidenceCount: totalEvidence,
          confidence: unionConf,
          confidenceU8: Math.round(unionConf * 255),
        });
      }
    }
    i = j;
  }

  // Insert alignment padding between fields and compute total struct size
  const members = [];
  let cursor = 0;
  let maxAlign = 1;
  for (const field of resolved) {
    if (field.offset > cursor && includePadding) {
      members.push({
        kind: 'padding',
        name: `_pad_${cursor.toString(16)}`,
        type: `uint8_t[${field.offset - cursor}]`,
        offset: cursor,
        size: field.offset - cursor,
        alignment: 1,
        confidence: 1.0,
        confidenceU8: 255,
      });
    }
    members.push(field);
    cursor = Math.max(cursor, field.offset + field.size);
    const fAlign = packed ? 1 : Math.max(1, Math.min(archPtrBytes, field.alignment || 1));
    if (fAlign > maxAlign) maxAlign = fAlign;
  }

  const tailAlignedSize = packed ? cursor : alignUp(cursor, maxAlign);
  if (tailAlignedSize > cursor && includePadding && members.length > 0) {
    members.push({
      kind: 'padding',
      name: `_pad_tail_${cursor.toString(16)}`,
      type: `uint8_t[${tailAlignedSize - cursor}]`,
      offset: cursor,
      size: tailAlignedSize - cursor,
      alignment: 1,
      confidence: 1.0,
      confidenceU8: 255,
    });
  }

  const realFields = members.filter((m) => m.kind !== 'padding');
  const overallConfidence =
    realFields.length === 0
      ? 0
      : Number(
          (
            realFields.reduce((acc, f) => acc + f.confidence, 0) / realFields.length
          ).toFixed(4)
        );

  return {
    structId,
    name: structName,
    byteSize: tailAlignedSize,
    alignment: maxAlign,
    packed,
    members,
    fieldCount: realFields.length,
    confidence: overallConfidence,
    confidenceU8: Math.round(overallConfidence * 255),
    stats: {
      totalObservations: (observations || []).length,
      acceptedObservations: normalized.length,
      rejectedNegative,
      isolatedStack,
      polymorphicBlocked,
    },
  };
}

/**
 * Build an 8B-packed Struct Member Xref Index (§4.1).
 * Each entry packs (funcIdx: u32, insnRelAndKind: u32 = ((insnRel << 2) | (accessKind & 3))).
 */
export function buildStructMemberXrefIndex(observations, options = {}) {
  const cap = options.hexDbEnabled ? Infinity : (options.maxEntries ?? DEFAULT_XREF_CAP_TIER_C);
  const byKey = new Map();
  let totalPacked = 0;
  let truncated = false;

  for (const raw of observations || []) {
    const structSeedId = Number(raw.structSeedId ?? raw.struct_seed_id ?? 0);
    const offset = Number(raw.offset ?? 0);
    if (offset < 0) continue;
    const funcIdx = Number(raw.funcIdx ?? raw.func_idx ?? 0) >>> 0;
    const insnRel = Number(raw.insnRel ?? raw.insn_rel ?? 0) >>> 0;
    const accessKind = Number(raw.obsFlags ?? raw.obs_flags ?? 0) & OBS_FLAGS.ACCESS_MASK;
    const key = `${structSeedId}:${offset}`;
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { structSeedId, offset, entries: [], truncated: false };
      byKey.set(key, bucket);
    }
    if (totalPacked >= cap) {
      bucket.truncated = true;
      truncated = true;
      continue;
    }
    const packedMeta = (((insnRel & 0x3fffffff) << 2) | (accessKind & 0x3)) >>> 0;
    bucket.entries.push({ funcIdx, insnRelAndKind: packedMeta });
    totalPacked += 1;
  }

  // Pack into CSR Uint32Array (2 u32 = 8 bytes per xref)
  const packedU32 = new Uint32Array(totalPacked * 2);
  const index = new Map();
  let writeCursor = 0;
  for (const [key, bucket] of byKey.entries()) {
    const start = writeCursor;
    for (const e of bucket.entries) {
      packedU32[writeCursor * 2] = e.funcIdx;
      packedU32[writeCursor * 2 + 1] = e.insnRelAndKind;
      writeCursor += 1;
    }
    index.set(key, {
      structSeedId: bucket.structSeedId,
      offset: bucket.offset,
      start,
      count: bucket.entries.length,
      truncated: bucket.truncated,
    });
  }

  return {
    index,
    packedU32,
    totalEntries: totalPacked,
    byteLength: packedU32.byteLength,
    truncated,
    query(structSeedId, offset) {
      const meta = index.get(`${structSeedId}:${offset}`);
      if (!meta) return { entries: [], truncated: false };
      const out = [];
      for (let k = 0; k < meta.count; k++) {
        const base = (meta.start + k) * 2;
        const funcIdx = packedU32[base];
        const word = packedU32[base + 1];
        out.push({
          funcIdx,
          insnRel: word >>> 2,
          accessKind: word & 0x3,
        });
      }
      return { entries: out, truncated: meta.truncated };
    },
  };
}

export class StructRecoveryEngine {
  constructor(options = {}) {
    this.archPtrBytes = options.archPtrBytes ?? 8;
    this.layouts = new Map();
  }

  recover(structId, observations, options = {}) {
    const layout = recoverStructLayout(observations, {
      archPtrBytes: this.archPtrBytes,
      structId,
      ...options,
    });
    this.layouts.set(structId, layout);
    return layout;
  }

  getLayout(structId) {
    return this.layouts.get(structId) || null;
  }

  clear() {
    this.layouts.clear();
  }
}
