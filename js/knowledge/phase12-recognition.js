import { deepFreeze, stableDigest } from '../core/identity/index.js';
import { importPhase12Package } from '../phase12/package-envelope.js';

export const RECOGNITION_ALGORITHM_VERSION = 'hex-recognition-phase12-v1';
export const MATCH_TIERS = Object.freeze(['exact-content', 'relocation-normalized', 'structural', 'semantic', 'capability']);

function clamp(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
function list(value) { return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))].sort(); }
function tierRank(value) { const index = MATCH_TIERS.indexOf(value); return index < 0 ? MATCH_TIERS.length : index; }

export function createMatchResult(input = {}) {
  const sourceEntityId = String(input.sourceEntityId || input.entityId || '').trim();
  const packageEntryId = String(input.packageEntryId || input.entryId || '').trim();
  if (!sourceEntityId || !packageEntryId) throw new TypeError('recognition source and package identities are required');
  if (Array.isArray(input.candidates) && input.candidates.length === 0) throw new TypeError('recognition candidates are required');
  const candidates = (Array.isArray(input.candidates) ? input.candidates : [{ ...input, sourceEntityId, packageEntryId }]).map((candidate) => ({
    sourceEntityId: String(candidate.sourceEntityId || sourceEntityId),
    packageEntryId: String(candidate.packageEntryId || candidate.entryId || packageEntryId),
    tier: MATCH_TIERS.includes(candidate.tier) ? candidate.tier : 'semantic',
    score: clamp(candidate.score ?? candidate.confidence),
    confidence: clamp(candidate.confidence ?? candidate.score),
    featuresUsed: list(candidate.featuresUsed || candidate.features),
    conflictingFeatures: list(candidate.conflictingFeatures || candidate.conflicts),
    evidenceIds: list(candidate.evidenceIds || candidate.evidence),
    packageContentHash: String(candidate.packageContentHash || input.packageContentHash || ''),
  })).sort((a, b) => b.score - a.score || tierRank(a.tier) - tierRank(b.tier) || a.packageEntryId.localeCompare(b.packageEntryId));
  const top = candidates[0];
  const second = candidates[1] || null;
  const rawAmbiguityWindow = Number(input.ambiguityWindow ?? 0.035);
  const ambiguityWindow = Number.isFinite(rawAmbiguityWindow) ? Math.max(0, rawAmbiguityWindow) : 0.035;
  const ambiguityMargin = second ? Math.max(0, top.score - second.score) : 1;
  const candidateSearchTruncated = input.candidateSearchTruncated === true || input.truncated === true || input.candidateSearch?.truncated === true;
  const ambiguous = candidateSearchTruncated || !!second && ambiguityMargin <= ambiguityWindow;
  const result = {
    id: `match:${stableDigest({ sourceEntityId, packageEntryId: top.packageEntryId, packageContentHash: top.packageContentHash, algorithm: RECOGNITION_ALGORITHM_VERSION })}`,
    sourceEntityId,
    packageEntryId: top.packageEntryId,
    tier: top.tier,
    score: top.score,
    confidence: top.confidence,
    ambiguityMargin,
    featuresUsed: top.featuresUsed,
    conflictingFeatures: top.conflictingFeatures,
    algorithmVersion: RECOGNITION_ALGORITHM_VERSION,
    packageContentHash: top.packageContentHash || null,
    evidenceIds: top.evidenceIds,
    completeness: candidateSearchTruncated ? 'partial' : 'complete',
    candidateSearchTruncated,
    candidateCount: candidates.length,
    candidates,
    unique: !ambiguous,
    status: ambiguous ? 'ambiguous' : 'suggestion',
    authority: 'L2-suggestion',
    externalConfirmation: input.externalConfirmation || null,
  };
  return deepFreeze(result);
}

export function recognitionCanClaimUnique(result) {
  return !!result && result.unique === true && result.candidateSearchTruncated !== true && result.completeness === 'complete' && result.conflictingFeatures.length === 0;
}

export async function recognizeWithKnowledgeDB({ db, input, packageEnvelope = null, options = {} } = {}) {
  if (!db || typeof db.findMatches !== 'function') throw new TypeError('knowledge database is required');
  const packageHash = packageEnvelope?.contentHash || null;
  const matches = await db.findMatches(input, options);
  const candidates = matches.map((match) => ({
    sourceEntityId: input.sourceEntityId || input.entityId || input.address || 'unknown-entity',
    packageEntryId: match.record.identityKey || match.record.id,
    tier: match.identity === 'exact' ? 'exact-content' : match.identity === 'normalized' ? 'relocation-normalized' : match.identity === 'structural' ? 'structural' : 'semantic',
    score: match.confidence,
    confidence: match.confidence,
    featuresUsed: match.reasons,
    evidenceIds: match.evidence?.map((item) => item.id || item.ref || stableDigest(item)),
    packageContentHash: packageHash,
  }));
  if (!candidates.length) return Object.freeze({ status: 'no-match', completeness: matches.truncated ? 'partial' : 'complete', candidateSearchTruncated: matches.truncated === true, candidates: [] });
  return createMatchResult({ ...input, packageContentHash: packageHash, candidates, candidateSearchTruncated: matches.truncated === true, ambiguityWindow: options.ambiguityWindow });
}

