/** Bounded adapter over the existing points-to/alias owner. Candidate status
 * is never semantic authority; the certificate checker requires byte-derived
 * integer premises plus newly reopened canonical object premises. */
import { pointsToAlias } from '../../pointsto/alias.js';
import { createPointsToSet } from '../../pointsto/lattice.js';
import { createAnalysisStatus, isCompleteStatus, mergeAnalysisStatus } from '../../status.js';
import { supportedAliasCell, ALIAS_PROOF_SCHEMA, ALIAS_PROOF_VERSION, ALIAS_PROOF_INTERPRETATION } from '../../../core/evidence/alias-proof-kernel.js';
import { integerFragmentProofScope } from '../../../core/evidence/range-proof-kernel.js';
import { stableStringify } from '../../../core/identity/index.js';
import { assertScopedAnalysisWork } from '../../../core/budgets/scoped-work.js';

function combineOwnerStatuses(leftStatus, rightStatus) {
  const fallbackBase = leftStatus && typeof leftStatus === 'object' ? leftStatus
    : rightStatus && typeof rightStatus === 'object' ? rightStatus : null;
  const fallback = (completeness, stopReason) => createAnalysisStatus({
    snapshotId: typeof fallbackBase?.snapshotId === 'string' && fallbackBase.snapshotId.trim()
      ? fallbackBase.snapshotId : 'demand-alias-unknown-snapshot',
    analyzerId: typeof fallbackBase?.analyzerId === 'string' && fallbackBase.analyzerId.trim()
      ? fallbackBase.analyzerId : 'phase7.pointsto.demand-alias',
    analyzerVersion: typeof fallbackBase?.analyzerVersion === 'string' && fallbackBase.analyzerVersion.trim()
      ? fallbackBase.analyzerVersion : '1.0.0',
    completeness,
    stopReason,
  });
  if (!leftStatus || typeof leftStatus !== 'object' || !rightStatus || typeof rightStatus !== 'object') {
    return fallback('unsupported', 'evidence-missing');
  }
  if (leftStatus.snapshotId !== rightStatus.snapshotId) {
    return fallback('unsupported', 'dependency-mismatch');
  }
  try {
    return mergeAnalysisStatus(leftStatus, rightStatus);
  } catch {
    if (!isCompleteStatus(leftStatus) || !isCompleteStatus(rightStatus)) {
      const worst = [leftStatus, rightStatus].some((s) => s?.completeness === 'unsupported')
        ? 'unsupported' : 'partial';
      const reason = leftStatus.stopReason ?? rightStatus.stopReason ?? 'unsupported-input';
      try {
        return fallback(worst, reason);
      } catch {
        return fallback(worst, 'unsupported-input');
      }
    }
    return fallback('unsupported', 'unsupported-input');
  }
}

export function compareCanonicalAliasCells(left, right) {
  const status = combineOwnerStatuses(left?.ownerStatus, right?.ownerStatus);
  const leftSet = left?.pointsTo != null ? createPointsToSet(left.pointsTo) : null;
  const rightSet = right?.pointsTo != null ? createPointsToSet(right.pointsTo) : null;
  return pointsToAlias(leftSet, rightSet, {
    widthBitsLeft: 8, widthBitsRight: 8, status });
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
