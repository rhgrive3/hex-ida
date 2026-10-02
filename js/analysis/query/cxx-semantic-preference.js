// Cheap ranking of existing anonymous members, never an evidence producer.
// The scoring formula is the pre-frozen real-game deterministic comparator.
import { demangleCxx } from '../../rtti.js';
import { cxxQueryTokens, cxxRecoveryTokens } from '../cxx/query-recovery.js';
import { isCxxMemberField, isCxxMemberIndex } from '../cxx/member-index.js';
import { isCanonicalCppMemberEvidence, isCanonicalCppReceiverEvidence, cxxBinarySymbolNameAt } from '../cxx/object-evidence.js';

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

// Prospective comparator: an explicitly mentioned owning object precedes an
// action word in an unrelated helper class. No offsets, gold names, particular
// classes, learned confidence cutoffs, or external answers enter this rule.
export function cxxObjectSemanticScores(query, views) {
  const tokens = new Set(cxxRecoveryTokens(query));
  return cxxSemanticScores(query, views).map(row => Object.freeze({ ...row,
    objectMatches: views[row.index]?.conflict ? 0
      : cxxRecoveryTokens(views[row.index]?.className?.split('::').at(-1))
        .filter(token => tokens.has(token)).length }));
}

export const compareCxxSemanticScores = (a, b) =>
  (b.objectMatches ?? 0) - (a.objectMatches ?? 0) || b.score - a.score || a.index - b.index;

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
        || member.sizeBytes !== field.size || !['this','typed-argument'].includes(receiver.receiverRole)) continue;
      const owner = receiver.classIdentity;
      const ownerKey = owner?.kind === 'named'
        ? JSON.stringify([receiver.snapshotId, 'named', owner.className])
        : owner?.vtableAddress != null ? JSON.stringify([receiver.snapshotId, 'vtable', String(owner.vtableAddress)])
        : owner?.typeinfoAddress != null ? JSON.stringify([receiver.snapshotId, 'typeinfo', String(owner.typeinfoAddress)]) : null;
      if (ownerKey !== field.ownerKey || owner?.offsetToTop !== 0n) continue;
      const address = receiver.functionAddress;
      const cacheKey = String(address);
      if (!names.has(cacheKey)) names.set(cacheKey, cxxBinarySymbolNameAt(symbols,address));
      contexts.push(Object.freeze({ address: cacheKey, name: names.get(cacheKey),
        receiverProven: true, accessRoles: member.accessRoles ?? [],
        receiverRole: receiver.receiverRole,
        writtenArgumentRegisters: member.writtenArgumentRegisters ?? [],
        writtenArgumentBits: member.writtenArgumentBits ?? [],
        writtenArgumentBitsTruncated: member.writtenArgumentBitsTruncated===true }));
    }
    return Object.freeze({ key: candidate.key, source: 'cxx', className: candidate.className,
      conflict: field.conflict === true, functionContexts: Object.freeze(contexts) });
  });
}

export function withCxxSemanticPreference(query, local, symbols, {policy='legacy'}={}) {
  if(!['legacy','object-context-v4'].includes(policy))return local;
  if (!local || ['confirmed', 'likely'].includes(local.verdict)
    || !Array.isArray(local.candidates) || !local.candidates.length
    || local.candidates.some(candidate => candidate.source !== 'cxx' || candidate.anonymous !== true || candidate.askedByName)) return local;
  try {
    const views = cxxSemanticViews(local.candidates, symbols);
    if (!views || views.some(view => !view)) return local;
    const scores = (policy==='object-context-v4'?cxxObjectSemanticScores:cxxSemanticScores)(query, views)
      .sort(compareCxxSemanticScores);
    if (!scores.length || scores[0].score <= 0 && (scores[0].objectMatches??0)<=0) return local;
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

// A prospective single-function retrieval result can express only a weak
// preference for the one existing member feeding that function's return.
// Inspect the complete published owner, not merely the ranked shortlist: a
// second return-linked member outside that shortlist still makes it ambiguous.
// This helper does no analysis, publication, HTTP, or semantic-name recovery.
export function withCxxReturnedMemberPreference(local, selection, symbols, index,
  { baseline=local, mode='partial', isCurrent=()=>false, shortlist=local?.candidates }={}) {
  try {
    if (mode!=='partial' || isCurrent()!==true || selection?.source!=='jev-retrieval'
      || !isCxxMemberIndex(index) || !local || !baseline
      || ['confirmed','likely'].includes(baseline.verdict)
      || ['confirmed','likely'].includes(local.verdict)
      || !Array.isArray(local.candidates) || !local.candidates.length
      || local.candidates.some(c=>c.source!=='cxx'||c.anonymous!==true||c.askedByName)
      || baseline.candidates?.some(c=>c.source!=='cxx'||c.anonymous!==true||c.askedByName)) return local;
    if (!Array.isArray(shortlist) || shortlist.length>255 || !shortlist.length
      || new Set(shortlist.map(c=>c.key)).size!==shortlist.length
      || shortlist.some(c=>!local.candidates.includes(c))) return local;
    const address=BigInt(selection.selectedAddress), owner=index.classInfo(selection.selectedClass);
    if (!owner || typeof selection.selectedClass!=='string' || address<0n
      || owner.ivars.length>400) return local;
    const views=cxxSemanticViews(local.candidates,symbols);
    if (!views || views.some(view=>!view)) return local;
    // Never reuse a stale baseline top after a genuine layout contradiction.
    if (baseline.top) {
      const current=local.candidates.find(c=>c.key===baseline.top.key);
      if (!current || current.field.conflict || current.offset!==baseline.top.offset
        || current.size!==baseline.top.size) return local;
    }
    const returned=[];
    for (const field of owner.ivars) {
      if (!isCxxMemberField(field,owner) || field.conflict || field.provenanceTruncated
        || field.memberNamesTruncated || !field.anonymous) return local;
      const linked=field.provenance.some(({receiver,member})=>
        isCanonicalCppReceiverEvidence(receiver) && isCanonicalCppMemberEvidence(member)
        && receiver.completeness==='complete' && receiver.snapshotId===index.snapshotId
        && receiver.classIdentity?.className===selection.selectedClass
        && receiver.functionAddress===address && member.functionId===receiver.functionId
        && member.snapshotId===receiver.snapshotId && member.receiverDigest===receiver.digest
        && member.offsetBytes===BigInt(field.offset) && member.sizeBytes===field.size
        && member.readCount>0 && member.accessRoles?.includes('return-input'));
      if (linked) returned.push(field);
    }
    if (returned.length!==1) return local;
    const top=local.candidates.find(c=>c.field===returned[0]);
    if (!top || !shortlist.includes(top) || isCurrent()!==true) return local;
    const candidates=[top,...local.candidates.filter(c=>c!==top)];
    return {...local,top,runnerUp:candidates[1]??null,candidates,margin:null,marginRatio:null,
      changeSites:top===local.top?local.changeSites:(top.sites??[]),
      semanticPreference:Object.freeze({source:'jev-selected-release-accessor',verdict:'weak-preference',
        evidenceTopKey:baseline.top?.key??null,selectedKey:top.key,
        selectedAddress:String(address),selectedClass:selection.selectedClass})};
  } catch (_) { return local; }
}