// Host-held approval authority for L4 promotion (#5216): a plain
// { approved:true, targetMatchId } self-declaration is not approval evidence,
// so promotion requires an opaque, single-use grant issued by the host for a
// specific match identity. Grants bind the exact match id, target entity,
// package identity/hash, algorithm version, actor identity and the host's
// project/binary binding; consumption verifies every binding and burns the
// grant, so forged, replayed or cross-target grants fail closed.
export function createRecognitionApprovalAuthority({ projectBinding = null } = {}) {
  const binding = projectBinding == null ? null : String(projectBinding).trim();
  if (binding !== null && !binding) throw new TypeError('recognition approval project binding must be a non-empty string');
  const pending = new Map();
  return deepFreeze({
    issueGrant(result, { actorId } = {}) {
      if (!result || result.authority !== 'L2-suggestion' || !result.id) throw new TypeError('recognition suggestion required');
      const actor = String(actorId || '').trim();
      if (!actor) throw new TypeError('local approving actor identity is required');
      const nonce = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)));
      const token = `recognition-grant_${stableDigest({ nonce, matchId: result.id, actor, projectBinding: binding })}`;
      const grant = deepFreeze({
        token,
        matchId: result.id,
        sourceEntityId: result.sourceEntityId,
        packageEntryId: result.packageEntryId,
        packageContentHash: result.packageContentHash ?? null,
        algorithmVersion: result.algorithmVersion,
        actorId: actor,
        projectBinding: binding,
      });
      pending.set(token, grant);
      return grant;
    },
    consumeGrant(result, token, { actorId = null } = {}) {
      const value = String(token || '');
      if (!value) throw new Error('explicit recognition approval is required');
      const grant = pending.get(value);
      if (!grant) throw new Error('recognition approval grant is not valid');
      const matches = (field, expected) => (grant[field] ?? null) === (expected ?? null);
      if (!matches('matchId', result?.id)) throw new Error('recognition approval grant is bound to a different match');
      if (!matches('sourceEntityId', result?.sourceEntityId)) throw new Error('recognition approval grant is bound to a different target entity');
      if (!matches('packageEntryId', result?.packageEntryId)) throw new Error('recognition approval grant is bound to a different package entry');
      if (!matches('packageContentHash', result?.packageContentHash)) throw new Error('recognition approval grant is bound to a different package content');
      if (!matches('algorithmVersion', result?.algorithmVersion)) throw new Error('recognition approval grant is bound to a different algorithm version');
      const actor = actorId == null ? grant.actorId : String(actorId).trim();
      if (actor !== grant.actorId) throw new Error('recognition approval grant is bound to a different actor');
      pending.delete(value);
      return grant;
    },
  });
}

export function promoteKnowledgeSuggestion(result, options = {}) {
  if (!result || result.authority !== 'L2-suggestion') throw new TypeError('recognition suggestion required');
  if (result.candidateSearchTruncated || result.status === 'ambiguous') throw new Error('ambiguous or truncated recognition cannot be promoted');
  const authority = options.approvalAuthority;
  if (!authority || typeof authority.consumeGrant !== 'function') throw new Error('explicit recognition approval is required');
  // A host-issued single-use grant is the only approval evidence; verified
  // actor/provenance come from the grant, not from caller fields (#5216).
  const grant = authority.consumeGrant(result, options.approvalGrant, { actorId: options.actorId ?? null });
  const actorId = String(grant.actorId || '').trim();
  if (!actorId) throw new TypeError('local approving actor identity is required');
  return deepFreeze({
    kind: 'knowledge-fact', targetEntityId: result.sourceEntityId, value: options.value || { packageEntryId: result.packageEntryId, name: options.name || null },
    confirmation: 'user-confirmed', authority: 'L4-local-canonical',
    provenance: { source: 'local-user', actorId, approvedMatchId: grant.matchId },
    externalProvenance: { packageContentHash: result.packageContentHash, packageEntryId: result.packageEntryId, algorithmVersion: result.algorithmVersion, evidenceIds: result.evidenceIds },
  });
}

export function importRecognitionPackage(value, options = {}) {
  const envelope = importPhase12Package(value, options);
  if (!['knowledge', 'mixed'].includes(envelope.kind)) throw new TypeError('recognition requires a knowledge package');
  return envelope;
}
