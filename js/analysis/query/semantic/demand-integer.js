/** Candidate collection is navigation only: it never decodes, evaluates, or
 * calls the independent checker. A proposed conclusion is copied from the
 * existing range owner and may subsequently be rejected by byte replay.
 */
import { INTEGER_FRAGMENT_SCHEMA, INTEGER_FRAGMENT_RULE, INTEGER_FRAGMENT_RULE_VERSION,
  INTEGER_FRAGMENT_MAX_INSTRUCTIONS, INTEGER_FRAGMENT_DOMAIN } from '../../../core/evidence/arm64-integer-fragment.js';
import { assertScopedAnalysisWork } from '../../../core/budgets/scoped-work.js';
import { jsonSafe } from '../../../core/identity/index.js';

export function collectDemandIntegerCandidates(member, { world, assumptions, work } = {}) {
  assertScopedAnalysisWork(work);
  const location = member.inputIdentity.sourceLocation;
  if (!location || location.snapshotId !== member.inputIdentity.snapshotId) return [];
  const entry = BigInt(location.start), fileMap = new Map(), reads = new Map();
  const rows = member.factReferences.filter(ref => ref.record.owner === 'semantic-ir');
  for (const ref of rows) {
    work.charge('workUnits');
    const row = ref.source, ranges = row?.origin?.byteRanges;
    if (ranges?.length !== 1 || ranges[0].binaryId !== member.inputIdentity.binaryId
      || BigInt(ranges[0].end) - BigInt(ranges[0].start) !== 4n) continue;
    for (const v of row.origin.virtualRanges ?? []) {
      const at = BigInt(v.start);
      if (BigInt(v.end) - at !== 4n || at < entry || at - entry > BigInt(INTEGER_FRAGMENT_MAX_INSTRUCTIONS * 4)) continue;
      const file = BigInt(ranges[0].start), key = at.toString();
      // A contradictory mapping is not a source certificate.
      if (fileMap.has(key) && fileMap.get(key) !== file) fileMap.set(key, null);
      else if (!fileMap.has(key)) fileMap.set(key, file);
    }
    if (row.kind === 'state-read' && row.variable?.physicalIdentity?.kind === 'register'
      && /^x(?:[0-9]|[12][0-9]|30)$/.test(row.variable.physicalIdentity.registerId)) {
      for (const id of row.outputs ?? []) reads.set(id, ref);
    }
  }
  const start = fileMap.get(entry.toString());
  if (start == null) return [];
  const candidates = [], values = member.demand.ranges?.values ?? [], bindings = member.demand.ranges?.bindings ?? [];
  for (const range of values) {
    work.charge('workUnits');
    const fact = range.fact;
    if (range.conditionalOn?.length || ![32, 64].includes(fact?.bits) || !fact.range
      || fact.knownOne == null || fact.knownZero == null || (fact.constant == null && BigInt(fact.knownOne) === 0n && BigInt(fact.knownZero) === 0n)) continue;
    const binding = bindings.find(b => b.localId === range.localId && b.bits === fact.bits && reads.has(b.semanticValueId));
    if (!binding) continue;
    const ref = reads.get(binding.semanticValueId), row = ref.source, boundary = BigInt(row.origin.byteRanges[0].start);
    const virtualBoundary = entry + boundary - start;
    if (boundary <= start || boundary - start > BigInt(INTEGER_FRAGMENT_MAX_INSTRUCTIONS * 4) || (boundary - start) % 4n
      || virtualBoundary + 4n > BigInt(location.end)
      || !row.origin.virtualRanges.some(v => BigInt(v.start) === virtualBoundary && BigInt(v.end) === virtualBoundary + 4n)) continue;
    let contiguous = true;
    for (let offset = 0n; offset <= boundary - start; offset += 4n) {
      work.charge('workUnits');
      if (fileMap.get((entry + offset).toString()) !== start + offset) { contiguous = false; break; }
    }
    if (!contiguous) continue;
    candidates.push({ readReferenceId: ref.record.id, fragment: {
      schema: INTEGER_FRAGMENT_SCHEMA, ruleId: INTEGER_FRAGMENT_RULE, ruleVersion: INTEGER_FRAGMENT_RULE_VERSION,
      worldId: world.id, assumptionsId: assumptions.id, functionId: member.functionId, snapshotId: member.inputIdentity.snapshotId,
      profile: world.profile, domain: INTEGER_FRAGMENT_DOMAIN,
      source: { binaryId: member.inputIdentity.binaryId, start: start.toString(), end: (boundary + 4n).toString(),
        boundary: boundary.toString(), virtualStart: entry.toString(), virtualBoundary: virtualBoundary.toString() },
      rangeLocalId: range.localId, semanticValueId: binding.semanticValueId,
      conclusion: { register: row.variable.physicalIdentity.registerId, bits: fact.bits,
        constant: fact.constant == null ? null : String(fact.constant.value), knownZero: String(fact.knownZero), knownOne: String(fact.knownOne),
        range: { kind: fact.range.kind, lower: String(fact.range.lower), upper: String(fact.range.upper) } },
    } });
    if (candidates.length >= 16) break;
  }
  return jsonSafe(candidates);
}
