// V2 prospective representation. No oracle imports or semantic field labels.
import { demangleCxx } from '../js/rtti.js';
import { cxxQueryTokens } from '../js/analysis/cxx/query-recovery.js';
import { cxxSemanticScores } from '../js/analysis/query/cxx-semantic-preference.js';
import { recoveryRequestBody } from './jev-realgame-recovery-contract.mjs';
import { describeCandidate } from './jev-realgame-final-contract.mjs';

export function stablePick(query, candidates) {
  const rows = cxxSemanticScores(query, candidates).sort((a, b) => b.score - a.score || a.index - b.index);
  return rows[0]?.score > 0 ? candidates[rows[0].index] : candidates[0] ?? null;
}

export function comparisonPool(query, candidates) {
  const rows = cxxSemanticScores(query, candidates).sort((a, b) => b.score - a.score || a.index - b.index);
  const max = rows[0]?.score ?? 0;
  if (max <= 0) return [];
  const tied = rows.filter(row => row.score === max).map(row => candidates[row.index]);
  // Compare only equally supported members of one canonical owner, and only
  // with a query-related method context. No confidence threshold is used.
  if (tied.length < 2 || tied.length > 255 || new Set(tied.map(c => c.className)).size !== 1
    || tied.some(c => c.source !== 'cxx' || c.conflict || c.anonymous !== true)) return [];
  const ownerHits = cxxQueryTokens(tied[0].className).filter(t => new Set(cxxQueryTokens(query)).has(t)).length;
  return max > 2 * ownerHits ? tied : [];
}

export function stabilityRequestBody(query, candidates, arm) {
  if (arm !== 'E2') return recoveryRequestBody(query, candidates, arm);
  const body = recoveryRequestBody(query, candidates, 'E');
  body.questions.pick.instructions += ' Prefer a method that retrieves or changes the requested value over a method that only mentions an action in the question. Constructor and shared-method accesses do not distinguish individual unnamed members. Treat identical context as ambiguous; do not infer a source member name from an offset.';
  const tokens = new Set(cxxQueryTokens(query));
  body.questions.pick.criteria = Object.fromEntries(candidates.map((candidate, index) => {
    const owner = cxxQueryTokens(candidate.className);
    const contexts = (candidate.functionContexts ?? []).slice(0, 64).map((context, position) => {
      const method = context.name ? (demangleCxx(context.name) ?? context.name).split('(')[0].split('::').at(-1) : '';
      const hits = cxxQueryTokens(method).filter(t => tokens.has(t) && !owner.includes(t)).length;
      return { context, position, priority: hits * (context.accessRoles?.includes('return-input') ? 2 : 1) };
    }).sort((a, b) => b.priority - a.priority || a.context.address.localeCompare(b.context.address) || a.position - b.position).slice(0, 8);
    const parts = [describeCandidate(candidate, 'C'), `reads: ${candidate.readCount ?? 'unknown'}`, `writes: ${candidate.writeCount ?? 'unknown'}`];
    for (const { context } of contexts) parts.push(`release method: ${String(context.name ? (demangleCxx(context.name) ?? context.name) : `0x${BigInt(context.address).toString(16)}`).slice(0, 240)}; proven receiver: ${context.receiverProven === true}; uses: ${(context.accessRoles ?? []).filter(r => ['return-input', 'comparison-input', 'arithmetic-input', 'address-base'].includes(r)).join(', ') || 'unclassified'}`);
    return [`c${index}`, parts.join(' | ')];
  }));
  return body;
}
