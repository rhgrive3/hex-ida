// UI evidence state is a conservative projection of upstream authority (#5817).
// Only primitive strings may act as a verdict and only primitive finite numbers
// may act as a confidence: structured values, booleans, and numeric strings
// fail closed to 'unverified' instead of being coerced into a stronger status.

function canonicalVerdictText(value) {
  return typeof value === 'string' && value ? value.toLowerCase() : '';
}

function canonicalConfidence(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : NaN;
}

function isVerdictObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function genericEvidenceStatus(item) {
  const verdictHolder = item?.verdict;
  let verdict = '';
  if (isVerdictObject(verdictHolder)) {
    verdict = canonicalVerdictText(verdictHolder.status);
  } else if (typeof verdictHolder === 'string' && verdictHolder) {
    verdict = verdictHolder.toLowerCase();
  } else if (verdictHolder == null || verdictHolder === '') {
    verdict = canonicalVerdictText(item?.status);
  }
  if (verdict === 'contradicted') return 'contradicted';
  if (verdict === 'confirmed' || item?.confirmed === true || item?.verified === true) return 'confirmed';
  const confidenceHolder = item?.confidence ?? (isVerdictObject(verdictHolder) ? verdictHolder.confidence : undefined);
  const confidence = canonicalConfidence(confidenceHolder);
  if (verdict === 'supported' || (Number.isFinite(confidence) && confidence >= 0.75)) return 'likely';
  return 'unverified';
}

export function ownerEvidence(owner) {
  if (!owner) return { status: 'unverified', unique: null, candidates: [] };
  if (owner.ambiguous === true || Array.isArray(owner.owners) && owner.owners.length > 1) {
    return { status: 'likely', unique: null, candidates: (owner.owners || []).filter(Boolean) };
  }
  if (owner.className) return { status: 'confirmed', unique: owner, candidates: [owner] };
  return { status: 'unverified', unique: null, candidates: [] };
}

export function summaryEvidenceStatus(result) {
  const value = result?.summary;
  if (value && typeof value === 'object') return genericEvidenceStatus(value);
  const confidence = canonicalConfidence(result?.summaryConfidence);
  if (Number.isFinite(confidence) && confidence >= 0.75) return 'likely';
  return value ? 'likely' : 'unverified';
}

export function provenanceStatus(provenance) {
  if (!provenance) return 'unverified';
  if (provenance.manual === true || provenance.status === 'manual') return 'manual';
  if (provenance.confirmed === true) return 'confirmed';
  const confidence = canonicalConfidence(provenance.confidence);
  return Number.isFinite(confidence) && confidence >= 0.5 ? 'likely' : 'unverified';
}
