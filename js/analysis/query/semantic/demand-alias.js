/** Bounded adapter over the existing points-to/alias owner. Candidate status
 * is never semantic authority; the certificate checker requires byte-derived
 * integer premises plus newly reopened canonical object premises. */
import { pointsToAlias } from '../../pointsto/alias.js';
import { createPointsToSet } from '../../pointsto/lattice.js';
import { supportedAliasCell, ALIAS_PROOF_SCHEMA, ALIAS_PROOF_VERSION, ALIAS_PROOF_INTERPRETATION } from '../../../core/evidence/alias-proof-kernel.js';
import { integerFragmentProofScope } from '../../../core/evidence/range-proof-kernel.js';
import { stableStringify } from '../../../core/identity/index.js';
import { assertScopedAnalysisWork } from '../../../core/budgets/scoped-work.js';

export function compareCanonicalAliasCells(left, right) {
  return pointsToAlias(createPointsToSet(left.pointsTo), createPointsToSet(right.pointsTo), {
    widthBitsLeft: 8, widthBitsRight: 8, status: left.ownerStatus });
}
export function collectDemandAliasCandidates(member, { work } = {}) {
  assertScopedAnalysisWork(work);
  const objects = new Map(member.demand.objects.map(row => [row.valueId, row])), candidates = [];
  const integers = member.integerProofCandidates.filter(row => supportedAliasCell(objects.get(row.fragment.semanticValueId), row.fragment));
  for (let i = 0; i < integers.length; i++) for (let j = i + 1; j < integers.length; j++) {
    work.charge('workUnits');
    const left = integers[i].fragment, right = integers[j].fragment, scope = integerFragmentProofScope(left);
    if (left.semanticValueId === right.semanticValueId || stableStringify(scope) !== stableStringify(integerFragmentProofScope(right))) continue;
    const actual = compareCanonicalAliasCells(objects.get(left.semanticValueId), objects.get(right.semanticValueId));
    if (!['no', 'must'].includes(actual.relation) || actual.status.completeness !== 'complete') continue;
    candidates.push({ schema: ALIAS_PROOF_SCHEMA, version: ALIAS_PROOF_VERSION, scope, interpretation: ALIAS_PROOF_INTERPRETATION,
      conclusion: { leftValueId: left.semanticValueId, rightValueId: right.semanticValueId, relation: actual.relation, addressSpace: 'memory', widthBytes: 1 } });
    if (candidates.length >= 16) return candidates;
  }
  return candidates;
}
