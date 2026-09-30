// Cheap ranking of existing anonymous members, never an evidence producer.
// The scoring formula is the pre-frozen real-game deterministic comparator.
import { demangleCxx } from '../../rtti.js';
import { cxxQueryTokens } from '../cxx/query-recovery.js';
import { isCxxMemberField } from '../cxx/member-index.js';
import { isCanonicalCppMemberEvidence, isCanonicalCppReceiverEvidence } from '../cxx/object-evidence.js';

export function cxxSemanticScores(query, views) {
  if (!Array.isArray(views) || views.length > 400) return [];
  const tokens = new Set(cxxQueryTokens(query));
  return views.map((view, index) => {
    let score = 0;
    if (view?.source === 'cxx' && view.conflict !== true) {
      const owner = cxxQueryTokens(view.className);
      const classHits = owner.filter(token => tokens.has(token)).length;
      let contextScore = 0;
      for (const ctx of (view.functionContexts ?? []).slice(0, 64)) {
        const method = ctx.name ? (demangleCxx(ctx.name) ?? ctx.name).split('(')[0].split('::').at(-1) : '';
        const hits = cxxQueryTokens(method).filter(token => tokens.has(token) && !owner.includes(token)).length;
        contextScore = Math.max(contextScore, 4 * hits * (ctx.accessRoles?.includes('return-input') ? 2 : 1));
      }
      score = 2 * classHits + contextScore;
    }
    return Object.freeze({ key: view?.key, index, score });
  });
}

// This is the production trust boundary. Serialized/forged provenance cannot
// acquire a method context. Names come only from the active binary's symbols.
export function cxxSemanticViews(candidates, symbols) {
  if (!Array.isArray(candidates) || candidates.length > 400 || typeof symbols?.nameAt !== 'function') return null;
  const names = new Map();
  return candidates.map(candidate => {
    const field = candidate?.field;
    if (candidate?.source !== 'cxx' || !isCxxMemberField(field)
      || candidate.key !== field.key || candidate.offset !== field.offset
      || candidate.size !== field.size) return null;
    const identity = field.classIdentity;
    const ownerName = identity.className || `anonymous@${identity.vtableAddress != null ? 'vtable' : 'typeinfo'}:0x${(identity.vtableAddress ?? identity.typeinfoAddress).toString(16)}`;
    if (candidate.className !== ownerName) return null;
    const contexts = [];
    for (const { receiver, member } of (candidate.provenance ?? field.provenance ?? []).slice(0, 64)) {
      if (!isCanonicalCppReceiverEvidence(receiver) || !isCanonicalCppMemberEvidence(member)
        || member.receiverDigest !== receiver.digest || member.functionId !== receiver.functionId
        || member.snapshotId !== receiver.snapshotId || member.offsetBytes !== BigInt(field.offset)
        || member.sizeBytes !== field.size || receiver.receiverRole !== 'this') continue;
      const owner = receiver.classIdentity;
      const ownerKey = owner?.kind === 'named'
        ? JSON.stringify([receiver.snapshotId, 'named', owner.className])
        : owner?.vtableAddress != null ? JSON.stringify([receiver.snapshotId, 'vtable', String(owner.vtableAddress)])
        : owner?.typeinfoAddress != null ? JSON.stringify([receiver.snapshotId, 'typeinfo', String(owner.typeinfoAddress)]) : null;
      if (ownerKey !== field.ownerKey || owner?.offsetToTop !== 0n) continue;
      const address = receiver.functionAddress;
      const cacheKey = String(address);
      if (!names.has(cacheKey)) names.set(cacheKey, symbols.nameAt(address) ?? null);
      contexts.push(Object.freeze({ address: cacheKey, name: names.get(cacheKey),
        receiverProven: true, accessRoles: member.accessRoles ?? [] }));
    }
    return Object.freeze({ key: candidate.key, source: 'cxx', className: candidate.className,
      conflict: field.conflict === true, functionContexts: Object.freeze(contexts) });
  });
}

export function withCxxSemanticPreference(query, local, symbols) {
  if (!local || ['confirmed', 'likely'].includes(local.verdict)
    || !Array.isArray(local.candidates) || !local.candidates.length
    || local.candidates.some(candidate => candidate.source !== 'cxx' || candidate.anonymous !== true || candidate.askedByName)) return local;
  try {
    const views = cxxSemanticViews(local.candidates, symbols);
    if (!views || views.some(view => !view)) return local;
    const scores = cxxSemanticScores(query, views).sort((a, b) => b.score - a.score || a.index - b.index);
    if (!scores.length || scores[0].score <= 0) return local;
    const candidates = scores.map(row => local.candidates[row.index]);
    const top = candidates[0];
    return {
      ...local, top, runnerUp: candidates[1] ?? null, candidates,
      // A lexical/context preference has no evidence margin or stronger verdict.
      margin: null, marginRatio: null,
      changeSites: top === local.top ? local.changeSites : (top.sites ?? []),
      semanticPreference: Object.freeze({ source: 'binary-method-context', verdict: 'weak-preference',
        evidenceTopKey: local.top?.key ?? null, selectedKey: top.key,
        decisive: scores.length === 1 || scores[0].score > scores[1].score,
        scores: Object.freeze(scores) }),
    };
  } catch (_) {
    return local;
  }
}
