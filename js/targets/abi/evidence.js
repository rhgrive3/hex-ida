/*
 * Shared ABI evidence contract.
 *
 * ABI placement is a canonical fact produced by a registered profile.  These
 * helpers only validate the evidence envelope at publication boundaries; they
 * do not classify parameters or invent physical locations.
 */

export const ABI_NON_EXACT_STATES = Object.freeze([
  'stale', 'malformed', 'conflict', 'cancelled', 'canceled', 'cancellation',
  'cancel', 'deadline', 'deadline-exceeded', 'deadline-expired', 'timeout',
  'timed-out', 'truncated', 'budget', 'budget-exhausted', 'budget-limited',
  'resource-exhausted', 'resource-budget-exhausted', 'resource-budget-limited',
  'unsupported', 'unsupported-profile', 'profile-mismatch', 'identity-mismatch',
  'invalid', 'failed', 'error', 'indirect-call', 'ambiguous',
  'unknown', 'incomplete', 'incomplete-run', 'partial', 'provisional',
  'unverified', 'not-proven', 'not-complete',
]);

const NON_EXACT = new Set(ABI_NON_EXACT_STATES);

export function abiInvalidState(value) {
  const state = String(value ?? '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  return NON_EXACT.has(state) ? state : null;
}

export function abiResultInvalidState(value) {
  if (!value || typeof value !== 'object') return null;
  // Producers use both a normalized status string and boolean terminal flags.
  // Treat either form as the same fail-closed observation; otherwise an
  // adapter could attach `partial: true` (or a cancellation/budget flag) to a
  // result that still contains exact-looking placements and have a consumer
  // accept those placements.
  if (value.unsupported === true) return 'unsupported';
  if (value.partial === true) return 'partial';
  if (value.malformed === true || value.malformedEvidence === true) return 'malformed';
  if (value.cancelled === true || value.canceled === true || value.cancellation === true) return 'cancelled';
  if (value.deadlineExceeded === true || value.deadlineExpired === true) return 'deadline-exceeded';
  if (value.truncated === true || value.truncatedRun === true) return 'truncated';
  if (value.budgetExhausted === true || value.resourceBudgetExhausted === true) return 'budget-exhausted';
  if (value.budgetLimited === true || value.resourceBudgetLimited === true) return 'budget-limited';
  const states = [
    value.status, value.analysisStatus, value.state, value.completeness, value.evidenceStatus,
    value.identity?.status, value.identity?.state, value.identity?.completeness,
    value.identity?.invalidation?.status, value.identity?.invalidation?.state,
    value.identity?.invalidation?.completeness,
    value.provenance?.status, value.provenance?.state, value.provenance?.completeness,
    value.provenance?.invalidation?.status, value.provenance?.invalidation?.state,
    value.provenance?.invalidation?.completeness,
    value.invalidation?.status, value.invalidation?.state, value.invalidation?.completeness,
    value.abiInvalidation?.status, value.abiInvalidation?.state, value.abiInvalidation?.completeness,
  ].map(abiInvalidState).filter(Boolean);
  // A hard terminal status must not be hidden by a simultaneous `partial:true`
  // convenience flag.  Only an explicitly partial envelope may use the
  // conservative unknown-prototype path in consumers.
  const hardState = states.find((state) => state !== 'partial');
  return hardState || (value.partial === true ? 'partial' : states[0] || null);
}

function record(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sameScalar(left, right) {
  if (left == null || right == null) return left == null && right == null;
  return String(left) === String(right);
}

function sameProfile(left, right) {
  if (!record(left) || !record(right)) return false;
  const fields = [
    'id', 'profileIdentity', 'semanticIdentity', 'abiSemanticIdentity', 'abiId',
    'architectureId', 'architecture', 'platform', 'platformId',
  ];
  return fields.every((field) => sameScalar(left[field], right[field]));
}

/*
 * Validate the identity/provenance/invalidation envelope emitted by
 * semanticAbiAdapter.classifyCall().  An adapter that supplies placements but
 * omits this envelope is not a compatibility adapter; accepting it would let
 * arbitrary decompiler-local ABI guesses become canonical facts.
 */
export function canonicalAbiEvidence(raw) {
  if (!record(raw)) return false;
  const required = ['abiId', 'abiSemanticVersion', 'abiSemanticIdentity'];
  if (required.some((field) => typeof raw[field] !== 'string' || !raw[field].trim())) return false;
  if (!record(raw.abiIdentity) || !record(raw.provenance) || !record(raw.invalidation)) return false;
  if (raw.provenance.source !== 'canonical-abi-registry') return false;
  if (typeof raw.registryDigest !== 'string' || !raw.registryDigest.trim()
    || !sameScalar(raw.abiIdentity.registryDigest, raw.registryDigest)
    || !sameScalar(raw.provenance.registryDigest, raw.registryDigest)
    || !sameScalar(raw.invalidation.registryDigest, raw.registryDigest)) return false;

  const identity = raw.abiIdentity;
  const profile = identity.architectureProfile;
  if (!record(profile) || !sameProfile(profile, raw.invalidation.architectureProfile)
    || !sameProfile(profile, raw.provenance.architectureProfile)) return false;
  const profileRequired = [
    'id', 'profileIdentity', 'semanticIdentity', 'abiSemanticIdentity', 'abiId',
    'architectureId', 'architecture',
  ];
  if (profileRequired.some((field) => typeof profile[field] !== 'string' || !profile[field].trim())) return false;
  if (!sameScalar(profile.architecture, profile.architectureId)
    || !sameScalar(profile.platform, profile.platformId)) return false;
  // Darwin arm64 is a platform/profile ABI, not an architecture synonym.
  // A copied identity with only `arm64` must never authorize Apple aggregate
  // placement or hidden sret publication.
  if (raw.abiId === 'darwin-arm64'
    && (typeof identity.platform !== 'string' || !identity.platform.trim()
      || typeof profile.platform !== 'string' || !profile.platform.trim()
      || !sameScalar(identity.platform, profile.platform)
      || !sameScalar(identity.platform, profile.platformId))) return false;
  const profileMirrors = [
    ['id', raw.abiSemanticIdentity],
    ['profileIdentity', raw.abiSemanticIdentity],
    ['semanticIdentity', raw.abiSemanticIdentity],
    ['abiSemanticIdentity', raw.abiSemanticIdentity],
    ['abiId', raw.abiId],
  ];
  if (profileMirrors.some(([field, expected]) => !sameScalar(profile[field], expected))) return false;
  const identityRequired = [
    'id', 'semanticVersion', 'semanticIdentity', 'architectureId',
    'targetArchitecture', 'profileIdentity', 'abiId', 'registryDigest',
  ];
  if (identityRequired.some((field) => typeof identity[field] !== 'string' || !identity[field].trim())) return false;

  const identityFields = [
    ['id', raw.abiId],
    ['semanticVersion', raw.abiSemanticVersion],
    ['semanticIdentity', raw.abiSemanticIdentity],
    ['profileIdentity', profile.profileIdentity],
    ['abiId', raw.abiId],
    ['architectureId', profile.architectureId],
    ['targetArchitecture', profile.architecture],
  ];
  if (identityFields.some(([field, expected]) => !sameScalar(identity[field], expected))) return false;

  const provenanceFields = [
    ['abiId', raw.abiId],
    ['semanticVersion', raw.abiSemanticVersion],
    ['semanticIdentity', raw.abiSemanticIdentity],
    ['registryDigest', raw.registryDigest],
    ['profileIdentity', profile.profileIdentity],
    ['targetArchitecture', identity.targetArchitecture],
    ['platformId', identity.platform],
    ['architectureProfile', profile],
  ];
  if (provenanceFields.some(([field, expected]) => {
    if (field === 'architectureProfile') return !sameProfile(raw.provenance[field], expected);
    return !sameScalar(raw.provenance[field], expected);
  })) return false;

  const invalidationFields = [
    ['abiId', raw.abiId],
    ['abiSemanticVersion', raw.abiSemanticVersion],
    ['abiSemanticIdentity', raw.abiSemanticIdentity],
    ['registryDigest', raw.registryDigest],
    ['profileIdentity', profile.profileIdentity],
    ['targetArchitecture', identity.targetArchitecture],
    ['platformId', identity.platform],
    ['architectureProfile', profile],
  ];
  if (invalidationFields.some(([field, expected]) => {
    if (field === 'architectureProfile') return !sameProfile(raw.invalidation[field], expected);
    return !sameScalar(raw.invalidation[field], expected);
  })) return false;

  // The nested invalidation record is checked before any consumer is allowed
  // to inspect return locations.  Matching only the top-level ABI id is not
  // sufficient because snapshot, analyzer, and profile changes invalidate the
  // placement fact too.
  for (const field of [
    'schemaVersion', 'snapshotId', 'analyzerId', 'analyzerVersion',
    'binaryId', 'sliceId', 'functionId',
  ]) {
    if (!sameScalar(identity[field], raw.invalidation[field])) return false;
    if (!sameScalar(identity[field], raw.provenance[field])) return false;
  }
  return true;
}

/*
 * Hidden sret is a separate proof boundary from the enclosing return result.
 * A register name copied onto an otherwise valid result is not enough: the
 * pointer's input, location, profile, provenance, and invalidation records
 * must all describe the same canonical ABI fact.  Keep this check shared by
 * the adapter, prototype recovery, and v2 compatibility projection.
 */
export function canonicalAbiHiddenResult(raw, hidden) {
  if (!canonicalAbiEvidence(raw) || abiResultInvalidState(raw) || !record(hidden)) return false;
  if (abiResultInvalidState(hidden)) return false;
  const input = hidden.input;
  const identity = raw.abiIdentity;
  const profile = identity.architectureProfile;
  if (typeof input !== 'string' || !input.trim()
    || hidden.canonicalInput !== input
    || hidden.location !== 'register'
    || !Number.isSafeInteger(Number(hidden.pointerBits)) || Number(hidden.pointerBits) <= 0
    || !sameScalar(hidden.profileIdentity, profile.profileIdentity)
    || !sameScalar(hidden.abiId, raw.abiId)
    || !sameScalar(hidden.abiSemanticIdentity, raw.abiSemanticIdentity)
    || !sameScalar(hidden.registryDigest, raw.registryDigest)) return false;

  if (!record(hidden.abiIdentity) || !record(hidden.provenance) || !record(hidden.invalidation)) return false;
  const identityFields = [
    ['id', identity.id],
    ['semanticVersion', identity.semanticVersion],
    ['semanticIdentity', identity.semanticIdentity],
    ['architectureId', identity.architectureId],
    ['targetArchitecture', identity.targetArchitecture],
    ['platform', identity.platform],
    ['profileIdentity', identity.profileIdentity],
    ['abiId', identity.abiId],
    ['registryDigest', identity.registryDigest],
    ['schemaVersion', identity.schemaVersion],
    ['snapshotId', identity.snapshotId],
    ['analyzerId', identity.analyzerId],
    ['analyzerVersion', identity.analyzerVersion],
    ['binaryId', identity.binaryId],
    ['sliceId', identity.sliceId],
    ['functionId', identity.functionId],
    ['architectureProfile', profile],
  ];
  if (identityFields.some(([field, expected]) => field === 'architectureProfile'
    ? !sameProfile(hidden.abiIdentity[field], expected)
    : !sameScalar(hidden.abiIdentity[field], expected))) return false;
  if (hidden.provenance.source !== 'canonical-abi-registry') return false;
  const provenanceFields = [
    ['abiId', raw.provenance.abiId],
    ['semanticVersion', raw.provenance.semanticVersion],
    ['semanticIdentity', raw.provenance.semanticIdentity],
    ['registryDigest', raw.provenance.registryDigest],
    ['architectureId', raw.provenance.architectureId],
    ['profileIdentity', raw.provenance.profileIdentity],
    ['targetArchitecture', raw.provenance.targetArchitecture],
    ['platformId', raw.provenance.platformId],
    ['schemaVersion', raw.provenance.schemaVersion],
    ['snapshotId', raw.provenance.snapshotId],
    ['analyzerId', raw.provenance.analyzerId],
    ['analyzerVersion', raw.provenance.analyzerVersion],
    ['binaryId', raw.provenance.binaryId],
    ['sliceId', raw.provenance.sliceId],
    ['functionId', raw.provenance.functionId],
    ['architectureProfile', profile],
  ];
  if (provenanceFields.some(([field, expected]) => field === 'architectureProfile'
    ? !sameProfile(hidden.provenance[field], expected)
    : !sameScalar(hidden.provenance[field], expected))) return false;
  const invalidationFields = [
    ['abiId', raw.invalidation.abiId],
    ['abiSemanticVersion', raw.invalidation.abiSemanticVersion],
    ['abiSemanticIdentity', raw.invalidation.abiSemanticIdentity],
    ['registryDigest', raw.invalidation.registryDigest],
    ['architectureId', raw.invalidation.architectureId],
    ['targetArchitecture', raw.invalidation.targetArchitecture],
    ['platformId', raw.invalidation.platformId],
    ['profileIdentity', raw.invalidation.profileIdentity],
    ['schemaVersion', raw.invalidation.schemaVersion],
    ['snapshotId', raw.invalidation.snapshotId],
    ['analyzerId', raw.invalidation.analyzerId],
    ['analyzerVersion', raw.invalidation.analyzerVersion],
    ['binaryId', raw.invalidation.binaryId],
    ['sliceId', raw.invalidation.sliceId],
    ['functionId', raw.invalidation.functionId],
    ['architectureProfile', profile],
  ];
  return !invalidationFields.some(([field, expected]) => field === 'architectureProfile'
    ? !sameProfile(hidden.invalidation[field], expected)
    : !sameScalar(hidden.invalidation[field], expected));
}

function positiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function offsetValue(value) {
  return nonNegativeInteger(value);
}

function safeEnd(offset, bytes) {
  const end = offset + bytes;
  return Number.isSafeInteger(end) && end > offset ? end : null;
}

/*
 * Normalize a canonical aggregate's physical pieces without filling a hole.
 * Every physical span and position must be emitted by the canonical producer;
 * this helper only validates and copies it.  The caller may then attach its
 * own register aliases.
 */
export function normalizeAbiPieces(container, rawPieces, { defaultAbiClass = null } = {}) {
  if (!record(container) || !Array.isArray(rawPieces) || rawPieces.length === 0) return null;
  // Both logical width and physical span are canonical facts.  Inferring one
  // from the other would erase ABI padding and permit a truncated aggregate
  // to be laundered as complete.
  if (!Object.hasOwn(container, 'bits') || !Object.hasOwn(container, 'bytes')) return null;
  const totalBits = positiveInteger(container.bits);
  const totalBytes = positiveInteger(container.bytes);
  if (totalBits == null || totalBytes == null) return null;
  const minimumBytes = Math.ceil(totalBits / 8);
  const pieces = [];
  const pieceIndexes = new Set();
  const orders = new Set();
  const ranges = [];
  const declaredRegisters = Array.isArray(container.regs)
    ? container.regs.filter((reg) => typeof reg === 'string' && reg.trim()).map(String)
    : typeof container.reg === 'string' && container.reg.trim() ? [String(container.reg)] : [];
  const declaredRegisterSet = new Set(declaredRegisters);
  if (declaredRegisters.length !== declaredRegisterSet.size) return null;
  const expectedClasses = Array.isArray(container.eightbyteClasses)
    ? container.eightbyteClasses
    : Array.isArray(container.pieceClasses) ? container.pieceClasses
      : Array.isArray(container.registerClasses) ? container.registerClasses : null;
  const pieceRegisters = new Set();
  const physicalStackRanges = [];
  let cursor = 0;
  let coveredBits = 0;

  for (let index = 0; index < rawPieces.length; index++) {
    const piece = rawPieces[index];
    if (!record(piece)) return null;
    const rawReg = piece.reg ?? piece.register ?? null;
    const rawStackOffset = piece.stackOffset ?? piece.offset ?? null;
    const hasRegister = typeof rawReg === 'string' && rawReg.trim().length > 0;
    const hasStack = rawStackOffset != null;
    if (hasRegister === hasStack) return null;
    if (hasRegister) {
      if (declaredRegisterSet.size > 0 && !declaredRegisterSet.has(String(rawReg))) return null;
      pieceRegisters.add(String(rawReg));
    }
    const stackOffset = hasStack ? offsetValue(rawStackOffset) : null;
    if (hasStack && stackOffset == null) return null;

    // Canonical pieces must carry both logical width and physical byte span.
    // Deriving either one here would let a malformed adapter launder a missing
    // lane into an exact aggregate.
    if (!Object.hasOwn(piece, 'bits') || !Object.hasOwn(piece, 'bytes')) return null;
    const normalizedBits = positiveInteger(piece.bits);
    const bytes = positiveInteger(piece.bytes);
    if (normalizedBits == null || bytes == null || Math.ceil(normalizedBits / 8) > bytes) return null;
    if (!Object.hasOwn(piece, 'abiClass')) return null;
    const abiClass = piece.abiClass;
    if (typeof abiClass !== 'string' || !abiClass.trim()) return null;

    if (hasStack) {
      // A stack destination is a physical byte range, not just a scalar
      // offset copied through to a consumer. Validate its alignment and keep
      // the ranges separate from logical byteOffset coverage so duplicate or
      // overlapping destinations cannot masquerade as a complete aggregate.
      const rawAlignment = piece.stackAlignment ?? container.stackAlignment;
      const alignment = rawAlignment == null
        ? (bytes >= 8 ? 8 : bytes >= 4 ? 4 : bytes >= 2 ? 2 : 1)
        : positiveInteger(rawAlignment);
      if (alignment == null || stackOffset % alignment !== 0) return null;
      const physicalEnd = safeEnd(stackOffset, bytes);
      if (physicalEnd == null) return null;
      if (physicalStackRanges.some(({ start, end }) => stackOffset < end && start < physicalEnd)) return null;
      physicalStackRanges.push({ start:stackOffset, end:physicalEnd, order:piece.order, pieceIndex:piece.pieceIndex });
    }

    // Aggregate positions are evidence, not presentation defaults.  A
    // compatibility adapter that omits any one of them cannot establish which
    // physical lane owns which bytes, even if the array happens to be ordered.
    if (!Object.hasOwn(piece, 'pieceIndex') || !Object.hasOwn(piece, 'order')
      || !Object.hasOwn(piece, 'byteOffset')) return null;
    const pieceIndex = nonNegativeInteger(piece.pieceIndex);
    const order = nonNegativeInteger(piece.order);
    if (pieceIndex == null || order == null || pieceIndexes.has(pieceIndex) || orders.has(order)) return null;
    if (Object.hasOwn(piece, 'pieceIndex') && Object.hasOwn(piece, 'index')
      && nonNegativeInteger(piece.index) !== pieceIndex) return null;
    pieceIndexes.add(pieceIndex);
    orders.add(order);

    if (expectedClasses && !(expectedClasses.length === 1
      && String(expectedClasses[0]).toLowerCase() === 'memory')
      && (expectedClasses[pieceIndex] == null
        || String(expectedClasses[pieceIndex]).toLowerCase() !== String(abiClass).toLowerCase())) return null;
    const expectedPosition = Array.isArray(container.piecePositions)
      ? container.piecePositions[pieceIndex]
      : Array.isArray(container.registerPositions) ? container.registerPositions[pieceIndex] : null;
    if (expectedPosition != null && String(expectedPosition) !== String(rawReg ?? rawStackOffset)) return null;

    const byteOffset = nonNegativeInteger(piece.byteOffset);
    if (byteOffset == null) return null;
    const end = safeEnd(byteOffset, bytes);
    if (end == null || (totalBytes != null && end > totalBytes)) return null;
    if (ranges.some(([start, finish]) => byteOffset < finish && start < end)) return null;
    ranges.push([byteOffset, end]);
    cursor = Math.max(cursor, end);
    coveredBits += normalizedBits;
    pieces.push({
      ...piece,
      ...(hasRegister ? { reg:String(rawReg), stackOffset:undefined } : {
        reg:null,
        // Canonical stack coordinates stay finite safe integers. Do not round
        // strings or BigInts through Number: doing so can turn two distinct
        // physical intervals into one cache/publication key.
        stackOffset,
      }),
      abiClass,
      pieceIndex,
      order,
      bits:normalizedBits,
      bytes,
      byteOffset,
    });
  }

  const expectedIndexes = Array.from({ length:pieces.length }, (_value, index) => index);
  if (pieces.some((piece) => !expectedIndexes.includes(piece.pieceIndex))) return null;
  const orderedPieces = pieces.slice().sort((left, right) => left.order - right.order);
  if (orderedPieces.some((piece, index) => piece.order !== index || piece.pieceIndex !== index)) return null;
  const orderedPhysicalStackRanges = physicalStackRanges.slice().sort((left, right) => left.order - right.order);
  if (orderedPhysicalStackRanges.some((range, index) => index > 0
    && range.start < orderedPhysicalStackRanges[index - 1].start)) return null;
  if (expectedClasses && expectedClasses.length !== pieces.length
    && !(expectedClasses.length === 1 && String(expectedClasses[0]).toLowerCase() === 'memory')) return null;
  const expectedPositions = Array.isArray(container.piecePositions)
    ? container.piecePositions
    : Array.isArray(container.registerPositions) ? container.registerPositions : null;
  if (expectedPositions && expectedPositions.length !== pieces.length) return null;
  if (declaredRegisterSet.size > 0 && pieceRegisters.size !== declaredRegisterSet.size) return null;
  // A physical aggregate layout is ordered byte coverage, not merely a list
  // of distinct destinations.  Reject holes even when the summed widths look
  // large enough; otherwise a consumer could mistake an absent lane for
  // padding or silently fabricate its value.
  const orderedRanges = ranges.slice().sort(([left], [right]) => left - right);
  let coveredEnd = 0;
  for (const [start, end] of orderedRanges) {
    if (start !== coveredEnd) return null;
    coveredEnd = end;
  }
  if (coveredEnd !== cursor || (totalBytes != null && coveredEnd !== totalBytes)) return null;
  if (totalBits != null && coveredBits !== totalBits) return null;
  if (minimumBytes != null && coveredEnd < minimumBytes) return null;
  return pieces;
}

function physicalInterval(offset, bytes) {
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0
    || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0) return null;
  const end = safeEnd(offset, bytes);
  return end == null ? null : { start:offset, end };
}

function entryStackIntervals(entry) {
  if (!record(entry)) return null;
  // Possible/unknown frontier entries intentionally carry no physical span;
  // they are conservative candidates, not contradictory stack evidence.
  if (entry.possible === true || entry.mustUse === false || entry.partial === true) return [];
  const pieces = Array.isArray(entry.pieces)
    ? entry.pieces
    : Array.isArray(entry.parts) ? entry.parts : null;
  if (pieces) {
    const intervals = [];
    for (const piece of pieces) {
      if (!record(piece)) return null;
      const offset = piece.stackOffset ?? piece.offset ?? null;
      if (offset == null) continue;
      const span = physicalInterval(offset, piece.bytes);
      if (!span) return null;
      intervals.push({ ...span, pieceIndex:piece.pieceIndex ?? piece.index ?? null });
    }
    const location = String(entry.location || '').toLowerCase();
    if (location === 'stack' && intervals.length !== pieces.length) return null;
    if (location === 'stack' && intervals.length) {
      const ordered = intervals.slice().sort((left, right) => left.start - right.start);
      const first = ordered[0].start;
      let end = first;
      for (const span of ordered) {
        if (span.start !== end) return null;
        end = span.end;
      }
      const declaredOffset = entry.offset ?? entry.stackOffset ?? null;
      const declaredBytes = entry.bytes ?? entry.stackBytes ?? null;
      const declared = physicalInterval(declaredOffset, declaredBytes);
      if (!declared || declared.start !== first || declared.end !== end) return null;
    }
    return intervals;
  }
  const location = String(entry.location || '').toLowerCase();
  const offset = entry.stackOffset ?? entry.offset ?? entry.calleeEntryOffset ?? null;
  if (offset == null) return ['stack', 'stack-fragment', 'register-stack', 'register-and-stack'].includes(location)
    ? null : [];
  const bytes = entry.bytes ?? entry.stackBytes ?? null;
  const span = physicalInterval(offset, bytes);
  return span ? [{ ...span, pieceIndex:null }] : null;
}

function sameCanonicalSplit(left, right) {
  const splitLocations = new Set(['register-stack', 'register-and-stack', 'stack-fragment']);
  const leftLocation = String(left?.location || '').toLowerCase();
  const rightLocation = String(right?.location || '').toLowerCase();
  if (!splitLocations.has(leftLocation) && !splitLocations.has(rightLocation)) return false;
  if (left?.index == null || right?.index == null || String(left.index) !== String(right.index)) return false;
  return true;
}

function sameSpan(left, right) { return left.start === right.start && left.end === right.end; }

function intervalsOverlap(left, right) { return left.start < right.end && right.start < left.end; }

/**
 * Validate all exact argument/return stack spans in one classifier result.
 * `arguments` and `stackArguments` commonly expose the same canonical split
 * entry through two projections; that one explicitly identified projection is
 * allowed. Distinct scalar entries, duplicate evidence, and every ambiguous
 * overlap are rejected before a consumer can publish an exact prototype.
 */
export function abiPhysicalIntervalsValid(result) {
  if (!record(result)) return false;
  const validateGroup = (entries, supplemental = [], label = 'argument') => {
    const intervals = [];
    const seenObjects = new Set();
    const all = [
      ...(Array.isArray(entries) ? entries.map((entry) => ({ entry, source:'canonical' })) : []),
      ...(Array.isArray(supplemental) ? supplemental.map((entry) => ({ entry, source:'supplemental' })) : []),
    ];
    for (const { entry, source } of all) {
      if (!record(entry)) return false;
      if (seenObjects.has(entry)) continue;
      seenObjects.add(entry);
      const spans = entryStackIntervals(entry);
      if (spans == null) return false;
      for (const span of spans) {
        const duplicate = intervals.find((candidate) => intervalsOverlap(candidate.span, span));
        if (!duplicate) {
          intervals.push({ span, entry, source, label });
          continue;
        }
        // One aggregate split entry is deliberately projected into both
        // `arguments` and `stackArguments`. It is the only duplicate physical
        // span that can be proven canonical without guessing ownership.
        if (sameSpan(duplicate.span, span)
          && duplicate.source !== source
          && sameCanonicalSplit(duplicate.entry, entry)) continue;
        return false;
      }
    }
    return true;
  };

  if (!validateGroup(result.arguments, result.stackArguments, 'argument')) return false;
  const returnEntries = Array.isArray(result.returnLocations)
    ? result.returnLocations
    : Array.isArray(result.pieces) ? result.pieces
      : Array.isArray(result.parts) ? result.parts : [];
  return validateGroup(returnEntries, [], 'return');
}
